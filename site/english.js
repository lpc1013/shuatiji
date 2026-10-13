/* ================= 医学英语词库（第 4 个内容域） =================
 * 与刷题三库并列但模型不同：词条没有对错，只有「熟悉度」。
 * 因此不复用 qstat / 错题 / 组卷中心，进度独立存在 S.global.english
 *   { [词形小写]: { s: 0忘记 1模糊 2认识, n: 标记次数, t: 时间戳 } }
 * 数据：data/english/manifest.json + data/english/d<NN>.json（按科室分片懒加载）
 */
/* 必须挂 window：classic script 顶层的 const 只建全局词法绑定，不会成为 window 属性，
 * 而 app.js 里是 `window.Eng && ...` 判断，写成 const 会永远取不到（features.js 同理用 window.Feat）。 */
window.Eng = (function () {
  const BASE = 'data/english/';
  let MAN = null;                 // manifest
  let cache = Object.create(null); // deptId → 词条数组
  let dept = '00';                // 当前科室分片 id
  let mode = 'list';              // list | card | quiz
  let hideCn = false;             // 遮中文（列表=中英对照默认可见；沉浸/卡片的信息在标记后才弹出）
  let hideEn = false;             // 遮英文（词形，中→英回忆；列表点词先揭示再进阅读）
  let hideTr = false;             // 遮例句译文（仅卡片详情块 / 阅读页里渲染）
  let q = '';                     // 搜索词
  let only = '';                  // 过滤：'' | 'new'(未标) | '0' | '1' | '2'
  let tagSel = '';                // 标签筛选（单元/专科）：'' 全部 | '__none__' 未分组 | 具体标签
  let cardIdx = 0, cardRevealed = false, cardOrder = null;
  /* 全屏阅读页（方案 A）：rWords 是打开那一刻的「当前筛选结果」快照，
     翻词、标记都作用在它上面，与列表里 data-i 的索引一一对应。 */
  let rOpen = false, rIdx = 0, rWords = null, rScroll = null;
  /* 阅读页渐进披露：打开/翻词时先只给词形（先想后看），点击才展开释义/词源/例句/文献。
     与卡片背诵的区分度：卡片=快节奏过卡（翻转即测），阅读页=词典式精读（可深读文献）。 */
  let rRevealed = false;
  /* 到期复习队列：进入复习时对「全库到期词」做一次快照，作用同 rWords——
     标记/翻卡都打在快照上，退出时丢弃。null = 不在复习中。 */
  let reviewList = null;
  /* 测验模式：quizList 开局洗牌快照；quizAns 当前题 4 选项（展示顺序已洗，
     正确项位置记在 quizRight）；quizPicked -1=未答，否则已答展示对错。 */
  let quizType = 'cn2en';         // cn2en 中→英 | en2cn 英→中 | audio 听音辨词
  let quizList = null, quizIdx = 0, quizAns = null, quizRight = -1, quizPicked = -1, quizWrong = 0;
  let quizDistractPool = null;   // 小科室测验干扰项回退池（全库，缓存复用）
  let allCache = null;            // 全库词条缓存（懒加载一次，搜索/复习共用）
  /* ② 列表分段渲染：长列表（「全部分类」≈3.7k 行）一次性出全会让切模式掉帧；
     首屏只渲染前 LIST_INIT 行，下方「展示全部」按钮一次放出剩余全部（用户主动触发）。
     ≤ LIST_INIT 行的小科室直接出全。 */
  const LIST_INIT = 30;
  let listShown = LIST_INIT;      // 当前已渲染行数（换科室/筛选/搜索/进列表时重置）
  let listPool = null;            // 当前列表完整词表（「展示全部」追加的唯一来源）
  /* A07：高级筛选折叠状态 + 卡片背诵位置记忆 */
  let advOpen = false;            // 高级筛选 <details> 是否展开（跨刷新保持）
  function loadCardPos(id) { try { const m = JSON.parse(localStorage.getItem('engCardPos') || '{}'); return (m && m[id]) || 0; } catch (e) { return 0; } }
  function saveCardPos(id, idx) { try { const m = JSON.parse(localStorage.getItem('engCardPos') || '{}'); m[id] = idx; localStorage.setItem('engCardPos', JSON.stringify(m)); } catch (e) {} }


  /* ---------- 进度 ---------- */
  function prog() {
    if (!S.global.english) S.global.english = {};
    return S.global.english;
  }
  function pkey(w) { return String(w.e || '').toLowerCase().trim(); }
  function pget(w) { return prog()[pkey(w)] || null; }
  /* ---------- 调度（穷人版间隔重复） ----------
   * 固定间隔表按「累计标记次数 n」步进：SM-2 的静态近似。个人库 3,414 词，
   * 与 FSRS 的效果差距远小于实现成本差距（FSRS 需 1,000+ 条复习史才值得拟合参数，
   * 而 log 从现在才开始记）。表长封顶后恒用末项。 */
  const DAY = 86400000;
  const SCHEDULE = {
    0: [1, 1, 2, 4, 7, 15, 30],    // 忘记：尽快重排
    1: [3, 7, 15, 30, 60],         // 模糊：中速巩固
    2: [30, 90, 180],              // 认识：长间隔维持
  };
  function nextDue(s, n) {
    const tab = SCHEDULE[s] || SCHEDULE[0];
    return Date.now() + tab[Math.min(Math.max(n - 1, 0), tab.length - 1)] * DAY;
  }
  function pset(w, s) {
    const p = prog(), k = pkey(w);
    const o = p[k] || { s: 0, n: 0, t: 0 };
    o.s = s; o.n = (o.n || 0) + 1; o.t = Date.now();
    o.due = nextDue(s, o.n);
    /* 复习行为日志 [评分, 时间戳]：封顶 50 条防爆体积。旧数据无 log 从零起记；
       这是将来升级真 SRS（SM-2/FSRS）的原料——现在不记，将来无米下锅。 */
    o.log = o.log || [];
    o.log.push([s, o.t]);
    if (o.log.length > 50) o.log = o.log.slice(-50);
    p[k] = o; save(); markDirty(k);   // 标记即存：脏词入队，2s 防抖上报专用 english 接口
  }
  /* ---------- 云端同步：标记即存（专用 english 接口，与整包 state 解耦） ---------- */
  /* 整包 forceFlush 已剥离 english，故这里单独上报脏词；换设备时由 sync.js 登录/打开时
   * 调用 QuizEnglish.pull() 拉取云端合并（逐词 n 大者赢），保证"换设备接着背"。 */
  let engDirty = new Set(), engTimer = null, engUploading = false;
  function markDirty(k) { engDirty.add(String(k)); if (!engTimer && !engUploading) engTimer = setTimeout(flushEnglish, 2000); }
  async function flushEnglish() {
    if (engUploading) return;
    const keys = [...engDirty]; if (!keys.length) return;
    engDirty.clear(); engTimer = null; engUploading = true;
    try {
      if (window.QuizSync) {
        const P = prog(), words = {};
        for (const k of keys) if (P[k]) words[k] = P[k];
        const r = await window.QuizSync.englishPush(words);
        // 失败（未登录/离线/服务端错）：本地已落盘，保留脏词等下次标记或切后台重试；不无限轮询
        if (!r || !r.ok) for (const k of keys) engDirty.add(k);
      }
    } catch (e) { for (const k of keys) engDirty.add(k); }
    finally {
      engUploading = false;
      // A11：失败退避重试——短暂离线后用户不再操作也能自动补报（原来只等下次标记/切后台）。
      // 未登录不排（englishPush 会永远返回失败，避免无谓轮询）；登录后由 doLogin 里的 flush() 补推。
      if (engDirty.size && !engTimer && window.QuizSync && window.QuizSync.isLoggedIn())
        engTimer = setTimeout(flushEnglish, 15000);
    }
  }
  function mergeEnglishInto(remote) {
    if (!remote || !Object.keys(remote).length) return false;
    const P = prog(); let changed = false;
    for (const k of Object.keys(remote)) {
      const cur = P[k], inc = remote[k];
      if (!cur) { P[k] = inc; changed = true; continue; }
      const nc = cur.n || 0, ni = inc.n || 0;
      if (ni > nc || (ni === nc && (inc.t || 0) > (cur.t || 0))) { P[k] = inc; changed = true; }
    }
    return changed;
  }
  async function pullEnglish() {
    try { const r = await window.QuizSync.englishPull(); if (r && r.ok && mergeEnglishInto(r.words)) save(); } catch (e) {}
  }
  async function resetEnglish() {
    try { engDirty.clear(); if (window.QuizSync) await window.QuizSync.englishReset(); } catch (e) {}
    S.global.english = {}; save();
  }
  window.QuizEnglish = { flush: flushEnglish, pull: pullEnglish, reset: resetEnglish };
  window.addEventListener('pagehide', () => { if (engDirty.size) flushEnglish(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && engDirty.size) flushEnglish(); });

  const LEVELS = [
    { n: '忘记', cls: 'el0' }, { n: '模糊', cls: 'el1' }, { n: '认识', cls: 'el2' },
  ];
  /* 标记按钮行：展示顺序 认识/模糊/忘记（data-v 仍按 p.s 的 2/1/0）。
     三种形态（卡片/详情/沉浸）共用，改一处即可。 */
  const MK_ORDER = [2, 1, 0];
  function mkRow(p) {
    return MK_ORDER.map(i => { const L = LEVELS[i];
      return `<button class="eng-mk ${p && p.s === i ? 'on ' + L.cls : ''}" data-act="eng-mk" data-v="${i}">${L.n}</button>`; }).join('');
  }
  /* 到期 / 今日统计：today 优先用 log（每次标记一条，p.t 只反映最后一刷），
     无 log 的旧数据退回 p.t 近似。 */
  function schedStats() {
    const p = prog(), now = Date.now();
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    let due = 0, today = 0;
    for (const k in p) {
      const o = p[k];
      if (o.due && o.due <= now) due++;
      if (o.log) { for (const it of o.log) if (it[1] >= t0.getTime()) today++; }
      else if (o.t >= t0.getTime()) today++;
    }
    return { due, today };
  }

  /* ---------- 数据加载 ---------- */
  async function loadMan() {
    if (MAN) return MAN;
    try {
      const r = await fetch(BASE + 'manifest.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      MAN = await r.json();
      /* A11 修复：dept 悬空校正。默认 '00'（通用医学英语）已并入 d32 从 manifest 消失，
       * 任何历史/默认 dept id 因分类合并失效时，回退第一个可用分类——
       * 否则 loadDept 落空返回 []，英语页整页空白（列表/卡片/沉浸全空）。
       * 用户进度按词形 key 存储不受影响（跨分类共享）。 */
      if (MAN && Array.isArray(MAN.depts) && MAN.depts.length && !MAN.depts.some(x => x.id === dept))
        dept = MAN.depts[0].id;
    } catch (e) { MAN = null; }
    return MAN;
  }
  async function loadDept(id) {
    if (id === 'all') return ensureAllWords();   // 「全部分类」：全库 31 分片懒加载（缓存复用）
    if (cache[id]) return cache[id];
    const d = (MAN && MAN.depts || []).find(x => x.id === id)
      /* A11 兜底：id 悬空（分类合并/删除后仍被引用）回退第一个可用分类，不静默返回空表 */
      || ((MAN && Array.isArray(MAN.depts) && MAN.depts.length) ? MAN.depts[0] : null);
    if (!d) return [];
    try {
      const r = await fetch(BASE + d.f, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      cache[id] = j.w || [];
    } catch (e) { cache[id] = []; }
    return cache[id];
  }
  /* 全库词条（3,414 词 ≈ 3MB）：首次调用拉齐 31 个分片并缓存。
     给「跨科搜索」和「全库到期复习」共用。词条对象上注入运行时科室名 _d
     （仅内存，不落盘——进度存的是词形 key，与词条对象无关）。 */
  async function ensureAllWords() {
    if (allCache) return allCache;
    if (!MAN) await loadMan();
    if (!MAN) return [];
    const parts = await Promise.all((MAN.depts || []).map(async d => {
      const ws = await loadDept(d.id);
      for (const w of ws) w._d = trimDept(d.n);
      return ws;
    }));
    allCache = [].concat.apply([], parts);
    return allCache;
  }
  /* 全库到期词快照：已标记且 due ≤ now。复习完标记会立刻刷新 due，
     所以队列要在进入那一刻定格（快照），否则边复习边缩小。 */
  async function dueWords() {
    const all = await ensureAllWords();
    const now = Date.now(), p = prog();
    return all.filter(w => { const o = p[pkey(w)]; return o && o.due && o.due <= now; });
  }

  /* ===== A11：英语复习对外 API（供主站「间隔回顾 / 错题」借道，复用既有 per-word SRS） ===== */
  function allFamiliar(arr) {
    const p = prog(), all = allCache || [];
    return all.filter(w => { const o = p[pkey(w)]; return o && arr.indexOf(o.s) >= 0; });
  }
  function dueCountSync() {
    const p = prog(), now = Date.now(), all = allCache || [];
    let n = 0;
    for (const w of all) { const o = p[pkey(w)]; if (o && o.due && o.due <= now) n++; }
    return n;
  }
  async function dueCount() { await ensureAllWords().catch(() => {}); return dueCountSync(); }
  async function wordsByFamiliar(s) { await ensureAllWords().catch(() => {}); return allFamiliar([s]); }
  async function launchReview() {
    const dw = await dueWords();          // 全库到期词快照（进那一刻定格）
    reviewList = dw; mode = 'card'; cardIdx = 0; cardRevealed = false;
    await refresh();
  }
  async function showFamiliar(s) {
    await ensureAllWords().catch(() => {});
    only = String(s); mode = 'card'; reviewList = null; cardIdx = 0; cardRevealed = false;
    await refresh();
  }
  async function launchImmersive(wordId) {
    await ensureAllWords().catch(() => {});
    let ws = allFamiliar([0, 1]);          // 优先在「模糊/忘记」词表里定位
    let list = ws, idx = ws.findIndex(w => w.id === wordId);
    if (idx < 0) { list = allCache || []; idx = Math.max(0, list.findIndex(w => w.id === wordId)); }
    openReader(Math.max(0, idx), list);
  }

  /* ---------- 列表计算 ---------- */
  /* 词表唯一来源：搜索非空 = 全库（跨科搜词），否则当前科室。
     view / act / updateList 三处必须共用，否则词表错位 → 标记打在错词上。 */
  async function curPool() { return q.trim() ? await ensureAllWords() : await loadDept(dept); }
  function listOf(words) {
    let out = words;
    const k = q.trim().toLowerCase();
    if (k) out = out.filter(w =>
      String(w.e).toLowerCase().indexOf(k) >= 0 || String(w.c || '').indexOf(k) >= 0);
    if (only === 'new') out = out.filter(w => !pget(w));
    else if (only !== '') out = out.filter(w => { const p = pget(w); return p && String(p.s) === only; });
    if (tagSel === '__none__') out = out.filter(w => !Array.isArray(w.g) || w.g.length === 0);
    else if (tagSel !== '') out = out.filter(w => Array.isArray(w.g) && w.g.indexOf(tagSel) >= 0);
    return out;
  }
  /* 当前词表内出现过的全部标签（单元/专科），供标签下拉使用 */
  function distinctTags(words) {
    const s = new Set();
    for (const w of (words || [])) if (Array.isArray(w.g)) for (const x of w.g) if (x) s.add(x);
    return [...s].sort();
  }
  function tagOptionsHtml(tags) {
    if (!tags || !tags.length) return '';
    const opts = [`<option value="">全部标签</option>`,
      `<option value="__none__" ${tagSel === '__none__' ? 'selected' : ''}>未分组</option>`]
      .concat(tags.map(t => `<option value="${esc(t)}" ${tagSel === t ? 'selected' : ''}>${esc(t)}</option>`));
    return `<select id="engTag" class="subject-select eng-dept-basic" aria-label="按标签筛选">${opts.join('')}</select>`;
  }
  function statOf(words) {
    const p = prog(); let n0 = 0, n1 = 0, n2 = 0, un = 0;
    for (const w of words) {
      const r = p[pkey(w)];
      if (!r) { un++; continue; }
      if (r.s === 0) n0++; else if (r.s === 1) n1++; else n2++;
    }
    return { n0, n1, n2, un, total: words.length, done: n0 + n1 + n2 };
  }

  /* ---------- 发音（音频优先 → TTS 兜底） ----------
   * 按钮读的是「词形」本身，不是音标字符串：TTS 念 /ˈkɑːdiæk/ 只会得到一串乱码。
   *
   * ⚠️ 为什么不是纯 TTS（2026-09-26 手机端实测定论）：
   *  ① iOS Safari：speechSynthesis 必须**在用户手势的同步调用栈里**首次 speak，
   *     否则静默拒绝（无报错、无事件）。异步补读 / 定时器里 speak 一律无效。
   *  ② iOS：getVoices() 在首次手势前恒为 []，且 onvoiceschanged 常永不触发
   *     → 「排队等语音库」在 iOS 上等于永远不响。
   *  ③ 安卓微信/QQ 内置 WebView：常直接阉割 speechSynthesis，或系统残缺无英语 TTS。
   *  → 对策：主路径改用词典音频 MP3（`<audio>`，全平台一致、不依赖系统语音），
   *     TTS 仅作为音频加载失败时的兜底，且必须保持「手势内同步调用」。 */
  const AUDIO_BASE = 'https://dict.youdao.com/dictvoice?type=2&audio=';
  let audioEl = null;           // 复用单个 <audio>，避免频繁建节点
  let audioOK = true;           // 音频连续失败 N 次后不再尝试，直接走 TTS
  let audioFail = 0;
  function playAudio(word) {
    if (!audioOK) return false;
    const W = typeof window === 'undefined' ? null : window;
    if (!W || typeof W.Audio !== 'function') return false;
    try {
      if (!audioEl) audioEl = new W.Audio();
      audioEl.src = AUDIO_BASE + encodeURIComponent(String(word));
      audioEl.play().then(function () { audioFail = 0; }).catch(function () {
        audioFail++; if (audioFail >= 3) audioOK = false;   // 网络/接口挂了 → 永久降级 TTS
      });
      return true;
    } catch (e) { return false; }
  }

  let pendingUtter = null;      // 待重读文本（voices 迟到时）
  let voicesHooked = false;     // onvoiceschanged 只挂一次
  function getVoices() {
    try {
      const SS = typeof window === 'undefined' ? null : window.speechSynthesis;
      if (!SS || typeof SS.getVoices !== 'function') return null;
      return { SS, vs: SS.getVoices() || [] };
    } catch (e) { return null; }
  }
  function hookVoices() {
    if (voicesHooked) return;
    const r = getVoices();
    if (!r) return;
    voicesHooked = true;
    r.SS.onvoiceschanged = function () {
      const t = pendingUtter; pendingUtter = null;
      if (t) speakTts(t);       // 语音库到位 → 补读刚才那次
    };
  }
  function pickEnVoice(vs) {
    return (vs || []).filter(x => /^en[-_]?US/i.test(x.lang || ''))[0]
      || (vs || []).filter(x => /^en[-_]?GB/i.test(x.lang || ''))[0]
      || (vs || []).filter(x => /^en/i.test(x.lang || ''))[0] || null;
  }
  /* 当前是否已有可用的「英语」语音。UI 用它区分失败类型。 */
  function hasEnVoice() {
    const r = getVoices();
    if (!r) return false;
    return !!pickEnVoice(r.vs);
  }
  /* TTS 兜底路径。注意：iOS 要求在手势内同步调用；异步补读在 iOS 上会静默失败。 */
  function speakTts(text) {
    const r = getVoices();
    if (!r) return false;
    const { SS, vs } = r;
    const W = typeof window === 'undefined' ? null : window;
    const Utt = W && W.SpeechSynthesisUtterance;
    if (!SS || typeof SS.speak !== 'function' || typeof Utt !== 'function') return false;
    const s = String(text == null ? '' : text);
    const v = pickEnVoice(vs);
    /* 语音库还没到位或没有英语包：先排队（桌面/Linux 靠 onvoiceschanged 能救回来）。
       iOS 上这个队列不会响，所以 speak() 已优先走音频，不会落到这里。 */
    if (!v) {
      pendingUtter = s;
      hookVoices();
      return false;
    }
    try {
      SS.cancel();
      const u = new Utt(s);
      u.lang = 'en-US'; u.rate = .9; u.pitch = 1;
      /* ⚠️ voice 赋值可能抛 TypeError（voice 对象与 synth 实例不匹配）→ 降级为默认语音 */
      try { u.voice = v; } catch (e) { /* 用默认语音念，总比不响好 */ }
      SS.speak(u);
      return true;
    } catch (e) { return false; }
  }
  /* 统一入口：音频优先，失败则 TTS。返回值语义：
     true = 已发起播放；false = 两条路都不行（UI 据此提示）。 */
  function speak(text) {
    const s = String(text == null ? '' : text);
    if (!s) return false;
    /* 主路径：词典音频。同步发起（手势内），iOS 无障碍。
       —— 若音频接口连续失败已降级，则直接走 TTS。 */
    if (playAudio(s)) return true;
    return speakTts(s);
  }
  const SPK_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">'
    + '<path d="M4 9.2v5.6h3.6L13 19V5L7.6 9.2H4z" fill="currentColor"/>'
    + '<path d="M16 8.6a4.4 4.4 0 0 1 0 6.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
    + '<path d="M18.7 6a8.2 8.2 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  /* 音标行：喇叭按钮在左、音标在右。音标缺失时仍保留按钮（照样能听发音）。 */
  function phRow(w, cls) {
    return `<div class="ph-row"><button class="ph-spk" data-act="eng-spk" role="button" tabindex="0" aria-label="朗读单词" title="朗读">${SPK_SVG}</button>${
      w && w.ph ? `<span class="${cls}">${esc(w.ph)}</span>` : ''}</div>`;
  }
  /* 三种形态各自取「当前词条」：阅读页快照 > 卡片模式当前张（复习中取复习快照，
     cardIdx 索引的是 reviewList 而非当前科室列表——不判 reviewList 会标错词） > 列表行 */
  function wordOf(t, words) {
    if (rOpen && rWords) return rWords[rIdx];
    if (mode === 'card') return (reviewList || words)[cardIdx];
    const item = t && t.closest ? t.closest('.eng-item') : null;
    return item ? words[parseInt(item.dataset.i, 10)] : null;
  }


  /* ---------- 渲染：全屏阅读页 ----------
   * 为什么不做成「列表行展开」：一页装不下音标+词源+例句+译文+文献原句，
   * 展开后要在一堆行里上下挪；阅读页把单个词条摊开成整屏大字，并且能
   * 上一个/下一个连续翻，才是「读词」而不是「查词」。
   * 覆盖层铺满整个视口（不设 max-width），内层三块各自限宽 600px，
   * 这样桌面端侧边栏/内容区不会被露出来，也不需要 display:none 掉 .view
   * （保住列表滚动位置）。 */
  /* 显示用科室名：去掉构建期打的「(扩增)」后缀（仅展示裁剪，不动数据层）；
     兼容「(扩增)/(扩展)」两种写法（数据层现为「(扩增)」，勿只留一种） */
  function trimDept(n) { return n ? n.replace(/[（(](?:扩增|扩展)[）)]/g, '') : (n || ''); }
  function deptName() {
    const d = (MAN && MAN.depts || []).find(x => x.id === dept);
    return d ? trimDept(d.n) : '';
  }
  function readerHtml() {
    const words = rWords || [];
    const w = words[rIdx];
    if (!w) return '<div class="empty">没有词条</div>';
    const p = pget(w);
    return `<div class="engr-head">
      <button class="engr-back" data-act="eng-read-close">‹ 退出沉浸</button>
      <span class="muted small">${esc(w._d || deptName())}</span>
      <span class="engr-idx">${rIdx + 1} / ${words.length}</span>
      ${p && rRevealed ? `<span class="mstag ${LEVELS[p.s].cls}">${LEVELS[p.s].n}</span>` : '<span class="muted small">未标记</span>'}
    </div>
    <div class="engr-body ${rRevealed ? 'rv' : ''}">
      <h2 class="engr-word">${esc(w.e)}</h2>
      ${rRevealed ? `${phRow(w, 'engr-ph')}<button class="engr-cn ${hideCn ? 'mask' : ''}" data-act="eng-cn" role="button" tabindex="0">${esc(w.c || '—')}</button>
      ${w.et ? `<section class="engr-sec"><h4>词源</h4><div class="engr-et">${esc(w.et)}</div></section>` : ''}
      ${w.ex ? `<section class="engr-sec"><h4>例句</h4><p class="engr-ex">${esc(w.ex)}</p>
        ${w.tr ? `<button class="engr-tr ${hideTr ? 'mask' : ''}" data-act="eng-tr" role="button" tabindex="0">${esc(w.tr)}</button>`
        : '<div class="eng-tr-none muted small">（该例句译文缺失：原译经核对属同科另一词条，已移除，避免误导）</div>'}</section>` : ''}
      ${w.pm && w.pm.s ? `<section class="engr-sec"><h4>文献原句</h4>
        <p class="engr-pm">${esc(w.pm.s)}</p>
        <div class="eng-pm-meta"><span class="tag">${esc(w.pm.j || 'PubMed')}</span>
          ${w.pm.y ? `<span class="muted small">${esc(w.pm.y)}</span>` : ''}
          ${w.pm.i ? `<a class="eng-pm-link" href="${esc(w.pm.u || ('https://pubmed.ncbi.nlm.nih.gov/' + w.pm.i + '/'))}" target="_blank" rel="noopener">PMID ${esc(w.pm.i)} ↗</a>` : ''}
        </div></section>` : ''}`
      : `<div class="engr-blank"></div>`}
    </div>
    <div class="engr-foot">
      <div class="eng-mark">${mkRow(p)}</div>
      ${rRevealed ? `<div class="engr-nav">
        <button class="btn ghost" data-act="eng-read-prev" ${rIdx <= 0 ? 'disabled' : ''}>‹ 上一个</button>
        <button class="btn" data-act="eng-read-next" ${rIdx >= words.length - 1 ? 'disabled' : ''}>下一个 ›</button>
      </div>` : ''}
      <div class="engr-tip muted small">键盘 ← → 翻词 · 空格朗读 · Esc 退出</div>
    </div>`;
  }
  function readerEl() {
    let el = document.getElementById('engReader');
    if (!el) {
      el = document.createElement('div');
      el.id = 'engReader';
      el.className = 'engr hidden';
      (document.getElementById('app') || document.body).appendChild(el);
    }
    return el;
  }
  function renderReader() {
    const el = readerEl();
    const old = el.querySelector('.engr-body');
    const top = old ? old.scrollTop : 0;   // 标记后重渲染不要把阅读位置顶回顶部
    el.innerHTML = readerHtml();
    const nb = el.querySelector('.engr-body');
    if (nb) nb.scrollTop = top;
  }
  function openReader(i, words) {
    rWords = words; rIdx = Math.max(0, Math.min(i, words.length - 1)); rOpen = true; rRevealed = false;
    /* 列表本身不隐藏（否则 display:none 会把 .view 滚动位置清零），
       覆盖层铺满视口，只在 body 上锁掉背景滚动。 */
    document.body.classList.add('reading');
    readerEl().classList.remove('hidden');
    renderReader();
  }
  async function closeReader() {
    rOpen = false; rWords = null;
    const el = document.getElementById('engReader');
    if (el) el.classList.add('hidden');
    document.body.classList.remove('reading');
    /* 回列表要同步统计条/筛选计数，但必须保住 .view 的滚动位置，
       否则「读到一半退出」会跳回顶部（refresh 重建 innerHTML 会把 scrollTop 清零）。 */
    const v = document.getElementById('view');
    if (!v || !document.getElementById('engBody')) return;   // 列表已不在（切走了）就别覆盖当前视图
    const top = v.scrollTop;
    await refresh();
    v.scrollTop = top;
  }
  function goReader(d) {
    if (!rOpen || !rWords) return false;
    const n = rIdx + d;
    if (n < 0 || n >= rWords.length) return true;   // 到头就不动，禁用态已经表达了边界
    rIdx = n; rRevealed = false;   // 翻到新词回到「英文+空白」态
    renderReader();
    return true;
  }
  /* 空态：说明被什么卡住（搜索词 / 标记筛选），给一键解除——
     纯「没有匹配的词条」曾让用户误以为该科室没词（d06 事件）。 */
  function emptyHtml() {
    const parts = [];
    if (q.trim()) parts.push(`搜索「${esc(q.trim())}」`);
    if (only !== '') parts.push(`「${LEVELS[+only].n}」筛选`);
    if (tagSel === '__none__') parts.push(`「未分组」标签`);
    else if (tagSel !== '') parts.push(`「${esc(tagSel)}」标签`);
    if (!parts.length) return '<div class="empty">没有词条</div>';
    return `<div class="empty">没有匹配的词条（${parts.join(' + ')}）<br>
      <button class="chip sm" data-act="eng-clear-filter" style="margin-top:10px">清除筛选 · 显示全部</button></div>`;
  }

  /* ---------- 渲染：列表模式 ----------
   * 纯中英对照 + 音标：行不可点击、无任何交互（背单词的交互全部在卡片/沉浸模式）。
   * 遮罩 chips（遮中文/遮英文）只在本模式显示。 */
  function listRowHtml(w) {
    const p = pget(w);
    return `<div class="eng-item ${p ? 'lv' + p.s : 'lvx'}">
        <div class="eng-item-h">
          <div class="eng-w ${hideEn ? 'mask' : ''}">${esc(w.e)}</div>
          ${w.ph ? `<span class="eng-item-ph">${esc(w.ph)}</span>` : ''}
          <span class="eng-cn ${hideCn ? 'mask' : ''}">${esc(w.c || '—')}</span>
          ${w._d ? `<span class="eng-dept">${esc(w._d)}</span>` : ''}
        </div>
      </div>`;
  }
  /* ② 分段渲染：> LIST_INIT 行只先出首屏 30 行 + 下方「展示全部」按钮；
     ≤ LIST_INIT 行的小科室一次性出全。 */
  function listHtml(words) {
    if (!words.length) { listPool = null; return emptyHtml(); }
    listPool = words;
    const total = words.length;
    const batch = total > LIST_INIT ? Math.min(listShown, total) : total;
    listShown = batch;
    const rows = words.slice(0, batch).map(listRowHtml).join('');
    if (batch >= total) return `<div id="engList">${rows}</div>`;
    return `<div id="engList">${rows}</div>
      <div id="engMore" class="eng-more"><button class="btn ghost sm" data-act="eng-more">展示全部（共 ${total} 词）</button></div>`;
  }
  /* 「展示全部」：一次 insert 剩余全部行（不重建已渲染的，保滚动位置） */
  function showAllList() {
    if (mode !== 'list' || !listPool) return;
    const list = document.getElementById('engList');
    if (!list || listShown >= listPool.length) return;
    list.insertAdjacentHTML('beforeend', listPool.slice(listShown).map(listRowHtml).join(''));
    listShown = listPool.length;
    const more = document.getElementById('engMore');
    if (more) more.remove();
  }


  /* ---------- 渲染：卡片模式 ----------
   * reviewList 非空 = 复习队列模式：词源是「进入时全库到期词」快照，
   * 到头显示完成面板而不是绕回第 1 张。 */
  function cardHtml(words) {
    if (reviewList) words = reviewList;
    if (!words.length) return emptyHtml();
    if (reviewList && cardIdx >= words.length) {
      return `<div class="eng-done"><div class="eng-done-t">${ICON('party')}今日复习完成</div>
        <div class="muted small">共 ${words.length} 词 · 标记过的词已按间隔表排好下次复习时间</div>
        <button class="btn" data-act="eng-review-exit" style="margin-top:12px">返回列表</button></div>`;
    }
    if (!reviewList && cardIdx >= words.length) cardIdx = 0;
    const w = words[cardIdx], p = pget(w);
    return `<div class="eng-card">
      <div class="eng-card-top">
        <span class="muted small">${reviewList ? '复习 ' : ''}${cardIdx + 1} / ${words.length}</span>
        ${p && cardRevealed ? `<span class="mstag ${LEVELS[p.s].cls}">${LEVELS[p.s].n}</span>` : '<span class="muted small">未标记</span>'}
      </div>
      <div class="eng-card-w">${esc(w.e)}</div>
      ${cardRevealed
        ? `<div class="eng-card-cn">${esc(w.c || '—')}</div>${phRow(w, 'eng-ph')}`
        : `<div class="eng-card-blank"></div>`}
    </div>
    <div class="eng-card-nav">
      ${cardRevealed ? `<button class="btn ghost" data-act="eng-prev">‹ 上一个</button>` : ''}
      <div class="eng-mark" style="flex:3 1 0">${mkRow(p)}</div>
      ${cardRevealed ? `<button class="btn" data-act="eng-next">下一个 ›</button>` : ''}
    </div>`;
  }

  /* ---------- 渲染：测验模式 ----------
   * 三种题型共用一套选项机器：quizAns 是洗好的 4 个选项值展示序（cn2en/audio=英文词形，
   * en2cn=中文释义），正确项位置存 quizRight（绝不能恒在首位，否则选项形同虚设）。
   * 答错 → pset(w,0)（降回忘记并排 1 天后重考——检索练习的闭环）；
   * 答对 → 不改标记（防「蒙对虚高」，熟悉度仍由用户自评维护）。 */
  function quizOptsHtml(correct, pool) {
    if (!quizAns) {
      const cnSide = quizType === 'en2cn';
      const val = w => cnSide ? String(w.c || '') : String(w.e);
      const forms = [val(correct)];
      const seen = new Set([pkey(correct)]);
      let guard = 0;
      const src = (pool.length > 4) ? pool : (quizDistractPool && quizDistractPool.length > 4 ? quizDistractPool : pool);
      while (forms.length < 4 && guard++ < 200 && src.length > 4) {
        const w = src[(Math.random() * src.length) | 0];
        const k = pkey(w);
        /* en2cn 时不同词可能同释义，按值去重防两个正确/雷同选项 */
        if (!seen.has(k) && val(w) && !forms.includes(val(w))) { seen.add(k); forms.push(val(w)); }
      }
      for (let i = forms.length - 1; i > 0; i--) {          // Fisher-Yates 洗展示序
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = forms[i]; forms[i] = forms[j]; forms[j] = tmp;
      }
      quizAns = forms;
      quizRight = forms.indexOf(val(correct));
    }
    return quizAns.map((e, i) => {
      let cls = '';
      if (quizPicked >= 0) {
        if (i === quizRight) cls = 'correct';               // 正确项亮绿
        else if (i === quizPicked) cls = 'wrong';           // 错选亮红
      }
      return `<button class="eng-qopt ${cls}" data-act="eng-quiz-pick" data-i="${i}" ${quizPicked >= 0 ? 'disabled' : ''}>
        <span class="eng-qk">${'ABCD'[i]}</span>${esc(e)}</button>`;
    }).join('');
  }
  function quizHtml(words) {
    if (!quizList) return '<div class="empty">测验未初始化</div>';
    if (quizIdx >= quizList.length) {
      return `<div class="eng-done"><div class="eng-done-t">${ICON('doc')}本轮测验完成</div>
        <div class="muted small">共 ${quizList.length} 题 · 答错 ${quizWrong} 题（已自动降回「忘记」并安排重考）</div>
        <button class="btn" data-act="eng-quiz-exit" style="margin-top:12px">返回列表</button></div>`;
    }
    const w = quizList[quizIdx];
    const head = quizType === 'audio'
      ? `<div class="eng-q-audio"><button class="eng-q-replay" data-act="eng-quiz-replay" aria-label="重听">${ICON('speaker')}再听一遍</button></div>`
      : quizType === 'en2cn'
        ? `<div class="eng-q-en">${esc(w.e)}</div>`
        : `<div class="eng-q-cn">${esc(w.c || '（该词中文释义缺失）')}</div>`;
    const typeLabel = quizType === 'audio' ? '听音辨词' : quizType === 'en2cn' ? '英 → 中' : '中 → 英';
    return `<div class="eng-quiz">
      <div class="eng-card-top">
        <span class="muted small">${quizIdx + 1} / ${quizList.length} · 答错 ${quizWrong}</span>
        <span class="muted small">${typeLabel}</span>
      </div>
      ${head}
      <div class="eng-qopts">${quizOptsHtml(w, words)}</div>
      ${quizPicked >= 0 ? `<div class="eng-q-next-row"><button class="btn" data-act="eng-quiz-next">下一题 ›</button></div>` : ''}
    </div>`;
  }

  /* 模式卡（tab + 各模式 chips + 标记筛选 + 计数）。
     ① 局部刷新（softRefresh）时只重建它 + #engBody，不再整视图 innerHTML ——
     头部（搜索框/科室下拉/进度卡）与 #view 滚动位置都能保住。 */
  function deptOptionsHtml() {
    const man = MAN || {};
    return `<option value="all" ${dept === 'all' ? 'selected' : ''}>全部分类 · ${man.total || ''} 词</option>` +
      (man.depts || []).map(x => `<option value="${x.id}" ${x.id === dept ? 'selected' : ''}>${esc(trimDept(x.n))} · ${x.c}</option>`).join('');
  }
  function modeCardInner(words, shown, sched, tags) {
    const st = statOf(words);
    const hint = filterHint(st);
    /* 科室选择 = 基础筛选（常驻主视图，与「⚙ 高级筛选」同行）；
       遮罩 / 题型 / 熟悉度仍收进独立弹窗。 */
    return `<div class="eng-modes" role="tablist" aria-label="学习模式">
        <button class="${mode === 'list' ? 'on' : ''}" data-act="eng-mode" data-v="list" role="tab" aria-selected="${mode === 'list'}">
          <b>列表浏览</b><span>中英对照 · 查词</span></button>
        <button class="${mode === 'card' ? 'on' : ''}" data-act="eng-mode" data-v="card" role="tab" aria-selected="${mode === 'card'}">
          <b>卡片背诵</b><span>先想后选 · 快速过卡</span></button>
        <button class="${mode === 'quiz' ? 'on' : ''}" data-act="eng-mode" data-v="quiz" role="tab" aria-selected="${mode === 'quiz'}">
          <b>测验</b><span>4 选 1 自测</span></button>
      </div>
      ${sched && sched.due > 0 ? `<button class="chip eng-review-hl" data-act="eng-review">${ICON('bell')}到期复习 ${sched.due} 个词</button>` : ''}
      <div class="eng-filter-row">
        <select id="engDept" class="subject-select eng-dept-basic" aria-label="选择分类">${deptOptionsHtml()}</select>
        ${tagOptionsHtml(tags)}
        <button class="chip eng-adv-btn" data-act="eng-adv-open">${ICON('gear')}高级筛选${hint}</button>
      </div>
      <p class="muted small" id="engCount" style="margin:8px 0 0">${countText(words, shown)}</p>`;
  }
  /* 高级筛选摘要右侧小计数：折叠时也能看到当前过滤状态 */
  function filterHint(st) {
    const parts = [];
    if (only !== '') parts.push(LEVELS[+only].n + ' ' + (only === 'new' ? st.un : only === '0' ? st.n0 : only === '1' ? st.n1 : st.n2));
    if (tagSel !== '') parts.push(tagSel === '__none__' ? '未分组' : tagSel);
    if (q.trim()) parts.push('搜索');
    if (hideCn) parts.push('遮中文');
    if (hideEn) parts.push('遮英文');
    return parts.length ? `<span class="cnt">${parts.join(' · ')}</span>` : '';
  }

  /* ---------- 主视图 ---------- */
  async function view() {

    const man = await loadMan();
    if (!man) return `<div class="card"><h3>医学英语词库</h3>
      <p class="muted small">词库数据未就位（data/english/manifest.json 读取失败）。
      确认已运行 <code>haimamed_english/build_english.mjs</code>。</p></div>`;
    /* 搜索时自动切全库（31 科室懒加载一次后走缓存）——查词的人不知道词在哪个科室 */
    /* 词表与 act()/updateList() 共用同一来源（curPool）——搜索时全库、否则当前科室，
     * 否则「搜索后进卡片模式，标记会打在错词上」（act 曾固定用科室词表，索引错位）。 */
    const base = await curPool();
    const words = listOf(base);
    /* listOf 幂等（q / only 都是逐条谓词，再过滤一次结果恒等）→ 旧代码多跑一趟 O(n)，去掉 */
    const shown = words;
    const tags = distinctTags(base);
    const st = statOf(words);

    const sched = schedStats();

    return `    <div class="search"><input id="engQ" placeholder="搜索英文 / 中文（全库）" autocomplete="off" value="${esc(q)}"><button class="btn ghost sm" data-act="eng-clear-q">清空</button></div>

    <div class="card">
      <div class="row between"><h3 style="margin:0">${ICON('abc')}医学英语词库</h3>
        <span class="muted small">${man.total} 词 · ${(man.depts || []).length} 分类</span></div>
      <div class="eng-bar">${[st.done - st.n1 - st.n2, st.n1, st.n2].map((n, i) =>
      `<i class="${LEVELS[[0, 1, 2][i]].cls}" style="width:${st.total ? n / st.total * 100 : 0}%" title="${LEVELS[[0, 1, 2][i]].n} ${n}"></i>`).join('')}</div>
      <div class="eng-legend">
        ${LEVELS.map((L, i) => `<span class="mstag ${L.cls}">${L.n} <b>${[st.n0, st.n1, st.n2][i]}</b></span>`).join('')}
        <span class="muted small">未标记 ${st.un}</span>
      </div>
      <div class="row between" style="margin-top:10px;gap:8px;flex-wrap:wrap">
        <span class="muted small">今日已学 <b>${sched.today}</b> · 待复习 <b>${sched.due}</b></span>
      </div>
    </div>

    <div class="card" id="engModeCard">${modeCardInner(words, shown, sched, tags)}</div>


      <div id="engBody" style="margin-top:12px">${bodyHtml(words, shown)}</div>`;
  }

  /* 局部刷新：只重建词条列表区，保住 #view 滚动位置与展开态（C05） */
  function bodyHtml(words, shown) {
    const inner = mode === 'quiz' ? quizHtml(words) : mode === 'card' ? cardHtml(shown) : listHtml(shown);
    /* 卡片背诵：整块包进「居中舞台」，配合 #view.eng-card-mode 的 flex 列布局，
       让卡片在可用视口内垂直居中，无需下滑（A06） */
    return mode === 'card' ? `<div class="eng-card-stage">${inner}</div>` : inner;
  }
  function countText(words, shown) {
    const d = dept === 'all' ? { n: '全部分类' } : ((MAN && MAN.depts || []).find(x => x.id === dept) || (MAN && MAN.depts || [])[0]);
    const dn = d ? trimDept(d.n) : '';
    let s = `${esc(dn)} · 共 ${words.length} 词`;
    if (shown.length !== words.length) s += ` · 筛出 ${shown.length}`;
    return s;
  }
  async function updateList() {
    const words = listOf(await curPool());
    const shown = listOf(words);
    const body = document.getElementById('engBody');
    if (body) body.innerHTML = bodyHtml(words, shown);
    const cnt = document.getElementById('engCount');
    if (cnt) cnt.innerHTML = countText(words, shown);
  }
  /* ① 局部刷新：只重建「模式卡 + 词条区」，不整视图 innerHTML ——
     切模式/筛选/卡片翻页走这里，头部搜索框焦点与 #view 滚动位置都保住。
     ${ICON('warn')}会改头部统计（标记、复习进出）的动作仍用 refresh()，否则进度条/图例显示旧值。 */
  async function softRefresh() {
    const base = await curPool();
    const words = listOf(base);
    const tags = distinctTags(base);
    const sched = schedStats();
    const mc = document.getElementById('engModeCard');
    if (mc) mc.innerHTML = modeCardInner(words, words, sched, tags);
    const body = document.getElementById('engBody');
    if (body) body.innerHTML = bodyHtml(words, words);
    const v = document.getElementById('view');
    if (v) v.classList.toggle('eng-card-mode', mode === 'card');   // A06：卡片模式 → 居中布局
    bindBasicDept();   // 重新绑定基础科室下拉（softRefresh 重建了 engModeCard 内的 select）
    await renderAdvModal();
  }
  /* A08：高级筛选弹出式抽屉。modal 挂在 #app 下（position:fixed 不被 #view 布局影响），
     科室选择 + 遮罩/题型/熟悉度 全收进弹窗；主视图只留一个触发按钮。
     advOpen 跨 refresh/softRefresh 保持；弹窗体在每次刷新时重建，状态取自模块变量。 */
  function mountAdvModal() {
    let el = document.getElementById('engAdvModal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'engAdvModal';
      el.className = 'eng-adv-modal hidden';
      el.innerHTML = `<div class="eng-adv-backdrop" data-act="eng-adv-close"></div>
        <div class="eng-adv-panel">
          <div class="eng-adv-head"><b>高级筛选</b><button class="eng-adv-x" data-act="eng-adv-close" aria-label="关闭">✕</button></div>
          <div class="eng-adv-body"></div>
          <div class="eng-adv-foot">
            <button class="btn ghost sm" data-act="eng-clear-filter">清除筛选</button>
            <button class="btn sm" data-act="eng-adv-close">完成</button>
          </div>
        </div>`;
      (document.getElementById('app') || document.body).appendChild(el);
    }
    renderAdvModal();
  }
  function advModalBody(words, sched) {
    const st = statOf(words);
    const advBody = [
      mode === 'list' ? `<div class="wrap eng-chips" style="margin-bottom:6px">
        <button class="chip sm ${hideCn ? 'on' : ''}" data-act="eng-toggle" data-f="hideCn">遮中文</button>
        <button class="chip sm ${hideEn ? 'on' : ''}" data-act="eng-toggle" data-f="hideEn" title="遮住词形：看中文回想英文，再点 chip 对照">遮英文</button>
      </div>` : '',
      (mode === 'card' || mode === 'quiz') ? `<div class="wrap eng-chips" style="margin-bottom:6px">
        <button class="chip sm" data-act="eng-immersive">${ICON('book2')}沉浸式${mode === 'quiz' ? '测验' : '背单词'}</button>
        <span class="muted small" style="align-self:center">全屏 · 标记后弹出词源 / 例句 / 文献</span>
      </div>` : '',
      mode === 'quiz' ? `<div class="wrap eng-chips" style="margin-bottom:6px">
        <button class="chip sm ${quizType === 'cn2en' ? 'on' : ''}" data-act="eng-quiz-type" data-v="cn2en">中 → 英</button>
        <button class="chip sm ${quizType === 'en2cn' ? 'on' : ''}" data-act="eng-quiz-type" data-v="en2cn">英 → 中</button>
        <button class="chip sm ${quizType === 'audio' ? 'on' : ''}" data-act="eng-quiz-type" data-v="audio">听音辨词</button>
      </div>` : '',
      `<div class="wrap eng-chips">
        <button class="chip sm ${only === '' ? 'on' : ''}" data-act="eng-only" data-v="">全部 ${words.length}</button>
        <button class="chip sm ${only === 'new' ? 'on' : ''}" data-act="eng-only" data-v="new">未标记 ${st.un}</button>
        <button class="chip sm ${only === '0' ? 'on' : ''}" data-act="eng-only" data-v="0">忘记 ${st.n0}</button>
        <button class="chip sm ${only === '1' ? 'on' : ''}" data-act="eng-only" data-v="1">模糊 ${st.n1}</button>
        <button class="chip sm ${only === '2' ? 'on' : ''}" data-act="eng-only" data-v="2">认识 ${st.n2}</button>
      </div>`
    ].filter(Boolean).join('');
    return `<div class="eng-adv-sec"><div class="eng-adv-label">筛选</div>${advBody}</div>`;
  }
  async function renderAdvModal() {
    const el = document.getElementById('engAdvModal');
    if (!el) return;
    const words = listOf(await curPool());
    el.classList.toggle('hidden', !advOpen);
    const body = el.querySelector('.eng-adv-body');
    if (body) body.innerHTML = advModalBody(words, schedStats());
  }
  async function openAdv() { advOpen = true; await renderAdvModal(); }
  async function closeAdv() { advOpen = false; await renderAdvModal(); }


  /* ---------- 交互 ---------- */
  async function refresh() {
    const v = document.getElementById('view');
    v.innerHTML = await view();
    v.classList.toggle('eng-card-mode', mode === 'card');   // A06：卡片模式 → 居中布局
    bind();
    mountAdvModal();
  }
  function bind() {
    const v = document.getElementById('view');
    if (v) v.classList.toggle('eng-card-mode', mode === 'card');   // A06：卡片模式 → 居中布局
    const qi = document.getElementById('engQ');
    if (qi) {
      let t = null;
      qi.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(async () => { q = qi.value; cardIdx = 0; cardRevealed = false; listShown = LIST_INIT; await updateList(); const n = document.getElementById('engQ'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 260);
      });
    }
    mountAdvModal();   // A10：首屏走 view()+bind()（不经 refresh），必须在此挂载弹窗节点，否则点「高级筛选」无反应
    bindBasicDept();
  }
  /* 基础筛选：主视图科室下拉（与「⚙ 高级筛选」同行），换科室即刷新 */
  function bindBasicDept() {
    const sel = document.getElementById('engDept');
    if (!sel) return;
    sel.value = dept;
    sel.onchange = async () => {
      dept = sel.value; cardIdx = 0; cardRevealed = false; listShown = LIST_INIT;
      only = ''; q = ''; tagSel = '';   // 换科室=换上下文：清除残留筛选/搜索词/标签
      await refresh();
    };
    bindTagSel();   // 科室下拉重建后一并绑定标签下拉
  }
  /* 标签下拉（单元/专科）：过滤当前分类内的词条 */
  function bindTagSel() {
    const sel = document.getElementById('engTag');
    if (!sel) return;
    sel.value = tagSel;
    sel.onchange = async () => {
      tagSel = sel.value; cardIdx = 0; cardRevealed = false; listShown = LIST_INIT;
      await softRefresh();
    };
  }


  /* 测验初始化：对题源快照洗牌；干扰项池 = 当前渲染时传入的全量词表 */
  async function initQuiz(words) {
    quizList = words.slice().sort(() => Math.random() - .5);
    quizIdx = 0; quizAns = null; quizRight = -1; quizPicked = -1; quizWrong = 0;
    try { quizDistractPool = await ensureAllWords(); } catch (e) { quizDistractPool = null; }
  }
  /* 发音能力探测。主路径是词典音频（只需 Audio API，全平台都有），
     TTS 只是兜底 → 不再用 speechSynthesis 存在性当闸门（iOS/微信 WebView 会误判）。
     CORS 已由 CSS(content-visibility) 无关；音频走 https 绝对地址，不受同源限制。 */
  function ttsOk() {
    const W = typeof window === 'undefined' ? null : window;
    return !!(W && (typeof W.Audio === 'function' || (W.speechSynthesis && W.SpeechSynthesisUtterance)));
  }

  async function act(a, t) {
    const man = MAN || await loadMan();
    const words = listOf(await curPool());   // 与 view() 同源：搜索时全库，否则当前科室

    if (a === 'eng-adv-open') { await openAdv(); return true; }
    if (a === 'eng-adv-close') { await closeAdv(); return true; }

    if (a === 'eng-clear-q') { q = ''; cardIdx = 0; cardRevealed = false; listShown = LIST_INIT; await refresh(); return true; }

    if (a === 'eng-mode') {
      mode = t.dataset.v; cardIdx = 0; cardRevealed = false; reviewList = null;
      if (mode === 'list') listShown = LIST_INIT;   // ② 进列表从首屏一批起（长列表分段渲染）
      /* A07：卡片背诵记忆上次位置（仅纯科室浏览：无筛选/搜索，否则索引错位从头） */
      if (mode === 'card' && only === '' && !q.trim()) cardIdx = loadCardPos(dept);

      if (mode === 'quiz') {
        initQuiz(words);
        /* 「听音辨词」现在走音频文件，不再依赖系统 TTS → 无需能力闸门。
           唯一可能失败的是音频接口本身，由 speak() 内部降级处理。 */
        if (quizType === 'audio') speak(quizList[0] && quizList[0].e);
      }      await softRefresh(); return true;
    }
    if (a === 'eng-quiz-type') {

      const v = t.dataset.v;
      quizType = v; initQuiz(words);
      if (quizType === 'audio' && quizList[0]) speak(quizList[0].e);
      await softRefresh(); return true;

    }
    if (a === 'eng-quiz-pick') {
      const i = parseInt(t.dataset.i, 10);
      if (quizPicked >= 0 || !quizList || !quizAns) return true;
      quizPicked = i;
      if (i !== quizRight) { quizWrong++; pset(quizList[quizIdx], 0); }   // 答错降回忘记并排重考
      await refresh(); return true;
    }
    if (a === 'eng-quiz-next') {
      quizIdx++; quizAns = null; quizRight = -1; quizPicked = -1;
      if (quizType === 'audio' && quizList && quizList[quizIdx]) speak(quizList[quizIdx].e);
      await softRefresh(); return true;

    }
    if (a === 'eng-quiz-replay') {
      if (quizList && quizList[quizIdx]) speak(quizList[quizIdx].e);
      return true;
    }
    if (a === 'eng-quiz-exit') { quizList = null; mode = 'list'; listShown = LIST_INIT; await softRefresh(); return true; }


    /* 到期复习：对全库到期词做快照 → 卡片模式逐张过；标记即刷新 due */
    if (a === 'eng-review') {
      const dw = await dueWords();
      if (!dw.length) { if (typeof toast === 'function') toast('当前没有到期的词'); return true; }
      reviewList = dw; mode = 'card'; cardIdx = 0; cardRevealed = false;
      await refresh(); return true;
    }
    if (a === 'eng-review-exit') { reviewList = null; mode = 'list'; cardIdx = 0; await refresh(); return true; }

    if (a === 'eng-toggle') {
      const f = t.dataset.f;
      if (f === 'hideCn') hideCn = !hideCn;
      else if (f === 'hideEn') hideEn = !hideEn;
      else hideTr = !hideTr;
      cardRevealed = false;
      await softRefresh(); return true;

    }
    if (a === 'eng-only') { only = t.dataset.v; cardIdx = 0; cardRevealed = false; listShown = LIST_INIT; await softRefresh(); return true; }

    if (a === 'eng-clear-filter') {
      only = ''; q = ''; tagSel = ''; cardIdx = 0; cardRevealed = false; listShown = LIST_INIT;
      await refresh(); return true;

    }

    if (a === 'eng-cn') { t.classList.toggle('mask'); return true; }
    if (a === 'eng-tr') { t.classList.toggle('mask'); return true; }
    /* 发音：始终读当前词条（阅读页 / 卡片 / 列表行由 wordOf 统一解析） */
    if (a === 'eng-spk') {
      const w = wordOf(t, words);
      if (!w) return true;
      if (speak(w.e)) {
        t.classList.add('on');
        setTimeout(function () { t.classList.remove('on'); }, 900);
      } else if (typeof toast === 'function') {
        toast('发音不可用，请检查网络或换用系统浏览器打开');
      }
      return true;
    }

    if (a === 'eng-immersive') {
      /* 沉浸式：卡片 / 测验均可进入全屏阅读页；词表 = 当前队列快照 */
      let cw, idx;
      if (mode === 'quiz' && quizList) {
        cw = quizList; idx = Math.min(quizIdx, Math.max(0, quizList.length - 1));
      } else {
        cw = reviewList || words; idx = Math.min(cardIdx, Math.max(0, cw.length - 1));
      }
      if (!cw.length) return true;
      openReader(idx, cw);
      return true;
    }
    if (a === 'eng-read-close') { await closeReader(); return true; }
    if (a === 'eng-read-prev') { goReader(-1); return true; }
    if (a === 'eng-read-next') { goReader(1); return true; }
    if (a === 'eng-prev') {
      const cw = reviewList || words;
      cardIdx = (cardIdx - 1 + cw.length) % Math.max(1, cw.length); cardRevealed = false;
      if (mode === 'card' && !reviewList && only === '' && !q.trim()) saveCardPos(dept, cardIdx);   // A07
      await softRefresh(); return true;

    }
    if (a === 'eng-next') {
      const cw = reviewList || words;
      if (reviewList && cardIdx + 1 >= cw.length) {
        /* 复习队列过完 → 完成面板（普通卡片模式保持环形绕回） */
        cardIdx = cw.length; cardRevealed = false; await softRefresh(); return true;
      }
      cardIdx = (cardIdx + 1) % Math.max(1, cw.length); cardRevealed = false;
      if (mode === 'card' && !reviewList && only === '' && !q.trim()) saveCardPos(dept, cardIdx);   // A07
      await softRefresh(); return true;

    }

    /* 「展示全部」：一次放出剩余全部行 */
    if (a === 'eng-more') { showAllList(); return true; }

    if (a === 'eng-mk') {
      const v = parseInt(t.dataset.v, 10);
      const target = wordOf(t, words);
      if (!target) return true;
      pset(target, v);
      /* 标记驱动揭示：标记后弹出信息（卡片=中文+音标+喇叭；沉浸=全部内容），
         同时下方才出现 上一个/下一个。不自动跳词——推进节奏归用户。 */
      if (rOpen) { rRevealed = true; renderReader(); return true; }
      cardRevealed = true;
      if (mode === 'card' && !reviewList && only === '' && !q.trim()) saveCardPos(dept, cardIdx);   // A07
      await refresh();
      return true;
    }
    /* 错题页「英语生词（模糊/忘记）」点击 → 进入全屏沉浸式背诵并定位到该词 */
    if (a === 'eng-wrong-word') { await launchImmersive(t.dataset.id); return true; }
    return false;
  }

  /* 键盘：阅读页 ←→/空格/Esc；测验模式 1-4 选项 + Enter 下一题。
     两把键盘互斥（rOpen / mode==='quiz'），避免与刷题区按键冲突。 */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && advOpen) { closeAdv(); return; }   // A08：Esc 关高级筛选抽屉
    if (rOpen) {
      if (e.key === 'Escape') { closeReader(); }
      else if (e.key === 'ArrowLeft') { goReader(-1); }
      else if (e.key === 'ArrowRight') { goReader(1); }
      /* 空格 = 朗读当前词。焦点在按钮上时放行，交给按钮自身的 click（避免读两遍）。 */
      else if (e.key === ' ' || e.key === 'Spacebar') {
        if (e.target && e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        if (rWords && rWords[rIdx]) speak(rWords[rIdx].e);
      }
      return;
    }
    if (mode === 'quiz' && quizList && !rOpen) {
      if (quizPicked < 0 && /^[1-4]$/.test(e.key)) {
        const btn = document.querySelector('#engBody .eng-qopt[data-i="' + (parseInt(e.key, 10) - 1) + '"]');
        if (btn) { e.preventDefault(); btn.click(); }
      } else if (quizPicked >= 0 && (e.key === 'Enter' || e.key === ' ')) {
        const btn = document.querySelector('#engBody [data-act="eng-quiz-next"]');
        if (btn) { e.preventDefault(); btn.click(); }
      }
    }
  });

  function engMasteredSync() {           // A12：同步读取英语「认识(熟悉度=2)」词数，供成就徽章判定
    let n = 0; const p = prog();
    for (const k in p) if (p[k] && p[k].s === 2) n++;
    return n;
  }
  /* 首页「单词背诵」入口：进入「卡片背诵」模式（非默认列表浏览），并保留上次卡片位置 */
  async function enterCardMode() {
    mode = 'card'; cardRevealed = false; reviewList = null; cardIdx = 0;
    if (only === '' && !q.trim()) cardIdx = loadCardPos(dept);   // A07：纯科室浏览恢复上次位置
    await softRefresh();
  }
  /* 对外：词库分类列表（供 题库页「词库」子 tab 的下拉） */
  async function depts() {
    if (!MAN) await loadMan();
    return (MAN && MAN.depts || []).map(d => ({ id: d.id, n: trimDept(d.n), c: d.c }));
  }
  /* 对外：词库检索（kw 为空返回该分类全部；deptId 省略 / 'all' = 全库） */
  async function searchWords(kw, deptId) {
    if (!MAN) await loadMan();
    const k = String(kw || '').trim().toLowerCase();
    let pool;
    if (deptId && deptId !== 'all') {
      const dd = (MAN && MAN.depts || []).find(x => x.id === deptId);
      pool = await loadDept(deptId);
      if (dd) for (const w of pool) if (!w._d) w._d = trimDept(dd.n);
    } else {
      pool = await ensureAllWords();
    }
    return k ? pool.filter(w => ((w.e || '') + ' ' + (w.c || '')).toLowerCase().includes(k)) : pool;
  }
  return { view, bind, act, loadMan, openReader, closeReader, goReader, speak, hasEnVoice, phRow,
    dueCount, dueCountSync, wordsByFamiliar, launchReview, showFamiliar, launchImmersive, ensureAll: ensureAllWords, engMasteredSync, enterCardMode, depts, searchWords };
})();
