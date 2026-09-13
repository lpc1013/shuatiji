// 解析 v3 周期日志 -> 三账号时间序列 -> 生成三图 HTML
import { readFileSync, writeFileSync } from 'fs';

const raw = readFileSync('v3_region.txt', 'utf8').split('\n').filter(Boolean);

// 配置切换点(UTC 时间戳 + 每账号 cap)
const capSteps = []; // {t: 'HH:MM:SS'(UTC), caps:[a0,a1,a2]}
let curCaps = [49, 49, 49];
for (const line of raw) {
  const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\] 续爬轮询器 v3.*?(每轮CAP=(\d+)题|每账号CAP=\[([^\]]+)\]题)/);
  if (m) {
    const t = m[1];
    if (m[3]) curCaps = [+m[3], +m[3], +m[3]];
    else curCaps = m[4].split(',').map(s => +s.trim());
    capSteps.push({ t, caps: [...curCaps] });
  }
}

// 把 UTC 时间转北京时间分钟(相对 2026-09-09 21:25:33 北京)
function toBJ(t) {
  let [h, mi, s] = t.split(':').map(Number);
  h += 8; let day = 9;
  if (h >= 24) { h -= 24; day = 10; }
  return { day, h, mi, s, label: `${day<=9?'9/':''}${day}日 ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}` };
}
const START = { day: 9, h: 21, mi: 25, s: 33 };
function minOf(d) { return (d.day - 9) * 1440 + d.h * 60 + d.mi + d.s / 60; }
const START_MIN = minOf(START);
function xmin(t) { const b = toBJ(t); return minOf(b) - START_MIN; }

// cap 在任意 UTC 时刻的值
function capAt(t) {
  let caps = capSteps[0].caps;
  for (const step of capSteps) { if (step.t <= t) caps = step.caps; }
  return caps;
}

const series = { 0: [], 1: [], 2: [] };
const names = { 0: '186 (账号0·被标记)', 1: '180 (账号1)', 2: '195 (账号2·主力)' };

for (const line of raw) {
  const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]   #([012]) (.+)$/);
  if (!m) continue;
  const [, t, acc, body] = m;
  if (body.includes('探针异常')) continue; // 网络抖动, 非429, 无 restMin
  const xm = xmin(t);
  const bj = toBJ(t);
  let hit429 = false, restMin = null, cap = null;
  if (body.includes('探针429')) { hit429 = true; restMin = +body.match(/休息延长至 ([\d.]+)min/)[1]; }
  else if (body.includes('抓途中429')) { hit429 = true; restMin = +body.match(/休息([\d.]+)min不够/)[1]; }
  else if (body.includes('抓')) {
    const cm = body.match(/抓(\d+)成功/);
    if (cm) { cap = +cm[1]; restMin = +body.match(/休息([\d.]+)min够/)[1]; }
  }
  if (restMin == null) continue;
  if (cap == null) cap = capAt(t)[+acc];
  series[acc].push({ t, xm, bjlabel: bj.label, cap, restMin, hit429 });
}

// ---- 生成 SVG 图表 ----
const W = 680, H = 380, ML = 52, MR = 52, MT = 46, MB = 56;
const X0 = ML, X1 = W - MR, Y0 = MT, Y1 = H - MB;
const XMAX = xmin('23:13:12') + 2;
const capMax = 55, restMax = 35;
const sx = x => X0 + (x / XMAX) * (X1 - X0);
const syCap = v => Y1 - (v / capMax) * (Y1 - Y0);
const syRest = v => Y1 - (v / restMax) * (Y1 - Y0);

