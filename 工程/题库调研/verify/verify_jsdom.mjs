// jsdom 端到端集成测试：真实加载 site/index.html + app.js + features.js（源码级）
// 用法：node verify_jsdom.mjs
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require_('C:/Users/Pengcheng_Li/.workbuddy/binaries/node/workspace/node_modules/jsdom');
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'site');
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ---------- 构建 DOM ---------- */
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const errors = [];
/* 运行时异常收集：jsdom 默认只把 jsdomError 打到 console，不会让断言失败。
 * 这正是「高级筛选首次点击崩溃」曾经漏网的原因 —— 旧测试直接调 Feat.filterSetup()，
 * 绕过了真正的 act 分发层（崩在 act('filter-setup') → collectFilterNums() → F 为 null）。 */
const runtimeErrs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const msg = (e.detail && (e.detail.stack || e.detail.message)) || e.message || String(e);
  if (!/getContext/.test(msg)) runtimeErrs.push(msg);   // canvas 未装包属环境限制，忽略
});
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8788/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const { document } = window;

// fetch shim：相对路径 / 绝对路径统一映射到磁盘文件
const QF = pathToFileURL(R + '/').href;
window.fetch = async (u) => {
  const href = String(u);
  let p = null;
  if (href.startsWith(QF)) p = fileURLToPath(href.split('?')[0]);
  else if (/^https?:\/\//.test(href)) {
    if (!href.startsWith('http://127.0.0.1:8788/')) return { ok: false, status: 404, json: async () => ({}) };
    p = path.join(R, decodeURIComponent(href.split('8788')[1].split('?')[0]));
  } else p = path.join(R, decodeURIComponent(href.split('?')[0]));   // 相对路径
  try {
    const buf = fs.readFileSync(p);
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), text: async () => buf.toString('utf8') };
  } catch { return { ok: false, status: 404, json: async () => ({}) }; }
};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.alert = () => {}; window.confirm = () => true;
window.requestAnimationFrame = cb => setTimeout(cb, 0);

const scriptCode = [
  'app.js', 'english.js', 'features.js',
].map(f => fs.readFileSync(path.join(R, f), 'utf8')).join('\n;\n')
  // 测试探针注入到与 app.js 相同的作用域（strict 模式下 let/const 不上 window）
  + '\n;window.__T = { x: c => eval(c) };';

try { window.eval(scriptCode); }
catch (e) { errors.push('顶层 eval: ' + e.message + '\n' + (e.stack || '').split('\n')[1]); }
const T = () => window.__T;
const X = c => { try { return T().x(c); } catch (e) { return '__ERR__' + e.message; } };

/* ---------- 等待 init ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(200);
/* ---------- 等待自动 init ---------- */
let bootReady = false;
for (let i = 0; i < 60; i++) {
  const n = X('Object.keys(SB).length');
  const vl = (document.getElementById('view')?.innerHTML || '').length;
  if (typeof n === 'number' && n > 0 && vl > 500) { bootReady = true; break; }
  await sleep(150);
}
ok('自动 init 完成（SB 就绪 + 首页渲染）', bootReady);


section('A. 启动与数据装配');
ok('无顶层脚本错误', errors.length === 0, errors.join(' | '));
ok('Feats 已加载', X('typeof Feat==="object" && !!Feat.MASTERY') === true);
ok('SB 装配完成', X('Object.keys(SB).length') >= 1);
const semJson = X('JSON.stringify(MANIFEST.semesters.map(s=>s.id+":"+s.subjects.map(x=>x.id).join(",")))');
console.log('    semesters:', semJson);
ok('仅白名单 4 科（含 med-english 占位或 3 科）', /bio/.test(semJson) && /physiology/.test(semJson) && /immunology/.test(semJson) && !/patho|micro|anatomy/.test(semJson), semJson);
ok('chapterAliases 存在（章节归一迁移表）', X('Object.keys(MANIFEST.chapterAliases||{}).length') >= 3);

/* ---------- B. 章节归一效果（扩展组） ---------- */

