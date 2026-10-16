import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = path.resolve(R, '..', '..');

const IDS = ['ykb_201011_12007_374412','school_bio_4f93a36121803f84','ykb_201011_12011_374439','school_bio_bd4df029f4ae1900','f1ac6fd0-6fc2-424e-afd3-6b78e8599cfb','school_bio_73a294dbf7fb0567','42c13ddd-e570-4ae0-b54f-639c6b5a8e8b'];
const ALIASES = ['ext-fda67b53af8510aa','ext-3ac81cfa73ec52fc'];

// 1) where do these ids live in packs?
const hits = {};
(function walk(p) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    if (e.isDirectory()) walk(fp);
    else if (e.name.endsWith('.json')) {
      const txt = fs.readFileSync(fp, 'utf8');
      for (const id of IDS) if (txt.includes('"' + id + '"')) (hits[id] = hits[id] || []).push(path.relative(R, fp).replaceAll('\\', '/'));
    }
  }
})(path.join(R, 'packs'));
console.log('--- packs 出现位置 ---');
for (const id of IDS) console.log(id, '->', hits[id] || '(不在 packs)');

// 2) user snapshot (NDJSON): which of these ids / aliases are actually referenced?
const snap = fs.readdirSync(WS).find(f => /^database_export.*\.json$/i.test(f));
const nd = fs.readFileSync(path.join(WS, snap), 'utf8').split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
console.log('\n--- snapshot 行数 ---', nd.length, '| username 样例:', nd.slice(0, 3).map(r => r.username || r._id).join(', '));
const refCount = {};
const refUsers = {};
for (const rec of nd) {
  const txt = JSON.stringify(rec);
  for (const id of [...IDS, ...ALIASES]) if (txt.includes(id)) { refCount[id] = (refCount[id] || 0) + 1; (refUsers[id] = refUsers[id] || new Set()).add(rec.username); }
}
console.log('--- 用户数据引用计数 ---');
for (const id of [...IDS, ...ALIASES]) console.log(id, '->', refCount[id] || 0, refUsers[id] ? [...refUsers[id]].slice(0, 5).join(',') : '');

// 3) 对比冲突双方的题目内容（packs 扩展/极光 生物化学.json）
function loadPack(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(j) ? j : (j.questions || []);
  const m = new Map();
  for (const q of arr) m.set(q.id, q);
  return m;
}
const ext = loadPack(path.join(R, 'packs', '大二', '扩展', '生物化学.json'));
const jg = loadPack(path.join(R, 'packs', '大二', '极光', '生物化学.json'));
const pairs = [
  ['ext-fda67b53af8510aa', ext.get('ykb_201011_12007_374412'), ext.get('school_bio_4f93a36121803f84')],
  ['ext-3ac81cfa73ec52fc', ext.get('ykb_201011_12011_374439'), ext.get('school_bio_bd4df029f4ae1900')],
  ['42c13ddd-e570-4ae0-b54f-639c6b5a8e8b', jg.get('f1ac6fd0-6fc2-424e-afd3-6b78e8599cfb'), ext.get('school_bio_73a294dbf7fb0567')],
];
for (const [alias, a, b] of pairs) {
  console.log('\n=== alias', alias, '===');
  for (const [tag, q] of [['a', a], ['b', b]]) {
    if (!q) { console.log(tag, ': 不在 pack'); continue; }
    console.log(tag, '| id:', q.id, '| 章节:', q.c, '| 题型:', q.t || '?');
    console.log('   题干:', String(q.q || q.stem || '').slice(0, 60).replaceAll('\n', ' '));
    console.log('   答案:', JSON.stringify(q.a !== undefined ? q.a : q.answer).slice(0, 40));
    console.log('   aliasIds:', JSON.stringify(q.flags && q.flags.aliasIds || null));
  }
}
