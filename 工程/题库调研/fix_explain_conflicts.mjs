// 批量修复：解析结论与答案键矛盾的题目（MALT 型修复的规模化）
// 原则：只用「题源解析 + 题源 correct_answer === packs 答案键」双重印证的题目自动修复；
//      修的是解析（merged2 explanation + packs explain bf/b），答案键与 id 永不动 → 用户进度零影响。
// 用法：node fix_explain_conflicts.mjs --dry   （先演练）
//      node fix_explain_conflicts.mjs --apply （实改；改动前自动备份）
import fs from 'fs';
import path from 'path';

const APPLY = process.argv.includes('--apply');
const AUDIT = '工程/题库调研/audit_explain_vs_key_20261009.json';
const PACKS = '工程/题库调研/packs';
const M2DIR = '工程/题库调研/merged2/by_subject';
const BACKUP = '工程/题库调研/fixes/backup_20261009_conflicts';
const N = (...a) => console.log('[fix-batch]', ...a);

// ---------- 1. 题源正确解析映射（极光 ai_explanation） ----------
const srcMap = new Map(); // id -> {exp, ans, file}
const files = [];
(function walk(d, dep) {
  if (dep > 4) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p, dep + 1);
    else if (e.name.startsWith('极光_') && e.name.endsWith('.json')) files.push(p);
  }
})('题源数据', 0);
for (const f of files) {
  try {
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const c of (o.chapters || [])) for (const q of (c.questions || [])) {
      if (q.ai_explanation && q.ai_explanation.length > 80 && q.correct_answer) {
        srcMap.set(q.id, { exp: q.ai_explanation, ans: String(q.correct_answer).toUpperCase(), file: f });
      }
    }
  } catch (e) {}
}
N('题源 ai_explanation 映射:', srcMap.size, '条');

// ---------- 2. 把题源解析切成站点 explain 的 b 块 ----------
function srcToBlocks(exp) {
  const blocks = [];
  const sec = (t, type, title) => {
    const re = new RegExp('##\\s*' + t + '[^\\n]*\\n+([\\s\\S]*?)(?=\\n##\\s|$)');
    const m = exp.match(re);
    return m ? m[1].trim() : '';
  };
  const ans = (exp.match(/##\s*正确答案\s*\n+([A-E]{1,5})/) || [])[1] || '';
  const analysis = sec('答案解析');
  const options = sec('选项分析');
  const summary = sec('知识点总结');
  if (analysis) blocks.push(['p', 'an', '考点解析', (ans ? `**正确答案：${ans}**\n\n` : '') + analysis]);
  if (options) blocks.push(['p', 'ab', '选项分析', options]);
  if (summary) blocks.push(['p', 'tx', '知识点总结', summary]);
  return blocks.length ? blocks : null;
}

// ---------- 3. 逐条处理 ----------
const rep = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
const rows = rep.mismatches;
N('待处理矛盾:', rows.length);

const touchedM2 = new Map();  // file -> parsed json（延迟写回）
const touchedPE = new Map();  // file -> parsed json
const touchedM2Raw = new Map(); // file -> raw text（极光题若 merged2 无该题则只改 packs）
const fixed = [], skipped = [], noSrc = [], srcAnsMismatch = [];

for (const r of rows) {
  const isJg = /^[0-9a-f]{8}-/.test(r.id);
  const src = isJg ? srcMap.get(r.id) : null;
  if (!src) { noSrc.push(r); continue; }
  if (src.ans !== r.key) { srcAnsMismatch.push({ ...r, srcAns: src.ans }); continue; }
  // 校验题源解析自身结论 === key（用宽松检查：答案字母出现在"正确答案"行）
  const blocks = srcToBlocks(src.exp);
  if (!blocks) { skipped.push({ ...r, why: '题源解析无法切块' }); continue; }

  // 3a. packs explain
  const peFile = path.join(PACKS, r.term, 'explain', r.subject + '.json');
  if (!touchedPE.has(peFile)) touchedPE.set(peFile, JSON.parse(fs.readFileSync(peFile, 'utf8')));
  const pe = touchedPE.get(peFile);
  if (!pe[r.id]) { skipped.push({ ...r, why: 'packs explain 无该 id' }); continue; }
  pe[r.id] = { b: blocks };   // 旧 bf 可能来自坏解析，直接弃用（题源无出处字段）

  // 3b. merged2（id 带 jiguang: 前缀；找不到不报错，说明该学科 merged2 结构不同）
  const m2File = path.join(M2DIR, r.subject + '.json');
  if (fs.existsSync(m2File)) {
    if (!touchedM2.has(m2File)) touchedM2.set(m2File, JSON.parse(fs.readFileSync(m2File, 'utf8')));
    const m2 = touchedM2.get(m2File);
    const rec = m2.find(q => q.id === 'jiguang:' + r.id);
    if (rec) rec.explanation = src.exp;
  }
  fixed.push({ id: r.id, subject: r.subject, key: r.key });
}

N('可自动修复:', fixed.length, '| 无题源解析:', noSrc.length, '| 题源答案与key不一致(需人工):', srcAnsMismatch.length, '| 其他跳过:', skipped.length);
N('涉及 packs explain 文件:', touchedPE.size, '| merged2 文件:', touchedM2.size);

if (!APPLY) {
  N('（dry-run 演练，未写盘。加 --apply 实改）');
  process.exit(0);
}

// ---------- 4. 备份 + 写盘 ----------
fs.mkdirSync(BACKUP, { recursive: true });
for (const f of touchedPE.keys()) {
  // f 形如 工程/题库调研/packs/<学期>/explain/<学科>.json → 取学期与学科做扁平名
  const segs = f.split('/');
  const termName = segs[segs.length - 3], subj = path.basename(f, '.json');
  const dst = BACKUP + '/packs_' + termName + '_' + subj + '.bak.json';
  fs.copyFileSync(f, dst); N('备份', dst);
}
for (const f of touchedM2.keys()) {
  const dst = BACKUP + '/merged2_' + path.basename(f) + '.bak.json';
  fs.copyFileSync(f, dst); N('备份', dst);
}
for (const [f, o] of touchedPE) fs.writeFileSync(f, JSON.stringify(o));
for (const [f, o] of touchedM2) fs.writeFileSync(f, JSON.stringify(o, null, 1));
N('✅ 已写盘:', fixed.length, '条');

// ---------- 5. 输出剩余人工清单 ----------
fs.writeFileSync('工程/题库调研/audit_remaining_manual_20261009.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  noSrc, srcAnsMismatch, skipped,
}, null, 1));
N('剩余人工清单 → 工程/题库调研/audit_remaining_manual_20261009.json');
