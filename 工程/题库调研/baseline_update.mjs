#!/usr/bin/env node
// 重锚 baseline_ids_20261013.json：把本次 ingest 的 68 新 id + 24 改后答案写入，
// 使 verify_schema_unified 的 mIdChanged=0 且 mAnsChanged=0。
import fs from 'fs';
import path from 'path';
const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const BIO = path.join(WS, '工程/题库调研/merged2/by_subject/生物化学.json');
const BASE = path.join(WS, '工程/题库调研/verify/baseline_ids_20261013.json');
const REP = path.join(WS, '工程/题库调研/ingest_xuetang_bio.report.json');

const bio = JSON.parse(fs.readFileSync(BIO, 'utf8'));
const bioAns = new Map(bio.map(q => [q.id, q.answerResolved ?? q.answer ?? '']));
const rep = JSON.parse(fs.readFileSync(REP, 'utf8'));
const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));

const idx = new Map(base.pairs.map((p, i) => [p[0], i]));
let added = 0, updated = 0;

for (const id of rep.newIdsList) {
  if (!idx.has(id)) { base.pairs.push([id, bioAns.get(id) || '']); added++; }
}
for (const c of rep.correctionsDetail) {
  if (idx.has(c.id)) { base.pairs[idx.get(c.id)][1] = c.new; updated++; }
  else { base.pairs.push([c.id, c.new]); added++; }
}

const ids = new Set(base.pairs.map(p => p[0]));
base.count = ids.size;
base.generatedAt = new Date().toISOString();
base.note = (base.note || '') + ` | 2026-10-15 学习通·生化按章重提：+${rep.newIdsList.length} 新 id + ${rep.correctionsDetail.length} 处答案校正（采纳学习通正确答案）`;

fs.writeFileSync(BASE, JSON.stringify(base, null, 2), 'utf8');
console.log('baseline 更新完成：新增 pair', added, '| 更新 pair', updated, '| 总唯一 id', base.count);
console.log('原 count 字段保留值（已覆盖）:', ids.size);
