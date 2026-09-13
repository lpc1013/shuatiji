// 全站交互冒烟：把每个 tab 页 / 弹窗 / 做题页里渲染出来的 [data-act] 元素逐个真实点击，
// 捕获运行时异常。判定「点了就抛异常」= bug。
//
// 为什么需要它：jsdom 只把 jsdomError 打到 console，不会让普通断言失败 ——
// 「高级筛选首次点击崩（act('filter-setup') → collectFilterNums() → F 为 null）」正是因为
// 旧测试直接调 Feat.filterSetup()（绕过分发层）而漏网。本脚本走的是真实点击链路。
//
// 用法：node 题库调研/verify/verify_actions_smoke.mjs
//      加 --full 会遍历 bank 页全部元素（很慢，且 jsdom 可能 OOM，仅供排查用）
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require_('C:/Users/Pengcheng_Li/.workbuddy/binaries/node/workspace/node_modules/jsdom');
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');
const FULL = process.argv.includes('--full');

const jsErrs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const m = String((e.detail && (e.detail.message || e.detail)) || e.message || e);
  if (!/getContext/.test(m)) jsErrs.push(m);      // canvas 未装包属环境限制
});

const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8788/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom; const { document } = window;

const QF = pathToFileURL(R + '/').href;
window.fetch = async (u) => {
  const href = String(u); let p = null;
  if (href.startsWith(QF)) p = fileURLToPath(href.split('?')[0]);
  else if (/^https?:\/\//.test(href)) {
    if (!href.startsWith('http://127.0.0.1:8788/')) return { ok: false, status: 404, json: async () => ({}) };
    p = path.join(R, decodeURIComponent(href.split('8788')[1].split('?')[0]));
  } else p = path.join(R, decodeURIComponent(href.split('?')[0]));
  try { const b = fs.readFileSync(p); return { ok: true, status: 200, json: async () => JSON.parse(b.toString('utf8')), text: async () => b.toString('utf8') }; }
  catch { return { ok: false, status: 404, json: async () => ({}) }; }
};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
window.alert = () => {}; window.confirm = () => true; window.requestAnimationFrame = cb => setTimeout(cb, 0);

try { window.eval(['app.js', 'features.js'].map(f => fs.readFileSync(path.join(R, f), 'utf8')).join('\n;\n') + '\n;window.__T={x:c=>eval(c)};'); }
catch (e) { jsErrs.push('顶层: ' + e.message); }
const X = c => { try { return window.__T.x(c); } catch (e) { return '__ERR__' + e.message; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mem = () => Math.round(process.memoryUsage().heapUsed / 1048576) + 'MB';

for (let i = 0; i < 60; i++) {
  const n = X('Object.keys(SB).length');
  if (typeof n === 'number' && n > 0 && (document.getElementById('view')?.innerHTML || '').length > 500) break;
  await sleep(150);
}
await sleep(300);

const problems = []; let clicks = 0;
const esc = s => String(s).replace(/"/g, '\\"');

async function hit(label, getEl) {
  const el = getEl(); if (!el) return false;
  const mark = jsErrs.length; let threw = null;
  try {
    // 派发会冒泡的 MouseEvent，对 HTML/SVG 元素都有效（jsdom 的 SVGElement 无 .click()）
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  } catch (e) { threw = e.message; }
  clicks++;
  await sleep(70);
  const errs = jsErrs.slice(mark);
  if (threw || errs.length) problems.push({ label, msg: (threw ? 'threw: ' + threw + ' ' : '') + errs.join(' | ') });
  return true;
}

console.log(`[冒烟] 目标 ${R} | ${FULL ? '全量' : '抽样（每类 action 一个）'} | 起始堆 ${mem()}`);

/* 1) 各 tab：每类 action 抽 1 个元素点击；点了会开弹窗的顺便点弹窗内一个元素 */
const tabs = [...document.querySelectorAll('.tab')].map(t => t.dataset.tab);
for (const tab of tabs) {
  X(`closeModal(); closePlayer(); show("${esc(tab)}")`); await sleep(300);
  const all = [...document.querySelectorAll('#view [data-act]')];
  const list = FULL ? all.map((_, i) => i) : null;
  const acts = []; const seen = new Set();
  for (const el of all) { const a = el.dataset.act; if (!seen.has(a)) { seen.add(a); acts.push(a); } }
  console.log(`  · tab=${tab}  元素 ${all.length} / 去重 action ${acts.length}  堆 ${mem()}`);

  if (FULL) {
    for (const i of list) {
      X('closeModal()'); await sleep(25);
      await hit(`${tab} #${i}`, () => document.querySelectorAll('#view [data-act]')[i]);
    }
  } else {
    for (const a of acts) {
      X('closeModal()'); await sleep(25);
      await hit(`${tab} <${a}>`, () => document.querySelector(`#view [data-act="${a}"]`));
      const md = document.getElementById('modal');
      if (md && !md.classList.contains('hidden')) {
        await hit(`${tab}/${a} → modal`, () => document.querySelector('#modal [data-act]'));
        X('closeModal()');
      }
    }
  }
  X('closePlayer()'); await sleep(80);
}

/* 2) 做题页专项 */
console.log(`  · player 专项  堆 ${mem()}`);
X('closeModal(); closePlayer(); show("home")'); await sleep(250);
await hit('进入顺序刷题', () => document.querySelector('#view [data-act="start-order"]'));
await sleep(300);
await hit('选第一章', () => document.querySelector('#modal [data-act="chapter"]'));
await sleep(200);
await hit('选第一题', () => document.querySelector('#modal [data-act="jump-q"]'));
await sleep(400);
{
  const pEls = [...document.querySelectorAll('#player [data-act]')];
  const acts = []; const seen = new Set();
  for (const el of pEls) { const a = el.dataset.act; if (!seen.has(a)) { seen.add(a); acts.push(a); } }
  console.log(`    player 元素 ${pEls.length} / 去重 action ${acts.length}`);
  for (const a of acts) await hit(`player <${a}>`, () => document.querySelector(`#player [data-act="${a}"]`));
  await hit('player 选选项', () => document.querySelector('#player .opt'));
  await hit('player 提交', () => document.querySelector('#player [data-act="submit"]'));
}

console.log('\n===== 冒烟汇总 =====');
console.log(`点击 ${clicks} 次 | 结束堆 ${mem()} | 异常路径 ${problems.length} | jsdomError ${jsErrs.length}`);
for (const p of problems) console.log(`  ❌ ${p.label}\n      ${p.msg}`);
if (jsErrs.length && !problems.length) jsErrs.slice(0, 6).forEach(e => console.log('  · ' + e.split('\n')[0]));
if (problems.length || jsErrs.length) process.exit(1);
console.log('✅ 全部交互路径无运行时异常');
