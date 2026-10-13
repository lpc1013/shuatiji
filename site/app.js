/* 刷题记 · 个人学习站  —  纯前端，无后端，状态存 localStorage */
'use strict';

/* ---------- 题库数据层：manifest + 分片懒加载 ----------
 * 首屏只拉 data/manifest.json（约 20KB），进某学科时才拉该科分片；
 * 解析另存 explain 分片，做题时才取。
 * 极光题沿用原始「章节 UUID」作 chapterId —— 与旧版完全一致，
 * 用户既有的分章正确率 / 断点会话 / 复习计划都不会失效。 */
let SB = {};
let MANIFEST = null;
const LOADED = new Set();
const QF = 'data/';
/* 极光内部同题存在多套 id（早期副本 / 站点早期另建）。分片以「网站当前在用的那个」为主 id，
 * 其余存进 flags.aliasIds。用户旧进度里可能存的是别名 → 必须建别名→主 id 映射，否则「查无此题」。 */
const ALIAS = Object.create(null);
/* 题 id / 章节 id → 所属题库（jg|ext）。**别名一并登记**。
 * 为什么需要它：清空进度要按题库分类，而 A02 统一 id 网之后扩展题主 id 是源站稳定 id
 * （ykb_ / school_ / kaoyan_），不再以 ext- 开头 —— 只看前缀会把扩展题误判成极光题删掉。
 * 分片是按学科懒加载的，所以这张表只覆盖已载入的学科；未载入时退回前缀判断（见 idGroupOf）。 */
const QGROUP = Object.create(null);
const CGROUP = Object.create(null);
/* 孤儿题表：未上线科（如外基）被用户进度引用、但站点未整科打包的少数题。启动期载入，
 * 让 qById 可解析、错题本/收藏不再悬空；不注册为 SB 学科，故不新增任何 tab。 */
const ORPHANS = Object.create(null);

async function bootData() {
  const r = await fetch(QF + 'manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('manifest HTTP ' + r.status);
  MANIFEST = await r.json();
  // 孤儿题包：未上线科（如外基）被用户进度引用但站点未整科打包的少数题，启动期载入即可解析
  try {
    const or = await fetch(QF + 'orphans.json', { cache: 'no-cache' });
    if (or.ok) for (const it of (await or.json())) {
      const q = toQ(it); q.group = 'orphan'; q.chapterId = it.c || '未分类';
      ORPHANS[q.id] = q; ALIAS[q.id] = q.id; QGROUP[q.id] = 'orphan';
      // 注册旧 id 别名（如 lql 进度里存的老 UUID）→ 新 id，使历史引用可解析
      if (it.f && it.f.aliasIds) for (const a of it.f.aliasIds) { ALIAS[a] = q.id; QGROUP[a] = 'orphan'; }
    }
  } catch (e) { /* 孤儿包可选，缺失不影响主流程 */ }
  migrateChapterKeys();   // 扩展章节归一后，旧「x+章名」键自动迁到新键（零丢失）
  migrateExamSessionKeys();   // 老考试断点 e:<科目> → e:<科目>:<卷指纹>（防串卷，见函数注释）
  for (const sem of MANIFEST.semesters) {
    for (const s of sem.subjects) {
      SB[s.id] = {
        id: s.id, name: s.name, semester: sem.name, meta: s, explain: {},
        chapters: [], activeGroup: 'jg',
        groups: {
          jg: { key: 'jg', name: '极光题库', chapters: [] },
          ext: { key: 'ext', name: '扩展题库', chapters: [] }
        }
      };
    }
  }
  return MANIFEST;
}

/* 题型中文名（做题页/列表/筛选共用） */
const TYPE_LABEL = { A1: '单选题', A2: '病例单选题', A3: '病例组题', 多选: '多选题', 判断: '判断题', 填空: '填空题' };
/* 选项键排序：源数据里存在 {A,C,D,E,B} 这类乱序键，直接渲染会出现 A→C→D→E→B 的错乱顺序 */
function sortOpts(o) {
  const out = {};
  for (const k of Object.keys(o || {}).filter(k => /^[A-Za-z]$/.test(k)).map(k => k.toUpperCase()).sort()) out[k] = o[k] || o[k.toLowerCase()] || '';
  return out;
}
function toQ(it) {
  const options = sortOpts(it.o);
  const correct = String(it.a || '').toUpperCase().split('').filter(c => /[A-Z]/.test(c)).sort().join('');
  const type = it.t || 'A1';
  return {
    id: it.id, content: it.q || '', options, correct,
    caseInfo: it.ci || '',
    multi: type === '多选' || correct.length > 1,
    type, typeLabel: TYPE_LABEL[type] || (correct.length > 1 ? '多选题' : '单选题'),
    noChoice: Object.keys(options).length === 0,
    images: [],
    difficulty: it.d, hot: it.n, acc: it.ac, favCount: it.fv,
    year: it.y || it.ey, qsource: it.qs, sys: it.sys, source: it.s, flags: it.f || null,
    tags: it.tg || null, suggestedTags: it.stg || null,
    group: null, chapterId: null, explanation: '', exp: null
  };
}

function buildGroups(sub, jg, ext) {
  const mk = (arr, grp) => {
    const m = new Map();
    for (const it of arr) {
      if (!it.q || !String(it.q).trim()) continue;   // 源数据题干缺失（极个别），不展示，但保留在数据文件中可追溯
      const cid = (grp === 'jg' && it.cid) ? it.cid : ('x' + (it.c || '未分类'));
      if (!m.has(cid)) m.set(cid, { id: cid, name: it.c || '未分类', grp, questions: [] });
      const q = toQ(it); q.chapterId = cid; q.group = grp;
      CGROUP[cid] = grp;
      QGROUP[q.id] = grp;
      if (it.f && it.f.aliasIds) for (const a of it.f.aliasIds) { ALIAS[a] = q.id; QGROUP[a] = grp; }
      m.get(cid).questions.push(q);
    }
    return [...m.values()];
  };
  sub.groups.jg.chapters = mk(jg, 'jg');
  sub.groups.ext.chapters = mk(ext, 'ext');
  sub.activeGroup = sub.groups.jg.chapters.length ? 'jg' : 'ext';
  sub.chapters = sub.groups[sub.activeGroup].chapters;
}

async function ensureSubject(id) {
  const sub = SB[id];
  if (!sub) return sub;
  /* A13（审计 P1-4）：分片级加载状态。_jgDone/_extDone=对应分片已成功载入，成功片数据
   * 缓存在 _jgData/_extData 不重复下载；失败片下次进科/预载自动重拉——旧版单片失败会被
   * 当空题库静默吞掉、且 LOADED 整科挡住重试。 */
  const m = sub.meta;
  const jgFile = m.jiguang && m.jiguang.file, extFile = m.extension && m.extension.file;
  const needJg = !!jgFile && !sub._jgDone, needExt = !!extFile && !sub._extDone;
  if (!needJg && !needExt) { LOADED.add(id); return sub; }   // 全部就绪（或本就无分片配置）
  if (sub._loading) return sub._loading;   // 在途去重：并发调用共用同一次加载
  sub._loading = (async () => {
    // 版本闸口：分片 URL 带 manifest.version，数据更新后自动失效旧缓存（manifest 本身不缓存）
    const v = MANIFEST.version || '0';
    const get = f => f ? fetch(QF + f + '?v=' + v).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null);
    const [jg, ext] = await Promise.all([needJg ? get(jgFile) : null, needExt ? get(extFile) : null]);
    if (Array.isArray(jg)) { sub._jgData = jg; sub._jgDone = true; }
    if (Array.isArray(ext)) { sub._extData = ext; sub._extDone = true; }
    // A11 修复保留：两片全失败（断网/404）不能留在 LOADED 里——否则该学科被永久视为已加载，
    // 用户只看到空题库、再进也不重试。回滚占位标记，明确提示，下次进科重新走加载。
    if (!sub._jgDone && !sub._extDone) {
      LOADED.delete(id);
      toast('题库加载失败，请检查网络后重试');
      return sub;
    }
    LOADED.add(id);
    // 富解析分片改为惰性加载：进学科只拉 jg/ext 两片，富解析（单科 6MB）首次打开某题才拉（见 loadExplain）。
    // 否则刷新即整块下载 6MB+，首屏/进科明显变慢。
    sub.explain = {};
    sub.explainChapters = (m.explain && m.explain.chapters) || null;   // 按章节拆分的解析分片清单
    if (sub.explainChapters) loadExplain(sub);   // 进科即并发预加载该科所有章节解析（小文件并发 + 缓存友好）
    buildGroups(sub, sub._jgData || [], sub._extData || []);
    normalizeSubjectIds(id);   // ALIAS 刚建好 → 立刻把本机存的旧题 id 归一到主 id（见函数注释）
    if ((needJg && !sub._jgDone) || (needExt && !sub._extDone))
      toast('部分题库分片加载失败，重新进入本学科将自动重试');
    return sub;
  })();
  try { return await sub._loading; } finally { sub._loading = null; }
}

/* ---------- 统一 id 网：本机旧进度 id 归一化 ----------
 * 分片换 id 后（扩展题由 ext-<sha1> 改为源站稳定 id），用户 localStorage 里存的仍是老 id。
 * ALIAS 建好之后把存储里的 id 一次性改写为主 id（幂等：已归一化的不会再变）。
 * 不做的话会出现「键错配」——错题本看得到（qById 走 ALIAS），但掌握度/作答统计直接比对原数组，读不到。
 * 只处理当前学科：ALIAS 是按学科懒加载填的，其他学科载入时自然会各自归一。 */
function normalizeSubjectIds(sid) {
  const st = S.subjects && S.subjects[sid];
  let changed = 0;
  const one = x => { const r = ALIAS[x] || x; if (r !== x) changed++; return r; };
  if (st) {
    for (const k of ['wrong', 'fav', 'doubt', 'mastered']) {
      if (!Array.isArray(st[k]) || !st[k].length) continue;
      const seen = new Set(), out = [];
      for (const x of st[k]) { const r = one(x); if (!seen.has(r)) { seen.add(r); out.push(r); } }
      st[k] = out;
    }
    /* A11 tombstone：墓碑 key 同样要归一到主 id（否则旧 id 墓碑与主 id 记录错位，删除语义失效）。
     * 同题两个形态都有墓碑时取 t 新者。 */
    if (st.tomb) {
      for (const f of Object.keys(st.tomb)) {
        const old = st.tomb[f]; if (!old || typeof old !== 'object') continue;
        const nb = {};
        for (const key of Object.keys(old)) {
          const r = one(key);
          const a = nb[r], b = old[key];
          nb[r] = (a && (a.t || 0) >= ((b && b.t) || 0)) ? a : b;
        }
        st.tomb[f] = nb;
      }
    }
    for (const k of ['qstat', 'review']) {
      if (!st[k] || typeof st[k] !== 'object') continue;
      const old = st[k], nb = {}; let dirty = false;
      for (const key of Object.keys(old)) {
        const r = one(key);
        if (r !== key) dirty = true;
        if (!(r in nb)) { nb[r] = old[key]; continue; }
        /* 新旧两个 id 同时有记录（同题曾以两个来源 id 各答过）→ 按字段语义保留信息量大的那个，
         * 直接覆盖会丢一边的作答历史。 */
        const a = nb[r], b = old[key];
        if (k === 'qstat') nb[r] = (((b && b.n) || 0) > ((a && a.n) || 0)) ? b : a;
        else if (k === 'review') {
          const merged = Object.assign({}, a, b);
          merged.stage = Math.max((a && a.stage) || 0, (b && b.stage) || 0);
          merged.streak = Math.max((a && a.streak) || 0, (b && b.streak) || 0);
          merged.wrongAns = [...new Set([...((a && a.wrongAns) || []), ...((b && b.wrongAns) || [])])];
          merged.mastered = !!(a && a.mastered) || !!(b && b.mastered);
          merged.feeling = (b && b.feeling && b.feeling !== 'unknown') ? b.feeling : ((a && a.feeling) || 'unknown');
          const sf = [a && a.streakFrom, b && b.streakFrom].filter(x => x); merged.streakFrom = sf.length ? Math.min(...sf) : null;
          const nr = [a && a.nextReview, b && b.nextReview].filter(x => x); merged.nextReview = nr.length ? Math.min(...nr) : Date.now();
          nb[r] = merged;
        }
      }
      if (dirty) st[k] = nb;
    }
  }
  for (const key of Object.keys(S.sessions || {})) {
    const s = S.sessions[key];
    if (!s || (s.subject && s.subject !== sid)) continue;
    if (Array.isArray(s.qids)) for (const q of s.qids) if (q && q.id) q.id = one(q.id);
    if (s.answers && typeof s.answers === 'object') {
      const nb = {}; let dirty = false;
      for (const k2 of Object.keys(s.answers)) { const r = one(k2); if (r !== k2) dirty = true; nb[r] = s.answers[k2]; }
      if (dirty) s.answers = nb;
    }
  }
  if (changed) save();
  return changed;
}

/* 扩展章节归一迁移：manifest.chapterAliases[科目id] = { 旧x章名: 新x章名 }
 * 改写 byChapter 分章正确率键 + sessions 里的 c:科目:章节 断点键；收藏/错题/复习按题目 id 存，不受影响 */
function migrateChapterKeys() {
  const CA = (MANIFEST && MANIFEST.chapterAliases) || {};
  for (const sid of Object.keys(CA)) {
    const map = CA[sid], st = S.subjects[sid];
    if (!st || !map) continue;
    if (st.byChapter) { const nb = {}; for (const k in st.byChapter) nb[map[k] || k] = st.byChapter[k]; st.byChapter = nb; }
  }
  if (S.sessions) {
    const ns = {};
    for (const k in S.sessions) {
      const parts = k.split(':');
      if (parts[0] === 'c' && parts.length >= 3) {
        const sid = parts[1], cid = parts.slice(2).join(':');
        const map = CA[sid];
        ns['c:' + sid + ':' + ((map && map[cid]) || cid)] = S.sessions[k];
      } else ns[k] = S.sessions[k];
    }
    S.sessions = ns;
  }
  save();
}

/* 考试会话键规范化：老键是 e:<科目>（不分卷），新键是 e:<科目>:<卷指纹>。
 * 不迁移的话，老断点永远命中不到新卷，但首页「继续刷题」又会把它捞出来（语义混乱）。
 * 这里按已存的 qids 补算指纹改写键 —— 用户断点零丢失。 */
function migrateExamSessionKeys() {
  if (!S.sessions) return;
  let dirty = false;
  for (const k of Object.keys(S.sessions)) {
    const s = S.sessions[k];
    if (!s || s.mode !== 'exam') continue;
    if (k.split(':').length >= 3) continue;            // 已是带指纹的新键
    const qids = s.qids || [];
    if (!qids.length) { delete S.sessions[k]; dirty = true; continue; }
    const nk = 'e:' + s.subject + ':' + examKeyOf(s.modeOpt || {});
    if (nk === k) continue;
    s.key = nk; S.sessions[nk] = s; delete S.sessions[k]; dirty = true;
  }
  if (dirty) save();
}

function setGroup(id, key) {
  const sub = SB[id];
  if (!sub || !sub.groups[key] || !sub.groups[key].chapters.length) return;
  sub.activeGroup = key;
  sub.chapters = sub.groups[key].chapters;
}
function groupCount(sub, key) {
  return sub.groups[key].chapters.reduce((a, c) => a + c.questions.length, 0);
}
/* 解析惰性填充：explain 是独立分片，用到才填。
 * 分片现在是「富解析」对象（blocks），同时派生一份纯文本进 q.explanation —— 
 * AI 上下文、复制、旧逻辑判断都还在读纯文本，不能只留结构。 */
let curDetailQid = null;    // 当前打开的详情题 id，供富解析到达后定向回填
                            // （去重改由 sub._expPromise 承担，见 loadExplain；旧 _expLoad 已删）
function loadExplain(sub, only) {
  if (!sub.explainChapters || !sub.explainChapters.length) { sub.explainLoaded = true; return Promise.resolve(); }
  sub.explainLoaded = true;
  // A11 修复：预加载进行中用户打开某题会再进到这里（ensureExplain）——没有去重就会把整科章节
  // 再并发拉一遍。_expPromise 挂在 sub 实例上做单飞（in-flight dedup），学科切换互不干扰。
  if (sub._expPromise) return sub._expPromise;
  const v = MANIFEST.version || '0';
  const list = (only && only.length) ? only : sub.explainChapters;   // A13：重试时只拉失败章
  // 按章节并发拉取小分片，逐片合并进 sub.explain（单章失败不影响其他章）；比旧「单文件 6MB」更稳、可缓存
  const ps = list.map(c =>
    fetch(QF + c.file + '?v=' + v).then(r => r.ok ? r.json() : null).catch(() => null)
      .then(ex => { if (ex) Object.assign(sub.explain, ex); return !!ex; })
  );
  sub._expPromise = Promise.all(ps).then(oks => {
    /* A13（审计·解析失败恢复）：失败章登记 _expFailed，ensureExplain 按 15s 退避重试；
     * 旧版 explainLoaded 请求前置位 + 失败静默吞掉，失败章整场会话再也回不来。 */
    sub._expFailed = list.filter((c, i) => !oks[i]);
    sub._expPromise = null;   // 已落定，允许下一轮重试进入单飞
    refreshExpDom();
  }).catch(() => { sub._expPromise = null; });
  return sub._expPromise;
}
function ensureExplain(sub, q) {
  if (!q || q.exp) return;
  if (sub.explain && sub.explain[q.id]) {
    const e = sub.explain[q.id];
    q.exp = e; q.explanation = richToText(e); return;
  }
  // 富解析可能尚未拉到（进科预加载进行中/失败）→ 触发该科加载，拉到后回填当前题解析区
  if (sub.explainChapters && (!sub.explainLoaded || (sub._expFailed && sub._expFailed.length))) {
    if (sub._expFailed && sub._expFailed.length) {
      // A13：失败章重试按 15s 退避（与 english.js 失败重试节奏一致），防离线时每题渲染都打一轮
      if (Date.now() - (sub._expRetryAt || 0) > 15000) { sub._expRetryAt = Date.now(); loadExplain(sub, sub._expFailed); }
    } else loadExplain(sub);
  }
}
/* 富解析分片到达后，定向刷新当前正在查看的题目解析区（尽量不整页重绘） */
function refreshExpDom() {
  let q = null, inPlayer = false, inDetail = false;
  const modalOpen = $('#modal') && !$('#modal').classList.contains('hidden');
  if (P && $('#player') && !$('#player').classList.contains('hidden')) { q = P.pool[P.idx] && P.pool[P.idx].q; inPlayer = true; }   // A13（审计）：显隐判据与 setPlaying 对齐——.hidden 是 class 不是 DOM 属性
  else if (curDetailQid && modalOpen) { const x = qById(curDetailQid); q = x && x.q; inDetail = true; }
  if (!q) return;
  ensureExplain(SB[cur], q);
  if (!hasExplain(q)) return;
  const wrap = document.getElementById('expWrap');
  if (!wrap) { if (inPlayer) renderPlayer(); else if (inDetail) openQDetail(curDetailQid); return; }
  if (inDetail) { wrap.innerHTML = explainHtml(q); return; }
  const revealed = P.answers[q.id] && P.answers[q.id].revealed;
  wrap.innerHTML = (revealed || P.mode === 'exam')
    ? explainHtml(q)
    : `<details class="exp"><summary>提前看解析</summary>${explainInner(q)}</details>`;
}

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- AI 出题（仅 lql 账号可调用，服务端按 token 鉴权） ---------- */
const QUIZ_API = 'https://shuatiji-d9gm0j668e9396859.service.tcloudbase.com/quiz';
const AI_OWNER = 'lql';
function quizToken() { try { return localStorage.getItem('quiz_token') || ''; } catch (e) { return ''; } }
function aiQuizUser() { try { return (localStorage.getItem('quiz_user') || '').trim(); } catch (e) { return ''; } }
/* AI 出题 / 解析：按钮对所有「已登录用户」可见；实际调用仍由后端强制仅 lql 可用。
 * 这样模块在登录后稳定出现在每题 收藏/疑点/纠错 旁，不再因未登录 / 账号名不完全等于 lql 而消失。 */
function aiEnabled() { return !!quizToken(); }

/* 通用 AI 云函数调用：
 *  ① token 放进 body，不通过自定义 header 携带 → 避免某些移动端浏览器/微信内置浏览器
 *    拦截 `X-Quiz-Token` 或触发 CORS 预检失败。
 *  ② `Content-Type: text/plain` 而非 `application/json` → 不触发 CORS preflight，
 *    减少一次网络往返，在弱网/移动网下更稳。
 *  ③ 自带超时 + 一次重试，网络抖动时不至于直接报错。
 *  ④ 统一把 fetch 异常转成人话提示。
 */
async function fetchQuiz(action, payload, opts) {
  opts = opts || {};   // ⚠️ 调用方常省略第三参，取属性前必须兜底（0926d 实锤：undefined.timeout 抛 TypeError 被吞 → 弹窗永远转圈）
  const body = JSON.stringify(Object.assign({ token: quizToken() }, payload, { action }));
  const controller = new AbortController();
  const timeout = opts.timeout || 25000;
  const tid = setTimeout(() => controller.abort(), timeout);
  let lastErr = null;
  const attempts = opts.noRetry ? 1 : 2;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1200));
    try {
      const r = await fetch(QUIZ_API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body,
        signal: controller.signal,
      });
      const j = await r.json().catch(() => ({}));
      clearTimeout(tid);
      return { ok: r.ok && !!j.ok, status: r.status, data: j, msg: j.msg || j.error || '未知错误' };
    } catch (e) {
      lastErr = e;
      // 超时/取消不再重试
      if (e && (e.name === 'AbortError' || /abort|timed out/i.test(String(e)))) break;
    }
  }
  clearTimeout(tid);
  return { ok: false, network: true, error: lastErr, msg: diagnoseFetchErr(lastErr) };
}
function diagnoseFetchErr(e) {
  const s = String(e);
  if (/Failed to fetch/i.test(s)) return '网络请求失败：当前网络可能无法连接到 AI 服务，请检查网络或切换 Wi-Fi/移动数据后重试';
  if (/AbortError|timed out|timeout/i.test(s)) return '请求超时：网络较慢，请检查网络后重试';
  if (/NetworkError|network/i.test(s)) return '网络错误：请检查网络连接';
  if (/CORS|cross-origin|blocked/i.test(s)) return '请求被浏览器拦截：可尝试更换浏览器（如 Chrome/Safari/Edge）';
  return '请求失败：' + s;
}

/* AI 加载态：旋转环 + 每 4 秒轮换的阶段性提示 + 计时。
 * AI 解析通常 5~15s（受所选模型通道影响），静态「正在解析…」会让人以为卡死了。
 * 计时器自清理：弹窗内容被结果替换后 #aiElapsed 消失 → 下一 tick 自动 clearInterval。 */
