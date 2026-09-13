/* 刷题记 · 云端同步模块
 * 平衡策略（用户指定 + 补充建议）：
 *  1) localStorage 实时写（由 app.js 每次作答立即写入，本模块只读）——零调用成本，断网/刷新不丢。
 *  2) 脏标记 + 节流：任意写入 LS_KEY 即打 dirty=true；定时器每 10s 检查，仅 dirty 才 push 一次。
 *     挂机/无改动 -> 不调用，调用量由"你真改了没"决定。
 *  3) 强制 flush（无视节流、立即存）：交卷/提交、beforeunload、visibilitychange->hidden（手机锁屏）。
 * 补充：
 *  - 登录是「可选增强」不是「准入门槛」：本站 local-first，不登录照样刷题，
 *    登录入口在顶栏账号按钮。**只有服务端明确回「未登录/过期」才清 token**；
 *    断网 / 云函数抖动一律保留 token、静默离线，等网络恢复自动重试。
 *    （旧行为是网络异常也 `clearAuth()+showGate()`，等于断网就被踢出学习，已废弃。）
 *  - 登录时 / 已登录打开时主动 pull 一次，与本地做**逐题合并**（见下方 mergeState）。
 *  - 推送失败保留 dirty 并重试（带退避），网络抖动不丢数据。
 *  - 未登录不跑节流定时器，省无谓调用。
 *  - 卸载兜底用 navigator.sendBeacon / fetch(keepalive)，普通 fetch 在 beforeunload 里常发不出。
 */
