// 极光题库本地全量审计 (2026-08-31)
// 1) 扫本地所有 极光_*.json: 章节数/题数/空章/重复id/字段缺失/题干混入选项
// 2) 拉线上公开学科列表(无需鉴权)对比标称题数, 输出缺口报告
// 输出: jiguang_audit_report.json + 控制台摘要
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.ji-guang.top/api/v1';
const ROOTS = ['大一', '大二', '大三', '大四', '水平测试'];
const OUT = path.join(HERE, 'jiguang_audit_report.json');

function walk(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/^极光_.*\.json$/.test(e.name) && !/\.bak_/.test(e.name)) acc.push(p);   // 跳过修复备份
  }
  return acc;
}

const files = ROOTS.flatMap(r => walk(path.join(HERE, r)));
console.log(`本地题库文件 ${files.length} 个`);

const subjects = [];
const allIssues = [];
for (const f of files) {
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { allIssues.push({ file: f, type: 'JSON_PARSE_FAIL', msg: e.message.slice(0, 80) }); continue; }
  const chapters = Array.isArray(d.chapters) ? d.chapters : [];
  let total = 0;
  const emptyCh = [];
  const seen = new Set();
  let dup = 0, noContent = 0, noOptions = 0, noAnswer = 0, stemLeak = 0;
  const samples = [];

  for (const c of chapters) {
    const qs = Array.isArray(c.questions) ? c.questions : [];
    total += qs.length;
    if (qs.length === 0) emptyCh.push({ id: c.id, name: c.name, nominal: c.count ?? c.total_questions ?? null });
    for (const q of qs) {
      if (q.id) { if (seen.has(q.id)) dup++; else seen.add(q.id); }
      const content = (q.content ?? q.stem ?? '').toString();
      const opts = q.options || {};
      const optKeys = Object.keys(opts).filter(k => String(opts[k] ?? '').trim() !== '');
      if (!content.trim()) noContent++;
      if (optKeys.length === 0) noOptions++;
      const ans = q.correct_answer ?? q.correct ?? q.answer ?? null;   // 字段名以 correct_answer 为准
      if (ans === null || ans === undefined || ans === '') noAnswer++;
      // 题干混入选项: 末尾形如 " E选项内容" 且该字母不在 options
      // 防伪: 字母后紧跟小写字母 = 代码标识符(如 python 题干里的 "Not Equal"), 不算泄漏
      const m = content.match(/\s([A-E])([^\s].*)$/);
      const afterLetter = m ? content[content.indexOf(m[0]) + 2] : '';
      if (m && !optKeys.includes(m[1]) && !/[a-z]/.test(afterLetter || '')) {
        stemLeak++;
        if (samples.length < 3) samples.push({ chapter: c.name, id: q.id, tail: content.slice(-60) });
      }
    }
  }
  const rel = path.relative(HERE, f).replace(/\\/g, '/');
  const rec = {
    file: rel, subject: d.subject || path.basename(f).replace(/^极光_|\.json$/g, ''),
    sid: d.subjectId || null, chapters: chapters.length, total,
    emptyCh, dup, noContent, noOptions, noAnswer, stemLeak, samples
  };
  subjects.push(rec);
  if (dup) allIssues.push({ file: rel, type: 'DUP_ID', n: dup });
  if (noContent) allIssues.push({ file: rel, type: 'NO_CONTENT', n: noContent });
  if (noOptions) allIssues.push({ file: rel, type: 'NO_OPTIONS', n: noOptions });
  if (noAnswer) allIssues.push({ file: rel, type: 'NO_ANSWER', n: noAnswer });
  if (stemLeak) allIssues.push({ file: rel, type: 'STEM_LEAK', n: stemLeak, samples });
}

// 线上学科列表 (需鉴权: /user/subjects/?skip=&limit=)
let online = [];
try {
  let token = '';
  try { token = fs.readFileSync(path.join(HERE, 'jiguang_token.txt'), 'utf8').trim(); } catch (e) {}
  let skip = 0; const limit = 100;
  for (let page = 0; page < 5; page++) {
    const r = await fetch(`${API}/user/subjects/?skip=${skip}&limit=${limit}`, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    const arr = (j && (j.data?.items || j.data?.subjects || (Array.isArray(j.data) ? j.data : []))) || [];
    online.push(...arr.map(s => ({
      id: s.id, name: s.name, total: s.total_questions ?? s.question_count ?? 0,
      vip: !!(s.is_vip_only), access: s.has_access
    })));
    if (arr.length < limit) break;
    skip += limit;
  }
  console.log(`线上学科 ${online.length} 个`);
} catch (e) { console.log('线上学科列表拉取失败:', e.message); }

const byName = new Map(online.map(s => [s.name, s]));
const byId = new Map(online.map(s => [s.id, s]));
const rows = subjects.map(s => {
  // 优先用 subjectId 匹配 (本地名是简写, 如 生理/组胚/python, 与线上全名不一致)
  const o = (s.sid && byId.get(s.sid)) || byName.get(s.subject) ||
    [...byName.values()].find(x => x.name && s.subject && (x.name.includes(s.subject) || s.subject.includes(x.name)) && s.subject.length >= 2);
  return {
    ...s,
    onlineTotal: o ? o.total : null,
    gap: o ? (o.total - s.total) : null,
    vip: o ? o.vip : null,
    access: o ? o.access : null
  };
}).sort((a, b) => (b.gap ?? -1) - (a.gap ?? -1));

const unmatchedLocal = subjects.filter(s => !byName.has(s.subject)).map(s => s.subject);
const uncrawled = online.filter(o => !subjects.some(s => s.subject === o.name));

fs.writeFileSync(OUT, JSON.stringify({ checked_at: new Date().toISOString(), rows, unmatchedLocal, uncrawled, allIssues }, null, 2), 'utf8');

// 控制台摘要
const sum = subjects.reduce((a, s) => a + s.total, 0);
console.log(`\n本地合计: ${subjects.length} 学科 / ${sum} 题`);
console.log(`\n=== 缺口 TOP (线上标称 - 本地, 仅非VIP可补) ===`);
let n = 0;
for (const r of rows) {
  if (r.gap === null || r.gap <= 0) continue;
  if (n++ >= 20) break;
  console.log(`${r.vip ? '🔒VIP' : '✅可爬'}\t${r.subject}\t本地${r.total}\t线上${r.onlineTotal}\t缺${r.gap}\t空章${r.emptyCh.length}`);
}
console.log(`\n=== 数据质量异常 (${allIssues.length} 条) ===`);
const byType = {};
for (const i of allIssues) byType[i.type] = (byType[i.type] || 0) + (i.n || 1);
console.log(byType);
for (const i of allIssues.filter(x => x.type === 'STEM_LEAK').slice(0, 10)) {
  console.log(`  STEM_LEAK ${i.file} x${i.n} e.g. ${i.samples?.[0]?.chapter} :: ${i.samples?.[0]?.tail}`);
}
console.log(`\n=== 空章明细 (本地0题但标称>0) ===`);
for (const r of rows) {
  const bad = r.emptyCh.filter(c => (c.nominal ?? 0) > 0);
  if (bad.length) console.log(`  ${r.subject}: ` + bad.map(c => `${c.name}(标称${c.nominal})`).join(', '));
}
console.log(`\n=== 本地有但线上无 / 线上有但本地无 ===`);
console.log('本地孤立:', unmatchedLocal.join(', ') || '无');
console.log('未爬学科:', uncrawled.map(o => `${o.name}(${o.total}${o.vip ? ',VIP' : ''})`).join(', ') || '无');
console.log(`\n报告已写入 ${OUT}`);