let aiLoadTimer = null;
function aiLoadingModal(title, hints) {
  if (aiLoadTimer) { clearInterval(aiLoadTimer); aiLoadTimer = null; }
  const hs = (Array.isArray(hints) && hints.length) ? hints : ['正在处理…'];
  openModal(`<h3>${title}</h3>
    <div class="ai-load">
      <div class="ai-spin" aria-hidden="true"></div>
      <div class="ai-hint" id="aiHint">${esc(hs[0])}</div>
      <div class="ai-elapsed" id="aiElapsed">已用 0 秒 · 通常需要 5~15 秒</div>
    </div>`);
  const t0 = Date.now();
  let step = 0;
  aiLoadTimer = setInterval(() => {
    const el = $('#aiElapsed'), h = $('#aiHint');
    if (!el || !h) { clearInterval(aiLoadTimer); aiLoadTimer = null; return; }
    const sec = Math.round((Date.now() - t0) / 1000);
    el.textContent = `已用 ${sec} 秒 · 通常需要 5~15 秒`;
    const want = Math.min(Math.floor(sec / 4) + 1, hs.length - 1);
    if (want !== step) { step = want; h.textContent = esc(hs[step]); }
  }, 1000);
}
const AI_EXPLAIN_HINTS = ['正在审读题干与选项…', '检索相关医学知识点…', '逐项核对每个选项…', '整理考点与常见陷阱…', '马上就好，正在组织语言…'];
const AI_GEN_HINTS = ['正在审读原题…', '设计变式出题角度…', '正在编写变式题…', '校验题目与答案…', '马上就好，正在收尾…'];
function uid() { return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function normAiQ(o) {
  const opts = o.options && typeof o.options === 'object' ? o.options : {};
  return {
    id: uid(), content: o.content || '', options: opts,
    correct: (o.correct || '').toString().toUpperCase(), multi: !!o.multi,
    explanation: o.explanation || '', images: [], difficulty: 2, type: o.multi ? 'X' : 'A1',
    tags: [], model: o.model || '', ai: true,
  };
}
function aiCardHtml(q, i) {
  return `<div class="card tight" style="margin-bottom:10px">
    <div class="row between"><span class="tag">第 ${i + 1} 题</span><span class="tag">${esc(q.model)}</span></div>
    <div class="qstem" style="font-size:1em;margin:8px 0">${esc(q.content)}</div>
    ${Object.keys(q.options).map(k => `<div class="opt" style="cursor:default"><div class="k">${k}</div><div class="v">${esc(q.options[k])}</div></div>`).join('')}
    <p class="muted small" style="margin:6px 0 0">答案与解析在点「开始练习」作答后揭晓。</p>
  </div>`;
}
async function doAiGen(q) {
  if (!aiEnabled()) { toast(ICON('lock') + ' AI 功能需先登录后使用'); return; }
  aiLoadingModal(`${ICON('robot')}AI 基于本题出题`, AI_GEN_HINTS);
  const j = await fetchQuiz('ai-gen', { subject: curSub().name, question: { content: q.content, options: q.options, correct: q.correct, multi: !!q.multi } });
  if (!j.ok) {
    openModal(`<h3>生成失败</h3><p class="muted">${esc(j.msg || '未知错误')}</p><button class="btn ghost" data-act="close-modal">关闭</button>`);
    return;
  }
  showAiResult(q, j.data.questions);
}
function doAiGenQid(qid) {
  if (!aiEnabled()) { toast(ICON('lock') + ' AI 功能需先登录后使用'); return; }
  const x = qById(qid); if (x) doAiGen(x.q);
}
function showAiResult(srcQ, raw) {
  const st = curState();
  st.aiGen = st.aiGen || [];
  const batch = { batchId: uid(), fromId: srcQ.id, fromContent: srcQ.content, fromExplanation: srcQ.explanation || '', subject: cur, questions: raw.map(normAiQ), createdAt: Date.now() };
  st.aiGen.unshift(batch);
  save(); if (window.QuizSync) window.QuizSync.forceFlush();
  const cards = batch.questions.map((q, i) => aiCardHtml(q, i)).join('');
  openModal(`<h3>${ICON('robot')}AI 出题 · 3 道变式</h3>
    <p class="muted small">已存入「AI 题库」存档，可随时复习。</p>
    ${cards}
    <button class="btn" data-act="ai-practice" data-bid="${batch.batchId}">开始练习这 3 题</button>
    <button class="btn soft sm" data-act="ai-gen-list">查看 AI 题库</button>
    <button class="btn ghost" data-act="close-modal">关闭</button>`);
}
function startAiPractice(bid) {
  const subs = curState();
  const batch = (subs.aiGen || []).find(b => b.batchId === bid);
  if (!batch) { toast('出题记录已失效'); return; }
  const pool = batch.questions.map(q => ({ q, chapterName: 'AI 出题', chapterId: 'aigen:' + bid }));
  requestStart(pool, 'practice', {}, 'aigen:' + bid);
}
function openAiGenList() {
  const list = curState().aiGen || [];
  if (!list.length) { openModal(`<h3>${ICON('robot')}AI 题库</h3><p class="muted">还没有生成记录。在题目中点「${ICON('robot')}AI出题」试试。</p><button class="btn ghost" data-act="close-modal">关闭</button>`); return; }
  const items = list.map(b => `<div class="qitem" data-act="ai-gen-open" data-bid="${b.batchId}">
    <div class="q">基于：${esc((b.fromContent || '').slice(0, 40))}…</div>
    <div class="meta"><span class="tag">${b.questions.length} 题</span><span class="tag">${new Date(b.createdAt).toLocaleDateString('zh-CN')}</span></div></div>`).join('');
  openModal(`<h3>${ICON('robot')}AI 题库</h3><div id="bkList">${items}</div><button class="btn ghost" data-act="close-modal">关闭</button>`);
}
function openAiGenBatch(bid) {
  const b = (curState().aiGen || []).find(x => x.batchId === bid);
  if (!b) { toast('记录已失效'); return; }
  const cards = b.questions.map((q, i) => aiCardHtml(q, i)).join('');
  openModal(`<h3>${ICON('robot')}AI 题库 · ${b.questions.length} 道</h3>
    <p class="muted small">基于：${esc(b.fromContent)}</p>
    ${cards}
    <button class="btn" data-act="ai-practice" data-bid="${b.batchId}">开始练习这 ${b.questions.length} 题</button>
    <button class="btn soft sm" data-act="ai-trace" data-bid="${b.batchId}">${ICON('search')}溯源（看原型题）</button>
    <button class="btn ghost" data-act="close-modal">关闭</button>`);
}

/* 当前学科全部 AI 生成的题（来自各批次） */
function aiQuestions() {
  const out = [];
  for (const b of (curState().aiGen || [])) for (const q of b.questions) out.push({ q, chapterName: 'AI 出题', chapterId: 'aigen:' + b.batchId });
  return out;
}
/* 溯源：显示原型题（基于哪道题生成） */
function aiTrace(bid) {
  const b = (curState().aiGen || []).find(x => x.batchId === bid);
  if (!b) { toast('原型题已失效'); return; }
  openModal(`<h3>${ICON('search')} · 原型题</h3>
    <p class="muted small">本批 AI 题由下面这道题衍生生成：</p>
    <div class="qstem">${esc(b.fromContent)}</div>
    ${b.fromExplanation ? `<div class="exp"><h4>原题解析</h4>${md(b.fromExplanation)}</div>` : '<p class="muted small">原题无附带解析</p>'}
    <button class="btn ghost" data-act="close-modal">关闭</button>`);
}
/* AI 再解析（仅 lql）：不给模型原答案/原解析，独立判定新答案，前端把新旧答案并列标注 */
function doAiExplain(q) {
  if (!aiEnabled()) { toast(ICON('lock') + ' AI 功能需先登录后使用'); return; }
  aiLoadingModal(`${ICON('brain')}AI 再解析`, AI_EXPLAIN_HINTS);
  fetchQuiz('ai-explain', { subject: curSub().name, question: { content: q.content, options: q.options, multi: !!q.multi } }).then(j => {
    if (!j.ok) { openModal(`<h3>解析失败</h3><p class="muted">${esc(j.msg || '未知错误')}</p><button class="btn ghost" data-act="close-modal">关闭</button>`); return; }
    /* fetchQuiz 返回包装结构 {ok,status,data,msg}，服务端负载在 data 里（0926e 实锤：直接读 j.result 会抛 TypeError） */
    const res = j.data && j.data.result;
    if (!res) { openModal(`<h3>解析失败</h3><p class="muted">服务端返回格式异常</p><button class="btn ghost" data-act="close-modal">关闭</button>`); return; }
    const st = curState(); st.aiExplain = st.aiExplain || {}; st.aiExplain[q.id] = { at: Date.now(), model: res.model, data: res }; save();
    showAiExplain(res, q.id);
  }).catch(e => openModal(`<h3>解析失败</h3><p class="muted">${esc(diagnoseFetchErr(e))}</p><button class="btn ghost" data-act="close-modal">关闭</button>`));
}
function doAiExplainQid(qid) {
  if (!aiEnabled()) { toast(ICON('lock') + ' AI 功能需先登录后使用'); return; }
  const x = qById(qid); if (x) doAiExplain(x.q);
}
function showAiExplain(res, qid) {
  const items = (res.items || []).map(it => `<div class="row between" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
    <span class="pill ${it.isCorrect ? 'pill-correct' : 'pill-wrong'}" style="flex:0 0 auto">${esc(it.option)}</span>
    <span class="small">${esc(it.why)}</span></div>`).join('');
  /* 新旧答案并列标注：AI 独立判定的 answer vs 题库原答案（不一致正是再解析的价值所在）。
     老缓存记录无 res.answer → 不显示判决条。 */
  const b = qById(qid);
  const orig = b ? (b.q.correct || '').toString().toUpperCase().replace(/[^A-Z]/g, '') : '';
  const ai = (res.answer || '').toString().toUpperCase().replace(/[^A-Z]/g, '');
  const norm = s => s.split('').sort().join('');
  let verdict = '';
  if (ai && orig && norm(ai) === norm(orig)) {
    verdict = `<div class="ai-verdict agree"><span class="pill pill-correct">AI 答案 ${esc(ai)}</span><span class="pill pill-correct">原答案 ${esc(orig)}</span><span class="muted small">独立判断与原答案一致</span></div>`;
  } else if (ai && orig) {
    verdict = `<div class="ai-verdict diff"><span class="pill pill-correct">AI 答案 <b>${esc(ai)}</b></span><span class="pill pill-wrong">原答案 ${esc(orig)}</span><span class="small">⚠️ AI 独立判断与题库答案不一致，请结合逐项分析自行甄别</span></div>`;
  } else if (ai) {
    verdict = `<div class="ai-verdict"><span class="pill pill-correct">AI 答案 <b>${esc(ai)}</b></span></div>`;
  }
  openModal(`<h3>${ICON('brain')} <span class="tag">${esc(res.model || '')}</span></h3>
    ${verdict}
    <div class="exp"><h4>考点</h4><p>${esc(res.summary || '')}</p>${res.keyPoint ? `<p class="muted small">${esc(res.keyPoint)}</p>` : ''}</div>
    <div class="exp"><h4>逐项分析</h4>${items}</div>
    ${res.commonTrap ? `<div class="exp"><h4>常见陷阱</h4><p class="muted small">${esc(res.commonTrap)}</p></div>` : ''}
    <button class="btn ghost" data-act="close-modal">关闭</button>`);
}

/* ---------- 状态 ---------- */
const LS_KEY = 'quiz_v1';
/* 偏好设置默认值。新增项一律给默认值：老备份 / 云同步数据导入后自动补齐，不会因为缺字段炸掉 */
const DEFAULT_SETTINGS = {
  dark: false, font: 'm', examDate: null, dailyGoal: 50, bg: 'classic',
  autoSubmit: false, autoNext: false, swipe: true, optShuffle: false, showMeta: true, plain: false,
};
function defaultState() {
  return { global: { xp: 0, badges: [], badgeTimes: {}, checkin: [], lastBackup: null, settings: Object.assign({}, DEFAULT_SETTINGS) }, subjects: {}, sessions: {} };
}
let S = load();
/* 补齐 + 迁移：本地启动时走 load()，导入备份时也走这里，
 * 保证老备份 / 云同步数据导入后字段齐全、掌握度不被清零（B06 修复点）。 */
function normalizeState(s) {
  if (!s || !s.global) return defaultState();
  if (!s.global.settings) s.global.settings = {};
  s.global.settings = Object.assign({}, DEFAULT_SETTINGS, s.global.settings);
  if (s.global.lastBackup === undefined) s.global.lastBackup = null;
  if (!s.sessions) s.sessions = {};
  // 存量数据补齐：① 错题清零徽章需「曾有过错题且已清空」，按当前错题数推断 hadWrong
  // ② 二期新字段（qstat / feedback）——老数据没有，这里一次性建好并推算作答统计
  if (s.subjects) for (const id in s.subjects) {
    const st = s.subjects[id]; if (!st) continue;
    if (st.hadWrong === undefined) st.hadWrong = !!(st.wrong && st.wrong.length);
    if (!st.feedback) st.feedback = [];
    if (!st.qstat) {
      st.qstat = {};
      for (const qid of (st.mastered || [])) st.qstat[qid] = { n: 2, r: 2, w: 0, last: Date.now(), lastWrong: false, seeded: true };
      for (const qid of (st.wrong || [])) st.qstat[qid] = { n: 2, r: 0, w: 2, last: Date.now(), lastWrong: true, seeded: true };
    }
  }
  // 迁移旧版单会话（quiz_v1 早期只存一个 S.session）到按章节的 sessions 映射
  if (s.session) {
    const o = s.session; let key;
    if (o.mode === 'exam') key = 'e:' + o.subject;
    else if (o.mode === 'practice' && o.key && o.key.indexOf('chapter:') === 0) key = 'c:' + o.subject + ':' + o.key.slice(8);
    else if (o.key === 'random') key = 'r:' + o.subject;
    else key = 'legacy:' + (o.key || 'x');
    o.key = key; o.updatedAt = Date.now();
    s.sessions[key] = o; delete s.session;
  }
  return s;
}
function load() {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY)); return normalizeState(s); }
  catch (e) { return defaultState(); }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); }
  catch (e) {
    // 存储配额满：原来静默吞掉 → 最新作答看似成功实则没存。改为提示一次，引导去清空进度
    const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
    if (quota && !window.__quotaWarned) {
      window.__quotaWarned = true;
      toast(ICON('warn') + ' 浏览器本地存储空间已满，最新作答可能未保存。请在「我的」→「清空学习进度」释放空间。');
    }
  }
}
/* 图片加载失败：用占位块替换，而不是静默消失（B09） */
function imgFail(el) {
  if (!el || el.dataset.failed) return;
  el.dataset.failed = '1';
  const ph = document.createElement('div');
  ph.className = 'qimg-ph';
  ph.innerHTML = ICON('img') + '图片加载失败（源站未同步或网络受限）';
  if (el.parentNode) el.parentNode.replaceChild(ph, el);
}
function subState(id) {
  if (!S.subjects[id]) S.subjects[id] = {
    wrong: [], fav: [], doubt: [], mastered: [], byChapter: {}, daily: {}, examHistory: [],
    review: {}, hadWrong: false,
    qstat: {},       // 每题作答统计：{n 作答次数, r 答对, w 答错, last 时间戳, lastWrong}
    feedback: [],    // 答案纠错反馈
  };
  const st = S.subjects[id];
  if (!st.qstat) st.qstat = {};
  if (!st.feedback) st.feedback = [];
  return st;
}
function curSub() { return SB[cur]; }
function curState() { return subState(cur); }
let cur = 'bio';
let activeTab = 'home';

/* ---------- 工具 ---------- */
function today() { return ymd(new Date()); }
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function inSet(a, id) { return a.indexOf(id) >= 0; }
function addSet(a, id) { if (!inSet(a, id)) a.push(id); }
function remSet(a, id) { const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); }
/* ---------- A11 tombstone（审计 P1-5）：集合删除语义 ----------
 * wrong/fav/doubt/mastered 是纯数组，跨设备并集合并「只增不减」——A 端取消收藏会被 B 端旧记录复活。
 * tomb = st.tomb[f][id] = { d: 1|0, t: 时间戳 }：每个 id 的「最后动作」（1=删除 0=加入），
 * 同步时逐 id LWW（t 大者赢）→ 删除能赢过另一端旧存在，重新加入能赢过旧删除。
 * 增删一律走 markAdd/markRem（写动作日志），封顶 200/字段防膨胀。清空进度同记删除。 */
function tombMark(st, f, id, deleted) {
  const t = st.tomb || (st.tomb = {});
  const m = t[f] || (t[f] = {});
  m[id] = { d: deleted, t: Date.now() };
  const keys = Object.keys(m);
  if (keys.length > 200) keys.sort((a, b) => m[a].t - m[b].t).slice(0, keys.length - 200).forEach(k => delete m[k]);
}
function markAdd(st, f, id) { addSet(st[f], id); tombMark(st, f, id, 0); }
function markRem(st, f, id) { remSet(st[f], id); tombMark(st, f, id, 1); }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }
function sameSet(chosen, correct) {
  const a = chosen.map(x => String(x).toUpperCase()).sort().join('');
  const b = String(correct).toUpperCase().split('').filter(c => /[A-Z]/.test(c)).sort().join('');
  return a === b;
}
function allQuestions(sub) {
  const out = [];
  for (const c of sub.chapters) for (const q of c.questions) out.push({ q, chapterName: c.name, chapterId: c.id });
  return out;
}
/* 全科（极光 + 扩展）—— 乱序/考试模式可跨组组卷 */
function allQuestionsBoth(sub) {
  const out = [];
  for (const g of ['jg', 'ext']) for (const c of sub.groups[g].chapters) for (const q of c.questions) out.push({ q, chapterName: c.name, chapterId: c.id, grp: g });
  return out;
}
/* 检索题：必须同时搜极光与扩展两组，否则错题/收藏里的跨组题会「查无此题」；
   旧进度里存的是别名 id 时，先用 ALIAS 换回主 id 再查。 */
function qById(id) {
  const real = ALIAS[id] || id;
  if (ORPHANS[real]) return { q: ORPHANS[real], chapterName: ORPHANS[real].chapterId || '未分类', chapterId: ORPHANS[real].chapterId || 'x未分类', grp: 'orphan' };
  const sub = curSub();
  for (const g of ['jg', 'ext']) for (const c of sub.groups[g].chapters) {
    const f = c.questions.find(x => x.id === real);
    if (f) return { q: f, chapterName: c.name, chapterId: c.id, grp: g };
  }
  /* AI 变式题不在静态题库里，只存在本机 aiGen 批次 —— 用户可能对它们打过错题/收藏标记，
   * 若不在这里兜住，错题本/收藏会静默丢弃这些条目（buildPoolFromSession 早有同样兜底）。 */
  for (const b of (curState().aiGen || [])) {
    const qq = (b.questions || []).find(x => x && x.id === real);
    if (qq) return { q: qq, chapterName: 'AI 出题', chapterId: 'aigen:' + b.batchId, grp: 'ai' };
  }
  return null;
}
function level() { return Math.floor(S.global.xp / 200) + 1; }
function addXp(n) { S.global.xp += n; }
function cssVar(n) { return getComputedStyle(document.body).getPropertyValue(n).trim() || '#888'; }
function toast(msg) { const t = $('#toast'); t.innerHTML = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 1800); }
/* C-1：徽章墙以外的图标统一换回 emoji（实测线性 SVG 小尺寸不如 emoji 直观，
 * 且 iOS/Android/Win 渲染一致）。ICON(name) 返回 emoji + 尾随空格（替代原 SVG 的 margin-right）。
 * 成就徽章保留彩色 SVG（见 BADGE_SVG）。 */
function ICON(name) {
  const E = {
    cal:'📅', target:'🎯', book:'📚', abc:'🔤', pin:'📍', grad:'🎓', fire:'🔥', star:'⭐',
    cross:'❌', question:'❓', check:'✅', new:'🆕', repeat:'🔁', planet:'🪐', book2:'📖',
    leaf:'🍃', search:'🔍', chart:'📊', trash:'🗑️', brain:'🧠', lock:'🔒', bell:'🔔', img:'🖼️',
    art:'🎨', moon:'🌙', type:'🔠', gear:'⚙️', warn:'⚠️', trophy:'🏆', dotr:'🔴', doty:'🟡',
    bolt:'⚡', next:'➡️', swipe:'👆', shuffle:'🔀', puzzle:'🧩', key:'🔑', scale:'⚖️',
    download:'⬇️', upload:'⬆️', clock:'⏱️', doc:'📄', bulb:'💡', cloud:'☁️', flag:'🚩',
    robot:'🤖', party:'🎉', speaker:'🔊', pencil:'✏️', spring:'♨️'
  };
  return (E[name] || '⭐') + ' ';
}
/* 成就徽章：彩色 SVG（圆形底色 + 描边图标），比 emoji 更统一精致。BADGES.em 调用。 */
function BADGE_SVG(name) {
  const M = {
    leaf:   { c:'#2e9e5b', bg:'#e7f6ee', p:'<path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14z"/><path d="M5 19C9 15 13 12 18 10" fill="none" stroke-width="1.4"/>' },
    star:   { c:'#e0a400', bg:'#fff6da', p:'<path d="M12 3l2.6 5.6L20 9.2l-4.4 4 1.2 6L12 16.8 7.2 19.2l1.2-6L4 9.2l5.4-.6z"/>' },
    target: { c:'#2b7cd3', bg:'#e6f0fb', p:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.6" fill="#2b7cd3" stroke="none"/>' },
    trophy: { c:'#d99a00', bg:'#fff3d6', p:'<path d="M7 4h10v4a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M9 14h6l1 6H8z"/>' },
    fire:   { c:'#e8531a', bg:'#fde9df', p:'<path d="M12 3c1 3-1.5 4-1.5 6.5A2.5 2.5 0 0 0 13 12c.5-1 .3-2 1-2.8C16 11 17 13 17 15a5 5 0 1 1-10 0c0-3.5 3-5.5 5-12z"/>' },
    book2:  { c:'#3a7bd5', bg:'#e8f0fd', p:'<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5v15"/>' },
    grad:   { c:'#7b54c9', bg:'#efe9fb', p:'<path d="M22 9.5 12 4 2 9.5 12 15z"/><path d="M6 12v4c0 1.5 2.7 3 6 3s6-1.5 6-3v-4"/>' },
    book:   { c:'#1aa0a0', bg:'#e2f6f6', p:'<path d="M12 6c-1.7-1.2-4.2-1.4-6-.5v11c1.8-.9 4.3-.7 6 .5 1.7-1.2 4.2-1.4 6-.5V5.5c-1.8-.9-4.3-.7-6 .5z"/><path d="M12 6v11"/>' },
    trash:  { c:'#c0473b', bg:'#fbe6e3', p:'<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>' }
  };
  const m = M[name] || M.star;
  return `<svg class="badge-ic" viewBox="0 0 24 24" width="1.6em" height="1.6em" fill="none" stroke="${m.c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="11" fill="${m.bg}" stroke="none"/>${m.p}</svg>`;
}
/* 轻量 markdown：标题 / 粗体 / 列表 / 表格。
 * 解析顺序：先扫行抽取 markdown 表格（| 表头 | + | --- | 分隔 + 表体），
 * 不在普通文本里跑表格正则（避免误伤）。易错点（pf）常以 p 型块内嵌 markdown 表格，
 * 旧版 md() 不认表格 → 渲染成裸竖线文本；这里补上 .exp-tbl 渲染，与 tb 型块同款外观。 */
function isMdTableRow(l) { return /^\s*\|.*\|\s*$/.test(l) && l.trim().split('|').length >= 3; }
function isMdTableSep(l) {
  const t = l.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!t.length) return false;
  return t.split('|').every(c => /^[\s:|-]*$/.test(c) && c.indexOf('-') >= 0);
}
function splitMdRow(l) { return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim()); }
function mdTableHtml(cols, rows) {
  const th = '<thead><tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr></thead>';
  const tb = '<tbody>' + rows.map(r =>
    '<tr>' + r.map((c, i) => '<td data-label="' + (cols[i] || '') + '">' + c + '</td>').join('') + '</tr>'
  ).join('') + '</tbody>';
  return '<div class="exp-tblwrap"><table class="exp-tbl">' + th + tb + '</table></div>';
}
function md(s) {
  if (!s) return '';
  s = esc(s);
  const lines = s.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMdTableRow(lines[i]) && i + 1 < lines.length && isMdTableSep(lines[i + 1])) {
      const cols = splitMdRow(lines[i]); i += 2;
      const rows = [];
      while (i < lines.length && isMdTableRow(lines[i])) { rows.push(splitMdRow(lines[i])); i++; }
      out.push(mdTableHtml(cols, rows));
      continue;
    }
    out.push(lines[i]);
  }
  s = out.join('\n');
  s = s.replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/^## (.*)$/gm, '<h4>$1</h4>').replace(/^# (.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/^- (.*)$/gm, '<div>• $1</div>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

