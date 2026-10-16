import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(WS, '工程', '题库调研');
const MERGED = path.join(ROOT, 'merged2', 'by_subject', '生物化学.json');
const REPORT = path.join(ROOT, 'ingest_xuetang_bio.report.json');
const OUT = path.join(ROOT, 'xuetang_corrections_review.md');

const merged = JSON.parse(fs.readFileSync(MERGED, 'utf8'));
const arr = Array.isArray(merged) ? merged : (merged.questions || merged.items || []);
const qmap = new Map(arr.map(q => [q.id, q]));
const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const detail = report.correctionsDetail || [];

let md = '# 学习通·生化 答案校正对照清单（24 处，待你审阅）\n\n';
md += '> 说明：本站原答案（旧）已被学习通正确答案（新）覆盖并已写入数据层（run_all 已通过）。\n';
md += '> 下表供你逐条复核。若某条你认为学习通答案有误，告诉我 id，我单独回退该 pair。\n\n';
md += '| # | 章节 | 题干 | 旧答案(站) | 新答案(学习通) |\n';
md += '| --- | --- | --- | --- | --- |\n';

let ok = 0, miss = 0;
detail.forEach((d, i) => {
  const q = qmap.get(d.id);
  if (!q) { md += `| ${i + 1} | ${d.chapterFolder || ''} | ${d.stem || ''} | ${d.old}（题不在库） | ${d.new} |\n`; miss++; return; }
  const oldTxt = (q.options && q.options[d.old]) ? q.options[d.old] : '（无该选项）';
  const newTxt = (q.options && q.options[d.new]) ? q.options[d.new] : '（无该选项）';
  md += `| ${i + 1} | ${d.chapterFolder || ''} | ${String(d.stem || '').replace(/\|/g, ' ')} | ${d.old}. ${String(oldTxt).replace(/\|/g, ' ')} | ${d.new}. ${String(newTxt).replace(/\|/g, ' ')} |\n`;
  ok++;
});

fs.writeFileSync(OUT, md, 'utf8');
console.log('已写出', OUT);
console.log('解析到题:', ok, ' 未命中:', miss, ' 合计:', detail.length);
