/* 刷题记 · 二期功能包（2026-09-12）
 * 高级筛选组卷 / 四级掌握状态 / 答案纠错反馈 / 偏好开关（含显示设置） / 禁用选项乱序 / 非选择题兜底
 *
 * 载入顺序：必须在 app.js **之前**（app.js 的渲染会调用 Feat.*）。
 * 只用 app.js 暴露的全局（S / cur / SB / P / curState / curSub / save / show / toast /
 * openModal / closeModal / closePlayer / renderPlayer / qById / inSet / addSet / remSet /
 * shuffle / allQuestions / allQuestionsBoth / startPractice / requestStart / subState / esc），
 * 不做顶层读写，全部逻辑延迟到调用时执行。
 */
window.Feat = (function () {
  'use strict';

  const escp = s => (s == null ? '' : String(s))
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ================= 1. 四级掌握状态 ================= */
  /* 用 CSS 画的圆点（.mdot）代替 emoji：emoji 在不同系统上字重/基线/配色都不一样，
   * 要么油腻要么发灰，「未接触」的 ⚪ 还常常被渲染成实心白盘。矢量圆点可精确控色/控尺寸，
   * 和整站 1.7 线宽图标同一套语言。 */
  const MASTERY = [
    { n: '未接触', em: '⚪', cls: 'm0', ds: '还没有作答记录' },
    { n: '见过', em: '🔴', cls: 'm1', ds: '答过，但在错题里或只答对过 1 次' },
    { n: '熟悉', em: '🟡', cls: 'm2', ds: '累计答对 ≥ 2 次' },
    { n: '掌握', em: '🟢', cls: 'm3', ds: '答对 ≥ 2 次且间隔回顾推进到第 3 轮' },
  ];
  /* 判定规则（确定性、可解释）：
   * 0 未接触 = 没有作答记录
   * 1 见过   = 答过，但要么在错题集里，要么只答对过 1 次
   * 2 熟悉   = 答对 ≥ 2 次
   * 3 掌握   = 答对 ≥ 2 次 且 间隔回顾已推到第 3 轮及以后 */
  function masteryOf(st, id) {
    const s = st && st.qstat ? st.qstat[id] : null;
    if (!s || !s.n) return 0;
    if (inSet(st.wrong, id)) return 1;
    const r = st.review ? st.review[id] : null;
    const stage = r ? r.stage : 0;
    if (s.r >= 2 && stage >= 2) return 3;
    if (s.r >= 2) return 2;
    return 1;
  }
  function masteryTag(st, id, withCount) {
    const k = masteryOf(st, id), m = MASTERY[k];
    const s = st.qstat ? st.qstat[id] : null;
    const tail = withCount && s ? `<span class="mcnt">${s.r}/${s.n}</span>` : '';
    return `<span class="mstag ${m.cls}" title="${m.ds}"><i class="mdot"></i>${m.n}${tail}</span>`;
  }
  function masteryDist(st, ids) {
    const d = [0, 0, 0, 0];
    for (const id of ids) d[masteryOf(st, id)]++;
    return d;
  }
  /* 分布条 + 四宫格图例。
   * 「未接触」用斜纹灰段（读起来就是"空着的部分"），其余三级各自实色渐变；
   * 图例格子给大号数字 + 占比，替代原来那排 12px 小胶囊。 */
  function masteryBarHtml(st, ids) {
    const d = masteryDist(st, ids), tot = ids.length || 1;
    const bar = `<div class="mrow">${d.map((n, i) =>
      `<div class="mseg ${MASTERY[i].cls}" style="width:${n / tot * 100}%" title="${MASTERY[i].n} ${n} 题"></div>`).join('')}</div>`;
    const grid = `<div class="mgrid">${d.map((n, i) => {
      const pct = tot ? Math.round(n / tot * 100) : 0;
      return `<div class="mcell ${MASTERY[i].cls}" title="${MASTERY[i].ds}">
        <span class="mdot"></span>
        <b>${n}</b>
        <span class="mlabel">${MASTERY[i].n}</span>
        <span class="mpct">${pct}%</span></div>`;
    }).join('')}</div>`;
    return bar + grid;
  }

  /* ================= 2. 高级筛选组卷 ================= */
  const STATUS = [
    { v: '', n: '不限' }, { v: 'todo', n: '未作答' }, { v: 'wrong', n: '做错过' },
    { v: 'right', n: '做对过' }, { v: 'fav', n: '已收藏' }, { v: 'doubt', n: '有疑点' },
    { v: 'never', n: '完全没碰' },
  ];
  const TYPE_OPTS = [['A1', '单选'], ['A2', '病例单选'], ['A3', '病例组题'], ['多选', '多选'], ['判断', '判断'], ['填空', '填空']];
  const DIFF_N = ['未标', '①很易', '②较易', '③中等', '④较难', '⑤很难'];

  let F = null;
  /* 组卷中心：同一个面板同时管「练习」与「限时考试」。mode 决定底部按钮 + 题量行怎么渲染。
   * exSingle/exMulti/minutes 只在考试模式下有意义（空串 = 自动）。 */
  function newFilter() {
    return {
      mode: 'practice',            // 'practice' | 'exam'
      grp: 'all', types: [], diffs: [], srcs: [], status: '',
      yFrom: '', yTo: '', hotMin: '', accFrom: '', accTo: '',
      excludeMastered: false, limit: 20, shuffle: true,
      exSingle: '', exMulti: '', minutes: '',
    };
  }
  function srcOptions(sub) {
    const s = new Set();
    for (const x of allQuestionsBoth(sub)) if (x.q.source) s.add(x.q.source);
    return [...s];
  }
  function poolFor(f) {
    const sub = curSub(), st = curState();
    let arr = allQuestionsBoth(sub);
    if (f.grp !== 'all') arr = arr.filter(x => x.grp === f.grp);
    if (f.types.length) arr = arr.filter(x => f.types.includes(x.q.type));
    if (f.diffs.length) arr = arr.filter(x => f.diffs.includes(String(x.q.difficulty || 0)));
    if (f.srcs.length) arr = arr.filter(x => f.srcs.includes(x.q.source || '未知来源'));
    if (f.yFrom) arr = arr.filter(x => x.q.year && x.q.year >= +f.yFrom);
    if (f.yTo) arr = arr.filter(x => x.q.year && x.q.year <= +f.yTo);
    if (f.hotMin !== '') arr = arr.filter(x => (x.q.hot || 0) >= +f.hotMin);
    if (f.accFrom !== '') arr = arr.filter(x => x.q.acc != null && x.q.acc >= +f.accFrom);
    if (f.accTo !== '') arr = arr.filter(x => x.q.acc != null && x.q.acc <= +f.accTo);
    if (f.status) {
      const s = f.status;
      arr = arr.filter(x => {
        const id = x.q.id, qs = st.qstat ? st.qstat[id] : null;
        if (s === 'todo') return !qs || !qs.n;
        if (s === 'never') return masteryOf(st, id) === 0;
        if (s === 'wrong') return inSet(st.wrong, id);
        if (s === 'right') return !!(qs && qs.r > 0);
        if (s === 'fav') return inSet(st.fav, id);
        if (s === 'doubt') return inSet(st.doubt, id);
        return true;
      });
    }
    if (f.excludeMastered) arr = arr.filter(x => masteryOf(st, x.q.id) < 3);
    return arr;
  }
  function chipRow(label, field, opts, cur, multi) {
    return `<div class="frow"><span class="flabel">${label}</span><div class="wrap fchips">${
      opts.map(([v, n]) => {
        const on = multi ? cur.includes(v) : cur === v;
        return `<button class="chip sm ${on ? 'on' : ''}" data-act="f-${multi ? 'toggle' : 'set'}" data-f="${field}" data-v="${v}">${n}</button>`;
      }).join('')}</div></div>`;
  }
  function baseGrpChips() {
    const sub = curSub(), jg = groupCount(sub, 'jg'), ext = groupCount(sub, 'ext');
    /* AI 变式题与极光/扩展是并列的第三个来源，但它是自生成的、无年份/来源/难度标注，
     * 也不参与「限时考试」评分 —— 所以只在这里展示数量并指路，不并进组卷池。
     * （历史反馈点 5：别把 AI 题库塞成考试的一个选项。） */
    const aiN = (curState().aiGen || []).reduce((a, b) => a + (b.questions || []).length, 0);
    return `<div class="frow"><span class="flabel">题库</span><div class="wrap fchips">
      <button class="chip sm ${F.grp === 'all' ? 'on' : ''}" data-act="f-set" data-f="grp" data-v="all">全部 ${jg + ext}</button>
      <button class="chip sm ${F.grp === 'jg' ? 'on' : ''}" data-act="f-set" data-f="grp" data-v="jg">极光 ${jg}</button>
      <button class="chip sm ${F.grp === 'ext' ? 'on' : ''}" data-act="f-set" data-f="grp" data-v="ext">扩展 ${ext}</button>
      ${aiN ? `<span class="chip sm off" title="AI 变式题无年份/来源/难度标注，也不参与限时考试评分；请到首页「AI 题库」单独练习">AI 变式 ${aiN} · 单独练</span>` : ''}
    </div></div>`;
  }
  /* 组卷中心：条件筛选（各模式共用）+ 模式化题量行。
   * preset 可以是字符串（旧签名的「预设作答状态」）或对象（{mode:'exam'} 等）。 */
  function filterSetup(preset) {
    if (!F) F = newFilter();
    if (typeof preset === 'string') { if (preset) F.status = preset; }
    else if (preset && typeof preset === 'object') Object.assign(F, preset);
    const isExam = F.mode === 'exam';
    const arr = poolFor(F), n = arr.length;
    const nS = arr.filter(x => !x.q.multi).length, nM = arr.filter(x => x.q.multi).length;
    const srcs = srcOptions(curSub());
    openModal(`<h3>${ICON('target')}组卷中心</h3>
      <p class="muted small" style="margin:0 0 10px">先挑条件，再决定「练习」还是「限时考试」。条件可自由组合。</p>
      <div class="frow"><span class="flabel">模式</span><div class="wrap fchips">
        <button class="chip sm ${isExam ? '' : 'on'}" data-act="f-mode" data-v="practice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H3z"/><path d="M21 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z"/></svg>练习</button>
        <button class="chip sm ${isExam ? 'on' : ''}" data-act="f-mode" data-v="exam"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 13V9"/><path d="M9 2h6"/></svg>限时考试</button>
      </div></div>
      ${baseGrpChips()}
      ${chipRow('题型', 'types', TYPE_OPTS.map(([v, n]) => [v, n]), F.types, true)}
      ${chipRow('难度', 'diffs', [['0', '未标'], ['1', '①'], ['2', '②'], ['3', '③'], ['4', '④'], ['5', '⑤']], F.diffs, true)}
      ${srcs.length > 1 ? chipRow('来源', 'srcs', srcs.map(s => [s, s]), F.srcs, true) : ''}
      ${chipRow('作答状态', 'status', STATUS.map(s => [s.v, s.n]), F.status, false)}
      <div class="frow"><span class="flabel">年份</span><div class="wrap fchips">
        <input class="inp num" id="fYFrom" inputmode="numeric" placeholder="起" value="${F.yFrom}">
        <span class="muted small">—</span>
        <input class="inp num" id="fYTo" inputmode="numeric" placeholder="止" value="${F.yTo}">
      </div></div>
      <div class="frow"><span class="flabel">热度</span><div class="wrap fchips">
        <input class="inp num" id="fHot" inputmode="numeric" placeholder="答题人次 ≥" value="${F.hotMin}">
        <span class="muted small">正确率</span>
        <input class="inp num" id="fAccFrom" inputmode="numeric" placeholder="%≥" value="${F.accFrom}">
        <input class="inp num" id="fAccTo" inputmode="numeric" placeholder="%≤" value="${F.accTo}">
      </div></div>
      ${isExam ? examQuotaRows(nS, nM) : practiceRows()}
      <div class="fpreview">${previewText()}</div>
      <div class="wrap" style="margin-top:10px">
        <button class="btn" data-act="f-go" ${n ? '' : 'disabled'}>${isExam ? '开始考试' : '开始练习'}</button>
        <button class="btn ghost" data-act="f-reset">重置条件</button>
        <button class="btn ghost" data-act="close-modal">取消</button>
      </div>`);
  }
  /* 练习模式题量行：总上限 + 快捷 + 随机顺序 + 排除已掌握 */
  function practiceRows() {
    return `<div class="frow"><span class="flabel">数量</span><div class="wrap fchips">
        <input class="inp num" id="fLimit" inputmode="numeric" value="${F.limit}">
        ${[10, 20, 50, 100].map(v => `<button class="chip sm" data-act="f-limit" data-v="${v}">${v}</button>`).join('')}
        <button class="chip sm" data-act="f-limit" data-v="all">全部</button>
        <button class="chip sm ${F.shuffle ? 'on' : ''}" data-act="f-bool" data-f="shuffle">随机顺序</button>
      </div></div>
      <div class="frow"><span class="flabel">其他</span><div class="wrap fchips">
        <button class="chip sm ${F.excludeMastered ? 'on' : ''}" data-act="f-bool" data-f="excludeMastered">排除已掌握</button>
      </div></div>`;
  }
  /* 考试模式题量行：单/多选分别取几题 + 时长（留空按题量自动估 0.9min/题） */
  function examQuotaRows(nS, nM) {
    const s = F.exSingle === '' ? Math.min(20, nS) : Math.min(Math.max(0, parseInt(F.exSingle) || 0), nS);
    const m = F.exMulti === '' ? Math.min(5, nM) : Math.min(Math.max(0, parseInt(F.exMulti) || 0), nM);
    const auto = Math.max(1, Math.round((s + m) * 0.9));
    return `<div class="frow"><span class="flabel">题量</span><div class="wrap fchips">
        <span class="muted small">单选</span><input class="inp num" id="fExSingle" inputmode="numeric" value="${s}" style="width:64px">
        <span class="muted small">多选</span><input class="inp num" id="fExMulti" inputmode="numeric" value="${m}" style="width:64px">
        <span class="muted small">可选 ${nS} / ${nM}</span>
      </div></div>
      <div class="frow"><span class="flabel">时长</span><div class="wrap fchips">
        <input class="inp num" id="fMin" inputmode="numeric" placeholder="分钟" value="${F.minutes}" style="width:76px">
        <span class="muted small">留空 = 自动（约 ${auto} 分钟）</span>
      </div></div>
      <div class="frow"><span class="flabel">其他</span><div class="wrap fchips">
        <button class="chip sm ${F.excludeMastered ? 'on' : ''}" data-act="f-bool" data-f="excludeMastered">排除已掌握</button>
      </div></div>`;
  }
  /* 组卷预览：命中题量 + 本轮取几题 + 时长；命中为 0 时指出「哪一条限制最紧」
   * （做法：逐条临时放开该条件，看题量回升最多的是哪个 —— 比笼统说「没有题」有用得多） */
  function previewText() {
    const arr = poolFor(F), n = arr.length;
    if (!n) return zeroHint();
    if (F.mode === 'exam') {
      const nS = arr.filter(x => !x.q.multi).length, nM = arr.filter(x => x.q.multi).length;
      const s = Math.min(F.exSingle === '' ? 20 : Math.max(0, parseInt(F.exSingle) || 0), nS);
      const m = Math.min(F.exMulti === '' ? 5 : Math.max(0, parseInt(F.exMulti) || 0), nM);
      const lim = s + m;
      const min = Math.max(1, parseInt(F.minutes) || Math.round(lim * 0.9));
      return `命中 <b>${n}</b> 题（单选 ${nS} · 多选 ${nM}）· 本卷取 <b>${lim}</b> 题 · 时长 <b>${min}</b> 分钟`;
    }
    const lim = F.limit === 'all' ? n : Math.min(Math.max(1, parseInt(F.limit) || 20), n);
    return `命中 <b>${n}</b> 题 · 本轮取 <b>${lim}</b> 题 · 预计 <b>${Math.max(1, Math.round(lim * 0.9))}</b> 分钟`;
  }
  function zeroHint() {
    const cands = [
      ['题型', { types: [] }], ['难度', { diffs: [] }], ['来源', { srcs: [] }],
      ['年份', { yFrom: '', yTo: '' }], ['热度/正确率', { hotMin: '', accFrom: '', accTo: '' }],
      ['作答状态', { status: '' }], ['排除已掌握', { excludeMastered: false }],
    ];
    let best = null;
    for (const [name, patch] of cands) {
      const save = JSON.parse(JSON.stringify(F));
      Object.assign(F, patch);
      const m = poolFor(F).length;
      Object.assign(F, save);
      if (m > 0 && (!best || m > best[1])) best = [name, m];
    }
    return best
      ? `当前条件没有命中任何题。<b>${best[0]}</b> 这条限制最紧 —— 放开它可命中 ${best[1]} 题。`
      : '当前条件没有命中任何题；该学科题库内也没有可回退的题目，请换学科或检查题库分组。';
  }
  function collectFilterNums() {
    if (!F) F = newFilter();   // 兜底：act('filter-setup') 会先于 filterSetup() 调用本函数，首次点击时 F 还是 null
    const g = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    F.yFrom = g('fYFrom'); F.yTo = g('fYTo'); F.hotMin = g('fHot');
    F.accFrom = g('fAccFrom'); F.accTo = g('fAccTo');
    const lim = g('fLimit'); if (lim !== '') F.limit = lim;
    const es = g('fExSingle'); if (es !== '') F.exSingle = es;   // 考试模式输入框，练习模式下不存在
    const em = g('fExMulti'); if (em !== '') F.exMulti = em;
    F.minutes = g('fMin');   // 空串 = 自动
  }
  /* 条件摘要：写进考试记录，回看时知道「这份卷子是按什么条件组的」 */
  function condSummary() {
    const bits = [];
    if (F.grp !== 'all') bits.push(F.grp === 'jg' ? '极光' : '扩展');
    if (F.types.length) bits.push(F.types.join('/'));
    if (F.diffs.length) bits.push('难度' + F.diffs.join(''));
    if (F.srcs.length) bits.push(F.srcs.join('/'));
    if (F.status) { const s = STATUS.find(x => x.v === F.status); if (s) bits.push(s.n); }
    if (F.yFrom || F.yTo) bits.push('年份' + (F.yFrom || '') + '~' + (F.yTo || ''));
    if (F.hotMin !== '') bits.push('热度≥' + F.hotMin);
    if (F.accFrom !== '' || F.accTo !== '') bits.push('正确率' + (F.accFrom || '') + '~' + (F.accTo || ''));
    if (F.excludeMastered) bits.push('排除已掌握');
    return bits.join(' · ');
  }
  /* 组卷开局：mode 决定走练习还是限时考试。
   * ${ICON('warn')}题源统一走 poolFor()（底层是 allQuestionsBoth + grp 条件）—— 不再跟随首页「极光/扩展」分组切换，
   *    否则同一套筛选条件在首页切一下分组就得到不同题量（老版本的口径冲突）。 */
  function filterGo() {
    collectFilterNums();
    const pool = poolFor(F);
    if (!pool.length) { toast('没有符合条件的题目，放宽些条件试试'); return; }
    if (F.mode === 'exam') {
      /* 考试：单选/多选按配额分别随机抽取，再整体打乱（模拟真实卷面结构） */
      const singles = shuffle(pool.filter(x => !x.q.multi));
      const multis = shuffle(pool.filter(x => x.q.multi));
      const nS = Math.min(F.exSingle === '' ? 20 : Math.max(0, parseInt(F.exSingle) || 0), singles.length);
      const nM = Math.min(F.exMulti === '' ? 5 : Math.max(0, parseInt(F.exMulti) || 0), multis.length);
      let exam = singles.slice(0, nS).concat(multis.slice(0, nM));
      if (!exam.length) { toast('单选题数和多选题数不能都是 0'); return; }
      exam = shuffle(exam);
      const minutes = Math.max(1, parseInt(F.minutes) || Math.round(exam.length * 0.9));
      closeModal();
      requestStart(exam, 'exam', { minutes, single: nS, multi: nM, src: 'filter', cond: condSummary() }, null);
      return;
    }
    let p = F.shuffle ? shuffle(pool) : pool.slice();
    const n = F.limit === 'all' ? p.length : Math.max(1, parseInt(F.limit) || 20);
    p = p.slice(0, n);
    closeModal();
    requestStart(p, 'practice', {}, null);
  }

  /* ================= 3. 选项乱序（确定性，按题 id 固定） ================= */
  const shakeCache = new Map();
  // 选项标签：<26 用单字母 A-Z，≥26 用双字母 AA/AB…（防溢出生僻符号）
  function optLabel(i) {
    if (i < 26) return String.fromCharCode(65 + i);
    let n = i, s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }
  function optView(q) {
    const keys = Object.keys(q.options || {}).slice().sort();
    if (!S.global.settings.optShuffle) return keys.map(k => ({ disp: k, key: k, text: q.options[k] }));
    let m = shakeCache.get(q.id);
    if (!m || m.length !== keys.length || m.some(x => !q.options[x.key])) {
      const perm = keys.slice();
      let h = 2166136261;
      for (let i = 0; i < q.id.length; i++) { h ^= q.id.charCodeAt(i); h = Math.imul(h, 16777619); }
      for (let i = perm.length - 1; i > 0; i--) {
        h = Math.imul(h ^ (h >>> 15), 2246822507);
        const j = Math.abs(h) % (i + 1);
        const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
      }
      m = perm.map((k, i) => ({ key: k, disp: optLabel(i) }));
      shakeCache.set(q.id, m);
    }
    return m.map(x => ({ disp: x.disp, key: x.key, text: q.options[x.key] }));
  }
  function keyOfDisp(q, disp) {
    const v = optView(q).find(x => x.disp === disp);
    return v ? v.key : disp;
  }
  function dispOfKey(q, key) {
    const v = optView(q).find(x => x.key === key);
    return v ? v.disp : key;
  }
  function isNoChoice(q) { return !Object.keys(q.options || {}).length; }

  /* ================= 4. 答案纠错反馈 ================= */
  const FB_TYPES = [{ v: 'answer', n: '答案有误' }, { v: 'explain', n: '解析有误' }, { v: 'stem', n: '题干/选项有误' }, { v: 'other', n: '其他问题' }];
  let fbSelType = '';
  function feedbackOf(st, qid) { return (st.feedback || []).find(f => f.id === qid) || null; }
  function openFeedback(qid) {
    const st = curState(), x = qById(qid); if (!x) return;
    const old = feedbackOf(st, qid);
    fbSelType = old ? old.type : (fbSelType || 'answer');
    openModal(`<h3><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>答案纠错</h3>
      <p class="muted small" style="margin:0 0 8px">${escp(x.chapterName)} · ${escp(String(x.q.content).slice(0, 70))}…</p>
      <div class="wrap" style="gap:6px;margin-bottom:10px">${FB_TYPES.map(t =>
        `<button class="chip sm ${fbSelType === t.v ? 'on' : ''}" data-act="fb-pick" data-v="${t.v}">${t.n}</button>`).join('')}</div>
      <textarea id="fbText" class="inp block" rows="3" placeholder="补充说明（可留空）：你认为正确答案是什么？依据（教材章节 / 指南）？">${escp(old ? old.text || '' : '')}</textarea>
      <div class="wrap" style="margin-top:10px">
        <button class="btn" data-act="fb-save" data-id="${qid}">提交反馈</button>
        ${old ? `<button class="btn ghost" data-act="fb-del" data-id="${qid}">撤销这条反馈</button>` : ''}
        <button class="btn ghost" data-act="close-modal">关闭</button>
      </div>`);
  }
  function saveFeedback(qid) {
    const st = curState(), x = qById(qid); if (!x) return;
    const text = (document.getElementById('fbText') || {}).value || '';
    const q = x.q;
    st.feedback = st.feedback || [];
    const i = st.feedback.findIndex(f => f.id === qid);
    const rec = {
      id: qid, type: fbSelType || 'other', text: text.trim(),
      at: Date.now(), subject: cur, chapter: x.chapterName, grp: x.grp || '',
      subjectName: SB[cur] ? SB[cur].name : cur,
      stem: String(q.content || '').slice(0, 300),
      options: q.options, answer: q.correct, source: q.source || '', year: q.year || null,
    };
    if (i >= 0) st.feedback[i] = rec; else st.feedback.push(rec);
    save();
    closeModal();
    toast(i >= 0 ? '已更新反馈 ✓' : '已记录反馈，可在「设置」导出 ✓');
    if (!document.getElementById('player').classList.contains('hidden')) renderPlayer();
  }
  function exportFeedback() {
    const all = [];
    for (const sid in (S.subjects || {})) {
      const st = S.subjects[sid];
      for (const f of (st.feedback || [])) all.push(Object.assign({ subjectId: sid }, f));
    }
    if (!all.length) { toast('还没有纠错记录'); return; }
    try {
      const blob = new Blob([JSON.stringify({ app: 'quiz_feedback', version: 1, exportedAt: Date.now(), items: all }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = '答案纠错_' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出 ' + all.length + ' 条纠错 ✓');
    } catch (e) { toast('导出失败'); }
  }
  function feedbackListHtml(st) {
    const arr = (st.feedback || []).slice().reverse();
    if (!arr.length) return '<div class="empty">还没有纠错记录</div>';
    return arr.slice(0, 30).map(f => {
      const tn = (FB_TYPES.find(t => t.v === f.type) || {}).n || f.type;
      return `<div class="lib-item" data-act="fb-open" data-id="${f.id}">
        <div class="row between"><span class="tag">${tn}</span><span class="muted small">${new Date(f.at).toLocaleDateString('zh-CN')}</span></div>
        <div class="lib-txt">${escp(f.stem)}</div>
        ${f.text ? `<div class="muted small">${escp(f.text)}</div>` : ''}</div>`;
    }).join('') + (arr.length > 30 ? `<div class="muted small">…共 ${arr.length} 条，导出可见全部</div>` : '');
  }

  /* ================= 6. 偏好开关 ================= */
  const PREFS = [
    ['autoSubmit', '选完自动提交', '单选题点选项即判定，不用再点「确认」'],
    ['autoNext', '答对自动下一题', '答对后 0.7 秒自动翻页（练习模式）'],
    ['swipe', '左右滑动翻题', '关闭后只能点按钮翻页，避免误触'],
    ['optShuffle', '选项乱序', '同一题每次顺序固定，防止背题号'],
    ['showMeta', '显示题目元信息', '题干下方显示年份 / 来源 / 难度 / 热度'],
    ['plain', '简洁模式', '隐藏热度条、滑动提示等装饰元素'],
  ];
  const PREF_ICON = { autoSubmit: 'bolt', autoNext: 'next', swipe: 'swipe', optShuffle: 'shuffle', showMeta: 'chart', plain: 'trash' };
  function prefCardHtml() {
    const s = S.global.settings;
    return `<div class="card"><h3>偏好设置</h3>
      <div class="set-row"><span>${ICON('moon')}暗色模式</span><div class="switch ${s.dark ? 'on' : ''}" data-act="toggle-dark"><i></i></div></div>
      <div class="set-row"><span>${ICON('type')}字号</span><div class="wrap">${[['s', '小'], ['m', '中'], ['l', '大']].map(([k, n]) => `<button class="btn ${s.font === k ? '' : 'ghost'} sm" data-act="set-font" data-k="${k}">${n}</button>`).join('')}</div></div>
      <div style="border-top:1px solid var(--line);margin:8px 0"></div>
      ${PREFS.map(([k, n, d]) => `<div class="set-row"><span>${ICON(PREF_ICON[k] || 'star')}${n}<div class="muted small">${d}</div></span>
        <div class="switch ${s[k] ? 'on' : ''}" data-act="pref" data-k="${k}"><i></i></div></div>`).join('')}
      <div class="set-row"><span>${ICON('cal')}考试日期</span><input type="date" id="setExam" class="inp" value="${s.examDate || ''}"></div>
      <div class="set-row"><span>${ICON('target')}每日目标题数</span><input type="number" id="setGoal" class="inp" min="1" max="200" style="width:72px" value="${s.dailyGoal || 50}"></div>
      <button class="btn sm" data-act="save-settings" style="margin-top:8px">保存考试日期 / 目标</button>
    </div>`;
  }
  function togglePref(k) {
    S.global.settings[k] = !S.global.settings[k];
    if (k === 'plain') document.body.classList.toggle('plain', !!S.global.settings.plain);
    save(); toast('已' + (S.global.settings[k] ? '开启' : '关闭'));
    show('me');
  }

  /* ================= 6b. 背景主题 =================
   * 主题只改 token（底色/纹理/主色/阴影），组件结构一律不动 —— 见 themes.css。
   * 缩略图 .thm.t-xxx 是彩板自绘的，不带当前主题 token，所以四个选项在任何主题下都看得清。 */
  const BG_THEMES = [
    ['classic', '经典蓝白', '清爽默认，蓝白配色'],
    ['grid', '横线练习本', '信纸横线 + 左侧装订线'],
    ['cn', '中国风 · 宣纸', '宣纸底 + 云纹 + 朱砂主色'],
    ['ink', '水墨青岚', '黛青晕染，护眼低饱和'],
  ];
  function themeCardHtml() {
    const k = S.global.settings.bg || 'classic';
    return `<div class="card"><h3>${ICON('art')}背景主题</h3>
      <p class="muted small" style="margin:0 0 10px">只换底色与气质，题目、进度、布局一律不变。开暗色模式时自动回到暗色配色。</p>
      <div class="thmgrid">${BG_THEMES.map(([v, n, d]) => `<button class="thmbtn ${k === v ? 'on' : ''}" data-act="set-bg" data-k="${v}" title="${d}">
        <span class="thm t-${v}"><i></i></span>
        <span class="thmnm">${n}</span>
        <span class="thmds">${d}</span></button>`).join('')}</div></div>`;
  }

  /* ================= 7. 播放器增强 ================= */
  function playerMetaHtml(q, st) {
    if (!S.global.settings.showMeta) return '';
    const bits = [];
    if (q.qsource) bits.push(escp(q.qsource)); else if (q.year) bits.push(q.year + ' 年');
    if (q.source) bits.push(escp(q.source));
    if (q.difficulty) bits.push('难度 ' + '①②③④⑤'[q.difficulty - 1]);
    if (q.hot) bits.push('热度 ' + q.hot + ' 人次');
    if (q.acc != null) bits.push('站内正确率 ' + q.acc + '%');
    if (q.favCount) bits.push('收藏 ' + q.favCount);
    if (q.sys && q.sys !== q.chapterId) bits.push(escp(String(q.sys).slice(0, 24)));
    if (!bits.length) return '';
    const id = q.id;
    return `<div class="qmeta">${bits.map(b => `<span class="mtag">${b}</span>`).join('')}${masteryTag(st, id, true)}</div>`;
  }
  function playerExtraChips(q) {
    const st = curState();
    const hasF = !!feedbackOf(st, q.id);
    return `<button class="chip ${hasF ? 'on' : ''}" data-act="fb-open" data-id="${q.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>${hasF ? '已报错' : '纠错'}</button>`;
  }
  function playerWarnHtml(q) {
    if (q.type === 'A3' && String(q.content || '').length < 24) {
      return `<div class="qwarn">${ICON('warn')}本题属于病例组题，源数据缺共享病例正文，题干可能不完整</div>`;
    }
    if (q.img) return `<div class="qwarn">${ICON('img')}本题原始数据带图片，图未随题库下发，请对照教材原图作答</div>`;
    return '';
  }

  /* ================= 8. 统计卡 ================= */
  /* 布局：左「累计正确率」大字 → 右「覆盖率进度条」→ 分布条 + 四宫格 → 底部明细 */
  function statsCardHtml() {
    const st = curState(), sub = curSub();
    const all = allQuestionsBoth(sub);
    const ids = all.map(x => x.q.id);
    const d = masteryDist(st, ids);
    const answered = all.filter(x => { const s = st.qstat ? st.qstat[x.q.id] : null; return s && s.n; }).length;
    let right = 0, wrong = 0, seen = 0;
    for (const id of ids) { const s = st.qstat[id]; if (s) { seen += s.n; right += s.r; wrong += s.w; } }
    const rate = seen ? Math.round(right / seen * 100) : 0;
    const cov = ids.length ? Math.round(answered / ids.length * 100) : 0;
    return `<div class="card"><h3>掌握度</h3>
      <div class="mhead">
        <div class="mrate"><b>${rate}<i>%</i></b><span>累计正确率</span></div>
        <div class="mgauge">
          <div class="mga-line"><span>已作答</span><b>${answered}<i>/${ids.length}</i></b></div>
          <div class="mrow thin"><i style="width:${cov}%"></i></div>
          <div class="muted small">覆盖 ${cov}% · 已掌握 ${d[3]} 题</div>
        </div>
      </div>
      ${masteryBarHtml(st, ids)}
      <div class="mfoot">
        <span>作答 <b>${seen}</b> 次</span>
        <span class="ok">对 <b>${right}</b></span>
        <span class="bad">错 <b>${wrong}</b></span>
        <span>收藏 <b>${(st.fav || []).length}</b></span>
        <span>疑点 <b>${(st.doubt || []).length}</b></span>
      </div>
    </div>`;
  }

  /* ================= 9. 动作分发 ================= */
  function act(a, t) {
    if (!a) return false;
    /* --- 高级筛选 --- */
    if (a === 'filter-setup') { filterSetup(); return true; }
    /* 注意：这里**不能**先调 collectFilterNums()。closeModal() 只加 hidden、不清 innerHTML，
     * 收集会读到「上次关闭时残留的输入框值」并写进 F，表现为「一打开面板就是 0 命中」。
     * 面板内的输入值本来就由 F 渲染，无需回读；用户填完直接点「开始练习」时由 filterGo() 收集。 */
    if (a === 'f-toggle' || a === 'f-set') {
      const f = t.dataset.f, v = t.dataset.v;
      collectFilterNums();
      if (a === 'f-toggle') {
        const arr = F[f] || [];
        const i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1); else arr.push(v);
        F[f] = arr;
      } else F[f] = v;
      filterSetup(); return true;
    }
    if (a === 'f-bool') { collectFilterNums(); F[t.dataset.f] = !F[t.dataset.f]; filterSetup(); return true; }
    if (a === 'f-limit') { collectFilterNums(); F.limit = t.dataset.v === 'all' ? 'all' : +t.dataset.v; filterSetup(); return true; }
    if (a === 'f-mode') { collectFilterNums(); F.mode = t.dataset.v === 'exam' ? 'exam' : 'practice'; filterSetup(); return true; }
    /* 重置只清条件，保留「练习/考试」模式选择（否则考试用户一点重置就被踢回练习） */
    if (a === 'f-reset') { const keep = F.mode; F = newFilter(); F.mode = keep; filterSetup(); return true; }
    if (a === 'f-go') { filterGo(); return true; }
    /* --- 纠错 --- */
    if (a === 'fb-open') { openFeedback(t.dataset.id); return true; }
    if (a === 'fb-pick') {
      fbSelType = t.dataset.v;
      document.querySelectorAll('#modalBox [data-act="fb-pick"]').forEach(b => b.classList.toggle('on', b.dataset.v === fbSelType));
      return true;
    }
    if (a === 'fb-save') { saveFeedback(t.dataset.id); return true; }
    if (a === 'fb-del') {
      const st = curState(); st.feedback = (st.feedback || []).filter(f => f.id !== t.dataset.id); save();
      closeModal(); toast('已撤销反馈'); if (!document.getElementById('player').classList.contains('hidden')) renderPlayer(); return true;
    }
    if (a === 'fb-export') { exportFeedback(); return true; }
    if (a === 'fb-clear') {
      if (!confirm('清空当前学科的纠错记录？')) return true;
      curState().feedback = []; save(); show('me'); toast('已清空'); return true;
    }
    /* --- 偏好 --- */
    if (a === 'pref') { togglePref(t.dataset.k); return true; }
    /* --- 背景主题 ---
     * 刻意不调 show('me')：那会把设置页滚回顶部，用户挑主题时得重新往下翻。
     * 原地改 body[data-bg] + 切按钮高亮即可。 */
    if (a === 'set-bg') {
      const k = t.dataset.k || 'classic';
      S.global.settings.bg = k;
      applySettings(); save();
      document.querySelectorAll('.thmbtn').forEach(b => b.classList.toggle('on', b.dataset.k === k));
      toast('背景已切换 · ' + (BG_THEMES.find(x => x[0] === k) || [, '经典蓝白'])[1]);
      return true;
    }
    /* --- 最弱知识点 → 组卷补漏 --- */
    if (a === 'kp-drill') { kpDrill(t.dataset.tag || ''); return true; }
    return false;
  }

  /* 供 app.js 的 renderPlayer 使用：非选择题（无选项）作答区 */
  function noChoiceHtml(q, a) {
    return `<div class="nochoice">
      <div class="muted small">本题为非选择题（源数据无选项），请对照答案自评。</div>
      <textarea class="inp block" rows="3" placeholder="写下你的答案（可选）">${escp(a && a.text || '')}</textarea>
      ${a && a.revealed ? `<div class="ans-line ${a.correct ? 'ok' : 'bad'}">参考答案：${escp(q.correct)}</div>` : ''}
      <div class="wrap" style="margin-top:8px">
        ${a && a.revealed
        ? `<button class="btn ghost" data-act="nc-undo">重做</button>`
        : `<button class="btn soft" data-act="nc-reveal">看答案</button>
             <button class="btn" data-act="nc-right">算我答对</button>
             <button class="btn ghost" data-act="nc-wrong">算我答错</button>`}
      </div></div>`;
  }

  /* ================= 4. 知识点掌握（tags 聚合 → 最弱知识点） =================
   * 借鉴 iyixue.top 的「最弱知识点 Top3」：把题目级作答统计（qstat）按知识点标签聚合，
   * 取正确率最低的几个，点一下就能对该知识点组卷补漏。
   * 注意：标签是稀疏字段（本站约 1 万题带 tg），无数据的知识点不入榜（minN 门槛），
   * 所以不会出现「1 题答错就判定你最弱」的噪声。 */
  /* 标签聚合：tag → {tag, total 题量, n 作答, r 答对, acc, ids}
   * 一次遍历同时拿到题量与作答统计 —— 「最弱排名」和「空态兜底入口」共用同一份数据。 */
  /* 元数据标签 ≠ 知识点：考频分级（A 必背 ×816 / B 高频 ×194）与题型名（A1型题）
   * 是筛选用的元信息。它们题量碾压任何真知识点（蛋白质 ×60、肾小球 ×30），
   * 不滤掉就必然长期霸占「最弱」Top3 —— 用户看到的「最弱知识点」是「A 必背」，
   * 自然觉得怪。 */
  function isMetaTag(t) {
    const s = String(t || '').trim();
    if (!s) return true;
    if (/型题|A\d+型|^(多选题|定义题|错题辨析)/.test(s)) return true;    // A1型题 / X型题 / A1型记忆题 / 多选题
    if (/(必背|高频|低频|中频|常规|考频|常考)/.test(s)) return true;   // A 必背 / B 高频
    return false;
  }
  function tagAgg(sub, st) {
    const m = new Map();
    for (const x of allQuestionsBoth(sub)) {
      const tg = x.q.tags; if (!tg || !tg.length) continue;
      const s = st.qstat ? st.qstat[x.q.id] : null;
      for (const t of tg) {
        if (isMetaTag(t)) continue;
        let a = m.get(t); if (!a) m.set(t, a = { tag: t, total: 0, n: 0, r: 0, acc: 0, ids: [] });
        a.total++; a.ids.push(x.q.id);
        if (s && s.n) { a.n += s.n; a.r += s.r; }
      }
    }
    for (const a of m.values()) a.acc = a.n ? Math.round(a.r / a.n * 100) : 0;
    return m;
  }
  function weakTags(sub, st, topN, minN) {
    topN = topN || 3; minN = minN || 3;
    return [...tagAgg(sub, st).values()].filter(a => a.n >= minN)
      .sort((x, y) => x.acc - y.acc).slice(0, topN);
  }
  /* 条形色 = 正确率分档（<50% 红 / 50–79% 黄 / ≥80% 绿 / 未练 灰）。
   * 原来所有条都是同一个蓝，看不出谁更弱，"最弱"名不副实。 */
  function barColor(acc, n) {
    if (!n) return 'var(--muted)';
    if (acc < 50) return 'var(--bad)';
    if (acc < 80) return 'var(--warn)';
    return 'var(--ok)';
  }
  function kpCardHtml() {
    const st = curState(), sub = curSub();
    const agg = tagAgg(sub, st);
    if (!agg.size) return '';                     // 该学科没有带知识点标签的题 → 整卡不出现
    const tagged = [...agg.values()].reduce((a, b) => a + b.total, 0);
    const head = `<div class="row between"><h3 style="margin:0">${ICON('puzzle')}最弱知识点</h3><span class="muted small">${agg.size} 个知识点 · 累计 ${tagged} 题次</span></div>`;
    const row = (tag, right, sub2) => `<div class="kp-row" role="button" tabindex="0" data-act="kp-drill" data-tag="${escp(tag)}" aria-label="练习知识点：${escp(tag)}">
        <div class="kp-t">${escp(tag)}</div>
        <div class="kp-bar"><i style="width:${right.pct}%;background:${right.color}"></i></div>
        <div class="kp-n" style="color:${right.color}">${right.main}<span class="muted small"> · ${sub2}</span></div>
        <span class="kp-go">练</span></div>`;
    const note = `<p class="muted small" style="margin:6px 0 0">知识点标签已覆盖全部题目（扩展题原生 + 极光题补标：合并继承/词表匹配/AI 补标），个别标签可能偏粗。</p>`;
    const w = weakTags(sub, st, 3, 3);
    if (w.length) {
      return `<div class="card" style="margin-top:12px">${head}
        <p class="muted small" style="margin:8px 0 10px">按正确率升序，至少作答 3 次才入榜：<b style="color:var(--bad)">红 &lt;50%</b> · <b style="color:var(--warn)">黄 50–79%</b> · <b style="color:var(--ok)">绿 ≥80%</b>。点一行即可组卷补漏。</p>${
        w.map(a => row(a.tag, { pct: a.acc, color: barColor(a.acc, a.n), main: a.acc + '%' }, a.n + ' 答')).join('')}${note}</div>`;
    }
    /* 兜底：作答量还不够排名时，列题量最大的知识点当入口。
     * 旧版这里只有一句「满 3 次后才列出」，卡片看着像坏了（点了没反应）。 */
    const top = [...agg.values()].sort((a, b) => b.total - a.total).slice(0, 6);
    return `<div class="card" style="margin-top:12px">${head}
      <p class="muted small" style="margin:8px 0 10px">知识点累计作答满 3 次后才参与「最弱」排名。先挑一个开练，练完这里就会自动排出最该补的 3 个。</p>${
      top.map(a => row(a.tag, { pct: a.n ? a.acc : 0, color: barColor(a.acc, a.n), main: a.n ? a.acc + '%' : '未练' }, a.total + ' 题')).join('')}${note}</div>`;
  }
  function kpDrill(tag) {
    const pool = allQuestionsBoth(curSub()).filter(x => (x.q.tags || []).indexOf(tag) >= 0);
    if (!pool.length) { toast('该知识点暂无可练习的题目'); return; }
    const n = Math.min(30, pool.length);
    toast(`「${tag}」组卷 ${n} 题`);
    requestStart(shuffle(pool).slice(0, n), 'practice', {}, null);
  }

  return {
    MASTERY, masteryOf, masteryTag, masteryDist, masteryBarHtml,
    newFilter, poolFor, filterSetup, filterGo, srcOptions,
    optView, keyOfDisp, dispOfKey, isNoChoice,
    FB_TYPES, openFeedback, feedbackListHtml, feedbackOf, exportFeedback,
    PREFS, prefCardHtml, togglePref, BG_THEMES, themeCardHtml,
    playerMetaHtml, playerWarnHtml, playerExtraChips, statsCardHtml, noChoiceHtml,
    tagAgg, weakTags, isMetaTag, barColor, kpCardHtml, kpDrill,
    act,
    esc: escp,
  };
})();
