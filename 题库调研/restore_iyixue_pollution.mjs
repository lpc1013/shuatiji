/* 一键回滚清洗：从原始爬取数据恢复 clean_iyixue_pollution.mjs 改动过的题目
 * - ext-* 题按题干在 iyixue_top 原始分片匹配（38/38 已验证全命中）
 * - 极光题按 id 在 大一~水平测试/极光_*.json 匹配（4/4 已验证）
 * - 恢复 = 用原始 options 重建选项对象 + 重新插入被移除的 3 题
 * 用法：node restore_iyixue_pollution.mjs   （确认要回滚时才跑） */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname); // 题库调研/
const WS = path.resolve(ROOT, '..');            // 工作区根
const PACKS = path.join(ROOT, 'packs');

/* 1. 收集受影响 id（从清洗报告） */
const rep = fs.readFileSync(path.join(ROOT, '清洗报告_options.md'), 'utf8');
const extIds = [...new Set([...rep.matchAll(/ext-[0-9a-f]{16}/g)].map(m => m[0]))];
const jgIds = ['f58e386b-4c79-4558-9461-0cc58b19ee90', '201857df-b684-47ed-b055-497b3223764e', 'b3a59da4-9a9a-48ca-a14c-2cc9b0ac991f', '68424b8a-d422-4d05-8620-f0050cf7a4d6'];
const DROP_IDS = ['ext-2a4d7522e06a0dd2', 'ext-87d3dde7852018ac', 'ext-9fd8ce027d7cfa7b'];

/* 2. packs 里定位受影响题：id -> {file, stem} */
const loc = new Map();
for (const sem of fs.readdirSync(PACKS)) {
  const semP = path.join(PACKS, sem);
  if (!fs.statSync(semP).isDirectory()) continue;
  for (const grp of fs.readdirSync(semP)) {
    const gp = path.join(semP, grp);
    if (!fs.statSync(gp).isDirectory()) continue;
    for (const f of fs.readdirSync(gp)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(gp, f);
      const a = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!Array.isArray(a)) continue;
      for (const q of a) if (extIds.includes(q.id) || jgIds.includes(q.id)) loc.set(q.id, { fp, stem: String(q.stem) });
    }
  }
}
console.log('packs 中现存受影响题:', loc.size, '/', extIds.length + jgIds.length);

/* 3. 载入原始记录，按题干(完整)匹配 */
const rawArr = [];
(function w(d, dep) { if (dep > 3) return; let es; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) { const p = path.join(d, e.name);
    if (e.isDirectory()) w(p, dep + 1);
    else if (/\.json$/.test(e.name)) { try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); if (Array.isArray(a)) rawArr.push(...a); } catch {} } }
})(path.join(WS, 'iyixue_top'), 0);
const rawByStem = new Map();
for (const q of rawArr) { const s = String(q.question || ''); if (s && !rawByStem.has(s)) rawByStem.set(s, q); }

/* 极光原始 */
const jgRaw = new Map();
for (const sem of ['大一', '大二', '大三', '大四', '水平测试']) {
  const p = path.join(WS, sem);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    if (!/^极光_.*\.json$/.test(f)) continue;
    try { for (const q of JSON.parse(fs.readFileSync(path.join(p, f), 'utf8'))) if (q.id) jgRaw.set(q.id, q); } catch {}
  }
}

/* 4. 执行恢复 */
const convOpts = arr => { const o = {}; for (const s of arr) { const m = String(s).match(/^([A-Ha-h])[\.、]\s*(.*)$/); if (m) o[m[1].toUpperCase()] = m[2].trim(); } return o; };
let restored = 0, failed = [];
for (const [id, { fp, stem }] of loc) {
  const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const q = arr.find(x => x.id === id);
  if (!q) { failed.push(id); continue; }
  const src = id.startsWith('ext-') ? rawByStem.get(stem) : jgRaw.get(id);
  if (!src) { failed.push(id); continue; }
  q.options = convOpts(src.options);
  fs.writeFileSync(fp, JSON.stringify(arr), 'utf8');
  restored++;
}
/* 5. 重新插回被移除的 3 题 */
for (const id of DROP_IDS) {
  const src = rawByStem.get([...loc.entries()].find(([k, v]) => k === id)?.[1]?.stem || '');
  // 上一步若题已被移除，loc 里没有 → 从报告找题干
  let stem = null;
  if (!src) { /* 报告里存了题干前40字 */ const m = rep.split('\n').find(l => l.includes(id)); if (m) stem = m.split(/\s+/).slice(2).join(' '); }
  const hit = stem ? rawByStem.get(stem) : src;
  if (!hit) { failed.push(id + '(被移除题)'); continue; }
  const fp = path.join(PACKS, '大二', '扩展', '生物化学.json');
  const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (!arr.some(x => x.id === id)) {
    arr.push({ id, type: 'A1', chapter: hit.system || '未分类', stem: hit.question, options: convOpts(hit.options), answer: hit.answer, source: '未知来源', qs: hit.questionSource || '待整理来源', sys: hit.system || '未分类' });
    fs.writeFileSync(fp, JSON.stringify(arr), 'utf8');
    restored++;
  }
}
console.log('恢复:', restored, '| 失败:', failed.length ? failed.join(',') : '无 ✅');
