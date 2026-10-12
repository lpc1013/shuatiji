// 全库审计：explain 解析结论 vs 答案键 一致性
// 背景：免疫 MALT 题（9b210c33）发现 iyixue 错挂解析——解析结论与答案键矛盾。
// 方法：对 packs/<学期>/explain/<学科>.json 每条解析抽取"结论字母"（多模式正则，优先末段结论句），
//      与题库记录（packs/<学期>/<组>/<学科>.json 的 a 字段）归一化比对（字母序，多选兼容）。
// 输出：工程/题库调研/audit_explain_vs_key_20261009.json + 控制台摘要。只读，不改任何文件。
import fs from 'fs';
import path from 'path';

const ROOT = '工程/题库调研/packs';
const OUT = '工程/题库调研/audit_explain_vs_key_20261009.json';

// ---------- 1. 建立 id -> {a, stem, subject, chapter} 索引 ----------
const keyMap = new Map();
let qFiles = 0;
for (const term of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!term.isDirectory()) continue;
  const termDir = path.join(ROOT, term.name);
  for (const grp of fs.readdirSync(termDir, { withFileTypes: true })) {
    if (!grp.isDirectory() || grp.name === 'explain') continue;
    const grpDir = path.join(termDir, grp.name);
    for (const f of fs.readdirSync(grpDir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(grpDir, f);
      let o;
      try { o = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { continue; }
      const list = Array.isArray(o) ? o : (o.qs || o.questions || []);
      if (!Array.isArray(list) || !list.length) continue;
      qFiles++;
      for (const q of list) {
        if (!q || !q.id) continue;
        const ans = String(q.answer || q.a || '').toUpperCase().replace(/[^A-Z]/g, '');
        if (!ans) continue;
        if (!keyMap.has(q.id)) keyMap.set(q.id, {
          a: ans,
          stem: (q.stem || q.content || q.q || '').slice(0, 60),
          subject: f.replace(/\.json$/, ''),
          src: term.name + '/' + grp.name + '/' + f,
        });
      }
    }
  }
}
console.log('[audit] 题库索引:', keyMap.size, '条（来自', qFiles, '个文件）');

// ---------- 2. 结论抽取 ----------
const norm = s => String(s).toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
// 按优先级排列的模式；[pattern, groupIdx]
const PATTERNS = [
  [/[（(]\s*([A-E]{1,5})\s*错[^）)]{0,8}为本题正确答案/, 1],  // iyixue："（BC错，为本题正确答案）"（支持多字母）
  [/(?<![A-Za-z0-9])([A-E]{1,5})\s*[（(][^）)]{0,8}为本题正确答案/, 1], // "赫氏小体（B错，为本题正确答案）"
  [/本题答案[为是]\s*\*{0,2}([A-E]{1,5})\*{0,2}/, 1],
  [/本题(?:的)?正确答案[为是]?\s*\*{0,2}([A-E]{1,5})\*{0,2}/, 1],
  [/正确答案[为是]?\s*[：:为是]?\s*\*{0,2}([A-E]{1,5})\*{0,2}/, 1],
  [/答案[为是]?\s*[：:]?\s*\*{0,2}([A-E]{1,5})\*{0,2}/, 1],
  [/故选\s*\*{0,2}([A-E]{1,5})\*{0,2}/, 1],
  [/应选\s*\*{0,2}([A-E]{1,5})\*{0,2}/, 1],
  [/因此选\s*([A-E]{1,5})/, 1],
  [/答案[：:]\s*([A-E]{1,5})\b/, 1],
];
// 反向题干："X对"启发式不可靠（解析里唯一的"对"可能是正确陈述项而非答案），跳过不判
const NEGATIVE = /错误|不正确|不是|不属于|除外|无关|不能|不宜|难以|不符|错误的是|不怀/;
// iyixue 风格："（C对）"/"C对，" —— 收集全部"X对"，唯一才采信
const DUI = /([A-E])\s*对/g;

function extractConclusion(text, stem) {
  if (!text) return { letter: null, how: null };
  for (const [re, gi] of PATTERNS) {
    // 取最后一次命中（结论句通常在末尾）
    let m, last = null;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(text))) last = m;
    if (last) {
      const letter = norm(last[gi]);
      if (letter) return { letter, how: last[0].slice(0, 24) };
    }
  }
  // iyixue "X对" 收集（反向题干不可靠，跳过）
  if (NEGATIVE.test(stem || '')) return { letter: null, how: '反向题跳过X对' };
  const dui = new Set();
  let m2;
  const r2 = new RegExp(DUI.source, 'g');
  while ((m2 = r2.exec(text))) dui.add(m2[1]);
  if (dui.size === 1) return { letter: [...dui][0], how: 'X对' };
  return { letter: null, how: dui.size > 1 ? 'X对多义(' + [...dui].join('') + ')' : null };
}

// ---------- 3. 逐条比对 ----------
const rows = [];
let stat = { total: 0, noKey: 0, noConclusion: 0, ambiguous: 0, match: 0, mismatch: 0 };
for (const term of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!term.isDirectory()) continue;
  const expDir = path.join(ROOT, term.name, 'explain');
  if (!fs.existsSync(expDir)) continue;
  for (const f of fs.readdirSync(expDir)) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(expDir, f);
    let o;
    try { o = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { continue; }
    const subject = f.replace(/\.json$/, '');
    for (const [id, rec] of Object.entries(o)) {
      stat.total++;
      const key = keyMap.get(id) || keyMap.get(id.replace(/^[a-z]+:/, ''));
      const text = (rec.b || []).map(x => x[3] || '').join('\n') + '\n' + (rec.bf || '');
      if (!key) { stat.noKey++; continue; }
      const { letter, how } = extractConclusion(text, key.stem);
      if (!letter) { stat.noConclusion++; if (how) stat.ambiguous++; continue; }
      if (norm(letter) === norm(key.a)) { stat.match++; continue; }
      stat.mismatch++;
      rows.push({
        id, subject, term: term.name,
        key: key.a, conclusion: letter, how,
        stem: key.stem, src: key.src,
        expHead: text.replace(/\s+/g, ' ').slice(0, 100),
      });
    }
  }
}

// ---------- 4. 输出 ----------
const report = { generatedAt: new Date().toISOString(), stat, mismatches: rows };
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log('[audit] 统计:', JSON.stringify(stat));
console.log('[audit] 报告 →', OUT);
console.log('\n===== 不一致清单（按学科分组，前 40 条） =====');
const bySub = {};
for (const r of rows) (bySub[r.subject] = bySub[r.subject] || []).push(r);
for (const [sub, list] of Object.entries(bySub).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n【${sub}】${list.length} 条`);
  for (const r of list.slice(0, 40)) {
    console.log(`  ${r.id.slice(0, 20)}… key=${r.key} 解析=${r.conclusion} (${r.how}) | ${r.stem.slice(0, 30)}`);
  }
  if (list.length > 40) console.log(`  … 其余 ${list.length - 40} 条见报告文件`);
}
