import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(WS, '工程', '题库调研');
const rep = JSON.parse(fs.readFileSync(path.join(ROOT, 'ingest_xuetang_bio.report.json'), 'utf8'));
const arr = JSON.parse(fs.readFileSync(path.join(ROOT, 'merged2', 'by_subject', '生物化学.json'), 'utf8'));
const qm = new Map((Array.isArray(arr) ? arr : (arr.questions || arr.items || [])).map(q => [q.id, q]));

const PATTERNS = [
  /正确答案\s*(?:是|为|：|:)?\s*([A-E])/,
  /正确答案为\s*([A-E])/,
  /正确答案是\s*([A-E])/,
  /故选\s*\*{0,2}([A-E])/,
  /答案应为\s*([A-E])/,
  /本题选\s*([A-E])/,
];
function claim(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, '');
  for (const p of PATTERNS) { const m = t.match(p); if (m) return m[1]; }
  return null;
}

const rows = [];
for (let i = 0; i < rep.correctionsDetail.length; i++) {
  const d = rep.correctionsDetail[i];
  const q = qm.get(d.id);
  if (!q) { rows.push({ n: i + 1, id: d.id, miss: true }); continue; }
  const cur = q.answer;
  const c1 = claim(q.explanation);
  const c2 = claim(q.aiExplanation);
  const claims = [c1, c2].filter(Boolean);
  const stale = claims.length > 0 && !claims.includes(cur);
  rows.push({
    n: i + 1, id: d.id, cur, old: d.old, new: d.new,
    claim_expl: c1, claim_ai: c2, stale,
    hasExpl: !!(q.explanation || q.aiExplanation),
  });
}

console.log('%-4s %-7s %-7s %-9s %-9s %s'.replace(/%/g, ''), '#', '当前', '旧', '解析主张', 'AI主张', '状态');
for (const r of rows) {
  const flag = r.miss ? 'MISS' : r.stale ? 'STALE冲突' : (r.claim_expl || r.claim_ai ? '一致' : '无解析可检');
  console.log(
    String(r.n).padEnd(4),
    String(r.cur).padEnd(7),
    String(r.old).padEnd(7),
    String(r.claim_expl || '-').padEnd(9),
    String(r.claim_ai || '-').padEnd(9),
    flag
  );
}
const nstale = rows.filter(r => r.stale).length;
console.log('--- 解析与当前答案冲突(STALE):', nstale, '/', rows.length);
console.log('--- 无解析可检:', rows.filter(r => !r.miss && !r.stale && !(r.claim_expl || r.claim_ai)).length);
// 输出需重生成的 id 列表
const staleIds = rows.filter(r => r.stale).map(r => ({ n: r.n, id: r.id, cur: r.cur }));
fs.writeFileSync(path.join(ROOT, '_stale_ids.json'), JSON.stringify(staleIds, null, 1));
console.log('已导出 _stale_ids.json:', staleIds.length, '条');
