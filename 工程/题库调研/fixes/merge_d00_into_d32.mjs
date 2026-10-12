/**
 * 将「通用医学英语(扩增) d00」合并进「学术英语·医学(教材) d32」，再删除 d00。
 * - d00 与 d32 重叠的 57 词：在 d32 现有条目上补「通用医学英语」标签 + 字段取长补短
 * - d00 独有的 103 词：完整搬进 d32，g=["通用医学英语"]
 * - 之后删除 d00.json，重建 manifest（剩余 d01/d31/d32 三片）
 * 进度按词形(pkey)跨分类共享，合并不改变任何进度键。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 仓库根目录（由脚本自身位置反推，避免硬编码本机绝对路径）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../') + path.sep;
const DIR = ROOT + 'site/data/english/';
const BAK = ROOT + '工程/题库调研/_bak_english_20261012b/';
const pkey = w => String(w.e).toLowerCase().trim();
const TAG = '通用医学英语';

function load(f) { return JSON.parse(fs.readFileSync(DIR + f, 'utf8')); }
function save(f, o) { fs.writeFileSync(DIR + f, JSON.stringify(o), 'utf8'); }

// 1) 备份
fs.mkdirSync(BAK, { recursive: true });
for (const f of ['d00.json', 'd32.json', 'manifest.json']) {
  fs.copyFileSync(DIR + f, BAK + f);
}
console.log('备份完成:', BAK);

// 2) 读取
const d00 = load('d00.json');
const d32 = load('d32.json');
const d00Words = d00.w || [];
const d32Words = d32.w || [];

// d32 按 pkey 建索引
const idx = new Map();
d32Words.forEach((w, i) => idx.set(pkey(w), i));

const FIELDS = ['c', 'ph', 'et', 'ex', 'tr', 'pm'];
let merged = 0, added = 0, tagged = 0;

for (const src of d00Words) {
  const k = pkey(src);
  if (idx.has(k)) {
    // 重叠：补字段 + 加标签
    const dst = d32Words[idx.get(k)];
    let changed = false;
    for (const f of FIELDS) {
      if (!dst[f] && src[f]) { dst[f] = src[f]; changed = true; }
    }
    const g = Array.isArray(dst.g) ? dst.g : [];
    if (!g.includes(TAG)) { g.push(TAG); dst.g = g; tagged++; changed = true; }
    if (changed) merged++;
  } else {
    // 独有：完整搬入，打标签
    const w = { ...src };
    w.g = [TAG];
    d32Words.push(w);
    idx.set(k, d32Words.length - 1);
    added++;
    tagged++;
  }
}

// 3) 写回 d32（保留原 k/n）
d32.w = d32Words;
save('d32.json', d32);
console.log(`d32 合并：补字段 ${merged} 条，追加 ${added} 条，打「${TAG}」标签 ${tagged} 条`);
console.log(`d32 词数: ${d32Words.length} (原 ${d32Words.length - added})`);

// 4) 删除 d00
fs.unlinkSync(DIR + 'd00.json');
console.log('已删除 d00.json');

// 5) 重建 manifest（剩余 d01/d31/d32）
const files = ['d01.json', 'd31.json', 'd32.json'];
// 维持原视觉顺序：31, 01, 32（去掉 00）
const order = ['d31.json', 'd01.json', 'd32.json'];
const present = order.filter(f => fs.existsSync(DIR + f));
const depts = [];
const union = new Map();   // pkey -> 出现片数
let shardTotal = 0;
let noTr = 0, noEx = 0, noPm = 0, withEt = 0;

for (const f of present) {
  const o = load(f);
  const list = o.w || [];
  const id = f.replace(/^d|\.json$/g, '');
  depts.push({ id, n: o.n, c: list.length, f });
  shardTotal += list.length;
  const seen = new Set();
  for (const w of list) {
    const k = pkey(w);
    union.set(k, (union.get(k) || 0) + 1);
    if (!seen.has(k)) { seen.add(k); }  // 片内去重只算一次
    if (!w.tr) noTr++;
    if (!w.ex) noEx++;
    if (!w.pm) noPm++;
    if (w.et) withEt++;
  }
}
// 修正：union 多计了片内重复——但各片内部词形已唯一（构建保证），这里 list 内无重复，故 union 即跨片计数
const total = union.size;
const crossDept = [...union.values()].filter(c => c >= 2).length;

const old = load('manifest.json');
const man = {
  v: old.v || 1,
  built: old.built || '2026-10-12',
  total,
  shardTotal,
  crossDept,
  stats: { noTr, noEx, noPm, withEt },
  depts,
};
save('manifest.json', man);
console.log(`manifest 重建：分类数 ${depts.length}，唯一词 ${total}，分片词条和 ${shardTotal}，跨片词 ${crossDept}`);
depts.forEach(d => console.log(`  - ${d.id} ${d.n} (${d.c}词)`));
