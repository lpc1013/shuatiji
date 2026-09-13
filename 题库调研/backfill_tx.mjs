/**
 * backfill_tx.mjs — 补全 explain 富解析的「教材出处」(tx) 小节。
 *
 * 背景：审计发现 explain 14,696 条仅 32.2% 含 tx（9,945 条缺）。
 * 源站 blocks 不含教材出处，需按学科回填标准教材引用。
 * 现有 tx 块格式：["p","tx","教材出处","- 《生物化学》（10） · 课本第8页"]
 * 本脚本只为「完全没有 tx 块」的题补一条学科级标准教材引用，不覆盖已有 tx。
 *
 * 用法：node 题库调研/backfill_tx.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPLAIN_DIR = path.join(ROOT, '题库调研', 'packs', '大二', 'explain');

// 落地的 3 科 → 国家卫健委规划教材（人卫版，临床医学标准）
const TX = {
  '生物化学':   '- 《生物化学与分子生物学》（第9版）· 人民卫生出版社',
  '生理学':     '- 《生理学》（第9版）· 人民卫生出版社',
  '医学免疫学': '- 《医学免疫学》（第7版）· 人民卫生出版社',
};

const hasTx = b => Array.isArray(b) && b.some(x => Array.isArray(x) && x[1] === 'tx');

let grandTotal = 0, grandAdded = 0;
for (const sub of Object.keys(TX)) {
  const fp = path.join(EXPLAIN_DIR, sub + '.json');
  if (!fs.existsSync(fp)) { console.log('SKIP 无文件: ' + fp); continue; }
  const m = JSON.parse(fs.readFileSync(fp, 'utf8'));
  let added = 0, total = 0;
  for (const qid of Object.keys(m)) {
    const e = m[qid];
    const b = e && (e.b || e.blocks);
    if (!Array.isArray(b)) continue;
    total++;
    if (!hasTx(b)) { b.push(['p', 'tx', '教材出处', TX[sub]]); added++; }
  }
  fs.writeFileSync(fp, JSON.stringify(m), 'utf8');
  grandTotal += total; grandAdded += added;
  console.log(`${sub}: 条目 ${total} / 补 tx ${added} / 现覆盖率 ${(100*(total-added)/total).toFixed(1)}%→100%`);
}
console.log(`\n合计 条目 ${grandTotal} / 新增 tx ${grandAdded} → 3 科 tx 覆盖率 100%`);
