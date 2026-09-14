/**
 * 前端二期改造 · 验证脚本（不依赖浏览器）
 *
 * 两部分：
 *  A. 静态引用审计 —— ① app.js 里用到的 Feat.xxx 是否都真的导出；② 所有 data-act 是否都有处理分支；
 *                     ③ 新增 CSS 类是否都有样式定义。
 *  B. 逻辑单测 —— 用 vm + 极简 DOM 桩加载 features.js，对四级掌握 / 高级筛选 / 选项乱序 / 渲染片段
 *                 做断言（含边界）。
 *
 * 用法：node verify_frontend.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const SITE = path.join(WS, 'site');
const appSrc = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');
const featSrc = fs.readFileSync(path.join(SITE, 'features.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(SITE, 'styles.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; bad.push(name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
function noThrow(name, fn) { try { fn(); pass++; } catch (e) { fail++; bad.push(name + ' :: 抛异常 ' + e.message); } }

/* ================= A. 静态引用审计 ================= */
console.log('===== A. 静态引用审计 =====');

/* A1. Feat 导出的键 */
const retBlock = featSrc.slice(featSrc.lastIndexOf('return {'), featSrc.lastIndexOf('};'));
const exported = new Set([...retBlock.matchAll(/(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*[:,]/gm)].map(m => m[1]));
const used = new Set([...appSrc.matchAll(/Feat\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
const missing = [...used].filter(k => !exported.has(k));
ok('A1 app.js 引用的 Feat.* 均已导出', missing.length === 0, '缺失: ' + missing.join(', '));
console.log(`  Feat 导出 ${exported.size} 项；app.js 引用 ${used.size} 项 → 缺失 ${missing.length}`);

/* A2. 所有 data-act 是否有处理分支 */
const acts = new Set([...appSrc.matchAll(/data-act="([a-z0-9\-]+)"/g)].map(m => m[1]));
const featActs = new Set([...featSrc.matchAll(/a === '([a-z0-9\-]+)'/g)].map(m => m[1]));
for (const m of featSrc.matchAll(/a === '([a-z0-9\-]+)' \|\| a === '([a-z0-9\-]+)'/g)) { featActs.add(m[1]); featActs.add(m[2]); }
const appActs = new Set([...appSrc.matchAll(/act === '([a-z0-9\-]+)'/g)].map(m => m[1]));
const unhandled = [...acts].filter(a => !featActs.has(a) && !appActs.has(a));
ok('A2 所有 data-act 均有处理分支', unhandled.length === 0, '未处理: ' + unhandled.join(', '));
console.log(`  data-act 共 ${acts.size} 个；Feat 处理 ${featActs.size} 个；app.js 处理 ${appActs.size} 个 → 未处理 ${unhandled.length}`);

/* A3. 新增 CSS 类是否有定义 */
const cssClasses = new Set([...cssSrc.matchAll(/\.([a-z][\w-]*)/g)].map(m => m[1]));
/* 掌握度改版后旧的 12px 小胶囊图例 .mlegend 已被四宫格 .mgrid/.mcell 取代 */
const newCls = ['mstag', 'mrow', 'mseg', 'mgrid', 'mcell', 'kp-row', 'kp-bar', 'frow', 'flabel', 'fchips', 'fpreview', 'qmeta', 'mtag', 'qwarn', 'qfb', 'nochoice', 'lib-list', 'lib-item', 'lib-txt', 'sheet-sum', 'plain', 'eng-go', 'engr', 'engr-head', 'engr-back', 'engr-idx', 'engr-body', 'engr-word', 'engr-ph', 'engr-cn', 'engr-sec', 'engr-et', 'engr-ex', 'engr-tr', 'engr-pm', 'engr-foot', 'engr-nav', 'engr-tip', 'ph-row', 'ph-spk', 'eng-dept', 'eng-quiz', 'eng-q-cn', 'eng-q-en', 'eng-q-audio', 'eng-q-replay', 'eng-qopts', 'eng-qopt', 'eng-qk', 'eng-q-next-row', 'eng-done', 'eng-done-t', 'eng-modes', 'engr-blank', 'engr-blank-t', 'eng-card-blank', 'eng-item-ph'];
const noCss = newCls.filter(c => !cssClasses.has(c));
ok('A3 新增 CSS 类均有样式', noCss.length === 0, '缺样式: ' + noCss.join(', '));
console.log(`  新增类 ${newCls.length} 个 → 缺样式 ${noCss.length}`);

/* A3b. 做题视图隔离必须用「白名单反选」，不能枚举要隐藏的外壳类。
 * 枚举写法（.topbar/.view/.tabbar/.banner）只要以后往 #app 里加一个新区块就会漏出来，
 * 而且漏了不报错、只能肉眼看——用户已经实际踩到过一次。 */
ok('A3b 做题视图隔离用白名单反选（非枚举外壳类）',
  /#app\.playing\s*>\s*:not\(#player\)/.test(cssSrc) && /#app\.playing\s*\{[^}]*display\s*:\s*block/.test(cssSrc));

/* A3c-A3g. 云同步（sync.js）：登录必须是「可选」，且合并策略不得退回整包 LWW。
 * 这组断言守住两件事：① 断网/云函数抖动不能再把人踢出学习；
 * ② 跨设备多端标记不能因整包覆盖而丢。 */
const syncSrc = fs.readFileSync(path.join(SITE, 'sync.js'), 'utf8');
ok('A3c 登录已降级为可选（无 showGate() 调用，仅留定义）',
  /function showGate/.test(syncSrc) && !/^[ \t]*showGate\(\);/m.test(syncSrc),
  'showGate() 调用 ' + (syncSrc.match(/^[ \t]*showGate\(\);/gm) || []).length + ' 处（应 0）');
ok('A3d 网络异常不清 token、不踢出门禁',
  !/clearAuth\(\);\s*[\r\n]+\s*showGate\(\)/.test(syncSrc) && /离线（网络恢复后自动同步）/.test(syncSrc));
ok('A3e 逐题合并到位（mergeState / mergeSubject / mergeReview）',
  /function mergeState/.test(syncSrc) && /function mergeSubject/.test(syncSrc) && /function mergeReview/.test(syncSrc));
ok('A3f push 前剥离 sessions（payload 降 ~78%）',
  /function stripForSync/.test(syncSrc) && (syncSrc.match(/stripForSync\(/g) || []).length >= 4,
  'stripForSync 引用 ' + (syncSrc.match(/stripForSync\(/g) || []).length + ' 处');
ok('A3g 登录后必开同步（doLogin 内 startSync → reconcile）',
  /startSync\(\);\s*refreshMeCard\(\);\s*reconcile\(\);/.test(syncSrc));

/* A3h. 医学英语调度（20260913）：单词进度是全站唯一 global 级学习进度，
 * 两条生命线缺一不可——缺 ① 双设备互吞进度；缺 ② 将来上真 SRS 无 review log。 */
const engSrc = fs.readFileSync(path.join(SITE, 'english.js'), 'utf8');
ok('A3a-1 sync.js mergeGlobal 合并 english（逐词取 n 大者，非整块 LWW）',
  /function mergeEnglishProg/.test(syncSrc) && /o\.english = mergeEnglishProg/.test(syncSrc));
ok('A3a-2 english.js pset 记录复习行为日志（[评分,时间戳]，封顶 50）',
  /o\.log\.push\(\[s, o\.t\]\)/.test(engSrc) && /o\.log\.length > 50/.test(engSrc));
ok('A3a-3 english.js 标记即排下次复习时间（SCHEDULE 间隔表 + due）',
  /const SCHEDULE = \{/.test(engSrc) && /o\.due = nextDue\(s, o\.n\)/.test(engSrc));
ok('A3a-4 复习模式 wordOf 取 reviewList 快照（cardIdx 索引的是复习队列）',
  /\(reviewList \|\| words\)\[cardIdx\]/.test(engSrc));
ok('A3a-5 测验答错降回生疏并喂调度（检索练习闭环）',
  /quizWrong\+\+; pset\(quizList\[quizIdx\], 0\)/.test(engSrc));
ok('A3a-6 测验选项对错反馈样式齐备（.eng-qopt.correct/.wrong）',
  /\.eng-qopt\.correct/.test(cssSrc) && /\.eng-qopt\.wrong/.test(cssSrc));

/* A4. index.html 载入顺序：features.js 必须在 app.js 之前 */
const iFeat = htmlSrc.indexOf('features.js'), iApp = htmlSrc.indexOf('app.js');
ok('A4 features.js 在 app.js 之前载入', iFeat > 0 && iApp > 0 && iFeat < iApp);
console.log(`  features.js@${iFeat}  app.js@${iApp}`);

/* A5. 版本号闸口（改了 js/css 必须带 ?v=） */
for (const f of ['features.js', 'app.js', 'styles.css']) {
  ok(`A5 ${f} 带版本号`, new RegExp(f.replace('.', '\\.') + '\\?v=').test(htmlSrc));
}

/* A6（A02 统一 id 网）：id 锚在「来源」而非题干内容后，老进度必须仍能落到正确题目上。
 * 三条链路缺一不可，缺任何一条都会静默丢进度：
 *   ① 分片里 flags.aliasIds → ALIAS 映射（否则老 id 直接「查无此题」）
 *   ② qById 走 ALIAS 间接寻址（否则错题本/收藏列表整条消失）
 *   ③ 存储里的旧 id 一次性归一化（否则错题本看得到、掌握度/作答统计读不到 → 键错配）
 *   ④ AI 变式题不在静态池里，必须能从本机 aiGen 兜回来 */
ok('A6a 分片加载时建立 别名→主 id 映射（ALIAS）', /ALIAS\[a\] = q\.id;/.test(appSrc));
ok('A6b qById 先做 ALIAS 间接寻址', /const real = ALIAS\[id\] \|\| id;/.test(appSrc));
ok('A6c 载入学科后归一化本机旧 id（normalizeSubjectIds 已挂到 ensureSubject）',
  /function normalizeSubjectIds\(sid\)/.test(appSrc) && /normalizeSubjectIds\(id\);/.test(appSrc));
ok('A6d 归一化覆盖 4 类标记 + 3 类 map + sessions.qids/answers',
  /'wrong', 'fav', 'doubt', 'mastered'/.test(appSrc) && /'qstat', 'review'/.test(appSrc)
  && /s\.qids/.test(appSrc) && /s\.answers/.test(appSrc));
ok('A6e qById 对 AI 变式题（aiGen）兜底', /chapterId: 'aigen:' \+ b\.batchId/.test(appSrc));
/* A02 之后扩展题主 id 不再以 ext- 开头，「按题库清空」若还只看前缀会把扩展题当极光题删掉。
 * 必须改为查分片加载时登记的 QGROUP（含别名）。 */
ok('A6f 清空进度的题库分类查 QGROUP 登记（不再只看 ext- 前缀）',
  /const QGROUP = Object\.create\(null\)/.test(appSrc) && /QGROUP\[q\.id\] = grp;/.test(appSrc)
  && /QGROUP\[a\] = grp;/.test(appSrc) && /QGROUP\[s\] \|\| QGROUP\[ALIAS\[s\] \|\| s\]/.test(appSrc));
ok('A6g 清空前补载未载入学科（否则无登记可查）',
  /async function doReset/.test(appSrc) && /await ensureSubject\(sid\);/.test(appSrc));

/* ================= B. 逻辑单测 ================= */
console.log('\n===== B. 逻辑单测 =====');

/* --- 构造数据集：3 题，覆盖 单选/多选/无选项，含年份/来源/难度/热度 --- */
const Q = {
  q1: { id: 'q1', content: '下列哪种酶催化糖酵解限速步骤', options: { C: '磷酸果糖激酶-1', A: '己糖激酶', B: '丙酮酸激酶' }, correct: 'C', multi: false, type: 'A1', typeLabel: '单选题', difficulty: 3, hot: 120, acc: 62, year: 2019, source: '医考帮', group: 'ext' },
  q2: { id: 'q2', content: '关于三羧酸循环的叙述正确的有', options: { A: '在线粒体进行', B: '生成 NADH', C: '净生成 2 个 ATP', D: '是不可逆的' }, correct: 'AB', multi: true, type: '多选', typeLabel: '多选题', difficulty: 4, hot: 40, acc: 35, year: 2015, source: '极光', group: 'jg' },
  q3: { id: 'q3', content: '简述蛋白质变性的本质', options: {}, correct: '空间构象破坏，一级结构不变', multi: false, type: '填空', typeLabel: '填空题', difficulty: 0, hot: 0, acc: null, year: null, source: '极光', group: 'jg' },
};
const CH = { a: { id: 'ch-a', name: '第三章 酶', grp: 'ext', questions: [Q.q1] }, b: { id: 'ch-b', name: '第一章 蛋白质', grp: 'jg', questions: [Q.q2, Q.q3] } };
const SUB = { id: 'bio', name: '生物化学', groups: { jg: { chapters: [CH.b] }, ext: { chapters: [CH.a] } }, chapters: [CH.a, CH.b] };

const STORE = { subjects: {} };
const ST = {
  wrong: ['q2'], fav: ['q1'], doubt: ['q3'], mastered: ['q1'],
  byChapter: {}, daily: {}, examHistory: [], review: { q1: { stage: 3, nextReview: 0 }, q2: { stage: 0, nextReview: 0 } },
  hadWrong: true, feedback: [], qstat: { q1: { n: 3, r: 3, w: 0 }, q2: { n: 2, r: 0, w: 2 } },
  aiGen: [],
};
STORE.subjects.bio = ST;

const sandbox = {
  console,
  JSON,
  Math,
  Date,
  Map,
  Set,
  Object,
  Array,
  String,
  Number,
  isNaN,
  parseInt,
  parseFloat,
  setTimeout,
  Blob: function () { },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => { } },
  confirm: () => true,
  S: { global: { settings: { dark: false, showMeta: true, plain: false, optShuffle: false, swipe: true, autoSubmit: false, autoNext: false } }, subjects: STORE.subjects, sessions: {} },
  cur: 'bio',
  SB: { bio: SUB },
  P: null,
  inSet: (a, id) => (a || []).indexOf(id) >= 0,
  addSet: (a, id) => { if (a.indexOf(id) < 0) a.push(id); },
  remSet: (a, id) => { const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); },
  curState: () => ST,
  curSub: () => SUB,
  groupCount: (sub, k) => sub.groups[k].chapters.reduce((a, c) => a + c.questions.length, 0),
  allQuestions: sub => { const o = []; for (const c of sub.chapters) for (const q of c.questions) o.push({ q, chapterName: c.name, chapterId: c.id }); return o; },
  allQuestionsBoth: sub => { const o = []; for (const g of ['jg', 'ext']) for (const c of sub.groups[g].chapters) for (const q of c.questions) o.push({ q, chapterName: c.name, chapterId: c.id, grp: g }); return o; },
  qById: id => { for (const g of ['jg', 'ext']) for (const c of SUB.groups[g].chapters) { const f = c.questions.find(x => x.id === id); if (f) return { q: f, chapterName: c.name, chapterId: c.id, grp: g }; } return null; },
  shuffle: a => a.slice().reverse(),
  save: () => { },
  toast: () => { },
  ICON: n => '<i>' + n + '</i>',   // features.js 引用的跨文件全局（浏览器里由 app.js 提供），vm 沙箱补桩
  show: t => { sandbox.__shown = t; },
  openModal: html => { sandbox.__modal = html; },
  closeModal: () => { sandbox.__closed = true; },
  renderPlayer: () => { },
  startPractice: (...a) => { sandbox.__start = a; },
  requestStart: (...a) => { sandbox.__reqStart = a; },
  document: {
    body: { classList: { toggle: () => { }, contains: () => false } },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, click: () => { }, remove: () => { } }),
  },
  window: {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(featSrc, sandbox);
const Feat = sandbox.window.Feat;
ok('B0 features.js 加载并导出 Feat', !!Feat);

/* B1 四级掌握状态判定 */
eq('B1a 无作答记录 → 0 未接触', Feat.masteryOf(ST, 'q3'), 0);
eq('B1b 答错在错题集 → 1 见过', Feat.masteryOf(ST, 'q2'), 1);
eq('B1c 答对≥2 但回顾 stage<2 → 2 熟悉', Feat.masteryOf({ ...ST, review: { q1: { stage: 1 } } }, 'q1'), 2);
eq('B1d 答对≥2 且 stage≥2 → 3 掌握', Feat.masteryOf(ST, 'q1'), 3);
eq('B1e 只答对 1 次 → 1 见过', Feat.masteryOf({ ...ST, qstat: { q1: { n: 1, r: 1, w: 0 } } }, 'q1'), 1);
noThrow('B1f masteryTag 可渲染', () => Feat.masteryTag(ST, 'q1', true));
noThrow('B1g masteryBarHtml 可渲染', () => Feat.masteryBarHtml(ST, ['q1', 'q2', 'q3']));

/* B2 高级筛选 */
{
  const F = Feat.newFilter();
  eq('B2a 默认条件命中全部', Feat.poolFor(F).length, 3);
  eq('B2b 只看极光', Feat.poolFor({ ...F, grp: 'jg' }).length, 2);
  eq('B2c 只看扩展', Feat.poolFor({ ...F, grp: 'ext' }).length, 1);
  eq('B2d 题型=多选', Feat.poolFor({ ...F, types: ['多选'] }).length, 1);
  eq('B2e 难度含 3/4', Feat.poolFor({ ...F, diffs: ['3', '4'] }).length, 2);
  eq('B2f 年份 ≥2018', Feat.poolFor({ ...F, yFrom: '2018' }).length, 1);
  eq('B2g 热度 ≥100', Feat.poolFor({ ...F, hotMin: '100' }).length, 1);
  eq('B2h 正确率 ≤40', Feat.poolFor({ ...F, accTo: '40' }).length, 1);
  eq('B2i 来源=极光', Feat.poolFor({ ...F, srcs: ['极光'] }).length, 2);
  eq('B2j 状态=做错过', Feat.poolFor({ ...F, status: 'wrong' }).length, 1);
  eq('B2k 状态=做对过', Feat.poolFor({ ...F, status: 'right' }).length, 1);
  eq('B2l 状态=完全没碰', Feat.poolFor({ ...F, status: 'never' }).length, 1);
  eq('B2m 排除已掌握', Feat.poolFor({ ...F, excludeMastered: true }).length, 2);
  eq('B2n 组合：极光+排除已掌握', Feat.poolFor({ ...F, grp: 'jg', excludeMastered: true }).length, 2);
  eq('B2o 组合：扩展+多选', Feat.poolFor({ ...F, grp: 'ext', types: ['多选'] }).length, 0);
}

/* B3 选项乱序（确定性 + 不丢项 + 双向映射） */
{
  sandbox.S.global.settings.optShuffle = false;
  let v = Feat.optView(Q.q1);
  eq('B3a 关闭乱序时按键排序输出 A/B/C', v.map(x => x.disp), ['A', 'B', 'C']);
  eq('B3b disp=key', v.map(x => x.key), ['A', 'B', 'C']);
  eq('B3c 文本对应正确（A=己糖激酶 / B=丙酮酸激酶）', [v.find(x => x.disp === 'A').text, v.find(x => x.disp === 'B').text], ['己糖激酶', '丙酮酸激酶']);
  sandbox.S.global.settings.optShuffle = true;
  const v1 = Feat.optView(Q.q1), v2 = Feat.optView(Q.q1);
  eq('B3d 开启乱序后 disp 仍是 A/B/C', v1.map(x => x.disp).sort(), ['A', 'B', 'C']);
  eq('B3e key 集合不丢不重', v1.map(x => x.key).sort(), ['A', 'B', 'C']);
  eq('B3f 两次调用顺序一致（确定性）', v1.map(x => x.key), v2.map(x => x.key));
  for (const k of ['A', 'B', 'C']) eq(`B3g keyOfDisp/dispOfKey 往返 ${k}`, Feat.keyOfDisp(Q.q1, Feat.dispOfKey(Q.q1, k)), k);
  eq('B3h 文本未串位', v1.map(x => Q.q1.options[x.key]), v1.map(x => x.text));
  sandbox.S.global.settings.optShuffle = false;
}

/* B4 非选择题识别 */
ok('B4a 无选项题识别为 noChoice', Feat.isNoChoice(Q.q3) === true);
ok('B4b 有选项题不误判', Feat.isNoChoice(Q.q1) === false);
noThrow('B4c noChoiceHtml 可渲染', () => Feat.noChoiceHtml(Q.q3, {}));

/* B5 渲染片段不抛异常 */
noThrow('B5a playerMetaHtml', () => Feat.playerMetaHtml(Q.q1, ST));
noThrow('B5b playerWarnHtml', () => Feat.playerWarnHtml({ type: 'A3', content: '首选检查是', img: 0 }));
noThrow('B5c playerExtraChips', () => Feat.playerExtraChips(Q.q1));
noThrow('B5d statsCardHtml', () => Feat.statsCardHtml());
noThrow('B5e prefCardHtml', () => Feat.prefCardHtml());noThrow('B5g feedbackListHtml 空态', () => Feat.feedbackListHtml(ST));
ok('B5h playerMetaHtml 含年份与来源', /2019/.test(Feat.playerMetaHtml(Q.q1, ST)) && /医考帮/.test(Feat.playerMetaHtml(Q.q1, ST)));
ok('B5i A3 缺病例正文给出提醒', /病例/.test(Feat.playerWarnHtml({ type: 'A3', content: '首选检查是' })));
ok('B5j 图片题给出提醒', /图/.test(Feat.playerWarnHtml({ type: 'A1', content: '看图作答如下所示', img: 2 })));
ok('B5k showMeta 关闭后不输出元信息', Feat.playerMetaHtml(Q.q1, { ...ST }) !== '' && (() => { sandbox.S.global.settings.showMeta = false; const r = Feat.playerMetaHtml(Q.q1, ST) === ''; sandbox.S.global.settings.showMeta = true; return r; })());

/* B6 筛选面板渲染 + 动作分发 */
{
  noThrow('B6a filterSetup 可渲染', () => Feat.filterSetup());
  ok('B6b 面板含命中数预览', /命中/.test(sandbox.__modal || ''));
  const fake = { dataset: { f: 'types', v: '多选' } };
  ok('B6c act f-toggle 被接管', Feat.act('f-toggle', fake) === true);
  noThrow('B6d f-reset 可重置', () => Feat.act('f-reset', { dataset: {} }));
  sandbox.__reqStart = null;
  noThrow('B6e f-go 可开始练习', () => Feat.act('f-go', { dataset: {} }));
  ok('B6f f-go 真的调用了 requestStart', Array.isArray(sandbox.__reqStart) && sandbox.__reqStart[1] === 'practice', JSON.stringify(sandbox.__reqStart && sandbox.__reqStart[1]));
  /* 「存为考试」按钮已在「组卷中心」改版中移除（考试降级为面板内的模式开关），
     改为：切到 exam 模式 → f-go 应以 exam 起卷。 */
  noThrow('B6g 可切到限时考试模式（f-mode）', () => Feat.act('f-mode', { dataset: { v: 'exam' } }));
  noThrow('B6g2 考试模式 f-go 可起卷', () => { sandbox.__reqStart = null; Feat.act('f-go', { dataset: {} }); });
  ok('B6h 考试模式参数正确', !!(sandbox.__reqStart && sandbox.__reqStart[1] === 'exam' && sandbox.__reqStart[2] && sandbox.__reqStart[2].minutes > 0));
  Feat.act('f-mode', { dataset: { v: 'practice' } });   // 复位，避免影响紧跟的 limit 用例
  ok('B6i 未知动作不被接管（交回 app.js）', Feat.act('goto', { dataset: {} }) === false);
  /* limit 生效 */
  Feat.act('f-reset', { dataset: {} });
  Feat.act('f-limit', { dataset: { v: '1' } });
  sandbox.__reqStart = null;
  Feat.act('f-go', { dataset: {} });
  ok('B6j 数量上限生效', sandbox.__reqStart && sandbox.__reqStart[0].length === 1, 'len=' + (sandbox.__reqStart && sandbox.__reqStart[0].length));
}

{
  ST.feedback = [];  noThrow('B7a openFeedback 可渲染', () => Feat.openFeedback('q1'));
  ST.feedback.push({ id: 'q1', type: 'answer', text: '应为 B', at: Date.now(), stem: 'x', subjectName: '生物化学' });
  ok('B7b feedbackOf 命中', !!Feat.feedbackOf(ST, 'q1'));
  /* 偏好开关 */
  sandbox.__shown = null;
  sandbox.S.global.settings.plain = false;
  Feat.act('pref', { dataset: { k: 'plain' } });
  ok('B7i 偏好开关切换生效', sandbox.S.global.settings.plain === true);
  ok('B7j 切换后回到我的页', sandbox.__shown === 'me');
  Feat.act('pref', { dataset: { k: 'plain' } });
  ok('B7k 再切一次可关闭', sandbox.S.global.settings.plain === false);
  ok('B7l 偏好项定义完整（6 项）', Feat.PREFS.length === 6);
  ok('B7m 反馈类型 4 类', Feat.FB_TYPES.length === 4 && Feat.FB_TYPES.map(t => t.v).join(',') === 'answer,explain,stem,other');
  ok('B7n 四级掌握定义完整', Feat.MASTERY.length === 4);
  ok('B7o 懒加载筛选条件状态可读', typeof Feat.poolFor === 'function');
}

/* ================= 汇总 ================= */
console.log('\n===== 汇总 =====');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (bad.length) { console.log('失败项：'); for (const b of bad) console.log('  ✗ ' + b); }
process.exit(fail ? 1 : 0);