function chart(acc) {
  const pts = series[acc];
  let g = '';
  // 网格 + 时间刻度(每60min)
  for (let xm = 0; xm <= XMAX; xm += 60) {
    const x = sx(xm);
    g += `<line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" stroke="#e6e9ef" stroke-width="1"/>`;
    const totMin = START_MIN + xm;
    const day = 9 + Math.floor(totMin / 1440);
    const hh = Math.floor((totMin % 1440) / 60);
    const mm = Math.floor(totMin % 60);
    g += `<text x="${x}" y="${Y1 + 16}" font-size="10" fill="#8a93a6" text-anchor="middle">${day}日${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}</text>`;
  }
  // cap 网格(左轴)
  for (let v = 0; v <= capMax; v += 10) {
    const y = syCap(v);
    g += `<line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" stroke="#f0f2f6" stroke-width="1"/>`;
    g += `<text x="${X0 - 6}" y="${y + 3}" font-size="10" fill="#2c7be5" text-anchor="end">${v}</text>`;
  }
  // rest 网格(右轴)
  for (let v = 0; v <= restMax; v += 5) {
    const y = syRest(v);
    g += `<text x="${X1 + 6}" y="${y + 3}" font-size="10" fill="#e8852b" text-anchor="start">${v}</text>`;
  }
  // cap 折线(蓝)
  let capPath = '';
  pts.forEach((p, i) => { capPath += (i ? 'L' : 'M') + sx(p.xm).toFixed(1) + ' ' + syCap(p.cap).toFixed(1) + ' '; });
  g += `<path d="${capPath}" fill="none" stroke="#2c7be5" stroke-width="2.2"/>`;
  // rest 折线(橙)
  let restPath = '';
  pts.forEach((p, i) => { restPath += (i ? 'L' : 'M') + sx(p.xm).toFixed(1) + ' ' + syRest(p.restMin).toFixed(1) + ' '; });
  g += `<path d="${restPath}" fill="none" stroke="#e8852b" stroke-width="2.2" stroke-dasharray="5 3"/>`;
  // 429 标记(红 X)
  pts.forEach(p => {
    if (p.hit429) {
      const x = sx(p.xm), y = syRest(p.restMin);
      g += `<path d="M${x-5} ${y-5} L${x+5} ${y+5} M${x+5} ${y-5} L${x-5} ${y+5}" stroke="#e23b3b" stroke-width="2.4"/>`;
    }
  });
  // 轴标题
  g += `<text x="${X0 - 40}" y="${Y0 - 16}" font-size="11" fill="#2c7be5">cap(题)</text>`;
  g += `<text x="${X1 + 8}" y="${Y0 - 16}" font-size="11" fill="#e8852b">等待(min)</text>`;
  g += `<text x="${W/2}" y="${H - 8}" font-size="11" fill="#8a93a6" text-anchor="middle">北京时间 (9/9 21:25 → 9/10 07:13)</text>`;
  // 统计
  const n429 = pts.filter(p => p.hit429).length;
  const nOk = pts.length - n429;
  g += `<text x="${W/2}" y="20" font-size="14" font-weight="700" fill="#2c3e50" text-anchor="middle">${names[acc]}　共${pts.length}轮 · 429命中${n429} · 成功${nOk}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#ffffff"/>${g}</svg>`;
}

const legend = `<div style="font:13px/1.6 'Microsoft YaHei',sans-serif;color:#2c3e50;margin:6px 0 14px">
  <span style="color:#2c7be5;font-weight:700">━ cap</span>（每轮抓取上限·蓝实线，阶梯变化）
  <span style="color:#e8852b;font-weight:700">┄ 等待</span>（restMin·橙虚线）
  <span style="color:#e23b3b;font-weight:700">✕ 429</span>（红叉=该轮撞限流）
</div>`;

let html = `<!doctype html><html><head><meta charset="utf-8"><title>外科学(test)续爬·三账号节奏</title></head>
<body style="margin:0;background:#f5f7fa;font-family:'Microsoft YaHei',sans-serif">
<div style="max-width:760px;margin:0 auto;padding:18px">
<h2 style="color:#2c3e50">极光·外科学(test)续爬 — 三账号节奏（北京时间）</h2>
<p style="color:#5a6678;font-size:13px">周期 2026-09-09 21:25 → 09-10 07:13（北京时间）。cap 为配置切换的阶梯值；restMin 为自适应休息窗口；红叉标记撞 429 的轮次。</p>
${legend}
<h3 style="color:#2c3e50">账号0 · 186（被额外标记，配额最低）</h3>${chart(0)}
<h3 style="color:#2c3e50;margin-top:24px">账号1 · 180</h3>${chart(1)}
<h3 style="color:#2c3e50;margin-top:24px">账号2 · 195（主力，最早解封）</h3>${chart(2)}
</div></body></html>`;

writeFileSync('waike_pacing_charts.html', html);
// 控制台摘要
for (const a of [0,1,2]) {
  const p = series[a];
  console.log(`\n#${a} ${names[a]}: ${p.length}轮, 429=${p.filter(x=>x.hit429).length}`);
  console.log('  cap序列(去重):', [...new Set(p.map(x=>x.cap))].join(','));
  console.log('  restMin范围:', Math.min(...p.map(x=>x.restMin)).toFixed(1), '~', Math.max(...p.map(x=>x.restMin)).toFixed(1));
}
console.log('\nHTML -> waike_pacing_charts.html');
