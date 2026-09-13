// 英语界面统一改造 · 自查探针（纯 DOM 点击驱动，不依赖 IIFE 内部状态）
// 重点：① 搜索+卡片模式，标记必须打在「可见词」上（修复 act 词表与 view 错位）
//       ② 新结构（section-title / .search / 清空 / 科室行）③ 模式切换回归
// 用法：node verify/probe_english_unify.mjs   （退出码 0=全过）
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require_('C:/Users/Pengcheng_Li/.workbuddy/binaries/node/workspace/node_modules/jsdom');
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'site');
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
window.confirm = () => true;
window.requestAnimationFrame = cb => setTimeout(cb, 0);

const scriptCode = ['app.js', 'english.js', 'features.js'].map(f => fs.readFileSync(path.join(R, f), 'utf8')).join('\n;\n')
  + '\n;window.__T = { x: c => eval(c) };';
try { window.eval(scriptCode); } catch (e) { console.log('顶层 eval 失败:', e.message); process.exit(1); }
const X = c => { try { return window.__T.x(c); } catch (e) { return '__ERR__' + e.message; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = el => el.dispatchEvent(new window.Event('click', { bubbles: true }));

await sleep(300);
for (let i = 0; i < 60; i++) { if (X('Object.keys(SB).length') > 0 && (document.getElementById('view') || {}).innerHTML?.length > 500) break; await sleep(150); }

console.log('\n== 1. 打开英语 tab，结构对齐主页面 ==');
document.getElementById('view').innerHTML = await X(`Eng.view()`);
X(`Eng.bind()`);   // 与 show('english') 一致：渲染后必须挂事件，否则搜索/科室监听不生效
const v = document.getElementById('view');
ok('有 section-title（与 题库检索/我的题目 同级）', !!v.querySelector('.section-title') && /医学英语/.test(v.querySelector('.section-title').textContent));
ok('搜索框用 .search 组件（同题库检索）', !!v.querySelector('.search input#engQ'));
ok('搜索框旁有「清空」按钮', !!v.querySelector('.search [data-act="eng-clear-q"]'));
ok('科室下拉在独立 .row 里（同题库布局）', !!v.querySelector('.row select#engDept.subject-select'));
ok('搜索框不再是 .inp 小样式', !v.querySelector('#engQ.inp'));
ok('结构顺序：进度卡 → 搜索 → 科室 → 模式卡 → 列表', (() => {
  const a = v.querySelector('.card'), b = v.querySelector('.search'), c = v.querySelector('.row select'),
    d = v.querySelector('.eng-modes'), e = v.querySelector('#engBody');
  if (!a || !b || !c || !d || !e) return false;
  return a.compareDocumentPosition(b) & 2 ? false
    : b.compareDocumentPosition(c) & 2 ? false
      : c.compareDocumentPosition(d) & 2 ? false
        : d.compareDocumentPosition(e) & 2 ? false : true;
})());
ok('列表行是 .eng-item（分隔线式）', v.querySelectorAll('#engBody .eng-item').length > 0);

console.log('\n== 2. 核心 bug 回归：搜索+卡片模式，标记必须打在「可见词」上 ==');
// 目标词取自第 2 个科室（不在默认科室里）
const target = await X(`(async () => {
  const man = await Eng.loadMan();
  const d2 = man.depts[1];
  const ws = await (await fetch('data/english/' + d2.f)).json();
  return JSON.stringify({ word: ws.w[0].e, dept2: d2.n, dept1: man.depts[0].n, dept1First: (await (await fetch('data/english/' + man.depts[0].f)).json()).w[0].e });
})()`);
const T = JSON.parse(target);
console.log(`    目标词「${T.word}」（${T.dept2}），默认科室 ${T.dept1}（首词 ${T.dept1First}）`);
ok('目标词确实不在默认科室首词位（错位才可观测）', T.word !== T.dept1First);
// 真实交互：输入搜索词 → 触发防抖搜索
const qi = document.getElementById('engQ');
qi.value = T.word;
qi.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(600);   // 防抖 260ms + 全库分片加载
// 切卡片模式
click(document.querySelector('.eng-modes [data-act="eng-mode"][data-v="card"]'));
await sleep(250);
const cardWord = document.querySelector('#engBody .eng-card-w');
ok('卡片显示的是搜索目标词', cardWord && cardWord.textContent === T.word, cardWord && cardWord.textContent);
// 点「认识」(data-v=2)
click(document.querySelector('#engBody [data-act="eng-mk"][data-v="2"]'));
await sleep(250);
const rec = X(`JSON.stringify(S.global.english[${JSON.stringify(T.word.toLowerCase())}] || null)`);
ok(`标记落在目标词「${T.word}」上（修复点）`, rec !== 'null' && JSON.parse(rec).s === 2, rec);
const wrongRec = X(`JSON.stringify(S.global.english[${JSON.stringify(T.dept1First.toLowerCase())}] || null)`);
ok(`修复前会错标到「${T.dept1First}」——现在未被打错标`, wrongRec === 'null', wrongRec);

console.log('\n== 3. 清空搜索 / 模式切换回归 ==');
click(document.querySelector('.search [data-act="eng-clear-q"]'));
await sleep(300);
ok('「清空」按钮清掉搜索词', document.getElementById('engQ') && document.getElementById('engQ').value === ''
  && !!document.querySelector('#engBody .eng-card, #engBody .eng-item'));
click(document.querySelector('.eng-modes [data-act="eng-mode"][data-v="list"]'));
await sleep(250);
ok('切回列表模式正常渲染', document.querySelectorAll('#engBody .eng-item').length > 0);
// 空搜索结果 → 清除筛选 chip
const qi2 = document.getElementById('engQ');
qi2.value = 'zzzz不存在的词zzz';
qi2.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(600);
ok('空结果显示清除筛选 chip', !!document.querySelector('#engBody [data-act="eng-clear-filter"]'));
click(document.querySelector('#engBody [data-act="eng-clear-filter"]'));
await sleep(300);
ok('清除筛选后列表恢复', document.querySelectorAll('#engBody .eng-item').length > 0);

console.log(`\n===== 汇总 =====\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