(function () {
  const API = "https://shuatiji-d9gm0j668e9396859.service.tcloudbase.com/quiz";
  const LS_KEY = "quiz_v1";     // 与 app.js 一致
  const TK = "quiz_token";      // 登录态 token
  const UU = "quiz_user";       // 用户名
  const META = "quiz_sync_meta";// { local: 本地最后变更时间戳, cloud: 云端最后已知时间戳 }
  const THROTTLE_MS = 10000;    // 节流周期：10 秒

  // 保留原始方法，避免递归
  const rawSet = Storage.prototype.setItem.bind(localStorage);
  const rawGet = Storage.prototype.getItem.bind(localStorage);

  let token = rawGet(TK) || null;
  let username = rawGet(UU) || null;
  let dirty = false;
  let applyingRemote = false; // 写入云端拉回的数据时，抑制脏标记
  let timer = null;
  let failCount = 0;
  let lastFailTs = 0;
  let mergeNote = "";   // 上次跨设备合并的提示（不弹窗，只在「我的」页卡片显示一行）

  function meta() {
    try {
      const m = JSON.parse(rawGet(META));
      return m && typeof m === "object" ? m : { local: 0, cloud: 0 };
    } catch (e) {
      return { local: 0, cloud: 0 };
    }
  }
  function setMeta(m) {
    rawSet(META, JSON.stringify(m));
  }

  // 监听对 LS_KEY 的写入 -> 打脏标记（实时本地写由 app.js 负责，这里只做"变更探测"）
  // _syncWrapped 标记防止重复包裹：sync.js 被重复加载 / HMR 时会二次覆盖 setItem，
  // 导致脏标记重复打、甚至对 rawSet 递归包裹形成死循环。
  if (!Storage.prototype.setItem._syncWrapped) {
    const _origSet = rawSet;
    Storage.prototype.setItem = function (k, v) {
      _origSet(k, v);
      if (applyingRemote) return;
      if (k === LS_KEY) {
        dirty = true;
        const m = meta();
        m.local = Date.now();
        setMeta(m);
      }
    };
    Storage.prototype.setItem._syncWrapped = true;
  }

  // ---------- UI 辅助 ----------
  const $ = (s) => document.querySelector(s);
  function toast(msg) {
    if (window.toast) return window.toast(msg);
    const t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.remove("hidden");
    setTimeout(() => t.classList.add("hidden"), 2200);
  }
  function setStatus(t) {
    const el = $("#syncStatus");
    if (el) el.textContent = t;
  }
  function getToken() { return rawGet(TK); }
  function getUser() { return rawGet(UU); }
  function setAuth(t, u) { rawSet(TK, t); rawSet(UU, u); token = t; username = u; }
  function clearAuth() {
    localStorage.removeItem(TK);
    localStorage.removeItem(UU);
    token = null; username = null;
  }

  async function api(action, payload, tk) {
    const headers = { "Content-Type": "application/json" };
    if (tk) headers["X-Quiz-Token"] = tk;
    // 超时护栏：云函数偶尔卡死，避免 await 永久挂起（之前无超时，弱网会一直转圈）
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const to = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    try {
      const r = await fetch(API, {
        method: "POST",
        headers,
        body: JSON.stringify(Object.assign({ action }, payload || {})),
        signal: ctrl ? ctrl.signal : undefined,
      });
      return await r.json();
    } catch (e) {
      const err = new Error(e && e.name === "AbortError" ? "请求超时（>20s）" : ("网络错误：" + (e && e.message || e)));
      err.offline = true;
      throw err;
    } finally {
      if (to) clearTimeout(to);
    }
  }

  // ---------- 英语单词进度：专用接口（与整包 state 解耦，按词合并，换设备稳） ----------
  async function apiEnglishPush(words) {
    const tk = getToken(); if (!tk || !words || !Object.keys(words).length) return null;
    return api("english-push", { words, clientTs: Date.now() }, tk);
  }
  async function apiEnglishPull() {
    const tk = getToken(); if (!tk) return null;
    return api("english-pull", {}, tk);
  }
  async function apiEnglishReset() {
    const tk = getToken(); if (!tk) return null;
    return api("english-reset", {}, tk);
  }

  // ---------- 逐题合并（取代整包 last-write-wins） ----------
  /* 为什么不能整包 LWW：错题/收藏/掌握度是「各自累加」的集合，多端各标一点，
   * 整包覆盖必然丢掉一侧（服务端 push 是 set() 全量覆盖，谁时间戳新谁赢）。
   * 按字段语义分三类合并：
   *   ① 集合类（wrong/fav/doubt/mastered/badges/checkin）→ 并集，零冲突、只增不减
   *   ② 计数类（qstat/byChapter/daily）→ 取「累计量更大」一方，单调递增、防回退
   *   ③ 题级 map（review/note/aiExplain）→ 逐 key 合并，本地优先 + 云端补缺
   * 另：sessions（断点续练草稿，占 payload 78%）**不上传**。它是「这台设备的游标 +
   * 顺序 + 临时作答」，跨设备本就没法续，剥离后单次 payload 436KB → ~94KB。 */
  const MARK_FIELDS = ['wrong', 'fav', 'doubt', 'mastered'];
  const COUNT_FIELDS = { qstat: (v) => v.n || 0, byChapter: (v) => v.total || 0, daily: (v) => v.answered || 0 };

  function stripForSync(state) {
    if (!state || typeof state !== 'object') return state;
    const o = Object.assign({}, state);
    delete o.sessions;
    // 英语单词进度走专用 english-push 接口（按词合并、标记即存），不再塞进整包 state，
    // 避免被整包时间戳 LWW 覆盖（双设备各自只改英语时互相踩）。
    if (o.global && o.global.english) { o.global = Object.assign({}, o.global); delete o.global.english; }
    return o;
  }
  function sumMap(obj, pick) {
    let s = 0;
    for (const k in (obj || {})) s += pick(obj[k] || {});
    return s;
  }
  function pickRicher(a, b, pick) { return sumMap(a, pick) >= sumMap(b, pick) ? (a || {}) : (b || {}); }
  function mergeArr(a, b) { return Array.from(new Set((a || []).concat(b || []))); }
  function mergeMapLocalFirst(local, cloud) { return Object.assign({}, cloud || {}, local || {}); }
  function mergeReview(local, cloud) {
    const out = Object.assign({}, local || {});
    for (const [qid, cv] of Object.entries(cloud || {})) {
      const lv = out[qid];
      if (!lv) { out[qid] = cv; continue; }
      const stage = Math.max(lv.stage || 0, cv.stage || 0);        // 已复习到更后面的阶段不该回退
      const wrongAns = Array.from(new Set((lv.wrongAns || []).concat(cv.wrongAns || [])));
      const cands = [lv.nextReview, cv.nextReview].filter((x) => typeof x === 'number');
      const merged = Object.assign({}, cv, lv, { stage, wrongAns });
      if (cands.length) merged.nextReview = Math.min.apply(null, cands);  // 取更早的：宁可多复习不漏
      else delete merged.nextReview;
      out[qid] = merged;
    }
    return out;
  }
  function mergeExamHistory(a, b) {
    const seen = new Set(), out = [];
    for (const rec of (a || []).concat(b || [])) {
      if (!rec) continue;
      const k = [rec.date, rec.score, rec.right, rec.total, rec.minutes].join('|');
      if (seen.has(k)) continue;
      seen.add(k); out.push(rec);
    }
    out.sort((x, y) => (x.date || 0) - (y.date || 0));
    return out.slice(-50);            // 与 app.js 的 50 条上限一致
  }
  /* 单词进度合并：逐词取 n 大者（标记次数多 = 信息更全），n 相等取 t 新者。
     整条赢（含 s/log/due），不做 log 级并集——两端的 log 序列可能包含
     指向不同 s 状态的段，拼接会产生「进度回放不出来」的矛盾序列。 */
  function mergeEnglishProg(l, c) {
    if (!l) return c; if (!c) return l;
    const out = Object.assign({}, l);
    for (const k of Object.keys(c)) {
      const lv = out[k], cv = c[k];
      if (!lv) { out[k] = cv; continue; }
      out[k] = ((cv.n || 0) > (lv.n || 0)) ? cv
             : (((cv.n || 0) === (lv.n || 0) && (cv.t || 0) > (lv.t || 0)) ? cv : lv);
    }
    return out;
  }
  function mergeGlobal(l, c) {
    if (!l) return c; if (!c) return l;
    const o = Object.assign({}, c, l);
    o.xp = Math.max(l.xp || 0, c.xp || 0);
    o.badges = mergeArr(l.badges, c.badges);
    o.checkin = mergeArr(l.checkin, c.checkin);
    o.settings = Object.assign({}, c.settings, l.settings);   // 偏好跟本机，不被另一端覆盖
    if (l.english || c.english) o.english = mergeEnglishProg(l.english, c.english);
    const lb = Math.max(l.lastBackup || 0, c.lastBackup || 0);
    o.lastBackup = lb || null;
    return o;
  }
  function mergeSubject(l, c) {
    const o = Object.assign({}, l);
    for (const f of MARK_FIELDS) o[f] = mergeArr(l[f], c[f]);
    o.review = mergeReview(l.review, c.review);
    o.aiExplain = mergeMapLocalFirst(l.aiExplain, c.aiExplain);
    for (const f in COUNT_FIELDS) o[f] = pickRicher(l[f], c[f], COUNT_FIELDS[f]);
    o.examHistory = mergeExamHistory(l.examHistory, c.examHistory);
    o.aiGen = (l.aiGen && l.aiGen.length) ? l.aiGen : (c.aiGen || []);
    o.feedback = (l.feedback && l.feedback.length) ? l.feedback : (c.feedback || []);
    o.hadWrong = !!(l.hadWrong || c.hadWrong);
    for (const k of Object.keys(c)) if (o[k] === undefined && k !== 'wrongReason') o[k] = c[k];
    return o;
  }
  function mergeState(local, cloud) {
    const out = Object.assign({}, local);
    out.global = mergeGlobal(local.global, cloud.global);
    const subjects = Object.assign({}, local.subjects || {});
    for (const [subj, cs] of Object.entries(cloud.subjects || {})) {
      subjects[subj] = subjects[subj] ? mergeSubject(subjects[subj], cs) : cs;
    }
    out.subjects = subjects;
    if (local.sessions) out.sessions = local.sessions;    // 本机草稿原样留着，云端本就不带
    return out;
  }

  // ---------- 推：节流定时器调用 ----------
  async function flush() {
    if (!token || !dirty) return;
    if (failCount > 0) {
      const gap = Math.min(30000, 4000 * failCount);
      if (Date.now() - lastFailTs < gap) return;
    }
    const stateStr = rawGet(LS_KEY);
    if (!stateStr) return;
    let state;
    try { state = JSON.parse(stateStr); } catch (e) { return; }
    const m = meta();
    try {
      const res = await api("push", { state: stripForSync(state), updatedAt: m.local }, token);
      if (res.ok) {
        dirty = false;
        failCount = 0;
        m.cloud = m.local;
        setMeta(m);
        setStatus("已同步 " + new Date().toLocaleTimeString());
        refreshMeCard();
      } else if (res.msg) {
        setStatus("同步失败：" + res.msg);
        if (/登录|过期/.test(res.msg)) doLogout();
        else { failCount = Math.min(failCount + 1, 12); lastFailTs = Date.now(); }
      }
    } catch (e) {
      failCount = Math.min(failCount + 1, 12); lastFailTs = Date.now();
      setStatus("同步网络错误，重试中");
    }
  }

  // ---------- 拉：与本地逐题合并（不再整包 last-write-wins） ----------
  async function reconcile() {
    if (!token) return;
    const pr = await api("pull", {}, token);
    if (!pr.ok) {
      if (/登录|过期/.test(pr.msg || "")) doLogout();
      return;
    }
    const m = meta();
    const cloudTs = pr.updatedAt || 0;
    const localStr = rawGet(LS_KEY);
    let localState = null;
    if (localStr) { try { localState = JSON.parse(localStr); } catch (e) { localState = null; } }

    // 1) 云端还没有数据 → 把本地推上去
    if (!pr.state) {
      if (localState) {
        const res = await api("push", { state: stripForSync(localState), updatedAt: m.local }, token);
        if (res.ok) { m.cloud = m.local; setMeta(m); refreshMeCard(); }
      }
      return;
    }
    // 2) 本机是空的（新设备 / 刚清过）→ 直接采用云端
    if (!localState) {
      applyingRemote = true;
      rawSet(LS_KEY, JSON.stringify(pr.state));
      applyingRemote = false;
      m.local = Math.max(m.local, cloudTs); m.cloud = cloudTs; setMeta(m);
      dirty = false; refreshMeCard();
      setTimeout(() => location.reload(), 350);
      return;
    }
    // 3) 两端都有 → 逐题合并，结果回流云端（双向：把本地独有的也补上去）
    const merged = mergeState(localState, pr.state);
    const localChanged = JSON.stringify(merged) !== JSON.stringify(localState);
    const cloudNew = cloudTs > m.local;
    if (!localChanged && !cloudNew) { m.cloud = cloudTs; setMeta(m); return; }
    applyingRemote = true;
    rawSet(LS_KEY, JSON.stringify(merged));
    applyingRemote = false;
    m.local = Math.max(m.local, cloudTs);
    setMeta(m);
    dirty = true;
    if (localChanged) {
      mergeNote = "已合并云端与本机进度（" + new Date().toLocaleTimeString() + "）";
      refreshMeCard();
      setTimeout(() => location.reload(), 350);   // 本机视图需按合并结果重建
    } else {
      refreshMeCard();
      await flush();                              // 内容无变化，只把本地补上云
    }
  }

  // ---------- 定时器 ----------
  function startSync() {
    if (timer) return;
    timer = setInterval(() => {
      if (token && dirty) flush();
    }, THROTTLE_MS);
  }
  function stopSync() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // ---------- 强制 flush：兜底不丢 ----------
  function forceFlush() {
    if (!token || !dirty) return;
    const stateStr = rawGet(LS_KEY);
    if (!stateStr) return;
    let state;
    try { state = JSON.parse(stateStr); } catch (e) { return; }
    const m = meta();
    const body = JSON.stringify({ action: "push", token, state: stripForSync(state), updatedAt: m.local });
    if (navigator.sendBeacon) {
      try {
        navigator.sendBeacon(API, new Blob([body], { type: "application/json" }));
        dirty = false; m.cloud = m.local; setMeta(m);
        return;
      } catch (e) { /* fallthrough */ }
    }
    try {
      fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
      dirty = false; m.cloud = m.local; setMeta(m);
    } catch (e) { /* 尽力而为，下次定时器兜底 */ }
  }

  // ---------- 账号 ----------
  async function doLogin(mode, uname, pwd) {
    const res = await api(mode, { username: uname, password: pwd });
    if (!res.ok) return res;
    setAuth(res.token, res.username);
    accountBtnLabel();
    toast(mode === "register" ? "注册成功，正在同步云端进度" : "登录成功，正在同步云端进度");
    /* 登录成功即接管同步：开节流定时器 + 拉起云端进度做逐题合并。
     * ⚠️ 这两步必须放在 doLogin 里 —— 门禁默认隐藏后，用户只能从顶栏账号弹窗登录，
     * 而 openAccount 的提交分支不会调 startSync，漏在这里就等于「登录了但永不同步」。 */
    startSync();
    refreshMeCard();
    reconcile();
    if (window.QuizEnglish) window.QuizEnglish.pull();   // 登录即拉取云端单词进度（换设备接着背）
    return { ok: true };
  }
  function doLogout() {
    clearAuth();
    stopSync();
    accountBtnLabel();
    refreshMeCard();
    setStatus("未登录");
    const m = $("#accountModal"); if (m) m.classList.add("hidden");
    // 不再弹门禁：退出登录 / 登录过期只切断云同步，不该把人锁在学习之外
  }

  // 对外暴露（app.js 在交卷/提交时调用 forceFlush）
  window.QuizSync = {
    forceFlush,
    flush,
    englishPush: apiEnglishPush,
    englishPull: apiEnglishPull,
    englishReset: apiEnglishReset,
    isLoggedIn: () => !!getToken(),
    login: doLogin,
    logout: doLogout,
    // 仅供验证套件断言合并语义 / payload 剥离，业务代码不要用
    _mergeState: mergeState,
    _stripForSync: stripForSync,
  };

  // 兜底：页面关闭 / 切后台锁屏
  window.addEventListener("beforeunload", forceFlush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") forceFlush();
  });

  // ---------- UI ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function accountBtnLabel() {
    const b = $("#accountBtn");
    if (!b) return;
    const u = getUser();
    b.textContent = u ? "👤 " + u : "👤 登录/注册";
    b.classList.toggle("is-guest", !u);
  }

  // 「我的」页顶部同步卡片
  function isMePage() {
    const v = $("#view");
    if (!v) return false;
    return !!v.querySelector('[data-act="export-data"]');
  }
  function cardHtml() {
    const u = getUser();
    if (u) {
      const status = mergeNote
        ? ("☁️ " + escapeHtml(mergeNote))
        : "☁️ 云端已连接 · 错题 / 进度自动同步（断点续练只存本机）";
      return '<div class="card account-card logged" data-account-card>' +
        '<div class="ac-row"><span class="ac-avatar">👤</span>' +
        '<div class="ac-meta"><div class="ac-name">' + escapeHtml(u) + '</div>' +
        '<div class="muted small" id="acStatus">' + status + '</div></div>' +
        '<button class="btn ghost sm" id="acLogout">退出</button></div></div>';
    }
    return '<div class="card account-card" data-account-card>' +
      '<div class="ac-row"><div class="ac-meta">' +
      '<div class="ac-title">☁️ 云同步 · 多设备不掉队（可选）</div>' +
      '<div class="muted small">不登录也能正常刷题，进度只存本机。登录后错题 / 进度存到云端，换设备接着刷。</div></div>' +
      '<button class="btn" id="acLogin">登录 / 注册</button></div></div>';
  }
  let suppress = false;
  function injectMeCard() {
    const v = $("#view");
    if (!v || !isMePage()) return;
    // 卡片已存在时直接返回：避免 MutationObserver 因我们自己的 DOM 变更再次触发 -> 死循环卡死
    if (v.querySelector("[data-account-card]")) return;
    const html = cardHtml();
    v.insertAdjacentHTML("afterbegin", html);
    bindCard();
  }
  function bindCard() {
    const loginBtn = $("#acLogin");
    if (loginBtn) loginBtn.onclick = openAccount;
    const logoutBtn = $("#acLogout");
    if (logoutBtn) logoutBtn.onclick = () => { doLogout(); toast("已退出登录"); };
  }
  function refreshMeCard() {
    const c = $("#view [data-account-card]");
    if (c) c.remove();
    injectMeCard();
  }

  // ---------- 登录门禁 UI ----------
  /* 保留这套 UI 但**默认不显示**（init 里 hideGate）：登录现在是可选增强，
   * 不再是准入门槛。showGate() 已无调用点，留着为将来可能的「强制登录」模式备用。 */
  function createGate() {
    if ($("#authGate")) return;
    const g = document.createElement("div");
    g.id = "authGate";
    g.className = "auth-gate";
    g.innerHTML =
      '<div class="auth-card">' +
      '<div class="auth-brand">📚 刷题记</div>' +
      '<div class="auth-sub">登录后即可同步进度，手机 / 电脑接着刷</div>' +
      '<div class="am-tabs">' +
      '<button class="btn sm g-tab active" data-mode="login">登录</button>' +
      '<button class="btn ghost sm g-tab" data-mode="register">注册</button>' +
      '</div>' +
      '<input id="gUser" class="inp block" placeholder="用户名（≥2字符）" autocomplete="username" />' +
      '<input id="gPwd" class="inp block" type="password" placeholder="密码（≥6位）" autocomplete="current-password" />' +
      '<p class="muted small" id="gMsg"></p>' +
      '<button class="btn block" id="gSubmit">登录</button>' +
      '<p class="muted tiny" id="gHint">首次使用请先「注册」一个账号</p>' +
      '</div>';
    document.body.appendChild(g);

    let mode = "login";
    g.querySelectorAll(".g-tab").forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.mode;
        g.querySelectorAll(".g-tab").forEach((x) => {
          const on = x.dataset.mode === mode;
          x.classList.toggle("active", on);
          x.classList.toggle("ghost", !on);
        });
        $("#gSubmit").textContent = mode === "login" ? "登录" : "注册";
        $("#gMsg").textContent = "";
      };
    });
    g.querySelectorAll("input").forEach((inp) => {
      inp.onkeydown = (e) => { if (e.key === "Enter") $("#gSubmit").click(); };
    });
    $("#gSubmit").onclick = async () => {
      const uname = $("#gUser").value.trim();
      const pwd = $("#gPwd").value;
      if (!uname || !pwd) { $("#gMsg").textContent = "请输入用户名和密码"; return; }
      $("#gMsg").textContent = "处理中…";
      const res = await doLogin(mode, uname, pwd);
      if (!res.ok) { $("#gMsg").textContent = res.msg || "操作失败"; return; }
      hideGate();
      startSync();
      await reconcile();
    };
  }
  function showGate() {
    const g = $("#authGate");
    if (g) {
      g.style.display = "flex";
      document.body.classList.add("gated");
      const u = $("#gUser"); if (u) u.focus();
    }
  }
  function hideGate() {
    const g = $("#authGate");
    if (g) {
      g.style.display = "none";
      document.body.classList.remove("gated");
      $("#gUser") && ($("#gUser").value = "");
      $("#gPwd") && ($("#gPwd").value = "");
      const msg = $("#gMsg"); if (msg) msg.textContent = "";
    }
  }
  // 校验已有 token（后台静默）。**网络异常不算登录失效**：保留 token、照常进入学习。
  async function validateAndEnter() {
    let pr = null;
    try {
      pr = await api("pull", {}, token);
    } catch (e) {
      // 断网 / 云函数抖动：token 原样保留，静默离线；网络恢复后定时器自动重试
      setStatus("离线（网络恢复后自动同步）");
      hideGate();
      return;
    }
    if (pr && pr.ok) { startSync(); await reconcile(); if (window.QuizEnglish) window.QuizEnglish.pull(); hideGate(); return; }
    if (pr && /登录|过期/.test(pr.msg || "")) {
      // 只有服务端「明确」否认登录态时才清 token
      clearAuth(); accountBtnLabel(); refreshMeCard();
      setStatus("登录已过期，请重新登录");
    } else {
      setStatus("云端暂时不可用（进度仍存本机）");
    }
    hideGate();
  }

  function ensureModal() {
    let el = $("#accountModal");
    if (el) return { el, box: el.querySelector(".modal-box") };
    el = document.createElement("div");
    el.id = "accountModal";
    el.className = "modal hidden";
    el.innerHTML = '<div class="modal-box"></div>';
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target === el) el.classList.add("hidden"); });
    return { el, box: el.querySelector(".modal-box") };
  }
  function openAccount() {
    const u = getUser();
    const m = ensureModal();
    if (u) {
      m.box.innerHTML =
        '<div class="am-card">' +
        "<h3 style=\"margin:0 0 6px\">云端账号</h3>" +
        '<p class="muted">已登录：<b>' + escapeHtml(u) + "</b></p>" +
        '<p class="muted small" id="syncStatus">同步中…</p>' +
        '<button class="btn block" id="btnLogout">退出登录</button>' +
        '<button class="btn ghost block" id="btnCloseAcc">关闭</button>' +
        "</div>";
      m.el.classList.remove("hidden");
      $("#btnLogout").onclick = () => { doLogout(); toast("已退出登录"); };
      $("#btnCloseAcc").onclick = () => m.el.classList.add("hidden");
      setStatus(getToken() ? "已连接云端" : "未登录");
    } else {
      m.box.innerHTML =
        '<div class="am-card">' +
        "<h3 style=\"margin:0 0 10px\">登录 / 注册</h3>" +
        '<div class="am-tabs">' +
        '<button class="btn sm" id="tabLogin">登录</button>' +
        '<button class="btn ghost sm" id="tabReg">注册</button>' +
        "</div>" +
        '<input id="accUser" class="inp block" placeholder="用户名（≥2字符）" />' +
        '<input id="accPwd" class="inp block" type="password" placeholder="密码（≥6位）" />' +
        '<p class="muted small" id="accMsg"></p>' +
        '<button class="btn block" id="accSubmit">登录</button>' +
        '<button class="btn ghost block" id="btnCloseAcc">关闭</button>' +
        "</div>";
      m.el.classList.remove("hidden");
      let mode = "login";
      const tabLogin = $("#tabLogin");
      const tabReg = $("#tabReg");
      tabLogin.onclick = () => { mode = "login"; tabLogin.className = "btn sm"; tabReg.className = "btn ghost sm"; $("#accSubmit").textContent = "登录"; };
      tabReg.onclick = () => { mode = "register"; tabReg.className = "btn sm"; tabLogin.className = "btn ghost sm"; $("#accSubmit").textContent = "注册"; };
      $("#btnCloseAcc").onclick = () => m.el.classList.add("hidden");
      $("#accSubmit").onclick = async () => {
        const uname = $("#accUser").value.trim();
        const pwd = $("#accPwd").value;
        if (!uname || !pwd) { $("#accMsg").textContent = "请输入用户名和密码"; return; }
        $("#accMsg").textContent = "处理中…";
        const res = await doLogin(mode, uname, pwd);
        if (!res.ok) { $("#accMsg").textContent = res.msg || "操作失败"; return; }
        if (!res.reload) m.el.classList.add("hidden");
      };
    }
  }

  function init() {
    createGate();
    const row = $(".topbar-row");
    if (row && !$("#accountBtn")) {
      const btn = document.createElement("button");
      btn.id = "accountBtn";
      btn.className = "account-btn";
      btn.onclick = openAccount;
      row.appendChild(btn);
    }
    accountBtnLabel();
    // 登录是「可选增强」：不登录也必须能刷题（local-first，本站全部功能都可离线用）。
    // 注意 createGate 的元素默认 display:flex（见 styles.css .auth-gate），所以这里先收起。
    hideGate();
    if (token) validateAndEnter();
    else setStatus("未登录（进度只存本机）");
    // 「我的」页同步卡片：监听视图变化，me 页渲染时注入/刷新
    const view = $("#view");
    if (view) {
      new MutationObserver(() => { if (!suppress) injectMeCard(); })
        .observe(view, { childList: true });
      injectMeCard();
    }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