const cnParse = s => { const m = String(s).match(/^第(.+?)章/); if (!m) return null; const t2 = m[1].trim(); if (/^\d+$/.test(t2)) return +t2; const CN = { 零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
  if (/^十/.test(t2)) return 10 + (t2.length > 1 ? CN[t2[1]] || 0 : 0);
  const mm = t2.match(/^([零一二三四五六七八九])十([零一二三四五六七八九])?$/); if (mm) return CN[mm[1]] * 10 + (mm[2] ? CN[mm[2]] : 0); return CN[t2] ?? null; };
for (const sid of ['bio', 'physiology', 'immunology']) {
  await X('ensureSubject(' + JSON.stringify(sid) + ')');
  await sleep(300);
  const names = X('SB[' + JSON.stringify(sid) + '].groups.ext.chapters.map(c=>c.name)');
  ok(sid + ' 扩展章节已加载', Array.isArray(names) && names.length > 0, String(names).slice(0,80));
  if (Array.isArray(names) && names.length) {
    const idx = names.map((n, i2) => { const v = cnParse(n); return v === null ? (n === '其他/综合' ? 999 : 998) : v; });
    ok(sid + ' 章节按章号有序', idx.every((v, i2) => i2 === 0 || v >= idx[i2 - 1]), JSON.stringify(names));
    ok(sid + ' 无裸名残留（除 其他/综合）', names.filter(n => !/^第.+章/.test(n) && n !== '其他/综合').length === 0);
    ok(sid + ' 每章有题数', X('SB[' + JSON.stringify(sid) + '].groups.ext.chapters.every(c=>c.questions.length>0)') === true);
  }
}

/* 章号解析源码注入（供上面 eval 用） */
const cnNumSrc = `var CNm={零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
function cnN(s){s=String(s).trim();if(/^\\d+$/.test(s))return +s;if(/^十/.test(s))return 10+(s.length>1?CNm[s[1]]||0:0);var m=s.match(/^([零一二三四五六七八九])十([零一二三四五六七八九])?$/);if(m)return CNm[m[1]]*10+(m[2]?CNm[m[2]]:0);return CNm[s]??null}`;
const chapNumSrc = `function chapNum(n){var m=String(n).match(/^第(.+?)章/);return m?cnN(m[1]):null}`;

/* ---------- C. 新功能点检 ---------- */
section('C. 新功能');
try { window.__T.x(`show('wrong')`); await sleep(80); } catch {}
/* B6 合并后题库页 = wrong tab（bank 独立页已并入）；C-5 起页内检索框为 #bkSearch，组卷按钮已移除 */
ok('题库页检索框入口', /bkSearch/.test(document.getElementById('view').innerHTML || ''));
ok('四级掌握状态定义', X('Feat.MASTERY.length') === 4);
ok('masteryOf 可用', X('typeof Feat.masteryOf==="function"') === true);
ok('纠错入口', X('typeof Feat.openFeedback==="function"') === true);
ok('偏好扩展字段', /swipe|autoNext|compact|plain|showMeta/.test(X('JSON.stringify(S.global.settings)')));
ok('错因筛选已移除', !/wreason/.test(fs.readFileSync(path.join(R, 'app.js'), 'utf8')));
ok('备考设置并入偏好卡', X('Feat.prefCardHtml().includes("setExam") && Feat.prefCardHtml().includes("setGoal")') === true);

/* ---------- D. 刷题流程 ---------- */
section('D. 刷题流程');
try {
  await X('ensureSubject("bio")'); await sleep(400);
  X('setGroup("bio","jg")');
  X('requestStart(allQuestionsBoth(SB["bio"]).slice(0,5), "practice", {}, null)'); await sleep(250);
  ok('练习器启动', X('!!P && typeof P.pool==="object" && P.pool.length>0 && P.idx===0') === true);
  const probe = X('(function(){ var it = P.pool[P.idx]; var q = it && it.q; return JSON.stringify({id:q.id, correct:q.correct, k:Object.keys(q.options)[0]}); })()');
  const pp = JSON.parse(probe);
  X('pick(' + JSON.stringify(pp.k) + ')'); await sleep(30);
  ok('选项已选中', X('P.answers[' + JSON.stringify(pp.id) + '].chosen.length>0') === true);
  X('confirmAns()'); await sleep(30);
  ok('作答记录并揭示', X('P.answers[' + JSON.stringify(pp.id) + '].revealed===true') === true);
  X('nextQ()'); await sleep(30);
  ok('翻题正常', X('P.idx>=1') === true);
} catch (e) { ok('刷题流程', false, e.message); }

/* ---------- E. 持久化与迁移 ---------- */
section('E. 持久化与章节键迁移');
const saved = window.localStorage.getItem('quiz_v1');
ok('localStorage 已写入', !!saved && saved.length > 50);
ok('状态结构完整', (() => { try { const j = JSON.parse(saved); return !!(j.subjects && j.sessions && j.global); } catch { return false; } })());
// 模拟旧章节键 → 迁移后应换到新键
const migProbe = X(`(function(){
  var CA=(MANIFEST.chapterAliases||{})['bio']||{};
  var oldCid=Object.keys(CA)[0]; if(!oldCid) return 'no-alias';
  S.subjects['bio']=S.subjects['bio']||{}; S.subjects['bio'].byChapter=S.subjects['bio'].byChapter||{};
  S.subjects['bio'].byChapter[oldCid]={total:3,correct:2};
  migrateChapterKeys();
  var nb=S.subjects['bio'].byChapter;
  return JSON.stringify({ old: oldCid, oldGone: !(oldCid in nb), newThere: !!(nb[CA[oldCid]] && nb[CA[oldCid]].total===3) });
})()`);
if (migProbe === 'no-alias') console.log('    （bio 无别名可测，跳过）');
else ok('章节键自动迁移', (() => { try { const j = JSON.parse(migProbe); return j.oldGone && j.newThere; } catch { return false; } })(), migProbe);

/* ---------- F. 富解析渲染（2026-09-12 新增） ---------- */
section('F. 富解析渲染');
try {
  await X('ensureSubject("bio")'); await sleep(300);
  const fmt = JSON.parse(X(`(function(){
    var e = SB['bio'].explain, ks = Object.keys(e), obj = 0, arr = 0;
    for (var i = 0; i < ks.length; i++) { var v = e[ks[i]]; if (v && typeof v === 'object' && !Array.isArray(v)) obj++; if (typeof v === 'string') arr++; }
    return JSON.stringify({ n: ks.length, obj: obj, str: arr });
  })()`));
  ok('解析分片为富解析对象', fmt.n > 1000 && fmt.obj > fmt.n * 0.99, JSON.stringify(fmt));

  const derive = JSON.parse(X(`(function(){
    var sub = SB['bio'], k = Object.keys(sub.explain)[0];
    var q = toQ({ id: k, t: 'A1', q: 'x', o: { A: 'a' }, a: 'A' });
    ensureExplain(sub, q);
    return JSON.stringify({ rich: typeof q.exp === 'object', txtLen: (q.explanation || '').length });
  })()`));
  ok('ensureExplain 注入富解析', derive.rich === true);
  ok('同时派生纯文本（AI 上下文仍可用）', derive.txtLen > 20, String(derive.txtLen));

  const blocks = JSON.parse(X(`(function(){
    var q = toQ({ id: 'vtest1', t: 'A1', q: '题干', o: { A: 'a', B: 'b' }, a: 'A' });
    q.exp = { bf: '一句话解析', b: [
      ['p', 'an', '考点解析', '正文段落'],
      ['tb', 'pf', '易错点分析', ['选项', '原因'], [['A', '混淆']]],
      ['l', 'ab', '答案依据', ['证据一', '证据二']],
      ['c', 'cn', '来源声明', '通用知识生成']
    ] };
    var h = explainHtml(q);
    return JSON.stringify({
      sec: (h.match(/class="exp-sec"/g) || []).length,
      brief: h.indexOf('exp-brief') >= 0,
      tbl: h.indexOf('exp-tbl') >= 0,
      dl: h.indexOf('data-label="选项"') >= 0,
      list: h.indexOf('exp-list') >= 0,
      callout: h.indexOf('exp-callout') >= 0
    });
  })()`));
  ok('小节卡片渲染', blocks.sec === 4, JSON.stringify(blocks));
  ok('一句话解析置顶', blocks.brief === true);
  ok('表格块渲染为真表格', blocks.tbl === true);
  ok('表格单元格带 data-label（移动端降级用）', blocks.dl === true);
  ok('列表块渲染', blocks.list === true);
  ok('提示块渲染为 callout', blocks.callout === true);

  const legacy = X(`(function(){ var q = toQ({ id: 'vtest2', t: 'A1', q: 'x', o: { A: 'a' }, a: 'A' }); q.exp = '旧格式纯文本'; return explainInner(q).indexOf('exp-p') >= 0; })()`);
  ok('旧版纯文本格式仍兼容', legacy === true);

  const reserved = JSON.parse(X(`(function(){
    var q = toQ({ id: 'vtest3', t: 'A1', q: 'x', o: { A: 'a' }, a: 'A' });
    q.exp = { t: '纯文本' };
    q.mnemonic = '口诀'; q.studyPoints = [{ title: 't', body: 'b' }];
    q.reasoningSteps = [{ evidence: 'e', inference: 'i' }];
    q.optionExplanations = [{ option: 'A', explanation: '因为' }];
    q.memoryCards = [{ title: 'c', content: 'x' }];
    q.knowledgePoints = ['知识点A'];
    var h = explainInner(q);
    return JSON.stringify({
      memo: h.indexOf('exp-memo') >= 0, sp: h.indexOf('exp-sp') >= 0,
      steps: h.indexOf('exp-steps') >= 0, opt: h.indexOf('exp-opt') >= 0,
      mc: h.indexOf('exp-mc') >= 0, chip: h.indexOf('kchip') >= 0
    });
  })()`));
  ok('预留字段 mnemonic 渲染为口诀卡', reserved.memo === true);
  ok('预留字段 studyPoints 渲染为折叠卡', reserved.sp === true);
  ok('预留字段 reasoningSteps 渲染为推理路径', reserved.steps === true);
  ok('预留字段 optionExplanations 渲染为逐项辨析', reserved.opt === true);
  ok('预留字段 memoryCards 渲染为背诵卡', reserved.mc === true);
  ok('knowledgePoints 渲染为知识点 chip', reserved.chip === true);

  const empty = X(`(function(){ var q = toQ({ id: 'vtest4', t: 'A1', q: 'x', o: { A: 'a' }, a: 'A' }); return JSON.stringify({ has: hasExplain(q), html: explainHtml(q), chips: qChipsHtml(q) }); })()`);
  const em = JSON.parse(empty);
  ok('无解析的题不产生空容器', em.has === false && em.html === '' && em.chips === '', empty);

  const chips = X(`(function(){ var q = toQ({ id: 'vtest5', t: 'A1', q: 'x', o: { A: 'a' }, a: 'A', y: 2024, qs: '考研真题', tg: ['糖代谢'] }); var h = qChipsHtml(q); return JSON.stringify({ y: h.indexOf('年真题') >= 0, s: h.indexOf('考研真题') >= 0, t: h.indexOf('糖代谢') >= 0 }); })()`);
  ok('题干 chip 行：真题年份/来源/标签', (() => { const j = JSON.parse(chips); return j.y && j.s && j.t; })(), chips);
  ok('题型全称表存在（A1/A2/A3/X）', X('JSON.stringify(TYPE_FULL)').indexOf('A1 型题') >= 0);

  /* --- 最弱知识点（tags 聚合） --- */
  const kp = JSON.parse(X(`(function(){
    var sub = SB['bio'], st = curState();
    var tagged = allQuestionsBoth(sub).filter(function (x) { return x.q.tags && x.q.tags.length; });
    if (tagged.length < 2) return JSON.stringify({ skip: true });
    st.qstat = st.qstat || {};
    tagged.slice(0, 8).forEach(function (x, i) { st.qstat[x.q.id] = { n: 4, r: i < 2 ? 0 : 4, w: 0, last: Date.now(), lastWrong: false }; });
    var w = Feat.weakTags(sub, st, 3, 3);
    var card = Feat.kpCardHtml();
    var aggKeys = []; Feat.tagAgg(sub, st).forEach(function (v, k) { aggKeys.push(k); });
    return JSON.stringify({ skip: false, n: w.length, ranked: w.every(function (a, i) { return i === 0 || a.acc >= w[i - 1].acc; }), rows: (card.match(/kp-row/g) || []).length, hasCard: card.indexOf('最弱知识点') >= 0, metaLeak: aggKeys.filter(function (t) { return /必背|高频|型题/.test(t); }).length, colored: (card.match(/background:var\\(--(bad|warn|ok|muted)\\)/g) || []).length });
  })()`));
  if (kp.skip) console.log('    （bio 带标签题不足，跳过知识点聚合）');
  else {
    ok('最弱知识点聚合返回结果', kp.n > 0, JSON.stringify(kp));
    ok('知识点按正确率升序', kp.ranked === true);
    ok('知识点卡片渲染 kp-row', kp.rows === kp.n && kp.hasCard === true, JSON.stringify(kp));
    /* 元数据标签（考频 A 必背/B 高频、题型 A1型题）不是知识点，必须在聚合层就被滤掉，
       否则它们题量最大（816 / 194）会长期霸占「最弱」Top3。 */
    ok('考频 / 题型等元数据标签已被过滤', kp.metaLeak === 0, '泄漏 ' + kp.metaLeak + ' 个');
    ok('isMetaTag 判据正确', window.Feat.isMetaTag('A 必背') === true && window.Feat.isMetaTag('B 高频') === true && window.Feat.isMetaTag('A1型题') === true && window.Feat.isMetaTag('蛋白质') === false && window.Feat.isMetaTag('肾小球') === false);
    /* 条形颜色按正确率分档，否则所有条同色看不出谁更弱 */
    ok('知识点条形按正确率着色', window.Feat.barColor(20, 3) === 'var(--bad)' && window.Feat.barColor(60, 3) === 'var(--warn)' && window.Feat.barColor(90, 3) === 'var(--ok)' && window.Feat.barColor(0, 0) === 'var(--muted)');
    ok('卡片内条形带分档颜色', kp.colored > 0, 'colored=' + kp.colored);
  }
  X('show("home")'); await sleep(60);
  ok('首页含最弱知识点卡（无数据显示提示语）', /最弱知识点/.test(document.getElementById('view').innerHTML || ''));

  /* --- 组卷预览：题量/时长 + 0 命中诊断 --- */
  X('Feat.filterSetup("")'); await sleep(40);
  const prev1 = document.getElementById('modalBox').innerHTML || '';
  ok('组卷预览含预计时长', /预计\s*<b>\d+<\/b>\s*分钟/.test(prev1), prev1.match(/fpreview[^<]*<[^>]*>[^<]*/)?.[0]);
  const hotEl = document.getElementById('fHot');
  if (hotEl) hotEl.value = '999999';
  const boolChip = document.querySelector('#modalBox [data-act="f-bool"]');
  if (boolChip) boolChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const prev2 = document.getElementById('modalBox').innerHTML || '';
  ok('0 命中时指出最紧的限制', /限制最紧/.test(prev2), prev2.match(/fpreview[^]{0,80}/)?.[0]);
  X('closeModal()');

  const css = fs.readFileSync(path.join(R, 'styles.css'), 'utf8');
  ok('CSS 数字等宽 tabular-nums', /font-variant-numeric:tabular-nums/.test(css));
  ok('CSS 解析正文限宽 78ch', /max-width:78ch/.test(css));
  ok('CSS 760px 以下表格转卡片', /max-width:760px/.test(css) && /td::before\{content:attr\(data-label\)/.test(css));
  ok('CSS 触控目标 ≥44px', /min-height:44px/.test(css));
  ok('CSS 尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(css));

  ok('Service Worker 已注册', /serviceWorker/.test(html) && fs.existsSync(path.join(R, 'sw.js')));
  ok('SW 缓存名带版本 + activate 清旧缓存', (() => { const s = fs.readFileSync(path.join(R, 'sw.js'), 'utf8'); return /shuati-shell-/.test(s) && /self\.location\.search/.test(s) && /keys\(\)\s*\n?\s*\.then/.test(s) && s.indexOf('skipWaiting') >= 0; })());
} catch (e) { ok('富解析渲染', false, e.message + ' | ' + (e.stack || '').split('\n')[1]); }

/* ---------- G. 真实点击链路回归 ---------- */
section('G. 点击链路回归');
{
  const mark = runtimeErrs.length;
  try {
    X('closeModal(); closePlayer(); show("home")'); await sleep(240);
    /* 先清干净筛选状态：上一段（F）在 #fHot 填过 999999 且触发过收集，否则这里会被前序状态污染 */
    X('Feat.act("f-reset", document.createElement("button"))'); await sleep(160);
    X('closeModal()'); await sleep(90);

    /* 1) 点击「高级筛选」应打开面板（「F 从未建立」的全新首点场景由 H 段用独立 DOM 覆盖） */
    const tile = document.querySelector('#view [data-act="filter-setup"]');
    ok('首页存在「组卷中心」入口', !!tile);
    if (tile) { tile.click(); await sleep(200); }
    const mb = document.getElementById('modalBox').innerHTML || '';
    ok('点击「组卷中心」即打开面板', /组卷中心/.test(mb), mb.slice(0, 80));
    ok('首点无运行时异常', runtimeErrs.length === mark, JSON.stringify(runtimeErrs.slice(mark)).slice(0, 200));

    /* 1b) 残留 DOM 回归：在输入框填值后直接关闭（不点 chip / 不点开始），重开面板
     *     不应把该残留值读进 F —— 否则表现为「一打开面板就是 0 命中、开始按钮禁用」 */
    const hotEl = document.getElementById('fHot');
    const pvBefore = (document.getElementById('modalBox').innerHTML.match(/fpreview[^>]*>([\s\S]{0,70})/) || [])[1] || '';
    if (hotEl) hotEl.value = '999999';
    X('closeModal()'); await sleep(90);
    if (tile) { tile.click(); await sleep(200); }
    const pvAfter = (document.getElementById('modalBox').innerHTML.match(/fpreview[^>]*>([\s\S]{0,70})/) || [])[1] || '';
    ok('重开面板不读残留输入框值（0 命中回归）', /fpreview[\s\S]*命中\s*<b>\d+<\/b>\s*题/.test('<div class="fpreview">' + pvAfter),
      'before=' + pvBefore.replace(/\s+/g, ' ').slice(0, 40) + ' after=' + pvAfter.replace(/\s+/g, ' ').slice(0, 70));

    /* 2) 面板内各类 chip 点击后不崩、面板保持 */
    let chipOk = true, chipTried = 0;
    for (const a of ['f-toggle', 'f-set', 'f-bool', 'f-limit', 'f-reset']) {
      const el = document.querySelector('#modalBox [data-act="' + a + '"]');
      if (!el) continue;
      chipTried++;
      el.click(); await sleep(90);
      const inner = document.getElementById('modalBox').innerHTML || '';
      if (!/组卷中心/.test(inner)) chipOk = false;
    }
    ok('面板内 chip（' + chipTried + ' 类）点击后面板仍开', chipOk && chipTried >= 4);
    const inner2 = document.getElementById('modalBox').innerHTML || '';
    ok('组卷预览含命中题量', /命中\s*<b>\d+<\/b>\s*题/.test(inner2), (inner2.match(/fpreview[\s\S]{0,60}/) || [''])[0]);
    ok('组卷预览含预计时长', /预计\s*<b>\d+<\/b>\s*分钟/.test(inner2));

    /* 3) 开始练习 → 进入做题页
     *    注意：该 mode 若已有断点会话，会先弹「继续上次练习」——这是既有设计（会话续跑），
     *    不是失败；此处选「重新开始」，走的才是高级筛选组卷的预期路径 */
    const go = document.querySelector('#modalBox [data-act="f-go"]');
    const goDis = go ? String(go.disabled) : 'no-btn';
    if (go && !go.disabled) { go.click(); await sleep(320); }
    const resumeNo = document.querySelector('[data-act="resume-no"]');
    if (resumeNo) { resumeNo.click(); await sleep(420); }
    const playerHidden = document.getElementById('player').classList.contains('hidden');
    ok('「开始练习」进入做题页', !playerHidden,
      'go.disabled=' + goDis + ' playerHidden=' + playerHidden + ' 曾弹续跑框=' + !!resumeNo
      + ' preview=' + ((inner2.match(/fpreview[^>]*>([\s\S]{0,60})/) || [])[1] || '').replace(/\s+/g, ' '));
    /* 做题时主页面必须整体退场：桌面端 #app 是两列 grid，600px 居中的播放器两侧
       会把左侧导航与主内容露出来（"浮在主页面上"）。用 #app.playing 隐藏外壳。 */
    const appPlaying = document.getElementById('app').classList.contains('playing');
    ok('做题时主页面已隐藏（#app.playing）', !playerHidden && appPlaying, 'appPlaying=' + appPlaying);
    /* 自愈：只要 renderPlayer 被调用，就必须补上视图隔离。
       旧版只在三处起卷入口调 openPlayer()，新增/旁路入口漏调一次，主页面就会
       继续在播放器两侧露出来（用户已实际撞到）。这条守住「不依赖调用点」这个约定。 */
    const heal = X('(function(){var a=document.getElementById("app");a.classList.remove("playing");renderPlayer();return a.classList.contains("playing");})()');
    ok('renderPlayer 自愈：漏调 openPlayer 也会补上视图隔离', heal === true, 'heal=' + heal);
    X('closePlayer()'); await sleep(120);
    ok('退出做题后主页面恢复', !document.getElementById('app').classList.contains('playing'));

    /* 4) 五个 tab 全部可切换 */
    const tabIds = [...document.querySelectorAll('.tab')].map(t => t.dataset.tab);
    let tabOk = true;
    for (const t of tabIds) {
      X('closeModal(); closePlayer(); show(' + JSON.stringify(t) + ')'); await sleep(170);
      if (document.getElementById('view').classList.contains('hidden')) tabOk = false;
    }
    ok('五个 tab 均可切换（' + tabIds.join('/') + '）', tabOk && tabIds.length >= 5);

    /* 5) 首页 mode 入口齐全 */
    X('closeModal(); closePlayer(); show("home")'); await sleep(220);
    const modes = [...document.querySelectorAll('#view [data-act]')].map(e => e.dataset.act);
    /* 5b) 首页已把「高级筛选 + 考试模式」合并为一张「组卷中心」卡：6 卡 → 5 卡，
     *     考试改由组卷中心内的模式开关进入，不应再存在 start-exam 入口 */
    ok('首页 mode 入口齐全（顺序/组卷/回顾/AI）',
      ['start-order', 'filter-setup', 'start-review', 'start-ai'].every(a => modes.includes(a)),
      JSON.stringify([...new Set(modes)]));
    ok('旧的 start-exam 入口已移除（考试并入组卷中心）', !modes.includes('start-exam'));

    /* 6) 组卷中心 → 切「限时考试」：出现单/多选配额与时长，开始后进限时考试（渲染计时器） */
    X('Feat.act("f-reset", document.createElement("button"))'); await sleep(160);
    const tileX = document.querySelector('#view [data-act="filter-setup"]');
    if (tileX) { tileX.click(); await sleep(220); }
    const mExam = document.querySelector('#modalBox [data-act="f-mode"][data-v="exam"]');
    ok('组卷中心有「练习/限时考试」模式切换',
      !!document.querySelector('#modalBox [data-act="f-mode"][data-v="practice"]') && !!mExam);
    if (mExam) { mExam.click(); await sleep(240); }
    const inX = document.getElementById('modalBox').innerHTML || '';
    ok('考试模式显示单选/多选配额 + 时长', /id="fExSingle"/.test(inX) && /id="fExMulti"/.test(inX) && /id="fMin"/.test(inX));
    ok('考试模式主按钮为「开始考试」', /data-act="f-go"[^>]*>开始考试</.test(inX));
    ok('考试模式预览含时长', /时长\s*<b>\d+<\/b>\s*分钟/.test(inX));
    const goX = document.querySelector('#modalBox [data-act="f-go"]');
    if (goX && !goX.disabled) { goX.click(); await sleep(380); }
    const rn = document.querySelector('[data-act="resume-no"]');
    if (rn) { rn.click(); await sleep(430); }
    ok('「开始考试」进入限时考试（渲染计时器）', !!document.getElementById('examTimer'),
      'playerHidden=' + document.getElementById('player').classList.contains('hidden') + ' 曾弹续考=' + !!rn);

    /* 6b) 考试未交卷时底栏必须能往后翻。
     *     原来只给「上一题 + 交卷」，答完一题只能开答题卡点题号，移动端直接卡死。 */
    const footOf = () => { const f = document.querySelector('#player .pfoot'); return f ? f.innerHTML.replace(/\s+/g, ' ') : ''; };
    const fMid = footOf();
    ok('考试未交卷底栏含「下一题」', /data-act="next"/.test(fMid) && /data-act="submit-exam"/.test(fMid), fMid.slice(0, 150));
    X('P.idx = P.pool.length - 1; renderPlayer()'); await sleep(140);
    const fLastRun = footOf();
    ok('考试末题「下一题」置灰（强制交卷）', /data-act="next"[^>]*disabled/.test(fLastRun) && /data-act="submit-exam"/.test(fLastRun), fLastRun.slice(0, 150));
    X('P.idx = 0; renderPlayer()'); await sleep(100);

    /* 7) 考试会话键带「组卷口径」指纹（e:<科目>:<hash>），不再共用 e:<科目> 造成串卷 */
    const eKeys = X('JSON.stringify(Object.keys(S.sessions||{}).filter(k=>k.charAt(0)==="e"))');
    let eOk = false;
    try { const ks = JSON.parse(eKeys); eOk = Array.isArray(ks) && ks.length > 0 && ks.every(k => k.split(':').length >= 3); } catch (e2) { eOk = false; }
    ok('考试会话键含卷指纹（不再共用 e:<科目>）', eOk, eKeys);
    X('closePlayer(); closeModal()'); await sleep(140);

    ok('G 段整体零运行时异常', runtimeErrs.length === mark, JSON.stringify(runtimeErrs.slice(mark)).slice(0, 300));
  } catch (e) { ok('点击链路回归', false, e.message + ' | ' + (e.stack || '').split('\n')[1]); }
  X('closeModal(); closePlayer()');
}

/* ---------- H. 全新 DOM 首点回归（真正复现「全新用户第一次点开」） ---------- */
section('H. 全新 DOM 首点回归');
{
  /* 为什么必须用独立 DOM：features.js 的 F 是闭包私有，外部无法置回 null。
   * 上面 G 段跑过 filterSetup 后 F 已建立，无法覆盖「F 从未建立」这个崩溃场景 ——
   * 而真实 bug 正是 act('filter-setup') → collectFilterNums() → F 为 null 时崩。 */
  const errs2 = [];
  const vc2 = new VirtualConsole();
  vc2.on('jsdomError', e => {
    const m = String((e.detail && (e.detail.message || e.detail)) || e.message || e);
    if (!/getContext/.test(m)) errs2.push(m);
  });
  const dom2 = new JSDOM(html, { url: 'http://127.0.0.1:8788/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc2 });
  const w2 = dom2.window, d2 = w2.document;
  w2.fetch = window.fetch;                 // 复用同一份分片读取 shim
  w2.matchMedia = window.matchMedia;
  w2.scrollTo = () => {}; w2.HTMLElement.prototype.scrollIntoView = () => {};
  w2.alert = () => {}; w2.confirm = () => true; w2.requestAnimationFrame = cb => setTimeout(cb, 0);
  try {
    w2.eval(['app.js', 'english.js', 'features.js'].map(f => fs.readFileSync(path.join(R, f), 'utf8')).join('\n;\n') + '\n;window.__T={x:c=>eval(c)};');
  } catch (e) { errs2.push('顶层:' + e.message); }
  const X2 = c => { try { return w2.__T.x(c); } catch (e) { return '__ERR__' + e.message; } };

  let ready = false;
  for (let i = 0; i < 60; i++) {
    const n = X2('Object.keys(SB).length');
    if (typeof n === 'number' && n > 0 && (d2.getElementById('view').innerHTML || '').length > 500) { ready = true; break; }
    await sleep(150);
  }
  await sleep(200);
  ok('fresh DOM 启动完成且无异常', ready && errs2.length === 0, errs2.join(' | ').slice(0, 200));

  const t2 = d2.querySelector('#view [data-act="filter-setup"]');
  ok('fresh DOM 有「组卷中心」入口', !!t2);
  if (t2) { try { t2.click(); } catch (e) { errs2.push('click:' + e.message); } }
  await sleep(220);
  const box2 = d2.getElementById('modalBox').innerHTML || '';
  ok('全新会话首次点击即打开面板（F=null 崩溃回归）', /组卷中心/.test(box2), box2.slice(0, 80));
  ok('首点无运行时异常', errs2.length === 0, errs2.join(' | ').slice(0, 200));
  const pv = (box2.match(/fpreview[^>]*>([\s\S]{0,80})/) || [])[1] || '';
  ok('首点预览正常命中（非 0 命中）', /命中\s*<b>\d+<\/b>\s*题/.test(pv), pv.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').slice(0, 80));
  try { dom2.window.close(); } catch { }
}

/* ---------- I. 掌握度视觉 / 背景主题 / 按题库清空 / 知识点可点 ---------- */
section('I. 掌握度 · 背景主题 · 按题库清空');
{
  const mark = runtimeErrs.length;
  try {
    X('closeModal(); closePlayer(); show("home")'); await sleep(200);

    /* 1) 掌握度改用矢量圆点：emoji 在跨系统下字重/配色不可控，12px 下糊成一团 */
    const mHtml = X('Feat.statsCardHtml()');
    ok('掌握度用矢量圆点（不再出现 emoji 圆点）', /mdot/.test(mHtml) && !/[\u26AA\u{1F534}\u{1F7E1}\u{1F7E2}]/u.test(mHtml));
    ok('四宫格图例：4 个格子 + 4 个占比', (mHtml.match(/mcell/g) || []).length === 4 && (mHtml.match(/mpct/g) || []).length === 4);
    ok('分布条含斜纹「未接触」段', /mseg m0/.test(mHtml));
    ok('头部含累计正确率 + 覆盖率进度', /mrate/.test(mHtml) && /mga-line/.test(mHtml) && /mrow thin/.test(mHtml));
    const mt = X('Feat.masteryTag(curState(), allQuestionsBoth(curSub())[0].q.id, true)');
    ok('masteryTag 同步换圆点（题干/详情/播放器共用）', /mdot/.test(mt) && !/[\u26AA\u{1F534}\u{1F7E1}\u{1F7E2}]/u.test(mt), String(mt).slice(0, 60));

    /* 2) 背景主题：themes.css + 设置页选择器 + 落盘 */
    const tcss = fs.readFileSync(path.join(R, 'themes.css'), 'utf8');
    ok('themes.css 四主题齐备', ['classic', 'grid', 'cn', 'ink'].every(k => tcss.includes('[data-bg="' + k + '"]')));
    ok('index.html 引入 themes.css（且在 styles.css 之后）', /themes\.css\?v=/.test(html) && html.indexOf('themes.css') > html.indexOf('styles.css'));
    X('show("me")'); await sleep(160);
    ok('设置页有「背景主题」卡（4 个选项）',
      (document.getElementById('view').innerHTML.match(/data-act="set-bg"/g) || []).length === 4);
    const bgBtn = document.querySelector('#view [data-act="set-bg"][data-k="cn"]');
    if (bgBtn) { bgBtn.click(); await sleep(200); }
    ok('点主题 → body[data-bg] 与设置同步', X('document.body.dataset.bg') === 'cn' && X('S.global.settings.bg') === 'cn',
      'data-bg=' + X('document.body.dataset.bg') + ' setting=' + X('S.global.settings.bg'));
    ok('主题选择已持久化', /"bg":"cn"/.test(String(X('localStorage.getItem("quiz_v1")'))));
    ok('无查询参数时预览覆盖不生效', X('applyUrlPreview()') === null);
    const bgBack = document.querySelector('#view [data-act="set-bg"][data-k="classic"]');
    if (bgBack) { bgBack.click(); await sleep(180); }
    ok('主题可切回经典蓝白', X('document.body.dataset.bg') === 'classic');

    /* 3) 按题库清空：造一份 jg + ext 混合进度，再清极光，验证 ext 存活 / 成就全保留 */
    const seed = JSON.parse(X(`(function () {
      var sub = SB['bio'], jg = null, ext = null, jc = null, ec = null;
      allQuestionsBoth(sub).forEach(function (x) {
        if (!jg && x.grp === 'jg') { jg = x.q.id; jc = x.chapterId; }
        if (!ext && x.grp === 'ext') { ext = x.q.id; ec = x.chapterId; }
      });
      var st = curState();
      st.wrong = [jg, ext]; st.fav = [jg]; st.doubt = [ext]; st.mastered = [jg, ext];
      st.qstat = {}; st.qstat[jg] = { n: 3, r: 2, w: 1, last: Date.now() }; st.qstat[ext] = { n: 2, r: 0, w: 2, last: Date.now() };
      st.review = {}; st.review[jg] = { stage: 2, next: Date.now() }; st.review[ext] = { stage: 1, next: Date.now() };
      st.byChapter = {}; st.byChapter[jc] = { total: 3, correct: 2 }; st.byChapter[ec] = { total: 2, correct: 0 };
      st.daily = { '2026-09-12': { answered: 5, correct: 3 } };
      st.examHistory = [{ date: Date.now(), score: 80, right: 4, total: 5, minutes: 5 }];
      st.aiGen = [{ batchId: 'b1', questions: [{ id: 'ai-1' }] }];
      st.feedback = [{ id: jg, type: 'content' }]; st.hadWrong = true;
      S.global.xp = 4560; S.global.badges = ['first', 'h100']; S.global.checkin = ['2026-09-11', '2026-09-12'];
      save();
      return JSON.stringify({ jg: jg, ext: ext, jc: jc, ec: ec });
    })()`));
    X('show("me")'); await sleep(160);
    const setBtn = document.querySelector('#view [data-act="reset-setup"]');
    ok('设置页有「选择范围并清空…」入口（不再是裸 confirm 的全局清空）', !!setBtn);
    ok('旧的「S = defaultState()」全局清空已移除', !/S = defaultState\(\)/.test(fs.readFileSync(path.join(R, 'app.js'), 'utf8')));
    if (setBtn) { setBtn.click(); await sleep(230); }
    let mb = document.getElementById('modalBox').innerHTML || '';
    const pick = k => document.querySelector('#modalBox [data-act="rst-pick"][data-k="' + k + '"]');
    ok('清空面板列出三个题库范围（极光/扩展/AI）', (mb.match(/data-act="rst-pick"/g) || []).length === 3);
    ok('清空面板明示「保留」成就与打卡', /保留/.test(mb) && /徽章/.test(mb));
    ok('清空面板给真实明细（错题/收藏/疑点分开计数）', /错题 \/ 收藏 \/ 疑点/.test(mb) && /掌握度与作答统计/.test(mb));
    ok('清空面板有「仅当前学科 / 全部学科」范围开关', !!document.querySelector('#modalBox [data-act="rst-subs"]'));
    if (pick('ext')) { pick('ext').click(); await sleep(150); }
    if (pick('ai')) { pick('ai').click(); await sleep(150); }
    ok('题库范围可多选（点掉 ext/ai 后仅极光高亮）',
      !!pick('jg') && pick('jg').classList.contains('on') && !pick('ext').classList.contains('on') && !pick('ai').classList.contains('on'));
    const rstGo = document.querySelector('#modalBox [data-act="rst-go"]');
    ok('清空面板有执行按钮', !!rstGo);
    if (rstGo) { rstGo.click(); await sleep(280); }
    const after = JSON.parse(X(`(function () {
      var st = curState();
      return JSON.stringify({
        wrong: st.wrong, fav: st.fav, doubt: st.doubt, mastered: st.mastered,
        qstat: Object.keys(st.qstat), review: Object.keys(st.review),
        byChapter: Object.keys(st.byChapter),
        daily: Object.keys(st.daily).length, exam: st.examHistory.length,
        fb: (st.feedback || []).length, aiGen: (st.aiGen || []).length,
        xp: S.global.xp, badges: S.global.badges.length, checkin: S.global.checkin.length
      });
    })()`));
    ok('极光题记录已清空（错题/收藏/疑点/掌握）',
      after.wrong.length === 1 && after.wrong[0] === seed.ext && after.fav.length === 0 && after.doubt[0] === seed.ext,
      JSON.stringify({ wrong: after.wrong, fav: after.fav }));
    ok('扩展题记录原样保留（按题库分治）',
      after.qstat.length === 1 && after.qstat[0] === seed.ext && after.review[0] === seed.ext
      && after.mastered[0] === seed.ext, JSON.stringify(after));
    ok('章节统计按题库拆分（ext 章节存活，jg 章节已删）',
      after.byChapter.length === 1 && after.byChapter[0] === seed.ec, JSON.stringify(after.byChapter));
    ok('汇总型记录如实归零（每日统计 / 考试记录）', after.daily === 0 && after.exam === 0);
    ok('纠错记录 / AI 题库 未被牵连', after.fb === 1 && after.aiGen === 1);
    ok('★ 成就徽章 / 连续打卡 / XP 等级 全部保留',
      after.xp === 4560 && after.badges === 2 && after.checkin === 2,
      JSON.stringify({ xp: after.xp, badges: after.badges, checkin: after.checkin }));
    ok('清空后无运行时异常', runtimeErrs.length === mark, JSON.stringify(runtimeErrs.slice(mark)).slice(0, 200));

    /* 4) 最弱知识点：没有作答数据时也要给可点入口（旧版只有一句「满 3 次后列出」→ 点了没反应） */
    X('S.sessions = {}; curState().qstat = {}; save(); closeModal(); closePlayer(); show("home")'); await sleep(240);
    const kpc = X('Feat.kpCardHtml()');
    ok('知识点无数据时列出「先开练」入口（含题量 + 未练）', /kp-row/.test(kpc) && /未练/.test(kpc) && /kp-go/.test(kpc));
    const kpRow = document.querySelector('#view .kp-row');
    ok('首页知识点行可点（role=button + 带 data-tag）', !!kpRow && kpRow.getAttribute('role') === 'button' && !!kpRow.dataset.tag,
      kpRow ? kpRow.dataset.tag : 'no row');
    const mark2 = runtimeErrs.length;
    if (kpRow) { kpRow.click(); await sleep(340); }
    const rn2 = document.querySelector('[data-act="resume-no"]');
    if (rn2) { rn2.click(); await sleep(430); }
    ok('点击知识点行可进入练习', !document.getElementById('player').classList.contains('hidden'), '曾弹续跑框=' + !!rn2);
    ok('知识点点击无运行时异常', runtimeErrs.length === mark2, JSON.stringify(runtimeErrs.slice(mark2)).slice(0, 200));
    X('closePlayer(); closeModal()');
  } catch (e) { ok('掌握度/主题/清空', false, e.message + ' | ' + (e.stack || '').split('\n')[1]); }
}

/* ---------- J. 医学英语词库（第 4 个内容域） ---------- */
section('J. 医学英语词库');
{
  const FEN = path.join(R, 'data/english');
  ok('已生成词库分片目录', fs.existsSync(path.join(FEN, 'manifest.json')));
  if (fs.existsSync(path.join(FEN, 'manifest.json'))) {
    const man = JSON.parse(fs.readFileSync(path.join(FEN, 'manifest.json'), 'utf8'));
    ok('manifest 含 30+ 科室、总量 >3000', (man.depts || []).length >= 30 && man.total > 3000,
      `depts=${(man.depts || []).length} total=${man.total}`);
    const s0 = (man.depts || [])[0];
    const shard = JSON.parse(fs.readFileSync(path.join(FEN, s0.f), 'utf8'));
    const ws = shard.w || [];
    const w0 = ws[0] || {};
    ok('分片词条字段齐全（e/c/ph/et/ex）', ['e', 'c', 'ph', 'et', 'ex'].every(k => k in w0), JSON.stringify(Object.keys(w0)));
    const nw = ws.map(x => String(x.e).toLowerCase());
    ok('单科内词形不重复（跨科重复已在构建期按词形合并）', new Set(nw).size === nw.length,
      `n=${nw.length} uniq=${new Set(nw).size}`);
    /* 译文错位会让「同一句译文」出现在两条不同词条下 —— 修复后同科内应无重复译文。
     * 这条是整段错位最灵敏的探针（比逐条语义比对可靠得多）。 */
    const trs = ws.map(x => x.tr).filter(Boolean);
    ok('同科译文无重复（错位修复后的硬指标）', new Set(trs).size === trs.length,
      `n=${trs.length} uniq=${new Set(trs).size}`);
  }
  /* 发音：jsdom 无 speechSynthesis，注入 mock 才能断言「确实调了 TTS、且读的是词形而非音标串」 */
  window.__spk = [];
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  window.speechSynthesis = {
    cancel() { }, getVoices() { return [{ lang: 'en-US', name: 'mock' }]; },
    speak(u) { window.__spk.push(u.text); },
  };
  ok('Eng 挂在 window（classic script 顶层 const 不会挂 window）', !!window.Eng);
  if (window.Eng) {
    const m = await window.Eng.loadMan();
    ok('loadMan 拿到 manifest', !!m && m.total > 0, m ? 'total=' + m.total : 'null');
    const tabBtn = document.querySelector('.tab[data-tab="english"]');
    ok('底栏有「单词」入口', !!tabBtn);
    if (tabBtn) { tabBtn.click(); await sleep(450); }
    let v = document.getElementById('view').innerHTML;
    ok('切到词库渲染出词条', /eng-item|eng-card/.test(v), v.slice(0, 120));
    ok('列表=纯中英对照（行含词形与释义）', !!document.querySelector('#view .eng-item .eng-w') && !!document.querySelector('#view .eng-item .eng-cn'));
    const item = document.querySelector('#view .eng-item');
    ok('列表行不可点击（无 data-act，背单词交互全在卡片/沉浸）', item && !item.hasAttribute('data-act'));
    if (item) {
      item.click(); await sleep(400);
      const rd0 = document.getElementById('engReader');
      ok('点列表行不弹任何浮层（浮层未创建或仍隐藏）', (!rd0 || rd0.classList.contains('hidden')));
    }
    /* —— 卡片背诵：英文+空白+三按钮 → 标记后弹中文+音标+上下按钮 —— */
    const cm = document.querySelector('#view [data-act="eng-mode"][data-v="card"]');
    ok('有卡片背诵模式入口', !!cm);
    if (cm) {
      cm.click(); await sleep(400);
      const v1 = document.getElementById('view').innerHTML;
      ok('卡片第一眼只有英文+空白（无中文、无音标）', /eng-card-w/.test(v1) && /eng-card-blank/.test(v1) && !/eng-card-cn/.test(v1) && !/ph-spk/.test(v1), v1.slice(v1.indexOf('eng-card'), v1.indexOf('eng-card') + 200));
      const mks = [...document.querySelectorAll('#engBody .eng-mk')];
      ok('卡片只显示 认识/模糊/忘记 三按钮（顺序一致）', mks.length === 3 && mks.map(b => b.textContent).join('') === '认识模糊忘记', mks.map(b => b.textContent).join('|'));
      ok('未标记时不显示 上一个/下一个', !document.querySelector('#engBody [data-act="eng-next"]') && !document.querySelector('#engBody [data-act="eng-prev"]'));
      const mkC = mks[0];   // 认识
      if (mkC) {
        mkC.click(); await sleep(450);
        const v2 = document.getElementById('view').innerHTML;
        ok('标记后弹出 中文+音标+喇叭', /eng-card-cn/.test(v2) && /ph-spk/.test(v2), v2.slice(v2.indexOf('eng-card'), v2.indexOf('eng-card') + 200));
        ok('标记后才出现 上一个/下一个', !!document.querySelector('#engBody [data-act="eng-next"]') && !!document.querySelector('#engBody [data-act="eng-prev"]'));
      }
      /* —— 沉浸式背单词：卡片模式入口 → 全屏 → 标记驱动全揭示 —— */
      const imm = document.querySelector('[data-act="eng-immersive"]');   // A08：入口已收进「高级筛选」抽屉（#engAdvModal）
      ok('卡片模式有「沉浸式背单词」入口', !!imm);
      if (imm) {
        imm.click(); await sleep(500);
        const rd = document.getElementById('engReader');
        ok('沉浸页打开（全屏 + 词头 + 空白 + 标记）', !!rd && !rd.classList.contains('hidden')
          && /engr-word/.test(rd.innerHTML) && /engr-blank/.test(rd.innerHTML)
          && !/engr-sec/.test(rd.innerHTML) && !/engr-nav/.test(rd.innerHTML) && !/ph-spk/.test(rd.innerHTML),
          rd.innerHTML.slice(0, 160));
        ok('沉浸页锁住背景滚动（body.reading）', document.body.classList.contains('reading'));
        const mkR = rd.querySelector('.eng-mk');
        if (mkR) {
          mkR.click(); await sleep(400);
          ok('沉浸标记后全信息弹出（释义/分区块/音标/上一下一）', /engr-cn/.test(rd.innerHTML) && /engr-sec/.test(rd.innerHTML)
            && /ph-spk/.test(rd.innerHTML) && !!rd.querySelector('[data-act="eng-read-next"]'), rd.innerHTML.slice(0, 160));
          const eg = window.__T.x('S.global.english') || {};
          const ent = eg[Object.keys(eg)[0]];
          ok('标记写入 S.global.english 且带 log/due（SRS 原料）', Object.keys(eg).length > 0
            && !!ent && Array.isArray(ent.log) && ent.log.length >= 1 && ent.log[0].length === 2
            && typeof ent.due === 'number' && ent.due >= ent.t, JSON.stringify(ent && ent.log));
          const spk = rd.querySelector('.ph-spk');
          if (spk) {
            window.__spk.length = 0;
            spk.click(); await sleep(150);
            const cur = (rd.querySelector('.engr-word') || {}).textContent || '';
            ok('点喇叭朗读当前词形（不是音标串）', window.__spk.length === 1 && window.__spk[0] === cur,
              'spoke=' + JSON.stringify(window.__spk) + ' word=' + cur);
            ok('播放中按钮有反馈态 .on', spk.classList.contains('on'));
            /* 老浏览器/无 TTS：必须静默降级，不能把沉浸页点崩 */
            const bakU = window.SpeechSynthesisUtterance, bakS = window.speechSynthesis;
            window.SpeechSynthesisUtterance = undefined; window.speechSynthesis = undefined;
            let fell = false;
            try { fell = window.Eng.speak('cardiac') === false; } catch (err) { fell = false; }
            ok('无 TTS 环境 speak() 返回 false 且不抛错', fell);
            window.SpeechSynthesisUtterance = bakU; window.speechSynthesis = bakS;
          }
          const nxt = rd.querySelector('[data-act="eng-read-next"]');
          if (nxt && !nxt.disabled) {
            nxt.click(); await sleep(450);
            const w1 = (rd.querySelector('.engr-word') || {}).textContent || '';
            ok('「下一个」翻到新词并回到空白态', !!w1 && !/engr-sec/.test(rd.innerHTML) && /engr-blank/.test(rd.innerHTML));
          }
        }
        rd.querySelector('[data-act="eng-read-close"]').click(); await sleep(700);
        ok('退出沉浸回到卡片模式', rd.classList.contains('hidden') && !document.body.classList.contains('reading')
          && !!document.querySelector('#view .eng-card'));
      }
    }
    const qi = document.getElementById('engQ');
    ok('存在搜索框', !!qi);
    if (qi) {
      qi.value = 'heart';
      qi.dispatchEvent(new window.Event('input', { bubbles: true }));
      await sleep(550);
      const v2 = document.getElementById('view').innerHTML;
      ok('搜索后重渲染（命中或空态）', /eng-item|eng-card|没有匹配/.test(v2), v2.slice(0, 100));
      /* 清掉搜索词再往下测——q 是模块级状态，不清会污染后面的测验/复习用例 */
      qi.value = '';
      qi.dispatchEvent(new window.Event('input', { bubbles: true }));
      await sleep(550);
    }
    /* —— 换科室必须重置筛选/搜索（d06「肾内科没单词」事件回归守卫）—— */
    {
      /* 前面用例可能把 mode 留在 card（卡片模式没有 .eng-item，会假失败）——先切回列表 */
      const backList = document.querySelector('#view [data-act="eng-mode"][data-v="list"]');
      if (backList) { backList.click(); await sleep(400); }
      const mk = [...document.querySelectorAll('[data-act="eng-only"]')].find(c => c.dataset.v === '2');
      if (mk) {
        mk.click(); await sleep(350);
        const sel = document.getElementById('engDept');
        if (sel) {
          sel.value = '06';
          sel.dispatchEvent(new window.Event('change', { bubbles: true }));
          await sleep(550);
          const n = document.querySelectorAll('#engBody .eng-item').length;
          /* B21 起列表默认只渲染前 30 行（下方「展示全部」再放全）→ 不能按行数断言 99；
             改校验「计数文本恢复为 99 词」（证明残留筛选已重置）+ 首屏确有渲染行 */
          const cntTxt = (document.getElementById('engCount') || {}).textContent || '';
          ok('换科室重置筛选（切 d06 后应恢复全部 99 词，而非被残留筛选清空）', /99/.test(cntTxt) && n > 0, 'items=' + n + ' count=' + cntTxt.trim());
          const back = [...document.querySelectorAll('[data-act="eng-only"]')].find(c => c.dataset.v === '');
          ok('换科室后「全部」chip 处于选中态', !!(back && back.classList.contains('on')));
          /* 恢复 d00，避免污染后续用例 */
          const sel2 = document.getElementById('engDept');
          sel2.value = '00';
          sel2.dispatchEvent(new window.Event('change', { bubbles: true }));
          await sleep(450);
        }
      }
    }
    /* —— 测验模式：中→英 4 选 1，答错喂调度 —— */
    const qm = document.querySelector('#view [data-act="eng-mode"][data-v="quiz"]');
    ok('有测验模式入口', !!qm);
    if (qm) {
      qm.click(); await sleep(500);
      const opts = document.querySelectorAll('#engBody .eng-qopt');
      ok('测验渲染出 4 个选项', opts.length === 4, 'n=' + opts.length);
      const qs = (document.querySelector('#engBody .eng-quiz') || {}).textContent || '';
      ok('测验头部显示进度与题型', /1\s*\/\s*\d+/.test(qs) && /中 → 英/.test(qs), qs.slice(0, 60));
      if (opts.length === 4) {
        opts[0].click(); await sleep(450);
        const fb = document.getElementById('view').innerHTML;
        /* HTML 里类是空格分隔（class="eng-qopt correct"），不能用 CSS 选择器式的点号正则 */
        ok('作答后高亮对错（correct 与 wrong 类至少其一）', /eng-qopt\s+correct/.test(fb) || /eng-qopt\s+wrong/.test(fb), fb.slice(fb.indexOf('eng-quiz'), fb.indexOf('eng-quiz') + 200));
        ok('作答后全部选项禁用（防连点）', Array.from(document.querySelectorAll('#engBody .eng-qopt')).every(b => b.disabled));
        ok('作答后出现「下一题」', !!document.querySelector('#engBody [data-act="eng-quiz-next"]'));
        const nx = document.querySelector('#engBody [data-act="eng-quiz-next"]');
        if (nx) { nx.click(); await sleep(450); ok('下一题推进到 2/N', /2\s*\/\s*\d+/.test(document.getElementById('view').innerHTML)); }
      }
      /* —— 英→中 题型：题面是英文词形，选项是互不重复的中文释义 —— */
      const e2c = document.querySelector('[data-act="eng-quiz-type"][data-v="en2cn"]');   // 题型切换在「高级筛选」抽屉内
      ok('有「英 → 中」题型入口', !!e2c);
      if (e2c) {
        e2c.click(); await sleep(450);
        ok('英→中：题面显示英文词形（eng-q-en）', !!document.querySelector('#engBody .eng-q-en'),
          document.getElementById('view').innerHTML.slice(document.getElementById('view').innerHTML.indexOf('eng-quiz'), document.getElementById('view').innerHTML.indexOf('eng-quiz') + 150));
        const o2 = Array.from(document.querySelectorAll('#engBody .eng-qopt'));
        ok('英→中：仍是 4 个选项', o2.length === 4, 'n=' + o2.length);
        const vals = o2.map(b => b.textContent.replace(/^[ABCD]/, '').trim());
        ok('英→中：选项值互不重复', new Set(vals).size === vals.length, vals.join(' | ').slice(0, 100));
        const lb = document.getElementById('view').innerHTML;
        ok('英→中：头部题型标签切换', /英 → 中/.test(lb));
        /* 切回列表模式，别把 quiz 状态污染后面的复习用例 */
        const bl = document.querySelector('#view [data-act="eng-mode"][data-v="list"]');
        if (bl) { bl.click(); await sleep(400); }
      }
      const qexit = document.querySelector('#engBody [data-act="eng-quiz-exit"]');
      if (qexit) { qexit.click(); await sleep(450); ok('退出测验回列表', !!document.querySelector('#view .eng-item')); }
    }
    /* —— 到期复习：塞一条过期词 → 出现「开始复习」→ 队列卡片 → 标记后完成 —— */
    ok('无到期词时不出现开始复习按钮', !document.querySelector('#view [data-act="eng-review"]'));
    const firstW = (document.querySelector('#view .eng-item .eng-w') || {}).textContent || '';
    if (firstW) {
      const key = firstW.toLowerCase().trim();
      window.__T.x('S.global.english["' + key + '"] = {s:0,n:1,t:Date.now()-86400000,due:Date.now()-1000,log:[[0,Date.now()-86400000]]};');
      tabBtn.click(); await sleep(500);
      const rBtn = document.querySelector('#view [data-act="eng-review"]');
      ok('塞入过期词后出现「开始复习」', !!rBtn);
      ok('头部显示今日到期计数 ≥1', /待复习\s*<b>[1-9]/.test(document.getElementById('view').innerHTML));
      if (rBtn) {
        rBtn.click(); await sleep(900);   // ensureAllWords 拉全库 31 分片
        ok('复习模式渲染卡片（复习 1 / 1）', /复习\s*1\s*\/\s*1/.test(document.getElementById('view').innerHTML) && !!document.querySelector('#engBody .eng-card-w'),
          document.getElementById('view').innerHTML.slice(0, 160));
        const mkc = document.querySelector('#engBody .eng-mk');
        if (mkc) {
          mkc.click(); await sleep(450);
          ok('复习标记后弹出信息 + 下一个按钮（不自动跳词）', /eng-card-cn/.test(document.getElementById('view').innerHTML)
            && !!document.querySelector('#engBody [data-act="eng-next"]'));
          const nxr = document.querySelector('#engBody [data-act="eng-next"]');
          if (nxr) { nxr.click(); await sleep(450); ok('复习队列过完 → 完成面板', /eng-done/.test(document.getElementById('view').innerHTML)); }
        }
        const ex = document.querySelector('#engBody [data-act="eng-review-exit"]');
        if (ex) { ex.click(); await sleep(450); ok('退出复习回列表', !!document.querySelector('#view .eng-item')); }
      }
    }
  }
}

/* ---------- L. 云同步（sync.js）：可选登录 + 逐题合并 ---------- */
section('L. 云同步 · 可选登录与逐题合并');
try {
  /* sync.js 独立加载（主脚本列表里没有它：它只依赖 DOM + localStorage）。
   * 注意它顶层会自动 init()，往 body 挂 #authGate，并包装 Storage.prototype.setItem。
   * 因此放在最后跑，避免影响前面的用例。 */
  const syncSrc = fs.readFileSync(path.join(R, 'sync.js'), 'utf8');
  /* app.js 是 'use strict'，顶层 function 声明经 window.eval 不落全局（只有浏览器 classic script 才挂 window），
     sync.js 独立 eval 取不到 ICON（createGate 用它拼品牌图标）→ 补一个显示用桩，避免假红。 */
  if (typeof window.ICON !== 'function') window.ICON = n => '[' + n + ']';
  window.eval(syncSrc);
  await sleep(150);
  const gate = document.getElementById('authGate');
  ok('门禁节点已创建', !!gate);
  /* A01：无 token 不再弹门禁（createGate 的元素 CSS 默认 display:flex，必须被收起） */
  ok('无 token 时门禁不显示（登录已降级为可选）',
    !!gate && gate.style.display === 'none' && !document.body.classList.contains('gated'),
    'display=' + (gate && gate.style.display) + ' gated=' + document.body.classList.contains('gated'));
  ok('QuizSync 已挂 window', !!window.QuizSync && typeof window.QuizSync.login === 'function');
  ok('QuizSync 暴露合并/剥离（供断言）',
    typeof window.QuizSync._mergeState === 'function' && typeof window.QuizSync._stripForSync === 'function');

  /* A03：三类字段各自的合并规则 */
  const L = {
    global: { xp: 100, badges: ['a'], checkin: ['2026-09-01'], settings: { dailyGoal: 50, dark: false } },
    subjects: { bio: {
      wrong: ['w1', 'w2'], fav: ['f1'], doubt: ['d1'], mastered: ['m1'],
      qstat: { q1: { n: 5, r: 5, w: 0 }, q2: { n: 2, r: 1, w: 1 } },
      byChapter: { c1: { total: 10, correct: 8 } },
      daily: { '2026-09-01': { answered: 10, correct: 8 } },
      review: { q1: { stage: 2, wrongAns: ['A'], nextReview: 200 } },
      examHistory: [{ date: 100, score: 80, right: 4, total: 5, minutes: 5 }],
    } },
    sessions: { 'c:bio:x': { subject: 'bio', qids: [], idx: 0 } },
  };
  const C = {
    global: { xp: 250, badges: ['b'], checkin: ['2026-09-02'], settings: { dailyGoal: 80, dark: true } },
    subjects: { bio: {
      wrong: ['w2', 'w3'], fav: ['f2'], doubt: [], mastered: ['m2'],
      qstat: { q1: { n: 1, r: 1, w: 0 }, q3: { n: 9, r: 9, w: 0 } },
      byChapter: { c1: { total: 3, correct: 3 }, c2: { total: 4, correct: 4 } },
      daily: { '2026-08-31': { answered: 30, correct: 25 } },
      review: { q1: { stage: 5, wrongAns: ['B'], nextReview: 100 }, q2: { stage: 1, wrongAns: [] } },
      examHistory: [{ date: 200, score: 90, right: 9, total: 10, minutes: 8 }],
    } },
    sessions: { 'c:bio:cloud': { subject: 'bio' } },
  };
  const M = window.QuizSync._mergeState(L, C);
  const mb = M.subjects.bio;
  ok('标记类取并集（wrong w1+w2+w3）', JSON.stringify(mb.wrong) === JSON.stringify(['w1', 'w2', 'w3']), JSON.stringify(mb.wrong));
  ok('标记类取并集（fav / mastered）', mb.fav.length === 2 && mb.mastered.length === 2);
  ok('qstat 取累计量更大一方（本地7 vs 云端10 → 云端）', !!mb.qstat.q3 && !mb.qstat.q2, JSON.stringify(Object.keys(mb.qstat)));
  ok('byChapter 取累计量更大（本地10 vs 云端7 → 本地）', !mb.byChapter.c2 && mb.byChapter.c1.total === 10);
  ok('daily 取累计量更大（云端30 vs 本地10 → 云端）', !!mb.daily['2026-08-31']);
  ok('review 逐题合并：stage 取更大 + wrongAns 并集 + 补缺', mb.review.q1.stage === 5 && mb.review.q1.wrongAns.length === 2 && !!mb.review.q2);
  ok('examHistory 合并去重', mb.examHistory.length === 2);
  ok('global.xp 取大（不回退）', M.global.xp === 250);
  ok('global.badges / checkin 取并集', M.global.badges.length === 2 && M.global.checkin.length === 2);
  ok('settings 跟随本机（设备偏好不被另一端覆盖）', M.global.settings.dailyGoal === 50 && M.global.settings.dark === false);
  ok('sessions 只留本机（不采纳云端的）', !!M.sessions['c:bio:x'] && !M.sessions['c:bio:cloud']);
  /* 单词进度合并：P0-1 修复的回归守卫——修复前 english 落在 Object.assign 整块 LWW 盲区 */
  const EL = { myocarditis: { s: 1, n: 3, t: 100, due: 200, log: [[1, 50], [1, 100]] }, anemia: { s: 2, n: 1, t: 100, due: 1000, log: [[2, 100]] } };
  const EC = { myocarditis: { s: 0, n: 2, t: 300, due: 400, log: [[0, 300]] }, leukemia: { s: 0, n: 1, t: 300, due: 500, log: [[0, 300]] } };
  const ME = window.QuizSync._mergeState({ global: { english: EL } }, { global: { english: EC } }).global.english;
  ok('english 逐词合并：n 大者赢（myocarditis n3 > n2 → 本地）', ME.myocarditis && ME.myocarditis.n === 3 && ME.myocarditis.s === 1);
  ok('english 逐词合并：云端独有词补入（leukemia）', !!ME.leukemia);
  ok('english 逐词合并：本地独有词保留（anemia）', !!ME.anemia && ME.anemia.s === 2);
  const P2 = window.QuizSync._stripForSync(L);
  ok('push 前剥离 sessions（这是 payload 的 78%）', P2.sessions === undefined && !!P2.subjects && !!P2.global);
} catch (e) {
  ok('L 段执行无异常', false, e.message + ' | ' + (e.stack || '').split('\n')[1]);
}

/* ---------- M. 统一 id 网（A02）：别名映射 / 旧 id 归一化 / AI 变式兜底 ---------- */
section('M. 统一 id 网 · 别名映射与旧 id 归一化');
try {
  /* 取一个「bio 学科当前在用的别名」——即老进度里可能存的旧 id */
  const probe = X(`(function(){var ids=new Set(),sub=SB['bio'];
    for(var gi=0;gi<2;gi++){var g=gi?'ext':'jg';
      for(var ci=0;ci<sub.groups[g].chapters.length;ci++){var qs=sub.groups[g].chapters[ci].questions;
        for(var i=0;i<qs.length;i++)ids.add(qs[i].id);}}
    for(var a in ALIAS) if(ids.has(ALIAS[a])) return a; return null;})()`);
  ok('ALIAS 已建立（存在 bio 可用别名）', typeof probe === 'string' && probe.length > 0, String(probe));
  const prim = probe ? X(`ALIAS[${JSON.stringify(probe)}]`) : null;
  ok('别名 → 主 id 映射可用', typeof prim === 'string' && prim.length > 0, String(prim));
  ok('qById 能用旧 id 找到题（走 ALIAS）', probe ? X(`!!qById(${JSON.stringify(probe)})`) === true : false);

  /* 把旧 id 灌进各类容器，模拟老用户 localStorage */
  X(`(function(){var a=${JSON.stringify(probe)},p=${JSON.stringify(prim)},st=subState('bio');
    st.wrong=[a,p]; st.fav=[a]; st.doubt=[]; st.mastered=[a];
    st.qstat={}; st.qstat[a]={n:3,r:2,w:1,last:1}; st.qstat[p]={n:1,r:1,w:0,last:2};
    st.review={}; st.review[a]={stage:2,wrongAns:['A'],nextReview:1};
    S.sessions['c:bio:__probe']={subject:'bio',mode:'practice',idx:0,qids:[{id:a,chapterId:'x第一章 蛋白质的结构与功能'}],answers:{}};
    S.sessions['c:bio:__probe'].answers[a]={chosen:['A'],correct:false,revealed:true};
    return 1;})()`);
  const n1 = X(`normalizeSubjectIds('bio')`);
  ok('归一化改写了旧 id（改写条数 > 0）', typeof n1 === 'number' && n1 > 0, String(n1));

  const stw = X("subState('bio').wrong");
  ok('标记类已归一 + 去重（wrong 只剩主 id 一条）', Array.isArray(stw) && stw.length === 1 && stw[0] === prim, JSON.stringify(stw));
  ok('mastered 已归一', JSON.stringify(X("subState('bio').mastered")) === JSON.stringify([prim]));
  ok('qstat 键已归一（且同题两份记录取作答量大的）',
    JSON.stringify(X("Object.keys(subState('bio').qstat)")) === JSON.stringify([prim]) && X(`subState('bio').qstat[${JSON.stringify(prim)}].n`) === 3,
    JSON.stringify(X("subState('bio').qstat")));
  ok('review 键已归一',
    JSON.stringify(X("Object.keys(subState('bio').review)")) === JSON.stringify([prim]));
  ok('session qids[].id 与 answers 键已归一',
    X(`S.sessions['c:bio:__probe'].qids[0].id`) === prim
    && JSON.stringify(X(`Object.keys(S.sessions['c:bio:__probe'].answers)`)) === JSON.stringify([prim]));
  ok('幂等：再归一化一次不产生改写', X(`normalizeSubjectIds('bio')`) === 0);

  /* AI 变式题：不在静态池里，只能从本机 aiGen 兜回来 */
  X(`(function(){var st=subState('bio'); st.aiGen=[{batchId:'__bt',questions:[{id:'__ai1',content:'AI 变式题'}]}]; return 1;})()`);
  const aiHit = X(`qById('__ai1')`);
  ok('qById 能兜住 AI 变式题（章节 aigen:<batchId>）',
    aiHit && aiHit.q && aiHit.q.id === '__ai1' && aiHit.chapterId === 'aigen:__bt', JSON.stringify(aiHit && aiHit.chapterId));

  /* 清理探针，避免污染后续/复跑 */
  X(`(function(){var st=subState('bio'); st.wrong=[];st.fav=[];st.doubt=[];st.mastered=[];st.qstat={};st.review={};st.aiGen=[];
    delete S.sessions['c:bio:__probe']; return 1;})()`);
} catch (e) {
  ok('M 段执行无异常', false, e.message + ' | ' + (e.stack || '').split('\n')[1]);
}

/* ---------- 汇总 ---------- */
console.log('\n===== 汇总 =====');
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log(`运行时异常 ${runtimeErrs.length} 条（忽略 canvas getContext 类环境限制）`);
if (runtimeErrs.length) console.log('异常明细:\n - ' + runtimeErrs.map(e => e.split('\n').slice(0, 2).join(' / ')).join('\n - '));
if (failures.length) { console.log('失败项:\n - ' + failures.join('\n - ')); process.exit(1); }
if (runtimeErrs.length) process.exit(1);
