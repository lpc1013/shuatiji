#!/usr/bin/env node
// -*- coding: utf-8 -*-
// 依据 2026-10-15 审核裁决，回退/确认 3 处有争议的答案校正。
// 裁决： #10 保留 D(5种)   #12 回退 C(抗原与抗体)   #24 回退 A(同工酶)
// 写入方式与 ingest_xuetang_bio.mjs 一致：同时改 answer / answerResolved，写前备份。
import fs from 'fs';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const BIO = WS + '/工程/题库调研/merged2/by_subject/生物化学.json';

// n: 清单序号  id: 库中题目 id  to: 最终答案  act: revert=回退 / keep=保留
const DECISIONS = [
  { n: 10, id: 'jiguang:5a43caf1-5daf-4514-8bf0-34ba1cde7a89', to: 'D', act: 'keep',
    why: '核酸碱基主要 A/G/C/T/U 共 5 种，教材主流表述' },
  { n: 12, id: 'jiguang:0bd3effb-5386-4602-8696-716918981970', to: 'C', act: 'revert',
    why: '分子杂交=核酸单链碱基互补配对；抗原-抗体为蛋白质间作用，不属于分子杂交范畴' },
  { n: 24, id: 'jiguang:5a7acf98-8490-49d4-b8c5-7b4287fd92b9', to: 'A', act: 'revert',
    why: '同工酶=催化相同化学反应而分子结构/理化性质不同，教材直接表述；D「是指」略绝对' },
];

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

const raw = fs.readFileSync(BIO, 'utf8');
const bio = JSON.parse(raw);
const map = new Map(bio.map(q => [q.id, q]));

const results = [];
let changedCount = 0;
for (const d of DECISIONS) {
  const q = map.get(d.id);
  if (!q) { results.push({ ...d, ok: false, err: 'id 未命中' }); continue; }
  const before = q.answer;
  if (before !== d.to) {
    q.answer = d.to;
    q.answerResolved = d.to;
    changedCount++;
  }
  results.push({
    n: d.n, id: d.id, act: d.act, stem: q.stem,
    before, after: q.answer, changed: before !== d.to, ok: true, why: d.why,
  });
}

const bak = BIO + '.bak_revert_' + ts();
fs.copyFileSync(BIO, bak);
fs.writeFileSync(BIO, JSON.stringify(bio, null, 2), 'utf8');

console.log('=== 裁决落库结果 ===');
console.log(JSON.stringify({ changed: changedCount, backup: bak, results }, null, 2));