/* ================= 解析渲染（富结构） =================
 * 分片格式 explain/<学期>/<sid>.json = {题目id: 富解析}
 *   富解析 = { bf?: 一句话解析, b?: 块数组, t?: 纯文本回退 }
 *   块     = [type, sec, title, …payload]
 *            p  段落  payload: text
 *            c  提示  payload: text, tone
 *            l  列表  payload: [item]
 *            tb 表格  payload: [列名], [[单元格]]
 * 旧版纯文本（字符串）仍兼容。见 manifest.explainHelp。
 * 设计：每小节一张卡（段头竖线），易错点走表格 + 760px 以下转卡片（td::before 读 data-label）。 */
const SEC_CN = { an: '考点解析', ab: '答案依据', pf: '易错点', cn: '临床与操作要点', tx: '教材出处', mn: '记忆口诀', rs: '推理路径', op: '逐项辨析' };
const FREQ_CN = { high: '高频', medium: '中频', low: '低频' };
/* 题型全称：A1/A2/A3/X/F 这些代号对考生并不自明，展开写 */
const TYPE_FULL = {
  A1: 'A1 型题 · 单句最佳选择', A2: 'A2 型题 · 病例摘要最佳选择', A3: 'A3 型题 · 病例组题',
  多选: 'X 型题 · 多项选择', 判断: '判断题', 填空: '填空题'
};
/* 富解析 → 纯文本（AI 上下文 / 复制 / 旧逻辑判断共用） */
function richToText(e) {
  if (typeof e === 'string') return e;
  if (!e) return '';
  if (e.t) return e.t;
  const out = [];
  if (e.bf) out.push(e.bf);
  for (const b of (e.b || [])) {
    const [ty, , title] = b;
    if (title) out.push('### ' + title);
    if (ty === 'tb') {
      out.push((b[3] || []).join(' | '));
      for (const r of (b[4] || [])) out.push(r.join(' | '));
    } else if (ty === 'l') out.push((b[3] || []).map(x => '- ' + x).join('\n'));
    else out.push(String(b[3] || '').replace(/^[-*]\s+/, ''));
  }
  return out.filter(Boolean).join('\n\n');
}
function explSecHead(sec, title) {
  return `<div class="exp-h"><span class="exp-bar"></span>${esc(title || SEC_CN[sec] || '解析')}</div>`;
}
function expBlockHtml(b) {
  const ty = b[0], sec = b[1];
  if (ty === 'tb') {
    const cols = b[3] || [], rows = b[4] || [];
    if (!cols.length) return '';
    return `<section class="exp-sec" data-sec="${sec}">${explSecHead(sec, b[2])}
      <div class="exp-tblwrap"><table class="exp-tbl"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td data-label="${esc(cols[i] || '')}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
  }
  if (ty === 'l') {
    const items = b[3] || []; if (!items.length) return '';
    return `<section class="exp-sec" data-sec="${sec}">${explSecHead(sec, b[2])}<ul class="exp-list">${items.map(x => `<li>${md(x)}</li>`).join('')}</ul></section>`;
  }
  if (ty === 'c') {
    const t = b[3] || ''; if (!t) return '';
    return `<section class="exp-sec" data-sec="${sec}">${explSecHead(sec, b[2])}<div class="exp-callout">${md(t)}</div></section>`;
  }
  const t = String(b[3] || '').replace(/^[-*]\s+/, ''); if (!t) return '';
  return `<section class="exp-sec" data-sec="${sec}">${explSecHead(sec, b[2])}<div class="exp-p">${md(t)}</div></section>`;
}
/* 预留字段渲染层（C 档）：数据当前多为空，「有值才显示」，接口填上即生效，前端无需再改。
 * 字段清单与预期结构见 题库调研/schema_unified.json → reservedFields */
function reservedBlocksHtml(q) {
  let h = '';
  const kps = [].concat(q.knowledgePoints || [], q.knowledgePoint ? [q.knowledgePoint] : []);
  if (kps.length) h += `<div class="exp-chips">${[...new Set(kps)].map(t => `<span class="kchip">${esc(t)}</span>`).join('')}</div>`;
  if (q.mnemonic) h += `<section class="exp-sec" data-sec="mn">${explSecHead('mn', '记忆口诀')}<div class="exp-memo">${esc(q.mnemonic)}</div></section>`;
  if (Array.isArray(q.studyPoints) && q.studyPoints.length) {
    h += `<details class="exp-fold"><summary>考点要点 · ${q.studyPoints.length} 条</summary>${q.studyPoints.map(p => `<div class="exp-sp"><b>${esc(p.title || '')}</b><div>${md(p.body || p.text || '')}</div></div>`).join('')}</details>`;
  }
  if (Array.isArray(q.reasoningSteps) && q.reasoningSteps.length) {
    h += `<section class="exp-sec" data-sec="rs">${explSecHead('rs', '推理路径')}<ol class="exp-steps">${q.reasoningSteps.map(s => `<li><span class="ev">${esc(s.evidence || '题干信息')}</span><span class="ar">→</span><span class="inf">${esc(s.inference || '')}</span></li>`).join('')}</ol></section>`;
  }
  if (Array.isArray(q.optionExplanations) && q.optionExplanations.length) {
    h += `<section class="exp-sec" data-sec="op">${explSecHead('op', '逐项辨析')}${q.optionExplanations.map(o => `<div class="exp-opt"><span class="k">${esc(o.option || o.key || '')}</span><div><div>${md(o.explanation || o.text || '')}</div>${o.typicalScenario ? `<div class="muted small">典型场景：${esc(o.typicalScenario)}</div>` : ''}</div></div>`).join('')}</section>`;
  }
  if (Array.isArray(q.memoryCards) && q.memoryCards.length) {
    h += `<details class="exp-fold"><summary>知识点背诵 · ${q.memoryCards.length} 张</summary>${q.memoryCards.map(c => `<div class="exp-mc"><div class="exp-mc-t">${esc(c.title || '')}</div><div>${md(c.content || '')}</div>${c.memoryCue ? `<div class="exp-mc-cue">${ICON('key')}${esc(c.memoryCue)}</div>` : ''}${c.contrast ? `<div class="exp-mc-ct">${ICON('scale')}对比：${esc(c.contrast)}</div>` : ''}</div>`).join('')}</details>`;
  }
  const meta = q.explanationMeta;
  if (meta && typeof meta === 'object') {
    const ev = Array.isArray(meta.evidence) ? meta.evidence : [];
    const books = Array.isArray(meta.textbooks) ? meta.textbooks : [];
    if (ev.length || books.length || meta.evidenceGrade) {
      h += `<section class="exp-sec" data-sec="tx">${explSecHead('tx', '教材依据')}${meta.evidenceGrade ? `<div class="exp-grade g-${esc(meta.evidenceGrade)}">证据等级 ${esc(meta.evidenceGrade)}</div>` : ''}${books.map(b => `<div class="exp-p">${esc(typeof b === 'string' ? b : (b.title || b.name || ''))}</div>`).join('')}${ev.map(x => `<div class="exp-ev">${esc(x.quote || x.text || '')}${x.source ? `<span class="muted small"> —— ${esc(x.source)}</span>` : ''}</div>`).join('')}</section>`;
    }
  }
  return h;
}
/* 解析区内容（不含外层容器，便于塞进 <details>） */
function explainInner(q) {
  const e = q.exp;
  if (!e) return q.explanation ? `<div class="exp-p">${md(q.explanation)}</div>${reservedBlocksHtml(q)}` : '';
  if (typeof e === 'string') return `<div class="exp-p">${md(e)}</div>${reservedBlocksHtml(q)}`;
  let h = '';
  if (e.bf) h += `<div class="exp-brief"><span class="bk">一句话解析</span>${esc(e.bf)}</div>`;
  if (Array.isArray(e.b)) h += e.b.map(expBlockHtml).join('');
  else if (e.t) h += `<div class="exp-p">${md(e.t)}</div>`;
  return h + reservedBlocksHtml(q);
}
function explainHtml(q) { const s = explainInner(q); return s ? `<div class="exp">${s}</div>` : ''; }
function hasExplain(q) { return !!(q.exp || q.explanation); }
/* 题干下方的元信息 chip 行：真题徽标 / 来源 / 考频 / 知识点标签 */
function qChipsHtml(q) {
  const bits = [];
  if (q.year) bits.push(`<span class="meta-pill y">${ICON('grad')} ${esc(q.year)} 年真题</span>`);
  if (q.qsource) bits.push(`<span class="meta-pill s">${esc(q.qsource)}</span>`);
  if (q.frequencyLevel) bits.push(`<span class="meta-pill f">考频 ${esc(FREQ_CN[q.frequencyLevel] || q.frequencyLevel)}</span>`);
  const tg = [...new Set([].concat(q.tags || []))];
  for (const t of tg) bits.push(`<span class="kchip">${esc(t)}</span>`);
  return bits.length ? `<div class="qchips">${bits.join('')}</div>` : '';
}

/* ---------- 成就 / 徽章 ---------- */
/* ---------- 艾宾浩斯间隔回顾 ---------- */
const REVIEW_INTERVALS = [1, 3, 7, 15, 30]; // 天 · stage 0→1→2→3→4，毕业（stage 5）移除

/* ---------- 成就 / 徽章 ---------- */
const BADGES = [
  { id: 'first', em: BADGE_SVG('leaf'), nm: '初次作答', ds: '完成第 1 题' },
  { id: 'h100', em: BADGE_SVG('star'), nm: '百题斩', ds: '累计作答 100 题' },
  { id: 'h500', em: BADGE_SVG('target'), nm: '五百勇士', ds: '累计作答 500 题' },
  { id: 'h1000', em: BADGE_SVG('trophy'), nm: '千题宗师', ds: '累计作答 1000 题' },
  { id: 'h2000', em: BADGE_SVG('star'), nm: '两千题', ds: '累计作答 2000 题' },
  { id: 'h5000', em: BADGE_SVG('star'), nm: '五千题', ds: '累计作答 5000 题' },
  { id: 's7', em: BADGE_SVG('fire'), nm: '七日打卡', ds: '连续打卡 7 天' },
  { id: 's30', em: BADGE_SVG('trophy'), nm: '月度坚持', ds: '连续打卡 30 天' },
  { id: 's100', em: BADGE_SVG('fire'), nm: '百日坚持', ds: '连续打卡 100 天' },
  { id: 'exam80', em: BADGE_SVG('book2'), nm: '优良', ds: '考试得分 ≥ 80%' },
  { id: 'exam90', em: BADGE_SVG('grad'), nm: '学霸附体', ds: '考试得分 ≥ 90%' },
  { id: 'exam100', em: BADGE_SVG('star'), nm: '满分', ds: '考试得分 100%' },
  { id: 'm50', em: BADGE_SVG('star'), nm: '融会贯通', ds: '掌握 50 题' },
  { id: 'm100', em: BADGE_SVG('trophy'), nm: '百题掌握', ds: '掌握 100 题' },
  { id: 'nm', em: BADGE_SVG('leaf'), nm: '单词入门', ds: '英语掌握 50 词' },
  { id: 'ne', em: BADGE_SVG('book'), nm: '单词达人', ds: '英语掌握 200 词' },
  { id: 'clear', em: BADGE_SVG('trash'), nm: '错题清零', ds: '当前学科错题清空' },
];
function totalAnswered() { let n = 0; for (const id in S.subjects) { const st = S.subjects[id]; for (const d in st.daily) n += st.daily[d].answered; } return n; }
function streak() {
  const set = new Set(S.global.checkin); if (!set.size) return 0;
  let cur = new Date();
  if (!set.has(ymd(cur))) { cur.setDate(cur.getDate() - 1); if (!set.has(ymd(cur))) return 0; }
  let s = 0; while (set.has(ymd(cur))) { s++; cur.setDate(cur.getDate() - 1); } return s;
}
function addBadge(id) { if (!inSet(S.global.badges, id)) { S.global.badges.push(id); if (!S.global.badgeTimes) S.global.badgeTimes = {}; S.global.badgeTimes[id] = Date.now(); const b = BADGES.find(x => x.id === id); if (b) toast(ICON('party') + ' 解锁徽章：' + b.nm); } }
function checkBadges() {
  const g = S.global, got = new Set(g.badges), ta = totalAnswered();
  if (!g.badgeTimes) g.badgeTimes = {};
  const mark = id => { if (!got.has(id)) { got.add(id); g.badgeTimes[id] = Date.now(); const b = BADGES.find(x => x.id === id); if (b) toast(ICON('party') + ' 解锁徽章：' + b.nm); } };
  if (ta >= 1) mark('first');
  if (ta >= 100) mark('h100');
  if (ta >= 500) mark('h500');
  if (ta >= 1000) mark('h1000');
  if (ta >= 2000) mark('h2000');
  if (ta >= 5000) mark('h5000');
  if (streak() >= 7) mark('s7');
  if (streak() >= 30) mark('s30');
  if (streak() >= 100) mark('s100');
  const eh = curState().examHistory || [];
  const maxScore = eh.reduce((m, e) => Math.max(m, e.score || 0), 0);
  if (maxScore >= 80) mark('exam80');
  if (maxScore >= 90) mark('exam90');
  if (maxScore >= 100) mark('exam100');
  if (curState().mastered.length >= 50) mark('m50');
  if (curState().mastered.length >= 100) mark('m100');
  const engM = (window.Eng && Eng.engMasteredSync) ? Eng.engMasteredSync() : 0;
  if (engM >= 50) mark('nm');
  if (engM >= 200) mark('ne');
  // 「错题清零」须：本学科曾经有过错题（hadWrong）且当前错题已清空，避免第一题答对就误发
  if (curState().hadWrong && curState().wrong.length === 0) mark('clear');
  g.badges = Array.from(got);
}

/* ---------- 作答记录 ---------- */
function recordAnswer(q, chapterId, correct) {
  const st = curState();
  const bc = st.byChapter[chapterId] || { total: 0, correct: 0 }; bc.total++; if (correct) bc.correct++; st.byChapter[chapterId] = bc;
  // 每题作答统计（四级掌握状态的数据底座）
  const qs = st.qstat[q.id] || (st.qstat[q.id] = { n: 0, r: 0, w: 0, last: 0, lastWrong: false });
  qs.n++; if (correct) qs.r++; else qs.w++;
  qs.last = Date.now(); qs.lastWrong = !correct;
  const d = today(), dy = st.daily[d] || { answered: 0, correct: 0 }; dy.answered++; if (correct) dy.correct++; st.daily[d] = dy;
  if (correct) { markRem(st, 'wrong', q.id); markAdd(st, 'mastered', q.id); } else { markAdd(st, 'wrong', q.id); markRem(st, 'mastered', q.id); st.hadWrong = true; }
  addXp(correct ? 15 : 5);
  checkBadges(); save();
}

/* ---------- 导航 ---------- */
function show(tab) {
  activeTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const v = $('#view');
  if (tab === 'home') v.innerHTML = renderHome();
  else if (tab === 'bank') v.innerHTML = renderBank();
  else if (tab === 'wrong') v.innerHTML = renderWrong();
  else if (tab === 'honor') v.innerHTML = renderHonor();
  else if (tab === 'me') v.innerHTML = renderMe();
  /* 医学英语走异步：先占位，数据到位后回填（分片 fetch 不能卡住首屏切换） */
  else if (tab === 'english') {
    v.innerHTML = '<div class="card"><h3>' + ICON('abc') + ' 医学英语词库</h3><p class="muted small">加载中…</p></div>';
    if (window.Eng) {
      Eng.loadMan().then(async () => {
        if (activeTab !== 'english') return;          // 用户已切走，别覆盖
        v.innerHTML = await Eng.view(); Eng.bind();
      });
    }
  }
  if (tab === 'bank') bindBank();
  if (tab === 'honor') bindHonor();
  if (tab === 'wrong') bindWrong();
  if (tab === 'me') bindMe();
  /* 词库是跨科室内容域，与「刷题三科」不是同一套学科 → 此时学科下拉无意义，隐藏 */
  const ss = $('#subjectSelect');
  if (ss) ss.style.display = (tab === 'english') ? 'none' : '';
  if (tab !== 'english') v.classList.remove('eng-card-mode');   // A06：离开单词页，撤掉卡片居中布局
  updateGroupToggle();
  const gt = document.getElementById('grpToggle');
  if (gt) gt.style.display = (tab === 'english') ? 'none' : '';
  updateTabDot();
  updateBackupBanner();
  v.scrollTop = 0;
}

/* A11：跨模块启动英语复习 / 定位（先挂载英语视图，再借道 Eng API；不重写刷题播放器） */
async function ensureEnglishMounted() {
  if (activeTab !== 'english') {
    show('english');
    for (let i = 0; i < 60; i++) { if (document.getElementById('engModeCard')) break; await new Promise(r => setTimeout(r, 50)); }
  }
}
async function launchEngReview() {
  closeModal();
  if (!window.Eng) return;
  await ensureEnglishMounted();
  await Eng.launchReview();
}
async function launchEngFamiliar(s) {
  closeModal();
  if (!window.Eng) return;
  await ensureEnglishMounted();
  await Eng.showFamiliar(s);
}
async function launchEngImmersive(wordId) {
  closeModal();
  if (!window.Eng) return;
  await ensureEnglishMounted();
  await Eng.launchImmersive(wordId);
}

function examCountdownHtml() {
  const d = S.global.settings.examDate;
  if (!d) return `<div class="row between"><h3 style="margin:0">${ICON('cal')}考试倒计时</h3></div><p class="muted small" style="margin:10px 0 0">去「设置」设置考试日期，开启倒计时。</p>`;
  const target = new Date(d + 'T00:00:00');
  const days = Math.ceil((target - new Date()) / 86400000);
  if (days < 0) return `<div class="row between"><h3 style="margin:0">${ICON('cal')}考试倒计时</h3></div><div class="cd-num">${ICON('grad', '1.1em')}</div><p class="muted small" style="margin:6px 0 0">考试已结束，继续加油！</p>`;
  return `<div class="row between"><h3 style="margin:0">${ICON('cal')}考试倒计时</h3></div><div class="cd-num">${days}<span>天</span></div><p class="muted small" style="margin:6px 0 0">目标日 ${d}</p>`;
}
function dailyRingHtml() {
  const goal = S.global.settings.dailyGoal || 0;
  const todayA = (curState().daily[today()] || {}).answered || 0;
  const pct = goal ? Math.min(100, Math.round(todayA / goal * 100)) : 0;
  const r = 22, c = 2 * Math.PI * r;
  return `<div class="row between"><h3 style="margin:0">${ICON('target')}今日目标</h3><span class="muted small">${goal ? goal + ' 题' : '未设'}</span></div>
    <div class="ring"><svg width="72" height="72" viewBox="0 0 72 72">
      <circle cx="36" cy="36" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="8"></circle>
      <circle cx="36" cy="36" r="${r}" fill="none" stroke="var(--primary)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 36 36)"></circle>
    </svg><div class="ring-c"><b>${todayA}</b><span>/ ${goal || '–'}</span></div></div>
    <p class="muted small" style="margin:8px 0 0">今日完成度 ${pct}%</p>`;
}
function renderCheckinSlot(sk, checked) {
  if (!checked) return `<button class="btn soft sm checkin-btn" data-act="checkin">打卡</button>`;
  return `<button class="btn ghost sm checkin-btn" data-act="checkin-info">${ICON('fire')}连续打卡 ${sk} 天</button>`;
}
function renderHome() {
  const st = curState(), sub = curSub();
  const saved = latestSession();
  const subjName = saved && SB[saved.subject] ? SB[saved.subject].name : '';
  const cont = saved ? `<div class="card cont-card" data-act="resume-home" style="cursor:pointer">
    <div class="row between"><div><b>${ICON('pin')}继续刷题</b><div class="muted small">${esc(subjName)} · ${sessionLabel(saved)} · 第 ${saved.idx + 1}/${saved.qids.length} 题</div></div>
    <button class="btn sm">继续 →</button></div></div>` : '';
  const totalQ = sub.meta ? sub.meta.count : 0;
  const lv = level(), xpIn = S.global.xp % 200, todayA = (st.daily[today()] || {}).answered || 0, sk = streak();
  const checked = S.global.checkin.includes(today());
  return `
  <div class="hero">
    <div class="hero-top">
      <span class="lv hero-lv">Lv.${lv} · ${esc(sub.semester || '')} ${esc(sub.name)}</span>
      <select id="subjectSelect" class="subject-select hero-subj" aria-label="切换学科">${subjOptionsHtml()}</select>
    </div>
    <div class="row between" style="margin-top:4px"><span class="lv hero-xp">${S.global.xp} XP</span><span class="muted small xp-rem">距下一级还差 ${200 - xpIn} XP</span></div>
    <div class="xpbar"><i style="width:${xpIn / 200 * 100}%"></i></div>
  </div>
  <div class="stat-grid">
    <div class="stat"><b>${totalQ}</b><span>总题数</span></div>
    <div class="stat"><b>${todayA}</b><span>今日已练</span></div>
    <div class="stat">${renderCheckinSlot(sk, checked)}</div>
  </div>
  <div class="cols2">
    <div class="card">${examCountdownHtml()}</div>
    <div class="card">${dailyRingHtml()}</div>
  </div>
  ${cont}
  <div class="mode-grid">
    <div class="mode" data-act="start-order"><div class="tile-wrap"><div class="em tile-blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg></div></div><div class="t">顺序刷题</div><div class="d">按章节逐项过</div></div>
    <div class="mode" data-act="filter-setup"><div class="tile-wrap"><div class="em tile-teal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/></svg></div></div><div class="t">组卷中心</div><div class="d">筛选 · 练习/限时考试</div></div>
    <div class="mode" data-act="start-review"><div class="tile-wrap"><div class="em tile-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></div></div><div class="t">间隔回顾</div><div class="d">待回顾 ${reviewDueTotal(st)} 题</div></div>
    <div class="mode" data-act="start-ai"><div class="tile-wrap"><div class="em tile-pink"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 13.9 8l5.6 1.9-5.6 1.9L12 17.5l-1.9-5.7L4.5 9.9 10.1 8z"/><path d="M19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg></div></div><div class="t">AI 题库</div><div class="d">基于本题的变式</div></div>
    <div class="mode" data-act="go-english"><div class="tile-wrap"><div class="em tile-purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6c-1.7-1.2-4.2-1.4-6-.5v11c1.8-.9 4.3-.7 6 .5 1.7-1.2 4.2-1.4 6-.5V5.5c-1.8-.9-4.3-.7-6 .5z"/><path d="M12 6v11"/></svg></div></div><div class="t">单词背诵</div><div class="d">医学英语速记</div></div>
    <div class="mode" data-act="go-leisure"><div class="tile-wrap"><div class="em tile-orange"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="7" rx="3.5"/><path d="M6.5 11.5h2M7.5 10.5v2M15.5 11.5h.01M17.5 13.5h.01"/></svg></div></div><div class="t">休闲娱乐</div><div class="d">学累了来放松</div></div>
  </div>
  ${Feat.statsCardHtml()}
  ${Feat.kpCardHtml()}`;
}

/* ---------- 题库检索：分页 + 关键词高亮（C09） ---------- */
let _bkArr = [], _bkPage = 1; const BK_PS = 60;
function hlBank(raw, kw) {
  const e = esc(raw); if (!kw) return e;
  const re = new RegExp('(' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return e.replace(re, '<mark>$1</mark>');
}
function renderBankList() {
  const list = $('#bkList'); if (!list) return;
  const st = curState();
  const kw = ($('#bkSearch').value || '').trim().toLowerCase();
  const total = _bkArr.length;
  if (!total) { list.innerHTML = '<div class="empty">没有匹配的题目</div>'; return; }
  const slice = _bkArr.slice(0, _bkPage * BK_PS);
  let html = `<p class="muted small" style="margin:0 0 8px">命中 ${total} 题${total > BK_PS ? `（已显示 ${slice.length}）` : ''} · 点题目看详情</p>`;
  html += slice.map(x => {
    const tags = `<span class="tag">${esc(x.chapterName)}</span><span class="tag">${esc(x.q.typeLabel || (x.q.multi ? '多选' : '单选'))}</span>`;
    const meta = []; if (x.q.year) meta.push(x.q.year); if (x.q.source) meta.push(esc(x.q.source));
    return `<div class="qitem" data-act="qview" data-id="${x.q.id}">
      <div class="q">${hlBank(x.q.content, kw)}</div>
      <div class="meta">${tags}${meta.length ? `<span class="muted small">${meta.join(' · ')}</span>` : ''}${Feat.masteryTag(st, x.q.id)}</div></div>`;
  }).join('');
  if (total > slice.length) html += `<div class="row" style="margin-top:8px"><button class="btn ghost sm" data-act="bk-more">加载更多（还剩 ${total - slice.length}）</button></div>`;
  list.innerHTML = html;
}
/* 把题库检索框抽成可复用片段，挂到题库页顶部（原独立题库页已并入题库 tab） */
function bankSearchHtml() {
  const sub = curSub();
  const chOpts = '<option value="">全部章节</option>' + (() => {
    const G = { jg: '极光', ext: '扩展' }; let s = '';
    for (const g of ['jg', 'ext']) { const chs = (sub.groups && sub.groups[g] && sub.groups[g].chapters) || []; if (chs.length) s += `<optgroup label="${G[g]}">` + chs.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('') + '</optgroup>'; }
    return s;
  })();
  return `<div class="search"><input id="bkSearch" placeholder="搜索题库题目 / 选项内容…" autocomplete="off"><button class="btn ghost sm" data-act="clear-search">清空</button></div>
  <div class="row" style="gap:8px;margin-bottom:10px">
    <select id="bkChapter" class="subject-select" style="flex:1;margin:0">${chOpts}</select>
  </div>
  <div id="bkList"></div>`;
}
function bindBankSearch() {
  const list = $('#bkList');
  if (!list) return;            // 非题库检索视图（词库模式 / 不在错题页）时安全跳过
  const run = () => {
    const kw = ($('#bkSearch').value || '').trim().toLowerCase();
    const cid = $('#bkChapter').value;
    if (!kw && !cid) { list.innerHTML = ''; _bkArr = []; _bkPage = 1; return; }   // 默认不显示题目，只等搜索 / 选章节
    if (kw && kw.length < 3) { list.innerHTML = '<div class="empty">请输入至少 3 个字符后再搜索</div>'; return; }
    let arr = allQuestionsBoth(curSub());
    if (cid) arr = arr.filter(x => x.chapterId === cid);
    if (kw) arr = arr.filter(x => (x.q.content + ' ' + Object.values(x.q.options).join(' ')).toLowerCase().includes(kw));
    _bkArr = arr; _bkPage = 1;
    if (!arr.length) { list.innerHTML = '<div class="empty">没有匹配的题目</div>'; return; }
    renderBankList();
  };
  $('#bkSearch').addEventListener('input', run);
  $('#bkChapter').addEventListener('change', run);
  run();
}
function renderBank() { return bankSearchHtml(); }   // 保留兼容：独立题库页（检索框已并入错题页，本函数暂未被调用）
function bindBank() { bindBankSearch(); }

let wrongTab = 'wrong';
let wrongMasteryFilter = null;
let wrongBankMode = 'bank';   // A12：错题页 题库 / 词库 双视图切换
function chapterAccHtml() {
  const st = curState(), sub = curSub();
  if (!sub.chapters.length) return '<p class="muted small">暂无章节</p>';
  return sub.chapters.map(c => {
    const bc = st.byChapter[c.id]; const tot = bc ? bc.total : 0; const cor = bc ? bc.correct : 0;
    const pct = tot ? Math.round(cor / tot * 100) : 0; const w = tot ? pct : 0;
    return `<div style="margin:6px 0"><div class="row between"><span class="small">${esc(c.name)}</span><span class="muted small">${tot ? cor + '/' + tot : '未练'}</span></div><div class="xpbar" style="background:var(--surface2)"><i style="width:${w}%;background:${pct >= 60 ? 'var(--ok)' : pct >= 30 ? 'var(--warn)' : 'var(--bad)'}"></i></div></div>`;
  }).join('');
}
function chapterAccModal() {
  const st = curState(), sub = curSub();
  const rows = sub.chapters.length ? chapterAccHtml() : '<p class="muted small">暂无章节数据</p>';
  const avg = (() => { let t = 0, c = 0; for (const ch of sub.chapters) { const bc = st.byChapter[ch.id]; if (bc && bc.total) { t += bc.total; c += bc.correct; } } return t ? Math.round(c / t * 100) : 0; })();
  openModal(`<h3>${ICON('chart')}各章正确率（全部章节）</h3>
    <p class="muted small" style="margin:0 0 12px">本学科平均正确率 <b>${avg}%</b> · 共 ${sub.chapters.length} 章 · 悬停星图看单章详情</p>
    <div class="chacc-list">${rows}</div>
    <button class="btn ghost" data-act="modal-close" style="margin-top:12px">关闭</button>`);
}
function renderWrong() {
  const st = curState();
  const modeToggle = `<div class="wrap" style="margin-bottom:10px;gap:8px">
    <button class="chip ${wrongBankMode === 'bank' ? 'on' : ''}" data-act="wbank-mode" data-v="bank">${ICON('book')}题库</button>
    <button class="chip ${wrongBankMode === 'words' ? 'on' : ''}" data-act="wbank-mode" data-v="words">${ICON('abc')}词库</button>
  </div>`;
  if (wrongBankMode === 'words') {
    return `${modeToggle}
      <div class="search"><input id="ewSearch" placeholder="搜索英文 / 中文（全库）" autocomplete="off"><button class="btn ghost sm" data-act="ew-clear">清空</button></div>
      <div class="row" style="gap:8px;margin-bottom:10px">
        <select id="ewDept" class="subject-select" style="flex:1;margin:0"><option value="all">全部分类</option></select>
      </div>
      <div class="card"><div class="row between"><h3 style="margin:0" id="ewTitle">${ICON('book')}英语生词（模糊 / 忘记）</h3><span class="muted small" id="engWrongCnt"></span></div>
      <div id="engWrongList" class="eng-wrong-list"></div></div>`;
  }
  const tabs = [['wrong', ICON('cross') + ' 错题', st.wrong.length], ['fav', ICON('star') + ' 收藏', st.fav.length], ['doubt', ICON('question') + ' 疑点', st.doubt.length]];
  const head = tabs.map(([k, n, c]) => `<button class="btn ${wrongTab === k ? '' : 'ghost'} sm" data-act="wtab" data-k="${k}" style="flex:1">${n} ${c}</button>`).join('');
  const baseIds = (wrongTab === 'wrong' ? st.wrong : wrongTab === 'fav' ? st.fav : st.doubt) || [];
  let shownIds = baseIds;
  if (wrongMasteryFilter !== null) shownIds = shownIds.filter(id => String(Feat.masteryOf(st, id)) === wrongMasteryFilter);
  const mChips = `<div class="wrap" style="margin-top:8px;gap:6px">
      <button class="chip sm ${wrongMasteryFilter === null ? 'on' : ''}" data-act="wmastery" data-k="">全部状态</button>
      ${Feat.MASTERY.map((m, i) => `<button class="chip sm ${wrongMasteryFilter === String(i) ? 'on' : ''}" data-act="wmastery" data-k="${i}">${m.em} ${m.n}</button>`).join('')}
    </div>`;
  return `${modeToggle}
    ${bankSearchHtml()}
    <div class="row" style="gap:8px;margin-bottom:10px">${head}</div>
    <div class="card tight" style="margin-bottom:10px"><div class="row between"><span class="muted small">按掌握状态筛选</span><span class="muted small">当前 ${shownIds.length} / ${baseIds.length} 题</span></div>${mChips}</div>
    <div id="wList"></div>`;
}
function bindWrong() {
  bindBankSearch();            // 题库检索框（挂在题库页顶部）统一在此绑定
  const list = $('#wList');
  const st = curState();
  if (list) {   // 词库模式下页面无 #wList（仅英语生词列表），跳过避免 null.innerHTML 崩溃
    let ids = (wrongTab === 'wrong' ? st.wrong : wrongTab === 'fav' ? st.fav : st.doubt) || [];
    if (wrongMasteryFilter !== null) ids = ids.filter(id => String(Feat.masteryOf(st, id)) === wrongMasteryFilter);
    if (!ids.length) { list.innerHTML = '<div class="empty">这里还空空如也</div>'; }
    else {
      list.innerHTML = ids.map(id => {
        const x = qById(id); if (!x) return '';
        return `<div class="qitem" data-act="qview" data-id="${id}">
          <div class="q">${esc(x.q.content)}</div>
          <div class="meta"><span class="tag">${esc(x.chapterName)}</span>${Feat.masteryTag(st, id)}</div></div>`;
      }).join('');
    }
  }
  /* A11/B21：题库页「词库」子 tab —— 英语搜索框 + 分类下拉。默认显示生词（模糊/忘记），
     输入搜索或选分类 → 词库检索；点击任一词进入沉浸式背诵并定位。 */
  const el = document.getElementById('engWrongList');
  if (el) {
    if (!window.Eng) { return; }
    const cnt = document.getElementById('engWrongCnt');
    const title = document.getElementById('ewTitle');
    const deptSel = $('#ewDept');
    if (deptSel && Eng.depts) Eng.depts().then(list => {
      deptSel.innerHTML = '<option value="all">全部分类</option>' + list.map(d => `<option value="${d.id}">${esc(d.n)} · ${d.c}</option>`).join('');
    }).catch(() => {});
    const wordRow = (w, extra) => `<div class="qitem eng-wrong-item" data-act="eng-wrong-word" data-id="${w.id}">
        <div class="q">${esc(w.e)}</div>
        <div class="meta"><span class="tag">${esc(w._d || '')}</span>${extra || esc(w.c || '')}</div></div>`;
    const draw = async () => {
      const kw = (($('#ewSearch') || {}).value || '').trim();
      const dv = ($('#ewDept') || {}).value || 'all';
      if (!kw && dv === 'all') {                     // 默认：生词（模糊 / 忘记）
        if (title) title.innerHTML = ICON('book') + '英语生词（模糊 / 忘记）';
        const f0 = await Eng.wordsByFamiliar(0), f1 = await Eng.wordsByFamiliar(1);
        const items = [...f0.map(w => ({ w, s: 0 })), ...f1.map(w => ({ w, s: 1 }))];
        if (cnt) cnt.textContent = items.length + ' 词';
        el.innerHTML = items.length ? items.map(({ w, s }) => wordRow(w, `<span class="tag" style="color:${s === 0 ? '#c81f23' : '#E07800'}">${s === 0 ? '忘记' : '模糊'}</span>`)).join('') : '<div class="empty">暂无生词</div>';
        return;
      }
      if (title) title.innerHTML = ICON('abc') + '词库检索';
      const arr = await Eng.searchWords(kw, dv);
      if (cnt) cnt.textContent = arr.length + ' 词';
      el.innerHTML = arr.length ? arr.map(w => wordRow(w, '')).join('') : '<div class="empty">没有匹配的词</div>';
    };
    const sEl = $('#ewSearch');
    if (sEl) { let t = null; sEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 260); }); }
    if (deptSel) deptSel.addEventListener('change', draw);
    draw();
  }
}

function renderHonor() {
  const g = S.global, st = curState(), lv = level(), xpIn = S.global.xp % 200, sk = streak();
  const badgeItem = b => { const got = inSet(g.badges, b.id); const t = (g.badgeTimes && g.badgeTimes[b.id]) ? new Date(g.badgeTimes[b.id]).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : ''; return `<div class="badge ${got ? '' : 'locked'}" data-act="badge-detail" data-id="${b.id}" title="${got && t ? '获得于 ' + t : '未获得'}"><div class="em">${b.em}</div><div class="nm">${b.nm}</div><div class="ds">${got ? (t || '已获得') : '未获得'}</div></div>`; };
  const shownBadges = BADGES.slice(0, 9);
  const eh = (st.examHistory || []).slice().reverse();
  const ehHtml = eh.length ? eh.map(e => {
    const cond = e.cond ? `<span class="muted small" style="display:block">${esc(e.cond)}</span>` : '';
    return `<div class="exam-item row between"><div><div class="score-big" style="color:${e.score >= 60 ? 'var(--ok)' : 'var(--bad)'}">${e.score} 分</div><span class="muted small">${new Date(e.date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 答对 ${e.right}/${e.total}</span>${cond}</div><div style="text-align:right"><span class="tag">${e.src === 'filter' ? '自组卷' : '抽题卷'}</span><span class="tag" style="display:block;margin-top:4px">${e.minutes}分钟</span></div></div>`;
  }).join('') : '<div class="empty">还没有考试记录</div>';
  // 热度图：仿备考台的 GitHub 式 30 天网格（7 列 × 5 行）。相对配色按本月最高单日题数分 4 档，今天描边，悬浮看明细（支持暗色）
  const hmDays = []; for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); hmDays.push(d); }
  const hmCnt = hmDays.map(d => { const dy = st.daily[ymd(d)] || {}; return { a: dy.answered || 0, c: dy.correct || 0 }; });
  const hmMax = Math.max(1, ...hmCnt.map(o => o.a));
  const hmColors = ['var(--surface2)', '#e6f4ea', '#b7e0c2', '#6cc78a', '#1f9d55'];
  const HM_COL = 15, HM_CELL = 16, HM_GAP = 4, HM_ROWS = 2;
  const hmW = HM_COL * (HM_CELL + HM_GAP) - HM_GAP, hmH = HM_ROWS * (HM_CELL + HM_GAP) - HM_GAP;
  let hmSvg = `<svg class="hm-svg" width="${hmW}" height="${hmH}" viewBox="0 0 ${hmW} ${hmH}" role="img" aria-label="近30天刷题热力图">`;
  hmDays.forEach((d, i) => {
    const o = hmCnt[i];
    const lv = o.a === 0 ? 0 : o.a <= hmMax * 0.2 ? 1 : o.a <= hmMax * 0.45 ? 2 : o.a <= hmMax * 0.7 ? 3 : 4;
    const x = (i % HM_COL) * (HM_CELL + HM_GAP), y = Math.floor(i / HM_COL) * (HM_CELL + HM_GAP);
    const isToday = ymd(d) === ymd(new Date());
    hmSvg += `<rect x="${x}" y="${y}" width="${HM_CELL}" height="${HM_CELL}" rx="4" fill="${hmColors[lv]}"${isToday ? ' stroke="var(--primary)" stroke-width="2"' : ''}><title>${ymd(d)} · 答对 ${o.c}/${o.a} 题</title></rect>`;
  });
  hmSvg += `</svg>`;
  return `
  <div class="hero"><div class="row between"><span class="lv">Lv.${lv} · ${esc(curSub().name)}</span><span class="lv">${g.xp} XP</span></div>
    <div class="xpbar"><i style="width:${xpIn / 200 * 100}%"></i></div>
    <div class="lv" style="margin-top:6px">距下一级还差 ${200 - xpIn} XP · ${ICON('fire')}连续 ${sk} 天</div></div>
  <div class="card"><h3>刷题热度（近 30 天）</h3><div class="heatmap" data-act="hm-click" title="点击查看刷题段位">${hmSvg}</div>
    <div class="hm-foot"><span>${hmDays[0].getMonth() + 1}/${hmDays[0].getDate()}</span>
      <div class="hm-legend">少 <i style="background:var(--surface2);border:1px solid var(--border)"></i> <i style="background:#e6f4ea"></i> <i style="background:#b7e0c2"></i> <i style="background:#6cc78a"></i> <i style="background:#1f9d55"></i> 多</div>
      <span>今天</span></div>
    <p class="muted small" style="margin:6px 0 0;cursor:pointer" data-act="hm-click">点击热力图查看你的刷题段位 ▾</p></div>
  <div class="card"><div class="row between" style="margin-bottom:10px"><h3 style="margin:0">徽章墙</h3><button class="chip sm" data-act="badge-more">全部 ${BADGES.length} 枚 ›</button></div><div class="badge-grid">${shownBadges.map(badgeItem).join('')}</div></div>
  <div class="card"><div class="row between" style="margin-bottom:8px"><h3 style="margin:0">${ICON('planet')}知识星图 · 章节掌握度</h3><button class="chip sm" data-act="chacc-more">各章正确率 ›</button></div><div id="kmWrap" class="km-wrap"></div>
    <div class="km-legend"><span class="km-dot km-lo"></span>薄弱<span class="km-dot km-mi"></span>一般<span class="km-dot km-hi"></span>扎实<span class="km-dot km-un"></span>未练<b id="kmStat" class="km-stat small"></b></div>
    <p class="muted small" style="margin:8px 0 0">星点越大越偏红＝越薄弱；悬停可查看章节作答详情。</p></div>
  <div class="honor-duo">
    <div class="card"><h3>正确率趋势（近 14 天）</h3><canvas id="trend" width="320" height="180"></canvas></div>
    <div class="card"><h3>${ICON('book')}医学英语掌握度</h3><div id="engDonut" class="eng-donut"></div>
      <div class="eng-donut-legend" id="engDonutLegend"></div></div>
  </div>
  <div class="card lxg-card" id="leisureCard"><h3>${ICON('book2')}学累了？放松一下</h3>
    <p class="muted small" style="margin:0 0 10px">读一段《理想国》导读，或去雾隐汤屋泡个温泉，给脑子放个假。</p>
    <div class="leisure-acts">
      <button class="btn soft" data-act="open-lixiangguo">${ICON('leaf')}打开《理想国》导读</button>
      <a class="btn soft" href="https://wuyin-onsen.app.workbuddy.host/" target="_blank" rel="noopener">${ICON('spring')}雾隐汤屋 · 像素动物温泉</a>
    </div></div>
  <div class="card"><h3>历史成绩</h3>${ehHtml}</div>`;
}
function buildConstellation(sub, st) {
  const ch = sub.chapters || [];
  const W = 360, H = 300, cx = W / 2, cy = H / 2;
  const n = ch.length;
  if (!n) return { svg: '<div class="empty">暂无章节数据</div>', stat: '' };
  const GA = 2.399963229; // 黄金角：向日葵排布，星点分布均匀且自带"旋臂"感
  const stats = { lo: 0, mi: 0, hi: 0, un: 0 };
  const nodes = ch.map((c, i) => {
    const bc = st.byChapter ? st.byChapter[c.id] : null;
    const practiced = !!(bc && bc.total);
    const pct = practiced ? Math.round(bc.correct / bc.total * 100) : 0;
    const ang = i * GA;
    const r = Math.sqrt((i + 0.5) / n) * (Math.min(W, H) / 2 - 30);
    const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
    const tier = practiced ? (pct >= 70 ? 'hi' : pct >= 40 ? 'mi' : 'lo') : 'un';
    stats[tier]++;
    const rad = practiced ? 3 + pct / 100 * 7 : 2.5;
    const name = (c.name || '').replace(/^第.+?章\s*/, '');
    return { x, y, rad, tier, pct, practiced, name, ct: bc ? (bc.correct + '/' + bc.total) : '未练', i };
  });
  const path = nodes.map((nd, i) => (i ? 'L' : 'M') + nd.x.toFixed(1) + ' ' + nd.y.toFixed(1)).join(' ');
  const stars = nodes.map(nd =>
    `<circle class="km-star km-${nd.tier}" cx="${nd.x.toFixed(1)}" cy="${nd.y.toFixed(1)}" r="${nd.rad.toFixed(1)}" style="--d:${nd.i * 45}ms"><title>${esc(nd.name)} · ${nd.ct}${nd.practiced ? (' · 掌握 ' + nd.pct + '%') : ''}</title></circle>`
  ).join('');
  const svg = `<svg class="km-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="章节掌握度星图"><path class="km-line" d="${path}"/>${stars}</svg>`;
  const stat = `已练 ${stats.hi + stats.mi + stats.lo} · 扎实 ${stats.hi} · 薄弱 ${stats.lo} · 未练 ${stats.un}`;
  return { svg, stat };
}

function bindHonor() {
  const sub = curSub(), st = curState();
  const km = buildConstellation(sub, st);
  const wrap = $('#kmWrap'); if (wrap) wrap.innerHTML = km.svg;
  const kmStat = $('#kmStat'); if (kmStat) kmStat.textContent = km.stat;
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const tdata = days.map(d => { const dy = st.daily[ymd(d)]; return dy && dy.answered ? Math.round(dy.correct / dy.answered * 100) : null; });
  const tlabels = days.map(d => (d.getMonth() + 1) + '/' + d.getDate());
  drawTrend($('#trend'), tdata, tlabels); _trend = tdata; _trendLabels = tlabels;
  drawEnglishDonut();
}

/* 医学英语掌握度甜甜圈：按 S.global.english 的 s(0/1/2) 统计 忘记/模糊/认识 三段。
 * 直接数进度对象（不加载 3414 词全表，轻量）；SVG 用主题 token 颜色，切主题自动跟随。 */
function drawEnglishDonut() {
  const el = document.getElementById('engDonut'); if (!el) return;
  const leg = document.getElementById('engDonutLegend');
  const p = (S.global && S.global.english) || {};
  let n0 = 0, n1 = 0, n2 = 0;
  for (const k in p) { const s = p[k] && p[k].s; if (s === 2) n2++; else if (s === 1) n1++; else n0++; }
  const total = n0 + n1 + n2;
  if (!total) { el.innerHTML = '<div class="empty">还没有背词记录</div>'; if (leg) leg.innerHTML = ''; return; }
  const C = 2 * Math.PI * 50;
  const segs = [
    { v: n2, color: 'var(--ok)', name: '认识' },
    { v: n1, color: 'var(--warn)', name: '模糊' },
    { v: n0, color: 'var(--bad)', name: '忘记' },
  ];
  let off = 0, arcs = '';
  for (const s of segs) {
    if (!s.v) continue;
    const len = s.v / total * C;
    arcs += `<circle cx="60" cy="60" r="50" fill="none" stroke="${s.color}" stroke-width="14" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
    off += len;
  }
  el.innerHTML = `<svg viewBox="0 0 120 120" class="donut-svg" role="img" aria-label="医学英语掌握度甜甜圈">
    <circle cx="60" cy="60" r="50" fill="none" stroke="var(--surface2)" stroke-width="14"/>
    ${arcs}
    <text x="60" y="57" text-anchor="middle" class="donut-num">${total}</text>
    <text x="60" y="75" text-anchor="middle" class="donut-cap">已学词</text>
  </svg>`;
  if (leg) leg.innerHTML = segs.map(s => `<span class="dl"><i style="background:${s.color}"></i>${s.name} ${s.v}</span>`).join('');
}

function renderMe() {
  const g = S.global, st = curState();
  return `
  <div class="section-title">设置</div>
  <div class="card">
    <h3>学习数据</h3>
    <div class="row between"><span class="muted small">当前学科错题</span><b>${st.wrong.length}</b></div>
    <div class="row between"><span class="muted small">当前学科收藏</span><b>${st.fav.length}</b></div>
    <div class="row between"><span class="muted small">当前学科疑点</span><b>${st.doubt.length}</b></div>
    <div class="row between"><span class="muted small">当前学科纠错</span><b>${(st.feedback || []).length}</b></div>
    <div class="row between"><span class="muted small">累计作答</span><b>${totalAnswered()}</b></div>
  </div>
  ${Feat.statsCardHtml()}
  ${Feat.prefCardHtml()}
  ${Feat.themeCardHtml()}
  <div class="card">
    <h3>${ICON('flag')}答案纠错</h3>
    <p class="muted small" style="margin:0 0 8px">遇到答案 / 解析 / 题干有问题的题，在题目页点「纠错」记录，这里统一导出。</p>
    <div class="lib-list">${Feat.feedbackListHtml(st)}</div>
    <div class="wrap" style="margin-top:10px">
      <button class="btn soft sm" data-act="fb-export">${ICON('download')}导出纠错记录</button>
      <button class="btn ghost sm" data-act="fb-clear">清空本学科</button>
    </div>
  </div>
  <div class="card">
    <h3>${ICON('robot')}AI 题库</h3>
    <p class="muted small" style="margin:0 0 10px">基于本题让 AI 生成的变式题，已存档并云端同步。仅 lql 账号可生成。</p>
    <div class="row between"><span class="muted small">共 ${(curState().aiGen || []).length} 批</span>
      <button class="btn soft sm" data-act="ai-gen-list">查看</button></div>
  </div>
  <div class="card">
    <h3>数据备份</h3>
    <p class="muted small" style="margin:0 0 10px">所有数据只存在这台设备的浏览器里。换设备 / 清缓存 / 用 QQ、微信等 App 内置浏览器打开都可能丢失，建议定期导出 JSON 备份。</p>
    <div class="wrap" style="margin-bottom:10px"><span class="muted small">上次备份：</span><b class="small">${g.lastBackup ? new Date(g.lastBackup).toLocaleString('zh-CN') : '尚未导出'}</b></div>
    <div class="wrap">
      <button class="btn sm" data-act="export-data">${ICON('download')}导出 JSON 备份</button>
      <button class="btn ghost sm" data-act="import-data">${ICON('upload')}导入恢复</button>
    </div>
    <input type="file" id="fileInput" accept="application/json,.json" class="hidden">
  </div>
  <div class="card">
    <h3>${ICON('trash')}清空学习进度</h3>
    <p class="muted small" style="margin:0 0 10px">只清「作答类」记录：错题 / 收藏 / 疑点 / 掌握度 / 间隔回顾 / 每日统计 / 考试记录。
      <b>不动</b>成就徽章、连续打卡、XP 等级与偏好设置；可按题库分别清（极光 / 扩展 / AI 变式）。</p>
    <button class="btn ghost" data-act="reset-setup">选择范围并清空…</button>
  </div>
  <div class="card">
    <h3>关于</h3>
    <p class="muted small" style="margin:0">刷题记 · 纯本地个人学习站。数据来自本地题库快照（生化 / 生理 / 免疫三科 + 医学英语），进度仅存于本机浏览器，可随时导出 JSON 备份或开启云端同步。无后端、无账号体系，离线可用。</p>
  </div>`;
}

/* ---------- 弹层 ---------- */
/* 焦点管理（审计 P2）：打开移焦点到弹窗内首个可聚焦元素，关闭恢复触发元素；Esc 关闭委托见 init。 */
let _modalLastFocus = null;
function openModal(html) { const m = $('#modal'); _modalLastFocus = document.activeElement; m.setAttribute('aria-hidden', 'false'); $('#modalBox').innerHTML = html; m.classList.remove('hidden'); const f = m.querySelector('button,[href],input,select,textarea,[tabindex]'); if (f) try { f.focus(); } catch (e) {} }
function closeModal() { const m = $('#modal'); m.setAttribute('aria-hidden', 'true'); m.classList.add('hidden'); if (_modalLastFocus && _modalLastFocus.focus) try { _modalLastFocus.focus(); } catch (e) {} }

/* 理想国导读全屏浮层：成就页「学累了放松」入口，iframe 同源按需加载（不入首屏缓存） */
function lxgEl() {
  let el = document.getElementById('lxgReader');
  if (!el) { el = document.createElement('div'); el.id = 'lxgReader'; el.className = 'lxg hidden'; (document.getElementById('app') || document.body).appendChild(el); }
  return el;
}
function openLixiangguo() {
  const el = lxgEl();
  el.innerHTML =
    '<div class="lxg-bar"><button class="engr-back" data-act="close-lixiangguo">← 返回成就</button>' +
    '<span class="lxg-title">《理想国》导读 · 学累了来放松</span></div>' +
    '<iframe class="lxg-frame" src="lixiangguo.html?v=20260913t" title="理想国导读"></iframe>';
  document.body.classList.add('reading');
  el.classList.remove('hidden');
  if (!lxgEl._key) lxgEl._key = (e) => { if (e.key === 'Escape' && !el.classList.contains('hidden')) closeLixiangguo(); };
  document.addEventListener('keydown', lxgEl._key);
}
function closeLixiangguo() {
  const el = document.getElementById('lxgReader');
  if (el) { const f = el.querySelector('.lxg-frame'); if (f) f.removeAttribute('src'); el.classList.add('hidden'); }
  document.body.classList.remove('reading');
  if (lxgEl._key) document.removeEventListener('keydown', lxgEl._key);
}

function openQDetail(qid) {
  const x = qById(qid); if (!x) return;
  curDetailQid = qid;
  const st = curState(), q = x.q;
  ensureExplain(SB[cur], q);
  const isFav = inSet(st.fav, qid), isWrong = inSet(st.wrong, qid), isDoubt = inSet(st.doubt, qid);
  const rv = st.review ? st.review[qid] : null;
  const wrongAns = rv ? rv.wrongAns || [] : [];
  const dispAns = String(q.correct || '').split('').map(k => Feat.dispOfKey(q, k)).sort().join('');
  let optHtml = ''; for (const o of Feat.optView(q)) {
    let cls = 'opt';
    if (String(q.correct).indexOf(o.key) >= 0) cls += ' correct';
    else if (wrongAns.indexOf(o.key) >= 0) cls += ' wrong';
    optHtml += `<div class="${cls}"><div class="k">${o.disp}</div><div class="v">${esc(o.text)}</div></div>`;
  }
  openModal(`<h3>${esc(x.chapterName)}</h3>
    ${q.caseInfo ? `<div class="qcase">${esc(q.caseInfo)}</div>` : (q.type === 'A3' ? `<div class="qcase qcase-miss">${ICON('doc')}本题为病例组题，源数据未附带共享病例正文，题干可能不完整</div>` : '')}
    <div class="qstem">${esc(q.content)}</div>
    ${qChipsHtml(q)}
    ${q.images && q.images.length ? q.images.map(im => `<img class="qimg" src="${esc(im)}" onerror="imgFail(this)">`).join('') : (q.img ? `<div class="qimg-ph">${ICON('img')}本题原始数据带图片，图未随题库下发，请对照教材原图作答</div>` : '')}
    ${optHtml}
    <div class="ans-line ok">正确答案：${esc(q.noChoice ? q.correct : dispAns)} ${Feat.masteryTag(st, qid, true)}</div>
    <div id="expWrap">${hasExplain(q) ? explainHtml(q) : ''}</div>
    <div class="wrap" style="margin-top:12px">
      ${aiEnabled() ? `<button class="btn soft sm" data-act="ai-gen-q" data-id="${qid}">${ICON('robot')}AI出题</button>` : ''}
      ${aiEnabled() ? `<button class="btn soft sm" data-act="ai-explain-q" data-id="${qid}">${ICON('brain')}AI再解析</button>` : ''}
      <button class="btn soft sm" data-act="toggle-fav" data-id="${qid}">${isFav ? ICON('star') + ' 取消收藏' : ICON('star') + ' 收藏'}</button>
      <button class="btn soft sm" data-act="toggle-doubt" data-id="${qid}">${isDoubt ? '已标记疑点' : '标记疑点'}</button>
      <button class="btn soft sm" data-act="remove-wrong" data-id="${qid}">${isWrong ? '移出错题' : '非错题'}</button>
        <button class="btn soft sm" data-act="fb-open" data-id="${qid}">${ICON('flag')}纠错</button>
    </div>
    <button class="btn ghost" data-act="close-modal" style="margin-top:8px">关闭</button>`);
}

/* ---------- 练习设置弹层 ---------- */
function orderSetup() {
  const sub = curSub(), st = curState();
  const items = sub.chapters.map(c => {
    const total = c.questions.length;
    const ids = new Set(c.questions.map(q => q.id));
    const correct = st.mastered.filter(id => ids.has(id)).length;   // 去重：已掌握题数
    const wrong = st.wrong.filter(id => ids.has(id)).length;        // 去重：当前错题数
    const done = correct + wrong;
    const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    return `<div class="qitem" data-act="chapter" data-id="${c.id}">
      <div class="q">${esc(c.name)}</div>
      <div class="ch-prog">
        <div class="ch-prog-bar"><i style="width:${total ? correct/total*100 : 0}%;background:var(--ok)"></i><i style="width:${total ? wrong/total*100 : 0}%;background:var(--bad)"></i></div>
        <span class="pct">${pct}%</span>
      </div></div>`;
  }).join('');
  openModal(`<h3>顺序刷题 · 选择章节</h3>${items}<button class="btn ghost" data-act="close-modal">关闭</button>`);
}
/* 章内题号导航：点击某章后弹出圆圈，定位到具体题目 */
function openChapterNav(c) {
  const st = curState();
  const cells = c.questions.map((q, i) => {
    let cls = 'qn';
    if (inSet(st.wrong, q.id)) cls += ' wrong';
    else if (inSet(st.mastered, q.id)) cls += ' correct';
    return `<button class="${cls}" data-act="jump-q" data-id="${c.id}" data-qi="${i}" aria-label="第 ${i + 1} 题">${i + 1}</button>`;
  }).join('');
  openModal(`<div class="qnav-head">
      <button class="back" data-act="back-chapters">← 返回章节</button>
      <div class="ttl">${esc(c.name)} · 题号导航</div>
    </div>
    <p class="muted small">点击题号直接定位到该题开始练习。绿底=已答对，红底=答错过，白底黑线=未刷。</p>
    <div class="qnav">${cells}</div>
    <div class="qnav-legend">
      <span><i class="dot"></i>未刷</span>
      <span><i class="dot ok"></i>已答对</span>
      <span><i class="dot bad"></i>答错过</span>
    </div>`);
}
/* 跳转到指定题号开始练习（保留已有作答进度，如有） */
function jumpToQuestion(c, qi) {
  const key = makeSessionKey('practice', c.id);
  const saved = getSession(key);
  // 题库顺序始终以「当前章节题目」为准，跳转题号 qi 才能与池内下标严格对齐（避免 data.js 重排后错位）
  const pool = c.questions.map(q => ({ q, chapterName: c.name, chapterId: c.id }));
  let answers = {};
  if (saved && saved.answers) {
    for (const it of pool) if (saved.answers[it.q.id]) answers[it.q.id] = saved.answers[it.q.id];
  }
  const st = curState();
  // 导航色（mastered/wrong）与题内状态对齐：已知作答结果的题，点进去直接显示已揭晓的作答痕迹
  for (const it of pool) {
    const id = it.q.id;
    if (answers[id]) continue;
    if (inSet(st.mastered, id)) answers[id] = { chosen: String(it.q.correct).toUpperCase().split('').filter(x => /[A-Z]/.test(x)), correct: true, revealed: true };
    else if (inSet(st.wrong, id)) answers[id] = { chosen: [], correct: false, revealed: true };
  }
  P = { pool, mode: 'practice', idx: Math.min(qi, pool.length - 1), answers, modeOpt: { chapterId: c.id }, submitted: false, start: Date.now(), timer: null, timeLeft: 0, sessionKey: key };
  saveSession();
  closeModal();
  openPlayer();
  renderPlayer();
}
/* 考试设置已并入「组卷中心」（features.js filterSetup）：
 * 考试 = 筛选条件 + 单选/多选配额 + 时限，与练习共用同一个面板，避免两套组卷口径。 */

/* ---------- 播放器 ---------- */
let P = null;

/* ---------- 间隔回顾（双门槛状态机 + 四象限复习中心） ---------- */
function reviewInit(r) {
  if (!r) return r;
  if (r.streak == null) {
    // 旧记录兼容：用当前 stage 推算连击与起点，避免首答把排期回退
    r.streak = Math.min(r.stage || 0, 3);
    r.streakFrom = (r.nextReview || Date.now()) - ((REVIEW_INTERVALS[r.stage] || 1) * 86400000);
    r.mastered = false;
    r.feeling = 'unknown';
  }
  if (r.wrongAns == null) r.wrongAns = [];
  return r;
}
function dueReviewIds(st) {
  const now = Date.now(), ids = [];
  for (const qid in (st.review || {})) {
    const r = st.review[qid];
    if (r.mastered) continue;                 // 已掌握不进到期池
    if (r.nextReview <= now) ids.push(qid);
  }
  return ids;
}
/* A11：待回顾总数 = 刷题到期 + 英语到期（英语依赖已加载的 allCache；未访问英语页时仅计刷题） */
function reviewDueTotal(st) {
  let n = dueReviewIds(st).length;
  if (window.Eng && Eng.dueCountSync) n += Eng.dueCountSync();
  return n;
}
function updateReview(q, correct, chosen) {
  const st = curState();
  if (!st.review) st.review = {};
  const now = Date.now();
  let r = st.review[q.id];
  if (!r) r = st.review[q.id] = { stage: 0, nextReview: now + REVIEW_INTERVALS[0] * 86400000, wrongAns: [], streak: 0, streakFrom: null, mastered: false, feeling: 'unknown' };
  reviewInit(r);
  if (correct) {
    if (r.mastered) { r.nextReview = now + REVIEW_INTERVALS[REVIEW_INTERVALS.length - 1] * 86400000; return; }
    if (r.streakFrom == null) r.streakFrom = now;
    r.streak = (r.streak || 0) + 1;
    const span = (now - r.streakFrom) / 86400000;
    if (r.streak >= 4 && span >= 21) {        // 双门槛达成 → 毕业（保留记录，不删）
      r.mastered = true;
      r.nextReview = now + REVIEW_INTERVALS[REVIEW_INTERVALS.length - 1] * 86400000;
      return;
    }
    // 未达双门槛：按连击/跨度推进到对应间隔档（不毕业）
    let stage;
    if (r.streak >= 3 && span >= 7) stage = 3; // 15 天
    else if (r.streak >= 2) stage = 2;        // 7 天
    else stage = 1;                           // 3 天
    r.stage = stage;
    r.nextReview = now + REVIEW_INTERVALS[stage] * 86400000;
  } else {
    r.stage = 0; r.streak = 0; r.streakFrom = null; r.mastered = false;
    r.nextReview = now + REVIEW_INTERVALS[0] * 86400000;
    r.wrongAns = (chosen || []).slice();
  }
}
function reviewStats(st) {
  const due = [], newWrong = [], repeat = [], mastered = [];
  for (const qid of (st.wrong || [])) {
    const r = st.review ? st.review[qid] : null;
    if (!r) newWrong.push(qid);
    else if (!r.mastered && r.streak === 0 && r.wrongAns && r.wrongAns.length && r.nextReview > Date.now()) newWrong.push(qid);
  }
  if (st.review) for (const qid in st.review) {
    const r = st.review[qid]; if (!r) continue;
    if (r.mastered) { mastered.push(qid); continue; }
    if (r.nextReview <= Date.now()) due.push(qid);
    const qs = st.qstat ? st.qstat[qid] : null;
    if (qs && qs.w >= 2) repeat.push(qid);
  }
  return { due, newWrong, repeat, mastered };
}
function reviewQueue(st) {
  const due = reviewStats(st).due;
  // 排序：上次错选过 > nextReview 早优先 > 错次多 > 练习多
  const rank = id => {
    const r = st.review[id], qs = st.qstat ? st.qstat[id] : null;
    const hadWrong = (r.wrongAns && r.wrongAns.length) ? 1 : 0;
    return [hadWrong, -(r.nextReview || 0), qs ? qs.w : 0, qs ? qs.n : 0];
  };
  due.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < 4; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? -1 : 1; return 0; });
  return due.slice(0, 100);                   // 单轮上限 100
}
function startReviewPool(ids) {
  const st = curState();
  const pool = [];
  for (const qid of ids) { const x = qById(qid); if (x) pool.push(x); }
  if (!pool.length) { toast('没有可复习的题目'); return; }
  closeModal();
  startPractice(pool, 'practice', {}, null);
  P.reviewMode = true;
  saveSession();
  renderPlayer();
}
let reviewCenterMode = 'bank';   // A11：间隔回顾中心双模式（题库 / 词库）
async function openReviewCenter() {
  const st = curState();
  const s = reviewStats(st);
  const dueQ = reviewQueue(st);
  const repeat = s.repeat.slice().sort((a, b) => ((st.qstat[b] || {}).w || 0) - ((st.qstat[a] || {}).w || 0)).slice(0, 100);
  const mastered = s.mastered;
  const engDue = (window.Eng && Eng.dueCountSync) ? Eng.dueCountSync() : 0;
  const f0 = (window.Eng && Eng.wordsByFamiliar) ? (await Eng.wordsByFamiliar(0)).length : 0;
  const f1 = (window.Eng && Eng.wordsByFamiliar) ? (await Eng.wordsByFamiliar(1)).length : 0;
  const desc = { due: '真正该复习的：到期且未掌握', new: '错过但还没稳住的新错题', repeat: '错 ≥2 次，优先啃硬骨头' };
  const card = (k, em, t, cnt, act, arg) => `<div class="rv-card"><div class="rv-card-h"><span class="rv-em">${em}</span><b>${t}</b><span class="rv-cnt">${cnt}</span></div><div class="rv-card-d">${desc[k] || ''}</div><button class="btn ${cnt ? '' : 'ghost'} sm" data-act="${act}"${arg ? ` data-pool="${arg}"` : ''} ${cnt ? '' : 'disabled'}>开始复习${cnt ? ' ' + cnt + ' 词' : ''}</button></div>`;
  const wcard = (em, t, cnt, act, v) => `<div class="rv-card"><div class="rv-card-h"><span class="rv-em">${em}</span><b>${t}</b><span class="rv-cnt">${cnt}</span></div><div class="rv-card-d">${v}</div><button class="btn ${cnt ? '' : 'ghost'} sm" data-act="${act}"${act === 'eng-fam-launch' ? ` data-v="${v === '忘记' ? 0 : 1}"` : ''} ${cnt ? '' : 'disabled'}>${cnt ? '去背诵' : '暂无'}</button></div>`;
  const toggle = `<div class="wrap" style="margin-bottom:10px;gap:8px"><button class="chip ${reviewCenterMode === 'bank' ? 'on' : ''}" data-act="rv-mode" data-v="bank">${ICON('book')}题库</button><button class="chip ${reviewCenterMode === 'words' ? 'on' : ''}" data-act="rv-mode" data-v="words">${ICON('abc')}词库</button></div>`;
  let body;
  if (reviewCenterMode === 'bank') {
    body = `<div class="rv-grid">${card('due', ICON('cal'), '今日到期', dueQ.length, 'rv-start', 'due')}${card('new', ICON('new'), '新错题', s.newWrong.length, 'rv-start', 'new')}${card('repeat', ICON('repeat'), '反复错误', repeat.length, 'rv-start', 'repeat')}</div>`;
  } else {
    body = `<div class="rv-grid">
      ${wcard(ICON('abc'), '英语到期复习', engDue, 'eng-review-launch', '模糊 / 忘记 到期词，用单词页 SRS 播放器逐词过')}
      ${wcard(ICON('dotr'), '忘记', f0, 'eng-fam-launch', '熟悉度=忘记 的生词')}
      ${wcard(ICON('doty'), '模糊', f1, 'eng-fam-launch', '熟悉度=模糊 的生词')}
    </div>`;
  }
  const mList = mastered.length ? mastered.map(id => {
    const x = qById(id);
    return `<div class="rv-m-item" data-act="qview" data-id="${id}"><span class="q">${x ? esc(x.q.content) : esc(id)}</span><button class="chip sm" data-act="rv-restore" data-id="${id}">恢复复习</button></div>`;
  }).join('') : '<div class="empty">还没有已掌握的题</div>';
  openModal(`<h3>${ICON('repeat')}间隔回顾中心</h3>${toggle}
    ${body}
    <div class="card tight" style="margin-top:10px"><div class="row between"><span>${ICON('check')}已掌握（点击可恢复自动复习）</span><b>${mastered.length}</b></div><div class="rv-m-list">${mList}</div></div>
    <p class="muted small" style="margin-top:10px">答对需「连对 ≥4 次且跨度 ≥21 天」才毕业；复习中可标「还不熟 / 掌握」手动调控。</p>
    <button class="btn ghost" data-act="modal-close">关闭</button>`);
}
async function startReview() {
  if (window.Eng) { try { await Eng.loadMan(); await Eng.ensureAll(); } catch (e) {} }
  openReviewCenter();
}
function rvFeelHtml(st, qid) {
  const r = st.review && st.review[qid];
  const cur = r ? r.feeling : 'unknown';
  const b = (v, n) => `<button class="chip ${cur === v ? 'on' : ''}" data-act="rv-feel" data-v="${v}">${n}</button>`;
  return `<div class="rv-feel"><span class="rv-feel-q">这道题现在感觉如何？<small class="muted">（可直接跳过）</small></span><div class="rv-feel-btns">${b('weak', '还不熟')}${b('ok', '暂时清楚')}${b('mastered', '掌握')}</div></div>`;
}
function rvFeel(qid, v) {
  const st = curState(); if (!st.review) st.review = {};
  const now = Date.now();
  let r = st.review[qid];
  if (!r) r = st.review[qid] = { stage: 0, nextReview: now + REVIEW_INTERVALS[0] * 86400000, wrongAns: [], streak: 0, streakFrom: null, mastered: false, feeling: 'unknown' };
  reviewInit(r);
  if (v === 'weak') { r.stage = 0; r.streak = 0; r.streakFrom = null; r.mastered = false; r.feeling = 'weak'; r.nextReview = now + 86400000; toast('「还不熟」· 1 天后再次复习'); }
  else if (v === 'ok') { r.feeling = 'ok'; toast('已记录 · 暂不清楚，按系统排期复习'); }
  else if (v === 'mastered') {
    if (r.mastered) { r.mastered = false; r.stage = 0; r.streak = 0; r.streakFrom = null; r.nextReview = now + 86400000; toast('已恢复本题自动复习'); }
    else { r.mastered = true; r.feeling = 'mastered'; r.nextReview = now + REVIEW_INTERVALS[REVIEW_INTERVALS.length - 1] * 86400000; toast('已标记掌握 · 移出复习队列（可恢复）'); }
  }
  save(); renderPlayer();
}

/* 练习进度持久化（断点续练 · 按「科目+章节」分别缓存）
   旧版只存一个全局会话，切到别的章节会把前一个覆盖，导致回不去。
   现改为 sessions 映射：key = c:<科目>:<章节> / r:<科目> / e:<科目>，
   每个章节独立保留进度，互不影响，且跨科目各自保留。 */
let pendingResume = null;
/* 考试卷指纹：由「组卷口径」（来源 + 条件摘要 + 单/多选配额）算出的稳定 hash。
 * 为什么不用题目 id 集合：抽题是随机的，按题目算指纹会每次开考都产生一个新会话键
 * （S.sessions 会写进 localStorage，导致无限膨胀）；按口径算则可以复用同一个键。
 * 背景：老版本考试键只有 e:<科目>，「抽题卷」与「筛选自组卷」共用同一个键 —— 考到一半退出、
 * 再组一份新卷，会被提示「继续上次考试」并真的接回旧卷（等于答错卷子）。 */
function examKeyOf(opt) {
  const o = opt || {};
  // 用控制字符 \x1f 作字段分隔，杜绝「a|b|c」式口径歧义碰撞；
  // 前缀 v1 作为盐，算法升级时改前缀即可让旧考试会话键自然失效（避免接错旧卷）。
  const SEP = String.fromCharCode(31);
  const basis = 'v1' + SEP + [o.src || 'exam', o.cond || '', o.single || 0, o.multi || 0].join(SEP);
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) { h ^= basis.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function makeSessionKey(mode, chapterId, fp) {
  if (mode === 'exam') return 'e:' + cur + (fp ? ':' + fp : '');
  if (mode === 'practice' && chapterId) return 'c:' + cur + ':' + chapterId;
  return 'r:' + cur;
}
function getSession(key) { return S.sessions[key] || null; }
function buildPoolFromSession(s) {
  const pool = [];
  for (const e of s.qids) {
    let x = qById(e.id);
    // AI 题不在静态题库 SB，需从 aiGen 批次按 bid 取
    if (!x && e.chapterId && e.chapterId.indexOf('aigen:') === 0) {
      const bid = e.chapterId.slice(6);
      const b = (curState().aiGen || []).find(bb => bb.batchId === bid);
      if (b) { const qq = b.questions.find(qq => qq.id === e.id); if (qq) x = { q: qq, chapterName: e.chapterName, chapterId: e.chapterId }; }
    }
    if (!x || !x.q) return null;
    pool.push({ q: x.q, chapterName: e.chapterName, chapterId: e.chapterId });
  }
  return pool;
}
function sessionLabel(s) {
  if (s.mode === 'exam') {
    if (s.modeOpt && s.modeOpt.src === 'filter') {
      const c = s.modeOpt.cond ? ' · ' + String(s.modeOpt.cond).slice(0, 40) : '';
      return '限时考试 · 自组卷' + c;
    }
    return '限时考试 · 抽题卷';
  }
  if (s.mode === 'review') return '作答回顾';
  if (s.key && s.key.charAt(0) === 'c') {
    const cid = s.key.slice(s.key.indexOf(':', 2) + 1);
    if (cid.indexOf('aigen:') === 0) return 'AI 题库 · 变式';
    const ch = curSub().chapters.find(c => c.id === cid);
    return '顺序刷题 · ' + (ch ? ch.name : ((s.qids && s.qids[0] && s.qids[0].chapterName) || '章节'));
  }
  if (s.key && s.key.charAt(0) === 'r') return '乱序刷题';
  return '练习';
}
/* 章节顺序练习的「继续」指针：指向第一道尚未作答的题（与最后浏览位置解耦，
   避免通过题号导航跳题时，把「已刷到的进度」覆盖成最后点开的那个圆圈） */
function nextTodoIdx(pool, answers) {
  for (let i = 0; i < pool.length; i++) { const a = answers[pool[i].q.id]; if (!a || !a.revealed) return i; }
  return pool.length - 1;
}
function saveSession() {
  if (!P) return;
  const key = P.sessionKey;
  const idx = (P.mode === 'practice' && key && key.charAt(0) === 'c') ? nextTodoIdx(P.pool, P.answers) : P.idx;
  S.sessions[key] = {
    subject: cur, key, mode: P.mode, idx,
    reviewMode: !!P.reviewMode,
    qids: P.pool.map(it => ({ id: it.q.id, chapterId: it.chapterId, chapterName: it.chapterName })),
    modeOpt: P.modeOpt, start: P.start, answers: P.answers, timeLeft: P.timeLeft, deadlineAt: P.deadlineAt || null,
    updatedAt: Date.now()
  };
  save();
}
function clearSession() {
  if (P && P.sessionKey && S.sessions[P.sessionKey]) { delete S.sessions[P.sessionKey]; save(); }
}
function clearSessionKey(key) { if (S.sessions[key]) { delete S.sessions[key]; save(); } }
/* 全局最近一次缓存（用于首页「继续刷题」入口，跨科目也按时间取最新） */
function latestSession(subject) {
  const subj = subject || cur;
  let best = null;
  for (const k in S.sessions) {
    const s = S.sessions[k];
    if (!s.qids || !s.qids.length) continue;
    if (s.subject !== subj) continue;
    if (!best || s.updatedAt > best.updatedAt) best = s;
  }
  return best;
}
async function resumeSession(saved) {
  cur = saved.subject; const sel = $('#subjectSelect'); if (sel) sel.value = cur;
  // 断点可能属于尚未加载的学科，先按其分片加载（否则 qById 会查不到题）
  try { await ensureSubject(cur); } catch (e) { toast('该学科数据加载失败'); return; }
  const pool = buildPoolFromSession(saved);
  if (!pool) { clearSessionKey(saved.key); toast('进度已失效，重新开始'); return; }
  P = {
    pool, mode: saved.mode, idx: Math.min(saved.idx, pool.length - 1),
    answers: saved.answers || {}, modeOpt: saved.modeOpt || {},
    reviewMode: !!saved.reviewMode,
    submitted: saved.mode === 'review', start: Date.now(), timer: null, timeLeft: 0, sessionKey: saved.key
  };
  if (saved.mode === 'exam' && !P.submitted) {
    // A11：按绝对截止时间恢复（防退出/刷新续时刷分）。新会话直接用 deadlineAt；
    // A13（审计 P1-6）：旧会话没有 deadlineAt 时按 timeLeft 值恢复——0=已到期（下个 tick
    // 立即交卷），只有 timeLeft 字段也缺失的更老会话才按整场配置重开（旧码 0 也回退整场，与注释相反）。
    P.deadlineAt = saved.deadlineAt
      || (typeof saved.timeLeft === 'number'
            ? Date.now() + Math.max(0, saved.timeLeft) * 1000
            : Date.now() + ((saved.modeOpt && saved.modeOpt.minutes) || 30) * 60000);
    P.timeLeft = Math.max(0, Math.round((P.deadlineAt - Date.now()) / 1000));
    P.timer = examTimer();
  }
  saveSession();
  openPlayer();
  renderPlayer();
}
function promptResume(saved, freshStartFn) {
  pendingResume = { saved, freshStartFn };
  openModal(`<h3>继续上次练习？</h3>
    <p class="muted">${sessionLabel(saved)} · 上次进行到第 ${saved.idx + 1}/${saved.qids.length} 题</p>
    <button class="btn" data-act="resume-yes">继续（第 ${saved.idx + 1} 题）</button>
    <button class="btn ghost" data-act="resume-no">重新开始</button>`);
}
function requestStart(pool, mode, opt, chapterId) {
  /* 考试卷按「组卷口径」分键：同条件同配额的卷子才续考，换了口径就是新断点（不再串卷） */
  const key = makeSessionKey(mode, chapterId, mode === 'exam' ? examKeyOf(opt) : null);
  const saved = getSession(key);
  if (saved && saved.mode === mode && saved.qids && saved.qids.length) promptResume(saved, () => startPractice(pool, mode, opt, key));
  else startPractice(pool, mode, opt, key);
}

/* A11 修复：考试计时改用绝对截止时间。setInterval 在后台/锁屏会被浏览器节流（最长每分钟才 tick），
 * 按 tick 次数递减会让考试时间虚多（防刷分失效）；tick 里按 deadlineAt - Date.now() 重算剩余，
 * 节流期间时间照走。断点恢复（resumeSession）同样按 deadline 重算。 */
function examTimer() {
  return setInterval(() => {
    P.timeLeft = Math.max(0, Math.round((P.deadlineAt - Date.now()) / 1000));
    const el = $('#examTimer'); if (el) el.textContent = ICON('clock') + ' ' + fmtTime(P.timeLeft);
    if (P.timeLeft <= 0) { clearInterval(P.timer); P.timer = null; submitExam(); }
  }, 1000);
}

function startPractice(pool, mode, opt, sessionKey) {
  if (!pool.length) { toast('没有可练习的题目'); return; }
  P = { pool, mode, idx: 0, answers: {}, modeOpt: opt || {}, submitted: false, start: Date.now(), timer: null, timeLeft: 0, sessionKey: sessionKey || 'adhoc' };
  if (mode === 'exam') {
    P.deadlineAt = Date.now() + (opt.minutes || 30) * 60000;   // 绝对截止时间（A11）
    P.timeLeft = Math.round((P.deadlineAt - Date.now()) / 1000);
    P.timer = examTimer();
  }
  saveSession();
  openPlayer();
  renderPlayer();
}
/* 做题时必须让主页面整体退场：player 是 fixed 全屏，但桌面端 #app 是
 * 「左侧固定导航 + 内容区」两列布局，600px 居中的播放器两侧会把侧边栏和
 * 主内容露出来，观感就成了"浮在主页面上"。
 * 隐藏规则在 CSS 侧是「白名单反选」：`#app.playing > :not(#player):not(#modal):not(#toast)`。 */
function setPlaying(on) {
  const a = document.getElementById('app'); if (a) a.classList.toggle('playing', !!on);
  const pl = $('#player'); if (pl) pl.classList.toggle('hidden', !on);
}
function openPlayer() { setPlaying(true); }
function closePlayer() { if (P && P.timer) clearInterval(P.timer); setPlaying(false); }
function renderPlayer() {
  /* 不依赖调用方记得先调 openPlayer：只要把播放器画出来，就顺手把外壳状态对齐。
     （旧版只在三处起卷入口调 openPlayer，任何新增/旁路入口漏调都会让主页面继续在
     播放器两侧露出——用户已实际撞到过一次，所以改成幂等的自愈式。） */
  setPlaying(true);
  const p = $('#player'), it = P.pool[P.idx], q = it.q, a = P.answers[q.id] || {};
  const st = curState();
  ensureExplain(SB[cur], q);
  const isFav = inSet(st.fav, q.id), isDoubt = inSet(st.doubt, q.id);
  let head = '';
  if (P.mode === 'exam') {
    head = `<div class="phead-row"><span class="pill">${P.idx + 1}/${P.pool.length}</span>
      <span id="examTimer" class="pill">${ICON('clock')}${fmtTime(P.timeLeft)}</span>
      <button class="btn soft sm" data-act="sheet">答题卡</button>
      <button class="btn ghost sm" data-act="exit-player">✕</button></div>`;
  } else if (P.mode === 'review') {
    head = `<div class="phead-row"><span class="pill">${P.idx + 1}/${P.pool.length} · 作答回顾</span><button class="btn soft sm" data-act="sheet">答题卡</button><button class="btn ghost sm" data-act="exit-player">✕</button></div>`;
  } else if (P.reviewMode) {
    const rnd = (st.review && st.review[it.q.id]) ? st.review[it.q.id].stage + 1 : 1;
    head = `<div class="phead-row"><span class="pill">${P.idx + 1}/${P.pool.length} · 🔄 间隔回顾 · 第 ${rnd} 轮</span><button class="btn soft sm" data-act="sheet">答题卡</button><button class="btn ghost sm" data-act="exit-player">✕</button></div>`;
  } else {
    head = `<div class="phead-row"><span class="pill">${P.idx + 1}/${P.pool.length} · ${esc(it.chapterName)}</span><button class="btn soft sm" data-act="sheet">答题卡</button><button class="btn ghost sm" data-act="exit-player">✕</button></div>`;
  }
  const dispAns = String(q.correct || '').split('').map(k => Feat.dispOfKey(q, k)).sort().join('');
  const typeTxt = (TYPE_FULL[q.type] || q.typeLabel || (q.multi ? '多选题' : '单选题')) + (q.multi ? ' · 可选多个' : ' · 只选一个');
  let body = `<div class="qtype"><span class="pill ${q.multi ? 'pill-multi' : 'pill-single'}">${typeTxt}</span></div>${Feat.playerMetaHtml(q, st)}${Feat.playerWarnHtml(q)}${q.caseInfo ? `<div class="qcase">${esc(q.caseInfo)}</div>` : (q.type === 'A3' ? `<div class="qcase qcase-miss">${ICON('doc')}本题为病例组题，源数据未附带共享病例正文，题干可能不完整</div>` : '')}<div class="qstem">${esc(q.content)}</div>${qChipsHtml(q)}`;
  // 间隔回顾：上轮错选提示
  const rv = st.review ? st.review[q.id] : null;
  if (rv && rv.wrongAns && rv.wrongAns.length) body += `<div class="rv-hint">${ICON('pencil')}${esc(rv.wrongAns.map(k => Feat.dispOfKey(q, k)).join('、'))} · 已进入第 ${rv.stage + 1} 轮回顾</div>`;
  if (q.images && q.images.length) for (const im of q.images) body += `<img class="qimg" src="${esc(im)}" onerror="imgFail(this)">`;
  else if (q.img) body += `<div class="qimg-ph">${ICON('img')}本题原始数据带图片，图未随题库下发，请对照教材原图作答</div>`;
  if (q.noChoice) {
    // 非选择题（源数据无选项）：输入框 + 自评，不硬判
    body += Feat.noChoiceHtml(q, a);
  } else {
    let optHtml = '';
    for (const o of Feat.optView(q)) {
      const k = o.key;
      let cls = 'opt', actAttr = '';
      if (a.revealed) { if (String(q.correct).indexOf(k) >= 0) cls += ' correct'; else if (a.chosen && a.chosen.includes(k)) cls += ' wrong'; else cls += ' dim'; }
      else { if (a.chosen && a.chosen.includes(k)) cls += ' sel'; actAttr = P.mode === 'exam' ? 'data-act="pick-exam"' : 'data-act="pick"'; }
      /* 无障碍（审计 P2）：选项用原生语义 role——单选 radio / 多选 checkbox，Tab 可达、Enter/Space 触发（委托见 init）。
       * 揭晓后转 aria-disabled 静态展示，不再可交互。 */
      const chosenK = !!(a.chosen && a.chosen.includes(k));
      const roleAttr = a.revealed
        ? `role="radio" aria-checked="${chosenK}" aria-disabled="true"`
        : `role="${q.multi ? 'checkbox' : 'radio'}" aria-checked="${chosenK}" tabindex="0"`;
      optHtml += `<div class="${cls}" ${actAttr} ${roleAttr} data-k="${k}" data-disp="${o.disp}"><div class="k">${o.disp}</div><div class="v">${esc(o.text)}</div></div>`;
    }
    body += optHtml;
  }
  if (a.revealed) {
    body += `<div class="ans-line ${a.correct ? 'ok' : 'bad'}">${a.correct ? ICON('check') + '回答正确' : ICON('cross') + '回答错误'} · 正确答案：${esc(q.noChoice ? q.correct : dispAns)}</div>`;
    body += `<div id="expWrap">${hasExplain(q) ? explainHtml(q) : ''}</div>`;
    const fbrec = Feat.feedbackOf(st, q.id);
    if (fbrec) body += `<div class="qfb">${ICON('flag')}你已报过纠错：${esc((Feat.FB_TYPES.find(x => x.v === fbrec.type) || {}).n || '')}${fbrec.text ? ' · ' + esc(fbrec.text) : ''}</div>`;
    if (P.reviewMode) body += rvFeelHtml(st, q.id);   // 间隔回顾主观三键
  } else if (P.mode !== 'exam') {
    body += `<div id="expWrap">${hasExplain(q) ? `<details class="exp"><summary>提前看解析</summary>${explainInner(q)}</details>` : ''}</div>`;
  }
  let foot = '';
  if (P.mode === 'exam') {
    if (P.submitted) foot = `<button class="btn ghost" data-act="prev">上一题</button><button class="btn" data-act="next">下一题</button>`;
    else {
      /* 未交卷也必须能往后翻：原来只给「上一题+交卷」，答完一题只能开答题卡点题号
       * （移动端连答题卡都难找 → 直接卡住）。nextQ() 早写好了末题保护
       * （idx 到底时 toast「请点击「交卷」」并 return），这里只是把按钮放出来。 */
      const examLast = P.idx >= P.pool.length - 1;
      foot = `<button class="btn ghost" data-act="prev">上一题</button>`
        + `<button class="btn ghost" data-act="next"${examLast ? ' disabled' : ''}>下一题</button>`
        + `<button class="btn" data-act="submit-exam">交卷</button>`;
    }
  } else if (P.mode === 'review') {
    foot = `<button class="btn ghost" data-act="prev">上一题</button><button class="btn" data-act="next">下一题</button>`;
  } else {
    if (!a.revealed) {
      if (P.reviewMode) foot = `<button class="btn" data-act="confirm">确认</button>`;
      else foot = `<button class="btn ghost" data-act="reveal">看答案</button><button class="btn" data-act="confirm">确认</button>`;
    }
    else foot = `<button class="btn" data-act="next">${P.idx >= P.pool.length - 1 ? '完成' : '下一题'}</button>`;
  }
  const prog = Math.round((P.idx + 1) / P.pool.length * 100);
  let aiBtns = '';
  if (aiEnabled()) {
    aiBtns += `<button class="chip" data-act="ai-gen">${ICON('robot')}AI出题</button>`;
    if (P.mode !== 'exam') aiBtns += `<button class="chip" data-act="ai-explain">${ICON('brain')}AI再解析</button>`;
    if (q.ai && it.chapterId && it.chapterId.indexOf('aigen:') === 0) aiBtns += `<button class="chip" data-act="ai-trace" data-bid="${it.chapterId.slice(6)}">${ICON('search')}</button>`;
  }
  body += `<div class="q-actions">
    <button class="chip ${isFav ? 'on' : ''}" data-act="pfav" data-id="${q.id}">${isFav ? ICON('star') + ' 已收藏' : ICON('star') + ' 收藏'}</button>
    <button class="chip ${isDoubt ? 'on' : ''}" data-act="pdoubt" data-id="${q.id}">${isDoubt ? ICON('question') + ' 已标记' : ICON('question') + ' 疑点'}</button>
    ${Feat.playerExtraChips(q)}
    ${aiBtns}
  </div>`;
  body += `<div class="swipe-hint">← 左右滑动切换题目 →</div>`;
  const sameQ = renderPlayer._qid === q.id;
  const _pv = p.querySelector('.pbody'); const _sv = _pv ? _pv.scrollTop : 0;
  p.innerHTML = `<div class="phead">${head}<div class="pbar"><i style="width:${prog}%"></i></div></div><div class="pbody">${body}</div><div class="pfoot">${foot}</div>`;
  renderPlayer._qid = q.id;
  if (sameQ) { const nb = p.querySelector('.pbody'); if (nb) nb.scrollTop = _sv; }  // B18：同题局部交互（多选第 2 项）不掉回顶部
}
function pick(k) {
  const q = P.pool[P.idx].q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
  if (q.multi && !a.revealed) {
    const i = a.chosen.indexOf(k);
    if (i >= 0) a.chosen.splice(i, 1); else a.chosen.push(k);
    // 多选未揭晓：仅切换该选项选中态，避免整块 rebuild（含图题重下载 / 微闪）
    // A11 修复：p 是 renderPlayer() 的局部变量，pick() 里不可见（多选首次点击 ReferenceError、
    // 选中态卡死）；现查 #player，并补 saveSession——原提前 return 把未提交的勾选漏在断点外
    const pbox = document.querySelector('#player');
    if (pbox) pbox.querySelectorAll('.opt').forEach(b => { if (b.dataset.k === k) { const on = a.chosen.includes(k); b.classList.toggle('sel', on); b.setAttribute('aria-checked', String(on)); } });   // A13（审计 P2-10）：选中态与 aria-checked 同步
    saveSession();
    return;
  }
  if (q.multi) { const i = a.chosen.indexOf(k); if (i >= 0) a.chosen.splice(i, 1); else a.chosen.push(k); }
  else a.chosen = [k];
  renderPlayer();
  // 偏好「选完自动提交」：仅单选题 + 练习模式（考试要整卷评分，不能逐题揭晓）
  if (!q.multi && S.global.settings.autoSubmit && P.mode === 'practice' && !P.submitted) confirmAns();
}
function confirmAns() {
  const it = P.pool[P.idx], q = it.q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
  if (!a.chosen || !a.chosen.length) { toast('请先选择答案'); return; }
  const correct = sameSet(a.chosen, q.correct);
  a.correct = correct; a.revealed = true;
  recordAnswer(q, it.chapterId, correct);
  updateReview(q, correct, a.chosen);
  saveSession();
  renderPlayer();
  // 偏好「答对自动下一题」：练习模式且不是最后一题；用题目 id 做守卫，防止用户手动翻页后重复前跳
  if (correct && S.global.settings.autoNext && P.mode === 'practice' && P.idx < P.pool.length - 1) {
    setTimeout(() => {
      if (!P || $('#player').classList.contains('hidden')) return;
      if (P.pool[P.idx] && P.pool[P.idx].q.id === q.id) nextQ();
    }, 700);
  }
}
function revealAns() {
  const it = P.pool[P.idx], q = it.q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
  // 仅用于正确显示，不调 recordAnswer——"看答案"不是正式作答
  a.correct = a.chosen && a.chosen.length ? sameSet(a.chosen, q.correct) : false;
  a.revealed = true; saveSession(); renderPlayer();
}
function nextQ() {
  // 考试未交卷时，最后一题不允许“下一题”结束，必须点「交卷」评分
  if (P.mode === 'exam' && !P.submitted) {
    if (P.idx >= P.pool.length - 1) { toast('请点击「交卷」结束考试'); return; }
    P.idx++; saveSession(); renderPlayer(); return;
  }
  if (P.idx >= P.pool.length - 1) finishPractice(); else { P.idx++; saveSession(); renderPlayer(); }
}
function prevQ() { if (P.idx > 0) { P.idx--; saveSession(); renderPlayer(); } }
function finishPractice() { if (window.QuizSync) window.QuizSync.forceFlush(); clearSession(); closePlayer(); show(activeTab); toast('本组练习完成 ' + ICON('party')); }
function submitExam() {
  if (!P) return;
  if (P.timer) clearInterval(P.timer);
  P.submitted = true;
  let right = 0, total = P.pool.length;
  for (const it of P.pool) {
    const q = it.q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
    const correct = a.chosen && a.chosen.length ? sameSet(a.chosen, q.correct) : false;
    a.correct = correct; a.revealed = true; if (correct) right++;
    recordAnswer(q, it.chapterId, correct);
    updateReview(q, correct, a.chosen);
  }
  const score = total ? Math.round(right / total * 100) : 0;
  const st = curState();
  st.examHistory = st.examHistory || [];
  st.examHistory.push({
    date: Date.now(), score, right, total,
    minutes: P.modeOpt.minutes || Math.round((Date.now() - P.start) / 60000),
    src: P.modeOpt.src || 'exam',   // 'filter' = 组卷中心自组卷；'exam' = 旧版抽题卷
    cond: P.modeOpt.cond || '',
  });
  if (st.examHistory.length > 50) st.examHistory.shift();
  if (score >= 90) addBadge('exam90');
  checkBadges(); save(); if (window.QuizSync) window.QuizSync.forceFlush(); clearSession();
  closePlayer();
  openModal(`<h3>考试结束</h3>
    <div class="score-big" style="color:${score >= 60 ? 'var(--ok)' : 'var(--bad)'}">${score} 分</div>
    <p class="muted">答对 ${right}/${total} 题 · 用时 ${P.modeOpt.minutes || Math.round((Date.now() - P.start) / 60000)} 分钟</p>
    <button class="btn" data-act="review-exam">查看作答回顾</button>
    <button class="btn ghost" data-act="exam-back">返回成就</button>`);
}
function reviewExam() { openPlayer(); P.mode = 'review'; P.idx = 0; renderPlayer(); }
function openSheet() {
  let nRight = 0, nWrong = 0, nDone = 0;
  const cells = P.pool.map((it, i) => {
    const a = P.answers[it.q.id]; let cls = 'cell';
    if (a) { if (a.revealed) { if (a.correct) { cls += ' right'; nRight++; } else { cls += ' wrong'; nWrong++; } } else if (a.chosen && a.chosen.length) { cls += ' done'; nDone++; } }
    return `<div class="${cls}" data-act="sheet-go" data-i="${i}">${i + 1}</div>`;
  }).join('');
  const nTodo = P.pool.length - nRight - nWrong - nDone;
  openModal(`<h3>答题卡</h3>
    <div class="sheet-sum"><span class="mstag m3">✅ 答对 ${nRight}</span><span class="mstag m1">❌ 答错 ${nWrong}</span><span class="mstag m0">⬜ 未判 ${nDone}</span><span class="mstag m0">— 未答 ${nTodo}</span></div>
    <div class="sheet">${cells}</div>
    <div class="qnav-legend"><span><i class="dot"></i>未作答</span><span><i class="dot ok"></i>答对</span><span><i class="dot bad"></i>答错</span></div>
    <button class="btn ghost" data-act="close-modal">关闭</button>`);
}

/* ---------- 可视化 ---------- */
/* DPR 适配：高分屏按 devicePixelRatio 放大画布后备存储，逻辑坐标仍用 CSS 像素，
 * 否则 canvas 在 Retina / 高分屏上发虚。切主题后 cssVar 重新取色，redrawCharts() 重画即可。 */
function fitCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return ctx;
}
let _trend = [], _trendLabels = [];
function toRGBA(c, a) {
  c = (c || '').trim();
  let m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(',').map(s => parseFloat(s)); return `rgba(${p[0]},${p[1]},${p[2]},${a})`; }
  if (c[0] === '#') { let h = c.slice(1); if (h.length === 3) h = h.split('').map(x => x + x).join(''); const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
  return c;
}
function smoothPath(ctx, pts) {
  for (let i = 0; i < pts.length - 1; i++) { const xc = (pts[i].x + pts[i + 1].x) / 2, yc = (pts[i].y + pts[i + 1].y) / 2; ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc); }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}
const HM_TIERS = ['查无此人', '轻轻路过', '持续输出', '效率拉满', '卷王模式'];
function openHeatmapModal() {
  const st = curState();
  const hmDays = []; for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); hmDays.push(d); }
  const hmCnt = hmDays.map(d => { const dy = st.daily[ymd(d)] || {}; return dy.answered || 0; });
  const hmMax = Math.max(1, ...hmCnt);
  let peak = 0;
  hmCnt.forEach(a => { const lv = a === 0 ? 0 : a <= hmMax * 0.2 ? 1 : a <= hmMax * 0.45 ? 2 : a <= hmMax * 0.7 ? 3 : 4; if (lv > peak) peak = lv; });
  const sw = ['var(--surface2)', '#e6f4ea', '#b7e0c2', '#6cc78a', '#1f9d55'];
  const rows = HM_TIERS.map((n, i) => `<div class="hm-tier ${i === peak ? 'on' : ''}"><span class="hm-tier-sw" style="background:${sw[i]}"></span><span class="hm-tier-n">${n}</span>${i === peak ? '<b class="hm-tier-tag">当前段位</b>' : ''}</div>`).join('');
  openModal(`<h3>${ICON('fire')}刷题段位</h3>
    <p class="muted small" style="margin:0 0 12px">近 30 天单日最高刷题 <b>${hmMax}</b> 题 · 你的段位：<b style="color:var(--primary-d)">${HM_TIERS[peak]}</b></p>
    <div class="hm-tiers">${rows}</div>
    <button class="btn ghost" data-act="modal-close" style="margin-top:14px">关闭</button>`);
}
let _badgeBackToWall = false;   // 徽章详情由「徽章墙」打开时，关闭/返回应回到徽章墙，而非成就页
function openBadgeListModal() {
  _badgeBackToWall = false;     // 进入徽章墙本级：此后关闭即回成就页
  const g = S.global;
  const items = BADGES.map(b => {
    const got = inSet(g.badges, b.id);
    const t = (g.badgeTimes && g.badgeTimes[b.id]) ? new Date(g.badgeTimes[b.id]).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="badge ${got ? '' : 'locked'}" data-act="badge-detail" data-id="${b.id}"><div class="em">${b.em}</div><div class="nm">${b.nm}</div><div class="ds">${got ? (t || '已获得') : '未获得'}</div></div>`;
  }).join('');
  openModal(`<h3>${ICON('trophy')}全部徽章（${BADGES.length}）</h3><p class="muted small" style="margin:0 0 12px">已获得 ${g.badges.length} / ${BADGES.length} 枚 · 点击查看详情</p><div class="badge-grid">${items}</div><button class="btn ghost" data-act="modal-close" style="margin-top:14px">关闭</button>`);
}
function openBadgeDetail(id) {
  const m = $('#modal');
  _badgeBackToWall = !!(m && !m.classList.contains('hidden') && m.querySelector('.modal-box .badge-grid'));   // 当前弹层是徽章墙 → 返回时回到墙
  const g = S.global, b = BADGES.find(x => x.id === id); if (!b) return;
  const got = inSet(g.badges, id);
  const t = (g.badgeTimes && g.badgeTimes[id]) ? new Date(g.badgeTimes[id]).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  openModal(`<div class="badge-detail"><div class="em">${b.em}</div>
    <h3 style="margin:6px 0">${b.nm}</h3>
    <p class="muted small" style="margin:0">${b.ds}</p>
    <div class="badge-status ${got ? 'got' : 'no'}">${got ? ICON('check') + '已获得' : ICON('lock') + '未获得'}</div>
    ${got && t ? `<p class="muted small" style="margin:8px 0 0">获得时间：${t}</p>` : ''}
    <button class="btn ghost" data-act="badge-detail-back" style="margin-top:12px">${_badgeBackToWall ? '‹ 返回徽章墙' : '关闭'}</button></div>`);
}
function drawTrend(canvas, data, labels) {
  if (!canvas) return;
  const W = 320, H = 180, ctx = fitCanvas(canvas, W, H); if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const text = cssVar('--muted'), grid = cssVar('--border'), bar = cssVar('--primary'), barLast = cssVar('--ok');
  if (!data || data.length < 1) { ctx.fillStyle = text; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('暂无正确率数据', W / 2, H / 2); return; }
  labels = labels || data.map(() => '');
  const padL = 32, padR = 14, padT = 18, padB = 24, x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  const Y = v => y1 - v / 100 * (y1 - y0);
  ctx.font = '9px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let g = 0; g <= 100; g += 25) {
    const y = Y(g);
    ctx.strokeStyle = grid; ctx.globalAlpha = g === 0 ? 0.85 : 0.3; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = text; ctx.fillText(g + '%', x0 - 5, y);
  }
  const n = data.length, slot = (x1 - x0) / n, bw = Math.min(22, slot * 0.62);
  data.forEach((v, i) => {
    if (v == null) return;
    const cx = x0 + slot * (i + 0.5);
    const top = Y(v), h = y1 - top;
    ctx.fillStyle = (i === n - 1) ? barLast : bar;
    ctx.globalAlpha = 0.92;
    roundRectTop(ctx, cx - bw / 2, top, bw, h, 4); ctx.fill(); ctx.globalAlpha = 1;
    if (i === n - 1) { ctx.font = 'bold 11px sans-serif'; ctx.fillStyle = barLast; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(v + '%', cx, top - 5); }
  });
  ctx.font = '9px sans-serif'; ctx.fillStyle = text; ctx.textBaseline = 'top';
  ctx.textAlign = 'left'; ctx.fillText(labels[0] || '', x0, y1 + 6);
  ctx.textAlign = 'center'; ctx.fillText(labels[Math.floor((n - 1) / 2)] || '', x0 + slot * (Math.floor((n - 1) / 2) + 0.5), y1 + 6);
  ctx.textAlign = 'right'; ctx.fillText(labels[n - 1] || '', x1, y1 + 6);
}
function roundRectTop(ctx, x, y, w, h, r) {
  if (h <= 0) return; r = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h); ctx.closePath();
}
function redrawCharts() { const t = $('#trend'); if (t) drawTrend(t, _trend, _trendLabels); }  // B17：切主题后按新 cssVar 重绘

/* ---------- 清空学习进度（按题库范围） ----------
 * 三条设计约束：
 * ① 只清「作答类」字段。旧实现是把整份状态换成初始值 —— 想删记录，顺手把 XP、徽章、打卡
 *    也清零了，等于把家当一起删。现在成就 / 打卡 / XP / 偏好 / 纠错 / AI 题库 一律保留。
 * ② 题库可分别清。分类靠「分片加载时登记的 id→题库」表（QGROUP，别名一并登记）——
 *    A02 统一 id 网之后扩展题主 id 是源站稳定 id（ykb_/school_/kaoyan_），不再以 ext- 开头，
 *    只看前缀会把扩展题当成极光题删掉。未载入的学科在清空前会先补载。
 * ③ 断点会话同步裁剪：整卷被清掉就删会话，部分被清就裁 qids/answers 并把游标夹回合法范围。
 * 分类口径：AI 变式（aigen: 章节 / aiGen 里的 batch id）→ ai ｜ 其余按 QGROUP（分片登记）
 * 判 jg/ext，别名同样登记；分片没载入时才退回 id 前缀兜底。
 */
let RST = null;
function idGroupOf(id, aiIds) {
  const s = String(id || '');
  if (aiIds && aiIds.has(s)) return 'ai';
  /* 权威来源：分片加载时登记的「题 id / 别名 → 题库」。只看前缀在 A02 之后会误判
   * （扩展题主 id 已是 ykb_/school_/kaoyan_ 这类源站 id）。分片没载入时才退回前缀。 */
  const g = QGROUP[s] || QGROUP[ALIAS[s] || s];
  if (g) return g;
  return s.indexOf('ext-') === 0 || /^(ykb_|school_|kaoyan_)/.test(s) ? 'ext' : 'jg';
}
function chGroupOf(cid) {
  const s = String(cid || '');
  if (s.indexOf('aigen:') === 0) return 'ai';
  if (CGROUP[s]) return CGROUP[s];
  return s.charAt(0) === 'x' ? 'ext' : 'jg';   // jg 章节 id 是 UUID，不可能以 x 开头
}
/* AI 题的 id 是随机 uid，只能从 aiGen 批次现取 */
function aiIdSet(st) {
  const s = new Set();
  for (const b of ((st && st.aiGen) || [])) for (const q of (b.questions || [])) if (q && q.id) s.add(q.id);
  return s;
}
function rstTargets() {
  /* 章节筛选锁定当前学科（章节 id 跨学科不唯一，见 rstChList 注释） */
  if (rstHasCh()) return [cur];
  const ids = RST.allSubjects ? Object.keys(S.subjects) : [cur];
  return [...new Set(ids.concat([cur]))].filter(Boolean);
}
/* 章节筛选（用户反馈）：勾了章节就只清这些章节内的题。
 * 章节 id 不是全局唯一（扩展章 id 由章节名拼出，跨学科会撞），所以章节筛选锁定当前学科。 */
function rstHasCh() { return !!(RST && RST.chapters && RST.chapters.length); }
function rstChList() {
  const sub = SB[cur]; if (!sub || !sub.groups) return [];
  return [...(sub.groups.jg.chapters || []), ...(sub.groups.ext.chapters || [])];
}
/* 当前学科 题 id → 章节 id 映射（含两题库；AI 题不进映射 → 章节模式下 AI 存档不受影响，面板会注明） */
function rstChMap() {
  const m = {};
  const sub = SB[cur];
  if (sub && sub.groups) for (const grp of ['jg', 'ext']) for (const c of (sub.groups[grp].chapters || [])) for (const q of c.questions) m[q.id] = c.id;
  return m;
}
/* 只统计不改动 —— 面板上的明细必须是真数字，不能拿总题数糊弄 */
/* ch=章节筛选（Set<章节id>，null=不限），qm=题id→章节id 映射；两者成对出现 */
function progCounts(st, groups, ch, qm) {
  const ai = aiIdSet(st), hit = id => groups.has(idGroupOf(id, ai)) && (!ch || ch.has(qm[id]));
  const keys = k => Object.keys(st[k] || {}).filter(hit).length;
  let daily = 0;
  for (const d in (st.daily || {})) daily += st.daily[d].answered || 0;
  return {
    wrong: (st.wrong || []).filter(hit).length,
    fav: (st.fav || []).filter(hit).length,
    doubt: (st.doubt || []).filter(hit).length,
    mastered: (st.mastered || []).filter(hit).length,
    stat: keys('qstat'), review: keys('review'),
    exam: (st.examHistory || []).length, daily,
    fb: (st.feedback || []).length,
    ai: groups.has('ai') ? (st.aiGen || []).length : 0,
  };
}
function clearSubjectProgress(st, groups, ch, qm) {
  const ai = aiIdSet(st), hit = id => groups.has(idGroupOf(id, ai)) && (!ch || ch.has(qm[id]));
  const drop = a => (a || []).filter(id => !hit(id));
  /* A11 tombstone：清空 = 显式删除动作，同样记墓碑 → 跨设备清空进度能传播（另一端同名记录也移除） */
  for (const f of ['wrong', 'fav', 'doubt', 'mastered']) {
    const before = st[f] || [];
    st[f] = drop(before);
    for (const id of before) if (st[f].indexOf(id) < 0) tombMark(st, f, id, 1);
  }
  for (const k of ['qstat', 'review']) {
    if (!st[k]) continue;
    for (const id of Object.keys(st[k])) if (hit(id)) delete st[k][id];
  }
  /* 注意：feedback（纠错）是用户亲手写的，属于「内容」而非「作答记录」，一律不删 */
  if (groups.has('ai') && !ch) st.aiGen = [];   // AI 题无法可靠映射回章节 → 章节模式下不动 AI 存档
  // 章节键也能分类（x… 扩展 / aigen:… AI / UUID 极光）；清除 = 组被选 且（无章节筛选 或 章节被选）
  st.byChapter = Object.fromEntries(Object.entries(st.byChapter || {}).filter(([cid]) => !groups.has(chGroupOf(cid)) || (ch && !ch.has(cid))));
  // 每日统计与考试记录是「按天/按场汇总」的，无法按题拆 → 非章节模式动了任一题库才整体归零；
  // 章节模式只清所选章节的题级记录，日/场级汇总原样保留
  if (!ch) { st.daily = {}; st.examHistory = []; }
  st.hadWrong = !!(st.wrong && st.wrong.length);
  return st;
}
function clearSessionsProgress(groups, ch) {
  const subs = rstTargets();
  for (const k of Object.keys(S.sessions || {})) {
    const s = S.sessions[k]; if (!s) continue;
    if (subs.indexOf(s.subject) < 0) continue;
    const ai = aiIdSet(S.subjects[s.subject]);
    /* 断点 qids 自带 chapterId → 章节筛选直接比章节，无需映射 */
    const keep = (s.qids || []).filter(e => !groups.has(idGroupOf(e.id, ai)) || (ch && !ch.has(e.chapterId)));
    if (keep.length === (s.qids || []).length) continue;
    if (!keep.length) { delete S.sessions[k]; continue; }
    const kept = new Set(keep);
    for (const qid of Object.keys(s.answers || {})) if (!kept.has(qid)) delete s.answers[qid];
    s.qids = keep;
    s.idx = Math.min(Math.max(0, s.idx || 0), keep.length - 1);
    s.updatedAt = Date.now();
  }
}
const RST_NAME = { jg: '极光题库', ext: '扩展题库', ai: 'AI 变式题' };
function resetSetup() {
  if (!RST) RST = { groups: ['jg', 'ext', 'ai'], allSubjects: false, clearEng: false, chapters: [], chOpen: false };
  /* 「全部学科」时把还没载入的学科补载一下，再重画一次 —— 否则未载入学科的扩展题
   * 没有 QGROUP 登记，会被按前缀误判成极光题，面板明细与随后的清空都会算错。 */
  if (RST.allSubjects) {
    const pend = Object.keys(S.subjects).filter(sid => SB[sid] && !LOADED.has(sid));
    if (pend.length) Promise.all(pend.map(sid => ensureSubject(sid).catch(() => {}))).then(() => { if (RST && RST.allSubjects) { try { resetSetup(); } catch (e) {} } });
  }
  const groups = new Set(RST.groups);
  const chActive = rstHasCh();
  const chList = rstChList();
  /* 勾选的章节可能因切学科/数据更新而失效 —— 渲染前先剔掉，数字才真 */
  if (chActive) {
    const valid = new Set(chList.map(c => c.id));
    RST.chapters = RST.chapters.filter(cid => valid.has(cid));
    if (!RST.chapters.length) { RST.chOpen = false; return resetSetup(); }
  }
  const chSet = chActive ? new Set(RST.chapters) : null;
  const qm = chActive ? rstChMap() : null;
  const chQn = chActive ? chList.filter(c => chSet.has(c.id)).reduce((n, c) => n + c.questions.length, 0) : 0;
  const subs = rstTargets();
  const agg = { wrong: 0, fav: 0, doubt: 0, mastered: 0, stat: 0, review: 0, exam: 0, daily: 0, fb: 0, ai: 0 };
  for (const sid of subs) {
    const st = S.subjects[sid]; if (!st) continue;
    const c = progCounts(st, groups, chSet, qm);
    for (const k in agg) agg[k] += (c[k] || 0);
  }
  const total = agg.wrong + agg.fav + agg.doubt + agg.mastered + agg.stat + agg.review;
  openModal(`<h3>${ICON('trash')}清空学习进度</h3>
    <p class="muted small" style="margin:0 0 8px">选择要清掉的题库范围。成就徽章、连续打卡、XP 等级、偏好设置<b>一律保留</b>。</p>
    <div class="rscope">${['jg', 'ext', 'ai'].map(k => `<button class="rpick ${groups.has(k) ? 'on' : ''}" data-act="rst-pick" data-k="${k}">
      <b>${RST_NAME[k]}</b><span>${k === 'ai' ? '自生成变式题' : '客观题库'}</span></button>`).join('')}</div>
    <div class="row" style="gap:8px;margin-top:8px">
      <button class="chip sm ${groups.size === 3 ? 'on' : ''}" data-act="rst-all-grp">三个题库全清</button>
      <button class="chip sm ${RST.allSubjects && !chActive ? 'on' : ''}" data-act="rst-subs" ${chActive ? 'style="opacity:.5"' : ''}>${chActive ? '仅当前学科（章节筛选生效）' : (RST.allSubjects ? `全部学科（${subs.length}）` : `仅当前学科 · ${SB[cur] ? esc(SB[cur].name) : ''}`)}</button>
      <button class="chip sm ${RST.clearEng ? 'on' : ''}" data-act="rst-eng">同时清空医学英语进度</button>
    </div>
    <div class="row" style="gap:8px;margin-top:6px">
      <button class="chip sm ${RST.chOpen || chActive ? 'on' : ''}" data-act="rst-chmode">${ICON('doc')}按章节筛选${chActive ? `（已选 ${RST.chapters.length} 章 / ${chQn} 题）` : ''}</button>
      ${chActive ? `<button class="chip sm" data-act="rst-ch-none">清除章节选择</button>` : ''}
    </div>
    ${RST.chOpen ? `<div class="rst-chlist">${chList.map(c => `<div class="rst-ch ${chSet && chSet.has(c.id) ? 'on' : ''}" data-act="rst-ch" data-cid="${esc(c.id)}" role="checkbox" aria-checked="${chSet && chSet.has(c.id)}">
      <i class="rst-chbox"></i><span>${esc(c.name)}</span><em>${c.grp === 'ext' ? '扩展' : '极光'} · ${c.questions.length} 题</em></div>`).join('') || '<div class="muted small">当前学科暂无章节数据</div>'}</div>` : ''}
    <div class="rsum">
      <div class="rl"><span>错题 / 收藏 / 疑点</span><b>${agg.wrong} / ${agg.fav} / ${agg.doubt}</b></div>
      <div class="rl"><span>掌握度与作答统计</span><b>${agg.stat} 题 · 已掌握 ${agg.mastered}</b></div>
      <div class="rl"><span>间隔回顾</span><b>${agg.review}</b></div>
      <div class="rl"><span>纠错记录</span><b>${agg.fb}（保留）</b></div>
      <div class="rl hi"><span>每日统计 / 考试记录</span><b>${agg.daily} 次作答 · ${agg.exam} 场</b></div>
      ${groups.has('ai') ? `<div class="rl hi"><span>AI 变式题存档</span><b>${agg.ai} 批${chActive ? '（章节筛选下不动）' : ''}</b></div>` : ''}
      <div class="rkeep">${ICON('warn')}每日统计与考试记录是「按天 / 按场汇总」的，没法按题拆开 —— 只要清了任意题库，这两项就整体归零。纠错是你自己写的，不删。${chActive ? '<br>' + ICON('doc') + ' 章节筛选生效：仅清所选章节内题目的记录；章节筛选只对当前学科可用，AI 变式题无法按章节归属、保持不动。' : ''}</div>
    </div>
    <p class="muted small" style="margin:10px 0 0">保留：${S.global.xp} XP · ${S.global.badges.length} 枚徽章 · ${S.global.checkin.length} 天打卡${total ? '' : '（当前所选范围没有可清的数据）'}</p>
    <div class="wrap" style="margin-top:10px">
      <button class="btn" data-act="rst-go" style="background:var(--bad)">清空所选学习进度</button>
      <button class="btn ghost" data-act="close-modal">取消</button>
    </div>`);
}
async function doReset() {
  if (!RST) return;
  const groups = new Set(RST.groups);
  if (!groups.size) { toast('先选一个要清空的题库'); return; }
  const chActive = rstHasCh();
  const chSet = chActive ? new Set(RST.chapters) : null;
  const qm = chActive ? rstChMap() : null;
  const subs = rstTargets();
  const scope = groups.size === 3 ? '三个题库' : [...groups].map(k => RST_NAME[k]).join(' + ');
  const subjName = chActive ? (SB[cur] ? SB[cur].name : cur) : (RST.allSubjects ? `全部 ${subs.length} 个学科` : (SB[cur] ? SB[cur].name : cur));
  const chNames = chActive ? rstChList().filter(c => chSet.has(c.id)) : [];
  const chTxt = chActive ? `\n章节范围：${chNames.length} 章（${chNames.slice(0, 4).map(c => c.name).join('、')}${chNames.length > 4 ? ' 等' : ''}）` : '';
  const engNote = RST.clearEng ? '\n\n' + ICON('warn') + '同时会清空「医学英语」的单词熟悉度进度（此项不可恢复）。' : '';
  if (!confirm(`确定清空「${subjName}」中「${scope}」的学习进度？${chTxt}\n\n会删除：所选范围内题目的错题、收藏、疑点、掌握度、间隔回顾${chActive ? '' : '、每日统计、考试记录'}。\n会保留：成就徽章、连续打卡、XP 等级、偏好设置、纠错记录。${engNote}\n\n此操作不可恢复。`)) return;
  /* 分类依赖 QGROUP（分片加载时登记）——未载入的学科先补上，否则扩展题会被误判成极光题删掉 */
  for (const sid of subs) { if (SB[sid] && !LOADED.has(sid)) { try { await ensureSubject(sid); } catch (e) {} } }
  for (const sid of subs) { const st = S.subjects[sid]; if (st) clearSubjectProgress(st, groups, chSet, qm); }
  if (RST.clearEng) S.global.english = {};   // C06：医学英语进度独立存储，需显式清空
  if (RST.clearEng && window.QuizEnglish) window.QuizEnglish.reset();   // 同步清空云端英语进度
  clearSessionsProgress(groups, chSet);
  save();
  try { if (window.QuizSync && window.QuizSync.forceFlush) window.QuizSync.forceFlush(); } catch (e) {}
  closeModal(); show('me');
  toast(chActive ? `已清空 ${chNames.length} 个章节内的学习进度` : '已清空所选学习进度');
}

/* ---------- 事件分发 ---------- */
function onAct(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (window.Feat && Feat.act(act, t)) return;   // 二期功能（高级筛选 / 纠错 / 偏好）优先接管
  /* 医学英语：eng-* 全部交给 Eng.act（异步，不阻塞分发） */
  if (window.Eng && String(act).indexOf('eng-') === 0) { Eng.act(act, t); return; }
  if (act === 'goto') { closeModal(); show(t.dataset.tab); return; }
  if (act === 'close-modal') { pendingResume = null; closeModal(); return; }
  if (act === 'open-lixiangguo') { openLixiangguo(); return; }
  if (act === 'close-lixiangguo') { closeLixiangguo(); return; }
  if (act === 'resume-home') { const s = latestSession(); if (s) resumeSession(s); return; }
  if (act === 'resume-yes') { const p = pendingResume; pendingResume = null; closeModal(); if (p) resumeSession(p.saved); return; }
  if (act === 'resume-no') { const p = pendingResume; pendingResume = null; closeModal(); if (p) { clearSessionKey(p.saved.key); p.freshStartFn(); } return; }
  if (act === 'checkin') { doCheckin(); return; }
  if (act === 'checkin-info') { openCheckinInfo(); return; }
  if (act === 'start-order') { orderSetup(); return; }
  if (act === 'start-review') { startReview(); return; }
  if (act === 'rv-mode') { reviewCenterMode = t.dataset.v; openReviewCenter(); return; }
  if (act === 'eng-review-launch') { launchEngReview(); return; }
  if (act === 'eng-fam-launch') { launchEngFamiliar(t.dataset.v); return; }
  if (act === 'eng-wrong-word') { launchEngImmersive(t.dataset.id); return; }
  if (act === 'modal-close') { closeModal(); return; }
  if (act === 'badge-more') { openBadgeListModal(); return; }
  if (act === 'badge-detail') { openBadgeDetail(t.dataset.id); return; }
  if (act === 'badge-detail-back') { if (_badgeBackToWall) openBadgeListModal(); else closeModal(); return; }
  if (act === 'hm-click') { openHeatmapModal(); return; }
  if (act === 'chacc-more') { chapterAccModal(); return; }
  if (act === 'rv-start') {
    const st = curState(), key = t.dataset.pool;
    let ids;
    if (key === 'due') ids = reviewQueue(st);
    else if (key === 'new') ids = reviewStats(st).newWrong;
    else if (key === 'repeat') ids = reviewStats(st).repeat.slice().sort((a, b) => ((st.qstat[b] || {}).w || 0) - ((st.qstat[a] || {}).w || 0)).slice(0, 100);
    startReviewPool(ids); return;
  }
  if (act === 'rv-feel') { rvFeel(t.dataset.id, t.dataset.v); return; }
  if (act === 'rv-restore') {
    const st = curState(), id = t.dataset.id;
    if (st.review && st.review[id]) { const r = st.review[id]; r.mastered = false; r.stage = 0; r.streak = 0; r.streakFrom = null; r.nextReview = Date.now() + 86400000; }
    save(); openReviewCenter(); return;
  }
  if (act === 'start-ai') { openAiGenList(); return; }
  if (act === 'go-english') {
    show('english');
    /* 单词页异步渲染（loadMan→view）：等挂载 → 切「卡片背诵」模式（非默认列表）→ 滚动居中（B19/B20） */
    (async () => {
      for (let i = 0; i < 60; i++) { if (document.getElementById('engModeCard')) break; await new Promise(r => setTimeout(r, 50)); }
      if (window.Eng && Eng.enterCardMode) { try { await Eng.enterCardMode(); } catch (e) {} }
      requestAnimationFrame(() => {
        const tgt = document.querySelector('#engBody .eng-card-stage') || document.getElementById('engModeCard');
        if (tgt) tgt.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    })();
    return;
  }
  if (act === 'go-leisure') {
    show('honor');
    setTimeout(() => { const c = document.getElementById('leisureCard'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
    return;
  }
  if (act === 'set-group') { setGroup(cur, t.dataset.k); closePlayer(); show(activeTab); return; }
  if (act === 'chapter') {
    const c = curSub().chapters.find(x => x.id === t.dataset.id);
    if (c) openChapterNav(c);
    return;
  }
  if (act === 'jump-q') {
    const c = curSub().chapters.find(x => x.id === t.dataset.id);
    const qi = parseInt(t.dataset.qi) || 0;
    if (c) jumpToQuestion(c, qi);
    return;
  }
  if (act === 'back-chapters') { orderSetup(); return; }
  if (act === 'clear-search') { $('#bkSearch').value = ''; $('#bkChapter').value = ''; $('#bkSearch').dispatchEvent(new Event('input')); return; }
  if (act === 'bk-more') { _bkPage++; renderBankList(); return; }
  if (act === 'qview') { openQDetail(t.dataset.id); return; }
  if (act === 'ai-gen') { if (!P) return; doAiGen(P.pool[P.idx].q); return; }
  if (act === 'ai-gen-q') { doAiGenQid(t.dataset.id); return; }
  if (act === 'ai-explain') { if (!P) return; doAiExplain(P.pool[P.idx].q); return; }
  if (act === 'ai-explain-q') { doAiExplainQid(t.dataset.id); return; }
  if (act === 'ai-trace') { aiTrace(t.dataset.bid); return; }
  if (act === 'ai-practice') { startAiPractice(t.dataset.bid); closeModal(); return; }
  if (act === 'ai-gen-list') { openAiGenList(); return; }
  if (act === 'ai-gen-open') { openAiGenBatch(t.dataset.bid); return; }
  if (act === 'toggle-fav') { const st = curState(), id = t.dataset.id; inSet(st.fav, id) ? markRem(st, 'fav', id) : markAdd(st, 'fav', id); save(); closeModal(); toast(inSet(st.fav, id) ? '已收藏 ' + ICON('star') : '已取消收藏'); if ($('#player').classList.contains('hidden')) show(activeTab); else renderPlayer(); return; }
  if (act === 'toggle-doubt') { const st = curState(), id = t.dataset.id; inSet(st.doubt, id) ? markRem(st, 'doubt', id) : markAdd(st, 'doubt', id); save(); closeModal(); toast(inSet(st.doubt, id) ? '已标记疑点 ❓' : '已取消疑点'); if ($('#player').classList.contains('hidden')) show(activeTab); else renderPlayer(); return; }
  if (act === 'remove-wrong') { const st = curState(), id = t.dataset.id; markRem(st, 'wrong', id); save(); closeModal(); toast('已移出错题'); if ($('#player').classList.contains('hidden')) show(activeTab); else renderPlayer(); return; }
  if (act === 'wtab') { wrongTab = t.dataset.k; show('wrong'); return; }
  if (act === 'ew-clear') { const s = document.getElementById('ewSearch'); if (s) s.value = ''; show('wrong'); return; }
  if (act === 'pick' || act === 'pick-exam') { pick(t.dataset.k); return; }
  if (act === 'confirm') { confirmAns(); return; }
  if (act === 'reveal') { revealAns(); return; }
  if (act === 'next') { nextQ(); return; }
  if (act === 'prev') { prevQ(); return; }
  if (act === 'submit-exam') { submitExam(); return; }
  if (act === 'pfav' || act === 'pdoubt') {
    const st = curState(), id = t.dataset.id, set = act === 'pfav' ? 'fav' : 'doubt';
    inSet(st[set], id) ? markRem(st, set, id) : markAdd(st, set, id);
    save(); renderPlayer();
    const on = inSet(st[set], id);
    toast(act === 'pfav' ? (on ? '已收藏 ' + ICON('star') : '已取消收藏') : (on ? '已标记疑点 ' + ICON('question') : '已取消疑点'));
    return;
  }
  if (act === 'sheet') { openSheet(); return; }
  if (act === 'sheet-go') { P.idx = parseInt(t.dataset.i); closeModal(); renderPlayer(); return; }
  if (act === 'exit-player') { saveSession(); closePlayer(); return; }
  if (act === 'review-exam') { reviewExam(); return; }
  if (act === 'exam-back') { closeModal(); show('honor'); return; }
  if (act === 'toggle-dark') { S.global.settings.dark = !S.global.settings.dark; applySettings(); save(); show('me'); return; }
  if (act === 'set-font') { S.global.settings.font = t.dataset.k; applySettings(); save(); show('me'); return; }
  if (act === 'save-settings') { const ex = ($('#setExam').value || '').trim(); const gl = parseInt($('#setGoal').value) || 50; S.global.settings.examDate = ex || null; S.global.settings.dailyGoal = Math.max(1, gl); save(); toast('设置已保存'); show('me'); return; }
  if (act === 'export-data') { exportData(); return; }
  if (act === 'import-data') { const fi = $('#fileInput'); if (fi) fi.click(); return; }
  if (act === 'banner-close') { bannerDismissed = true; updateBackupBanner(); return; }
  if (act === 'wmastery') { wrongMasteryFilter = t.dataset.k === '' ? null : t.dataset.k; show('wrong'); return; }
  if (act === 'wbank-mode') { wrongBankMode = t.dataset.v; show('wrong'); return; }
  /* 非选择题（无选项）自评 */
  if (act === 'nc-reveal') {
    const it = P.pool[P.idx], q = it.q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
    a.text = ((document.querySelector('.nochoice textarea') || {}).value || '');
    a.revealed = true; a.correct = false; a.selfJudge = true; saveSession(); renderPlayer(); return;
  }
  if (act === 'nc-right' || act === 'nc-wrong') {
    const it = P.pool[P.idx], q = it.q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
    a.text = ((document.querySelector('.nochoice textarea') || {}).value || '');
    const ok = act === 'nc-right';
    a.correct = ok; a.revealed = true;
    recordAnswer(q, it.chapterId, ok); updateReview(q, ok, []);
    saveSession(); renderPlayer(); return;
  }
  if (act === 'nc-undo') {
    const it = P.pool[P.idx], q = it.q;
    delete P.answers[q.id]; saveSession(); renderPlayer(); return;
  }
  /* 清空学习进度（按题库范围）—— 只清作答记录，见 clearSubjectProgress 注释 */
  if (act === 'reset-setup') { resetSetup(); return; }
  if (act === 'rst-pick') {
    const k = t.dataset.k, i = RST && RST.groups.indexOf(k);
    if (RST && i >= 0) RST.groups.splice(i, 1); else if (RST) RST.groups.push(k);
    resetSetup(); return;
  }
  if (act === 'rst-all-grp') { if (RST) RST.groups = ['jg', 'ext', 'ai']; resetSetup(); return; }
  if (act === 'rst-subs') { if (RST) { if (rstHasCh()) { toast('章节筛选只对当前学科生效，先清除章节选择'); } else { RST.allSubjects = !RST.allSubjects; } } resetSetup(); return; }
  if (act === 'rst-eng') { if (RST) RST.clearEng = !RST.clearEng; resetSetup(); return; }
  if (act === 'rst-chmode') { if (RST) RST.chOpen = !RST.chOpen; resetSetup(); return; }
  if (act === 'rst-ch-none') { if (RST) { RST.chapters = []; RST.chOpen = false; } resetSetup(); return; }
  if (act === 'rst-ch') {
    if (RST) { const cid = t.dataset.cid, i = RST.chapters.indexOf(cid); if (i >= 0) RST.chapters.splice(i, 1); else RST.chapters.push(cid); }
    resetSetup(); return;
  }
  if (act === 'rst-go') { doReset().catch(() => {}); return; }
}
function doCheckin() {
  const d = today(); if (inSet(S.global.checkin, d)) { toast('今天已打卡'); return; }
  S.global.checkin.push(d); addXp(10); checkBadges(); save(); toast('打卡成功 +10 XP ' + ICON('fire')); show(activeTab);
}
function openCheckinInfo() {
  const sk = streak();
  openModal(`<div class="checkin-info"><div class="em">${ICON('fire')}</div>
    <h3 style="margin:6px 0">今日已打卡</h3>
    <p class="muted small" style="margin:0">连续打卡 <b style="color:var(--primary)">${sk}</b> 天 · 明天再来保持火苗不灭</p>
    <button class="btn ghost" data-act="modal-close" style="margin-top:14px">好的</button></div>`);
}
function applySettings() {
  document.body.classList.toggle('dark', !!S.global.settings.dark);
  redrawCharts();  // B17：暗色切换后图表按新 token 重绘
  const tc = document.querySelector('meta[name="theme-color"]'); if (tc) tc.setAttribute('content', S.global.settings.dark ? '#1a1d29' : '#4f6ef7'); // C03：主题色跟随暗色
  document.body.classList.toggle('plain', !!S.global.settings.plain);
  /* 背景主题：只切 <body data-bg>，样式全在 themes.css（组件不感知主题） */
  document.body.dataset.bg = S.global.settings.bg || 'classic';
  const app = $('#app'); app.className = 'font-' + (S.global.settings.font || 'm');
}
/* 预览用具：?bg=cn&dark=1&font=l 只影响本次显示、不落盘。
 * 用途：把主题链接直接发出去比「你去设置里点一下」省事（也方便 _preview/bgs.html 做真机对比）。 */
function applyUrlPreview() {
  let q;
  try { q = new URLSearchParams(location.search); } catch (e) { return null; }
  const bg = q.get('bg'), dark = q.get('dark'), font = q.get('font'), plain = q.get('plain');
  if (!bg && dark == null && !font && plain == null) return null;
  const o = {};
  if (bg) { document.body.dataset.bg = bg; o.bg = bg; }
  if (dark != null) { const on = dark !== '0' && dark !== 'false'; document.body.classList.toggle('dark', on); o.dark = on; }
  if (font) { $('#app').className = 'font-' + font; o.font = font; }
  if (plain != null) document.body.classList.toggle('plain', plain !== '0' && plain !== 'false');
  return o;
}

/* 移动端左右滑动切题 */
function bindSwipe() {
  const pl = $('#player');
  let sx = 0, sy = 0, st = 0, dir = 0; // dir: 0 未定 / 1 横向 / -1 纵向
  const TH = 45;                        // 触发切换所需的最小水平位移
  const swipeOn = () => !!S.global.settings.swipe;   // 偏好：滑动翻题可关闭，避免误触
  pl.addEventListener('touchstart', e => { if (!swipeOn()) return; const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); dir = 0; }, { passive: true });
  pl.addEventListener('touchmove', e => {
    if (!swipeOn() || !P || $('#player').classList.contains('hidden')) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (dir === 0 && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) dir = Math.abs(dx) > Math.abs(dy) ? 1 : -1; // 先出现的方向锁定手势
    if (dir === 1) e.preventDefault();   // 横向手势：阻止浏览器纵向滚动抢走事件
  }, { passive: false });
  const finish = e => {
    if (!swipeOn() || !P || $('#player').classList.contains('hidden')) return;
    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]); if (!t) return;
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (dir === 1 && Math.abs(dx) > TH && Math.abs(dy) < 90) dx < 0 ? nextQ() : prevQ(); // 左滑下一题，右滑上一题
  };
  pl.addEventListener('touchend', finish, { passive: true });
  pl.addEventListener('touchcancel', finish, { passive: true }); // 手势被浏览器取消也要兜底判定
}

/* ---------- 备份 / 备考设置 / 横幅 / Tab 红点 ---------- */
let bannerDismissed = false;
function isInAppBrowser() { const ua = navigator.userAgent || ''; return /QQ\/|MicroMessenger|Weibo|Alipay|UCBrowser|Quark|NewsArticle/i.test(ua) && /Mobile|Android|iPhone|iPad|iPod/i.test(ua); }
function updateBackupBanner() {
  const b = $('#backupBanner'); if (!b) return;
  const showIt = !bannerDismissed && (isInAppBrowser() || !S.global.lastBackup);
  if (!showIt) { b.classList.add('hidden'); return; }
  const msg = isInAppBrowser()
    ? ICON('warn') + ' 你正用 App 内置浏览器打开，进度可能随缓存清理丢失。建议点右上角菜单「在浏览器中打开」，或到「设置」导出 JSON 备份。'
    : ICON('bulb') + ' 数据只存在本机浏览器，换设备 / 清缓存会丢失，建议到「设置」导出 JSON 备份。';
  b.innerHTML = `<span>${msg}</span><button class="banner-x" data-act="banner-close" aria-label="关闭">✕</button>`;
  b.classList.remove('hidden');
}
function exportData() {
  try {
    const payload = { app: 'quiz_v1', version: 1, exportedAt: Date.now(), state: S };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = '刷题记备份_' + ymd(new Date()) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    S.global.lastBackup = Date.now(); save();
    toast('已导出备份 ✓'); updateBackupBanner();
  } catch (e) { toast('导出失败'); }
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const loaded = parsed && parsed.state ? parsed.state : parsed;
      if (!loaded || !loaded.global) throw new Error('文件格式不正确');
      if (!confirm('导入将覆盖当前全部进度，确定继续？')) return;
      S = normalizeState(loaded); save(); applySettings(); rebuildSubjectSelect(); show('me'); toast('导入成功 ✓');
    } catch (e) { toast('导入失败：' + e.message); }
  };
  reader.onerror = () => toast('读取文件失败');
  reader.readAsText(file);
}
function bindMe() {
  const fi = $('#fileInput');
  if (fi) fi.addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) importData(f); fi.value = ''; });
}
function updateTabDot() {
  const dot = $('#dotWrong'); if (!dot) return;
  let n = 0;
  for (const sid in (S.subjects || {})) { const st = S.subjects[sid]; if (st) n += dueReviewIds(st).length; } // C08：跨已载入学科聚合待回顾数
  if (n > 0) { dot.textContent = n > 99 ? '99+' : n; dot.style.display = 'flex'; }
  else dot.style.display = 'none';
}

function subjOptionsHtml() {
  return (MANIFEST.semesters || []).map(sem =>
    `<optgroup label="${esc(sem.name)} · ${sem.count} 题">` +
    sem.subjects.map(s => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}（${s.count}）</option>`).join('') +
    '</optgroup>').join('');
}
/* A09：顶栏「极光 / 扩展」切换框 —— 按当前学科 activeGroup 同步高亮（已去小方块与题数） */
function updateGroupToggle() {
  const sub = curSub();
  const ag = (sub && sub.activeGroup) || 'jg';
  document.querySelectorAll('.grp-toggle').forEach(el => {
    el.querySelectorAll('.gt-cell').forEach(c => {
      const on = c.dataset.k === ag;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');   // 无障碍（审计 P2）：激活态同步 ARIA
    });
  });
}

/* ---------- 初始化 ---------- */
async function init() {
  try {
    await bootData();
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">题库清单加载失败：${esc(String(e))}<br><span class="small">请确认 data/manifest.json 已随站点一起部署</span></div>`;
    return;
  }
  cur = (S.cur && SB[S.cur]) ? S.cur : (SB[cur] ? cur : defaultSubject());
  await ensureSubject(cur);
  /* A13（审计 P1-5）：英语全库预载移出首屏关键路径——旧版 await 卡在 show('home') 之前，
   * 慢网时 31 个分片任一拖慢就拖死首页（旧注释自称"不阻塞首屏"与代码相反）。
   * 现先渲染首页，全库后台到位后若用户仍停留在首页则重画一次，
   * reviewDueTotal 的英语到期计数这才计入（dueCountSync 依赖 allCache）。 */
  if (window.Eng) { try { Eng.loadMan().then(() => Eng.ensureAll()).then(() => { if (activeTab === 'home') show('home'); }).catch(() => {}); } catch (e) {} }

  /* 学科下拉已移入首页 hero（每次 show('home') 重建），改用事件委托，
     元素重建也不丢 change 绑定；切换后软刷新当前 tab。 */
  document.addEventListener('change', async (e) => {
    const sel = e.target;
    if (!sel || sel.id !== 'subjectSelect') return;
    cur = sel.value; closePlayer();
    sel.disabled = true;
    try { await ensureSubject(cur); } catch (err) { toast('该学科数据加载失败'); }
    sel.disabled = false;
    show(activeTab);
  });
  const bi = document.getElementById('brandIco');
  if (bi) bi.addEventListener('click', e => { e.preventDefault(); showEncourage(); });
  updateGroupToggle();

  $$('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));
  document.addEventListener('click', onAct);
  /* 无障碍键盘（审计 P2）：① 选项 role=radio/checkbox 上 Enter/Space 触发点击；② 弹窗开着时 Esc 关闭
   * （与理想国独立 Esc 共存：modal 未开则不动作）。 */
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList && e.target.classList.contains('opt') && e.target.dataset.act) {
      e.preventDefault(); e.target.click(); return;
    }
    if (e.key === 'Escape') {
      const m = $('#modal');
      if (m && !m.classList.contains('hidden')) closeModal();
    }
  });
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') { if (_badgeBackToWall) openBadgeListModal(); else closeModal(); } });
  bindSwipe();
  applySettings();
  applyUrlPreview();   // ?bg= / ?dark= 临时预览（不写盘），必须在 applySettings 之后
  show('home');
}

