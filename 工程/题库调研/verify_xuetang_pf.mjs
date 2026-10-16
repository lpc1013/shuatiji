import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(WS, '工程', '题库调研');
const DIR = path.join(ROOT, 'pf_gen', 'xuetang');

// 期望集合：来自 12 个 chunk 文件
const expected = new Map(); // qid -> {options, answer, chapter}
for (let i = 0; i < 12; i++) {
  const c = JSON.parse(fs.readFileSync(path.join(DIR, `chunk_xuetang_bio_${i}.json`), 'utf8'));
  for (const q of c) expected.set(q.id, q);
}

// 实际集合：来自 12 个 out 文件（磁盘实读）
const actual = new Map(); // qid -> {file, md}
let fileCount = 0, entryCount = 0;
for (let i = 0; i < 12; i++) {
  const f = path.join(DIR, `out_xuetang_bio_${i}.json`);
  if (!fs.existsSync(f)) { console.log('⛔ 缺失 out 文件:', path.basename(f)); continue; }
  fileCount++;
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [qid, md] of Object.entries(o)) { actual.set(qid, { file: `out_xuetang_bio_${i}.json`, md }); entryCount++; }
}

console.log('期望题数(去重):', expected.size, '| out 文件数:', fileCount, '| 实际条目数:', entryCount);

// 缺失 & 多余
const missing = [...expected.keys()].filter(k => !actual.has(k));
const extra = [...actual.keys()].filter(k => !expected.has(k));
console.log('缺失(在chunk但无out):', missing.length, missing.slice(0, 10));
console.log('多余(在out但不在chunk):', extra.length, extra.slice(0, 10));

// 逐条校验格式 —— 复用 write_pf.mjs 的 normalizeTable + validate，得到真实 reject
const isTableRow = l => /^\s*\|.+\|\s*$/.test(l);
const isTableSep = l => /^\s*\|[\s:|-]+\|\s*$/.test(l) && l.includes('-');
function normalizeTable(md) {
  let lines = String(md).split('\n').map(x => x.trim()).filter(Boolean);
  lines = lines.filter(l => l.startsWith('|'));
  lines = lines.map(l => (l.endsWith('|') ? l : l + ' |'));
  if (lines.length && lines[0].startsWith('|') && !isTableSep(lines[1] || '')) {
    const cols = Math.max(2, lines[0].split('|').length - 2);
    lines.splice(1, 0, '|' + Array(cols).fill(' --- ').join('|') + '|');
  }
  return lines.join('\n');
}
function validate(md, q) {
  const lines = md.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length < 4) return '行数不足(<4)';
  if (!isTableRow(lines[0])) return '首行非表头';
  if (!isTableSep(lines[1])) return '第二行非分隔行';
  const rows = lines.slice(2);
  if (!rows.every(isTableRow)) return '存在非表格行';
  const letters = Object.keys(q.options || {});
  const firstCells = rows.map(r => r.split('|')[1]?.trim() || '');
  const missing = letters.filter(L => !firstCells.some(c => new RegExp('^\\*{0,2}' + L + '[.、．\\s]').test(c)));
  if (missing.length) return '缺选项行: ' + missing.join(',');
  const ansRow = rows.find(r => new RegExp('^\\*{0,2}' + q.answer + '[.、．\\s]').test(r.split('|')[1]?.trim() || ''));
  if (ansRow && /(错误|不正确|不符|并非|不是)/.test(ansRow)) return 'WARN_ANSWER_ROW_NEGATIVE';
  return null;
}
let bad = 0, warnNeg = 0, warnCell = 0;
const problems = [];
for (const [qid, { file, md }] of actual) {
  const q = expected.get(qid);
  if (!q) continue;
  const md2 = normalizeTable(md);
  const v = validate(md2, q);
  if (v && v.startsWith('WARN')) { warnNeg++; problems.push({ qid, file, reason: v }); continue; }
  if (v) { problems.push({ qid, file, reason: v }); bad++; continue; }
  // 列数一致性（warn）
  const rows = md2.split('\n').slice(2);
  const colBad = rows.filter(r => r.split('|').length !== 5);
  if (colBad.length) { warnCell++; problems.push({ qid, file, reason: `行内竖线数异常(${colBad.length}行)` }); }
}
console.log('格式错误(reject级):', bad, '| 正确项负向词warn:', warnNeg, '| 竖线异常warn:', warnCell);
if (problems.length) console.log('前20条问题:', JSON.stringify(problems.slice(0, 20), null, 0));
console.log(bad === 0 ? '✅ 全部条目格式通过 write_pf 级校验' : '⛔ 存在需修复条目');
