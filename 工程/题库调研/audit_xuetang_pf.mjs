import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(WS, '工程', '题库调研');
const MERGED = path.join(ROOT, 'merged2', 'by_subject', '生物化学.json');
const JG = path.join(ROOT, 'packs', '大二', '极光', '生物化学.json');
const EXT = path.join(ROOT, 'packs', '大二', '扩展', '生物化学.json');
const EXPL = path.join(ROOT, 'packs', '大二', 'explain', '生物化学.json');

const merged = JSON.parse(fs.readFileSync(MERGED, 'utf8'));
// merged2/by_subject items 可能是 {id, stem, options, answer, explanation, sourceType, chapter, ...}
const arr = Array.isArray(merged) ? merged : (merged.questions || merged.items || Object.values(merged).find(v => Array.isArray(v)) || []);
const jg = JSON.parse(fs.readFileSync(JG, 'utf8'));
const ext = JSON.parse(fs.readFileSync(EXT, 'utf8'));
const explain = JSON.parse(fs.readFileSync(EXPL, 'utf8'));

const jgIds = new Set((Array.isArray(jg) ? jg : (jg.questions||[])).map(q => q.id));
const extIds = new Set((Array.isArray(ext) ? ext : (ext.questions||[])).map(q => q.id));
const explIds = new Set(Object.keys(explain));

let xuetangAll = 0, xuetangNoExpl = 0, reachable = 0, alreadyPf = 0, noExplReachable = 0, noExplUnreachable = [];
const chapters = {};
const sample = [];

for (const q of arr) {
  if (q.sourceType !== 'xuetang') continue;
  xuetangAll++;
  const hasExpl = q.explanation && (typeof q.explanation === 'string' ? q.explanation.trim() : q.explanation && q.explanation.b);
  if (!hasExpl) xuetangNoExpl++;
  const inPacks = jgIds.has(q.id) || extIds.has(q.id);
  const hasPf = explIds.has(q.id) && Array.isArray(explain[q.id]?.b) && explain[q.id].b.some(b => b[1] === 'pf');
  if (inPacks) reachable++;
  if (hasPf) alreadyPf++;
  const ch = q.chapter || '(无章)';
  chapters[ch] = (chapters[ch] || 0) + 1;
  if (!hasExpl) {
    if (!inPacks) noExplUnreachable.push(q.id);
    else {
      noExplReachable++;
      if (sample.length < 5) sample.push({ id: q.id, chapter: ch, stem: String(q.stem||'').slice(0, 50), answer: q.answer });
    }
  }
}

console.log('=== 学习通·生化 pf 审计 ===');
console.log('学习通总题数:', xuetangAll);
console.log('其中无解析(explanation空):', xuetangNoExpl);
console.log('在 packs(极光/扩展)可命中数:', reachable, '(占学习通比)');
console.log('已带 pf 块数:', alreadyPf);
console.log('无解析 且 在packs可命中(=本次待生成):', noExplReachable);
console.log('无解析 但 不在packs(不可达, 需排查):', noExplUnreachable.length, noExplUnreachable.slice(0,20));
console.log('--- 章节分布(学习通全部) ---');
console.log(JSON.stringify(chapters, null, 0));
console.log('--- 样本(待生成前5) ---');
console.log(JSON.stringify(sample, null, 1));
