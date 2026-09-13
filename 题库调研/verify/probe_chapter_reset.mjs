// 章节重置探针：真实加载 site 源码，验证「危险区 → 按章节重置」端到端行为
// 用法：node verify/probe_chapter_reset.mjs   （退出码 0=全过）
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require_('C:/Users/Pengcheng_Li/.workbuddy/binaries/node/workspace/node_modules/jsdom');
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); } };

const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', e => { const m = (e.detail && (e.detail.stack || e.detail.message)) || e.message || String(e); if (!/getContext/.test(m)) console.log('  [jsdomError]', m.split('\n')[0]); });
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8788/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom, { document } = window;

const QF = pathToFileURL(R + '/').href;
window.fetch = async (u) => {
  const href = String(u); let p = null;
  if (href.startsWith(QF)) p = fileURLToPath(href.split('?')[0]);
  else if (/^https?:\/\//.test(href)) { if (!href.startsWith('http://127.0.0.1:8788/')) return { ok: false, status: 404, json: async () => ({}) }; p = path.join(R, decodeURIComponent(href.split('8788')[1].split('?')[0])); }
  else p = path.join(R, decodeURIComponent(href.split('?')[0]));
  try { const buf = fs.readFileSync(p); return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), text: async () => buf.toString('utf8') }; }
  catch { return { ok: false, status: 404, json: async () => ({}) }; }
};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
let confirmCalls = [];
window.confirm = (msg) => { confirmCalls.push(msg); return true; };
window.requestAnimationFrame = cb => setTimeout(cb, 0);

const scriptCode = ['app.js', 'english.js', 'features.js'].map(f => fs.readFileSync(path.join(R, f), 'utf8')).join('\n;\n')
  + '\n;window.__T = { x: c => eval(c) };';
