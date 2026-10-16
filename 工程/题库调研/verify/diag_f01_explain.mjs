// F01 诊断：生化解析 611 条去哪了？
import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PACKS = path.join(ROOT, '工程', '题库调研', 'packs');
const DATA = path.join(ROOT, 'site', 'data');

function safeChapName(ch){ return String(ch).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 80) || '未分类'; }

const sem = '大二', sub = '生物化学', sid = 'bio';
const po = JSON.parse(fs.readFileSync(path.join(PACKS, sem, 'explain', sub + '.json'), 'utf8'));

// 重建 build 的 chapOf（题id→章节），模拟 build_site_data.mjs 逻辑
const chapOf = new Map();
// F05 后分片文件名带内容哈希，改用前缀匹配
const packsDir = path.join(DATA, 'packs', sem);
for (const f of fs.readdirSync(packsDir)) {
  if (!f.startsWith(sid + '-')) continue;
  const arr = JSON.parse(fs.readFileSync(path.join(packsDir, f), 'utf8'));
  for (const q of arr) if (q.id && q.c) chapOf.set(q.id, q.c);
}
// 注意：site packs 里的扩展组章节已是 canon 之后的；build 时 chapOf 来自源 arr（canonChapters 归一后）。

// site 端聚合
const dir = path.join(DATA, 'explain', sem, sid);
const so = {};
for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) Object.assign(so, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const miss = Object.keys(po).filter(k => !so[k]);
const extra = Object.keys(so).filter(k => !po[k]);
console.log('packs 条目', Object.keys(po).length, '| site 条目', Object.keys(so).length, '| 缺失', miss.length, '| site独有', extra.length);
console.log('缺失示例', miss.slice(0, 5));

// 假设 A：章节文件名清洗碰撞 —— 用源文件重建 byChap 并检测碰撞
// 找到 packs 侧源题库（build 用的输入）
const candDirs = [];
for (const grp of ['极光', '扩展']) {
  const gp = path.join(PACKS, sem, grp);
  if (fs.existsSync(gp)) for (const f of fs.readdirSync(gp)) if (f.replace(/\.json$/, '') === sub) candDirs.push(path.join(gp, f));
}
console.log('源题库文件', candDirs.map(p => path.basename(path.dirname(p)) + '/' + path.basename(p)));
const srcChapOf = new Map();
for (const [i, p] of candDirs.entries()) {
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  const isExt = p.includes('扩展');
  let items = arr;
  if (isExt) {
    // build 对扩展做 canonChapters —— 我们拿 site packs 里的 c 反推太复杂，直接用源 chapter，足够检测碰撞
  }
  for (const q of items) if (q.id && q.chapter) srcChapOf.set(q.id, q.chapter);
}
// 模拟 byChap 写文件：检查 fn→(章节名集合) 是否有碰撞
const fnMap = new Map();
for (const [qid, ch] of srcChapOf) {
  const fn = safeChapName(ch) + '.json';
  if (!fnMap.has(fn)) fnMap.set(fn, new Set());
  fnMap.get(fn).add(ch);
}
const coll = [...fnMap.entries()].filter(([, set]) => set.size > 1);
console.log('文件名碰撞组数', coll.length);
for (const [fn, set] of coll.slice(0, 10)) console.log('  碰撞', fn, '<-', [...set].map(s => JSON.stringify(s)).join(' vs '));

// 假设 B：缺失题的 qid 是否在 chapOf / 源题库里
let inChapOf = 0, inSrc = 0, noChap = 0;
for (const k of miss) { if (chapOf.has(k)) inChapOf++; else noChap++; if (srcChapOf.has(k)) inSrc++; }
console.log('缺失题中: 在site packs chapOf =', inChapOf, '| 在源题库 =', inSrc, '| 两处都不在 =', noChap);
// 缺失题如果都在，按章节统计缺失分布
const missByChap = {};
for (const k of miss) { const ch = srcChapOf.get(k) || chapOf.get(k) || '(无章节)'; missByChap[ch] = (missByChap[ch] || 0) + 1; }
const top = Object.entries(missByChap).sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('缺失按章节 top15:'); for (const [c, n] of top) console.log('  ', JSON.stringify(c), n);