/* B1：点击左上角「刷题记」品牌图标 → 随机弹一句中二治愈鼓励语，动画进出，多次点击只换词不堆叠 */
const ENC_SPARK = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 2l1.9 5.8L19.5 9l-5.6 1.2L12 16l-1.9-5.8L4.5 9l5.6-1.2z" fill="currentColor"/></svg>';
const ENCOURAGE = [
  '今天的你，比昨天离上岸又近了一厘米 ✦',
  '细胞的分裂有周期，你的努力也有回响',
  '三羧酸循环转一圈，你的知识也转一圈',
  '别慌，线粒体都在为你疯狂产 ATP',
  '刷题如磷酸化，慢一点也会点亮终点',
  '你不是一个人，全宇宙的核糖体都挺你',
  '错题是大脑在悄悄重排突触，别怕',
  '碱基配对要专一，你的目标也要专一',
  '把焦虑交给 GABA，把坚持交给自己',
  '今天的 50 题，是未来录取通知书的像素',
  '钠钾泵一直在逆浓度搬运，你也能逆风翻盘',
  'DNA 会复制，勇气也会；再来一题',
  '你的海马体正在偷偷记下每一个知识点',
  '星光不问赶路人，题库不负有心人',
  '去吧，把今天也刷成一条漂亮的高保真曲线',
];
let _encTimer = null, _encLast = -1;
function showEncourage() {
  let el = document.getElementById('encouragePop');
  if (!el) {
    el = document.createElement('div');
    el.id = 'encouragePop';
    el.innerHTML = '<span class="enc-spk">' + ENC_SPARK + '</span><span class="enc-tx"></span>';
    (document.getElementById('app') || document.body).appendChild(el);
  }
  let i; do { i = (Math.random() * ENCOURAGE.length) | 0; } while (ENCOURAGE.length > 1 && i === _encLast);
  _encLast = i;
  el.querySelector('.enc-tx').textContent = ENCOURAGE[i];
  el.classList.remove('hide'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(_encTimer);
  _encTimer = setTimeout(() => { el.classList.remove('show'); el.classList.add('hide'); }, 1900);
}

init();
