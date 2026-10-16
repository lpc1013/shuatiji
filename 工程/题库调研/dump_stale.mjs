import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(WS, '工程', '题库调研');
const stale = JSON.parse(fs.readFileSync(path.join(ROOT, '_stale_ids.json'), 'utf8'));
const arr = JSON.parse(fs.readFileSync(path.join(ROOT, 'merged2', 'by_subject', '生物化学.json'), 'utf8'));
const qm = new Map((Array.isArray(arr) ? arr : (arr.questions || arr.items || [])).map(q => [q.id, q]));

const out = [];
for (const { n, id, cur } of stale) {
  const q = qm.get(id);
  if (!q) { out.push(`#${n} MISS ${id}`); continue; }
  let s = `\n========== #${n}  id=${id}  当前答案=${cur} ==========\n`;
  s += `题干: ${q.stem}\n`;
  for (const k of Object.keys(q.options || {})) {
    const mark = k === cur ? '   <== 当前答案' : '';
    s += `   ${k}. ${q.options[k]}${mark}\n`;
  }
  s += `--- explanation ---\n${q.explanation || '(空)'}\n`;
  s += `--- aiExplanation ---\n${q.aiExplanation || '(空)'}\n`;
  s += `--- 其它字段: sourceType=${q.sourceType} chapter=${q.chapter || q.chapterFolder || ''}\n`;
  out.push(s);
}
fs.writeFileSync(path.join(ROOT, '_stale_dump.txt'), out.join('\n'), 'utf8');
console.log(out.join('\n'));
