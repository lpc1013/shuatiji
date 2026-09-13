/* iyixue 贡献题污染清洗：
 * 形态A：选项为「X. X. X. …」重复前缀垃圾（粘贴残留，含下一题碎片）→ 整条剔除
 * 形态B：选项以单个「X. 」字母前缀开头（字母已由 key 编码）→ 剥前缀保留内容
 * 形态C：题干与选项完全错配、答案无法自洽的贡献题 → 从库中移除（记录在案）
 * 只动 题库调研/packs/，原始 iyixue_top/ 不碰 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname); // 题库调研/
const PACKS = path.join(ROOT, 'packs');
const GARBAGE = /^([A-Ha-h])\.\s*(?:\1\.\s*){2,}/;          // 形态A
const LETTER_PREFIX = /^([A-Ha-h])\.\s*/;                    // 形态B
// 形态C：人工核实的坏题（题干/选项/答案三者错配，无法自洽）
const DROP_QUESTIONS = new Set([
  'ext-2a4d7522e06a0dd2', // 题干「主要散热方式」配 脂肪酸/磷酸盐/维生素/维生素C，答案B无从谈起
  'ext-87d3dde7852018ac', // 题干「G蛋白激活直接影响的酶」配 G蛋白/PK/JAK/MAPK，答案A=题干自身
  'ext-9fd8ce027d7cfa7b', // 题干「认TATA盒的转录因子」配 TFⅡA/B/Ⅱ/F，答案C不成立（应为TFⅡD，选项未列）
]);

const report = { garbageOpts: [], stripped: [], dropped: [] };
let filesTouched = 0;

for (const sem of fs.readdirSync(PACKS)) {
  const semP = path.join(PACKS, sem);
  if (!fs.statSync(semP).isDirectory()) continue;
  for (const grp of fs.readdirSync(semP)) {
    const gp = path.join(semP, grp);
    if (!fs.statSync(gp).isDirectory()) continue;
    for (const f of fs.readdirSync(gp)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(gp, f);
      const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!Array.isArray(arr)) continue;
      let dirty = false;
      const kept = [];
      for (const q of arr) {
        if (DROP_QUESTIONS.has(q.id)) { report.dropped.push(`${grp}/${sem}/${f} ${q.id} ${String(q.stem).slice(0, 40)}`); dirty = true; continue; }
        const opts = q.options || {};
        for (const k of Object.keys(opts)) {
          const s = String(opts[k]);
          if (GARBAGE.test(s)) { report.garbageOpts.push(`${grp}/${sem}/${f} ${q.id} ${k}=${JSON.stringify(s.slice(0, 50))}`); delete opts[k]; dirty = true; continue; }
          const m = s.match(LETTER_PREFIX);
          if (m) { report.stripped.push(`${grp}/${sem}/${f} ${q.id} ${k}: ${JSON.stringify(s.slice(0, 30))} → ${JSON.stringify(s.replace(LETTER_PREFIX, '').slice(0, 30))}`); opts[k] = s.replace(LETTER_PREFIX, '').trim(); dirty = true; }
        }
        kept.push(q);
      }
      if (dirty) { fs.writeFileSync(fp, JSON.stringify(kept), 'utf8'); filesTouched++; console.log('CLEANED', fp); }
    }
  }
}

const lines = [
  '# iyixue 贡献题污染清洗报告', '',
  `- 剔除垃圾选项（形态A）：**${report.garbageOpts.length} 条**`,
  `- 剥离字母前缀（形态B）：**${report.stripped.length} 条**`,
  `- 移除坏题（形态C）：**${report.dropped.length} 题**`,
  `- 改写文件：${filesTouched} 个`, '',
  '## 剔除的垃圾选项', ...report.garbageOpts.map(x => '- ' + x), '',
  '## 剥离的前缀', ...report.stripped.map(x => '- ' + x), '',
  '## 移除的坏题（理由见脚本注释）', ...report.dropped.map(x => '- ' + x), '',
  '注：清洗只动 题库调研/packs/（派生层）；iyixue_top/ 原始爬取数据保持原样未动。',
];
fs.writeFileSync(path.join(ROOT, '清洗报告_options.md'), lines.join('\n'), 'utf8');
console.log(`\n垃圾选项 ${report.garbageOpts.length} | 前缀剥离 ${report.stripped.length} | 坏题移除 ${report.dropped.length} | 文件 ${filesTouched}`);