try { window.eval(scriptCode); } catch (e) { console.log('顶层 eval 失败:', e.message); process.exit(1); }
const X = c => { try { return window.__T.x(c); } catch (e) { return '__ERR__' + e.message; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = el => el.dispatchEvent(new window.Event('click', { bubbles: true }));

await sleep(300);
for (let i = 0; i < 60; i++) { if (X('Object.keys(SB).length') > 0 && (document.getElementById('view') || {}).innerHTML?.length > 500) break; await sleep(150); }
await X(`ensureSubject('bio')`); await sleep(400);

console.log('\n== 1. 造数据：两章各 2 题进度 + 断点会话 ==');
// 取前两章（含题的），每章取 2 题主 id
const setup = X(`(() => {
  const chs = SB.bio.groups.jg.chapters.filter(c => c.questions.length >= 1).slice(0, 2);
  if (chs.length < 2) return 'NEED_CH';
  const st = S.subjects.bio;
  const out = [];
  for (const c of chs) {
    const ids = c.questions.slice(0, 2).map(q => q.id);
    for (const id of ids) {
      if (!st.wrong.includes(id)) st.wrong.push(id);
      st.qstat[id] = { n: 3, c: 1 };
      st.review[id] = { stage: 2, wrongAns: ['A'] };
    }
    st.byChapter[c.id] = { total: 10, correct: 5 };
    out.push({ cid: c.id, name: c.name, ids });
  }
  st.daily['2026-09-13'] = { answered: 42, correct: 30 };
  st.examHistory.push({ key: 'fake', at: Date.now(), total: 10, correct: 8 });
  S.sessions['probe:chapter'] = { subject: 'bio', mode: 'order', idx: 0, updatedAt: Date.now(),
    qids: out.flatMap(o => o.ids.map(id => ({ id, chapterId: o.cid, chapterName: o.name }))), answers: {} };
  return JSON.stringify(out);
})()`);
if (setup === 'NEED_CH' || String(setup).startsWith('__ERR__')) { console.log('  ❌ 造数据失败', setup); process.exit(1); }
const CH = JSON.parse(setup);
ok('两章测试数据就绪', CH.length === 2);
const stJson = () => X(`JSON.stringify({ w: S.subjects.bio.wrong.length, q: Object.keys(S.subjects.bio.qstat).length, r: Object.keys(S.subjects.bio.review).length, bc: Object.keys(S.subjects.bio.byChapter).length, daily: Object.keys(S.subjects.bio.daily).length, exam: S.subjects.bio.examHistory.length })`);
const before = JSON.parse(stJson());
console.log('    before:', JSON.stringify(before), '章节A=' + CH[0].name, '章节B=' + CH[1].name);

console.log('\n== 2. 打开重置面板 → 展开章节筛选 → 勾选章节 A ==');
X(`RST = null; resetSetup()`);
const modal = document.getElementById('modal');
ok('重置面板已打开', modal && !modal.classList.contains('hidden'));
const chBtn = modal.querySelector('[data-act="rst-chmode"]');
ok('「按章节筛选」按钮存在', !!chBtn);
click(chBtn);
const rows = [...modal.querySelectorAll('[data-act="rst-ch"]')];
ok('章节列表已展开（≥2 项）', rows.length >= 2, 'rows=' + rows.length);
const rowA = rows.find(r => r.dataset.cid === CH[0].cid);
ok('章节 A 行存在', !!rowA);
click(rowA);
const onA = modal.querySelector(`[data-act="rst-ch"][data-cid="${CH[0].cid}"]`);
ok('章节 A 已勾选（on 态）', onA && /(^|\s)on(\s|$)/.test(onA.className), onA && onA.className);
const summary = modal.textContent;
ok('面板明细只统计章节 A（chQn 提示出现）', /已选 1 章/.test(summary), '');
ok('确认按钮仍存在', !!modal.querySelector('[data-act="rst-go"]'));

console.log('\n== 3. 执行重置（confirm 已 stub） ==');
click(modal.querySelector('[data-act="rst-go"]'));
await sleep(400);
ok('confirm 弹出且含章节范围说明', confirmCalls.length === 1 && /章节范围/.test(confirmCalls[0]), confirmCalls[0] && confirmCalls[0].slice(0, 60));
const after = JSON.parse(stJson());
console.log('    after :', JSON.stringify(after));
// 章节 A 的 2 题 + 章节 B 的 2 题 → 总 wrong 4（若与其他测试数据无冲突）
ok('章节 A 的 wrong 已清 / 章节 B 保留', X(`S.subjects.bio.wrong.filter(id=>${JSON.stringify(CH[0].ids)}.includes(id)).length`) === 0
  && X(`S.subjects.bio.wrong.filter(id=>${JSON.stringify(CH[1].ids)}.includes(id)).length`) === 2);
ok('章节 A 的 qstat 已删 / 章节 B 保留', X(`!S.subjects.bio.qstat[${JSON.stringify(CH[0].ids[0])}]`)
  && X(`!!S.subjects.bio.qstat[${JSON.stringify(CH[1].ids[0])}]`));
ok('章节 A 的 review 已删 / 章节 B 保留', X(`!S.subjects.bio.review[${JSON.stringify(CH[0].ids[0])}]`)
  && X(`!!S.subjects.bio.review[${JSON.stringify(CH[1].ids[0])}]`));
ok('byChapter：A 键已删 / B 键保留', X(`!S.subjects.bio.byChapter[${JSON.stringify(CH[0].cid)}]`)
  && X(`!!S.subjects.bio.byChapter[${JSON.stringify(CH[1].cid)}]`));
ok('章节模式保留 daily / examHistory', after.daily === before.daily && after.exam === before.exam,
  `daily ${before.daily}→${after.daily} exam ${before.exam}→${after.exam}`);
ok('断点会话已裁剪章节 A 的题', X(`(S.sessions['probe:chapter'].qids||[]).every(e=>e.chapterId!==${JSON.stringify(CH[0].cid)})`)
  && X(`S.sessions['probe:chapter'].qids.length`) === CH[1].ids.length);
ok('纠错 feedback 不受影响（键仍存在）', X(`Array.isArray(S.subjects.bio.feedback)`));

console.log('\n== 4. 收尾：章节 B 也清掉 + 面板交互回归 ==');
X(`RST = null; resetSetup()`);
click(document.getElementById('modal').querySelector('[data-act="rst-chmode"]'));
click(document.getElementById('modal').querySelector(`[data-act="rst-ch"][data-cid="${CH[1].cid}"]`));
click(document.getElementById('modal').querySelector('[data-act="rst-go"]'));
await sleep(400);
ok('章节 B 也清干净', X(`S.subjects.bio.wrong.filter(id=>${JSON.stringify(CH[1].ids)}.includes(id)).length`) === 0);
ok('rst-subs 在章节模式下被拦截（学科 chip 不生效）', (() => {
  X(`RST = null; RST = { groups:['jg','ext','ai'], allSubjects:false, clearEng:false, chapters:[], chOpen:false };
     RST.chapters = ${JSON.stringify([CH[0].cid])};`);
  X(`rstTargets()`);
  return X(`JSON.stringify(rstTargets())`) === JSON.stringify(['bio']);
})());

console.log(`\n===== 汇总 =====\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
