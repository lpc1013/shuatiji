import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(WS, '工程', '题库调研');
const MERGED = path.join(ROOT, 'merged2', 'by_subject', '生物化学.json');
const OUTDIR = path.join(ROOT, 'pf_gen', 'xuetang');
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

const merged = JSON.parse(fs.readFileSync(MERGED, 'utf8'));
const arr = Array.isArray(merged) ? merged : (merged.questions || merged.items || []);

const target = [];
for (const q of arr) {
  if (q.sourceType !== 'xuetang') continue;
  const expl = q.explanation;
  const hasExpl = expl && (typeof expl === 'string' ? expl.trim().length > 0 : Array.isArray(expl?.b) && expl.b.length);
  if (hasExpl) continue;
  target.push({
    id: q.id,
    stem: q.stem,
    options: q.options,
    answer: q.answer,
    chapter: q.chapter || '',
    type: q.type || ''
  });
}

const PER = 51;
const n = Math.ceil(target.length / PER);
const manifest = [];
for (let i = 0; i < n; i++) {
  const slice = target.slice(i * PER, (i + 1) * PER);
  const file = path.join(OUTDIR, `chunk_xuetang_bio_${i}.json`);
  fs.writeFileSync(file, JSON.stringify(slice, null, 1));
  manifest.push({ chunk: i, count: slice.length, file: path.basename(file) });
}

console.log('总待生成:', target.length, '→', n, '块 (每块≈', PER, ')');
console.log(JSON.stringify(manifest, null, 0));
// 抽样一题确认结构
console.log('样本:', JSON.stringify(target[0], null, 0).slice(0, 400));
