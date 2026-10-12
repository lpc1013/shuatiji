// 应用裁决：verdicts_20261009.jsonl → merged2 + packs
// key_ok  ：答案键对，重写解析（merged2 explanation + packs explain b 块，删 bf）
// key_wrong：答案键错（已由人工核实确凿），改 packs/merged2 答案键，解析保留（其结论与新 key 一致）
// exp_ok / unsure：不动
// 用法：node apply_verdicts.mjs [--dry|--apply]
import fs from 'fs';
import path from 'path';

const APPLY = process.argv.includes('--apply');
const M2DIR = '工程/题库调研/merged2/by_subject';
const PACKS = '工程/题库调研/packs';
const N = (...a) => console.log('[apply]', ...a);

const work = JSON.parse(fs.readFileSync('工程/题库调研/audit_worklist_20261009.json', 'utf8'));
const workV2 = JSON.parse(fs.readFileSync('工程/题库调研/audit_worklist_v2.json', 'utf8'));
const verdicts = fs.readFileSync('工程/题库调研/verdicts_20261009.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);
N('工作清单', work.length, '| 裁决', verdicts.length);

const m2Cache = new Map(), peCache = new Map(), qCache = new Map();
const stats = { key_ok: 0, key_wrong: 0, exp_ok: 0, unsure: 0, miss: 0 };
const keyWrongList = [];
const touched = { m2: new Set(), pe: new Set(), q: new Set() };

for (const v of verdicts) {
  const norm = s => String(s||'').replace(/^(jiguang|iyixue|school|kaoyan):/,'');
  const nid = norm(v.id);
  const item = workV2.find(x => norm(x.id) === nid) || work.find(x => norm(x.id) === nid) || work.find(x => x.i === v.i && norm(x.id) === nid);
  if (!item || !item.id || norm(item.id) !== nid) { stats.miss++; continue; }
  if (v.verdict === 'exp_ok' || v.verdict === 'unsure') { stats[v.verdict]++; continue; }

  // 1) merged2（极光 id 加 jiguang: 前缀，扩展题 id 原样/带前缀，逐一探测）
  const m2File = path.join(M2DIR, item.subject + '.json');
  if (fs.existsSync(m2File)) {
    if (!touchedM2(m2File)) { stats.miss++; continue; }
    const m2 = m2Cache.get(m2File);
    const cands = ['jiguang:' + item.id, item.id, 'iyixue:' + item.id, 'school:' + item.id, 'kaoyan:' + item.id];
    const rec = m2.find(q => cands.includes(q.id));
    if (rec) {
      if (v.verdict === 'key_ok') rec.explanation = v.newExp;
      if (v.verdict === 'key_wrong' && v.correct) { rec.answer = v.correct; rec.answerResolved = v.correct; }
    }
  }

  // 2) packs 题库记录（key_wrong 改答案键）
  const qFile = path.join(PACKS, item.src);
  if (v.verdict === 'key_wrong') {
    if (!touchedQ(qFile)) { stats.miss++; continue; }
    const qs = qCache.get(qFile);
    const q = qs.find(x => x.id === item.id);
    if (q) {
      keyWrongList.push({ id: q.id, subject: item.subject, stem: q.stem, oldKey: q.answer, newKey: v.correct, reason: v.newExp });
      q.answer = v.correct;
    }
  }

  // 3) packs explain（key_ok 重写 b 块并删 bf）
  const peFile = path.join(PACKS, item.term, 'explain', item.subject + '.json');
  if (!fs.existsSync(peFile)) { continue; }
  if (!touchedPE(peFile)) { stats.miss++; continue; }
  const pe = peCache.get(peFile);
  if (pe[item.id]) {
    if (v.verdict === 'key_ok') pe[item.id] = { b: [['p', 'an', '考点解析', v.newExp]] };
  }
  stats[v.verdict]++;
}
function touchedM2(f) { if (!m2Cache.has(f)) { try { m2Cache.set(f, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { return false; } touched.m2.add(f); } return true; }
function touchedPE(f) { if (!peCache.has(f)) { try { peCache.set(f, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { return false; } touched.pe.add(f); } return true; }
function touchedQ(f) { if (!qCache.has(f)) { try { qCache.set(f, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { return false; } touched.q.add(f); } return true; }

N('统计:', JSON.stringify(stats), '| key_wrong 明细:', keyWrongList.length);
N('涉及文件: m2', touched.m2.size, '| pe', touched.pe.size, '| q', touched.q.size);

if (!APPLY) { N('（dry-run，未写盘）'); process.exit(0); }

const BK = '工程/题库调研/fixes/backup_20261009_verdicts';
fs.mkdirSync(BK, { recursive: true });
for (const [tag, cache] of [['m2', m2Cache], ['pe', peCache], ['q', qCache]]) {
  for (const f of cache.keys()) {
    const dst = BK + '/' + tag + '_' + path.basename(f, '.json') + '.bak.json';
    if (!fs.existsSync(dst)) fs.copyFileSync(f, dst);
  }
}
for (const f of touched.m2) fs.writeFileSync(f, JSON.stringify(m2Cache.get(f), null, 1));
for (const f of touched.pe) fs.writeFileSync(f, JSON.stringify(peCache.get(f)));
for (const f of touched.q) fs.writeFileSync(f, JSON.stringify(qCache.get(f), null, 1));
if (keyWrongList.length) fs.writeFileSync('工程/题库调研/key_wrong_fixed_20261009.json', JSON.stringify(keyWrongList, null, 1));
N('✅ 已写盘 | key_wrong 修复清单 → key_wrong_fixed_20261009.json');
