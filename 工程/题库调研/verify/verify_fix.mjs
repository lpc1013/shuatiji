/** 独立复验：修复前后极光题库质量对比（不读修复中间产物，只对比原始 vs fixed/） */
import { readFile, readdir, writeFile } from "fs/promises";
const WS = "D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学";
const out = []; const P = (...a) => out.push(a.join(" "));
const alphaOf = o => Object.keys(o || {}).filter(k => /^[A-Z]$/.test(k)).sort();

function metrics(questions, label) {
  let n = 0, gapKeys = 0, ansOOB = 0, emptyOpt = 0, emptyStem = 0, htmlLeft = 0, prefixLeft = 0, imgMissing = 0, blankQ = 0;
  for (const q of questions) {
    n++;
    const opts = q.options || {};
    const keys = alphaOf(opts);
    const ans = String(q.correct_answer ?? "").toUpperCase().replace(/[^A-F]/g, "");
    const stem = String(q.content || "");
    if (!keys.length) { if (Object.keys(opts).some(k => /^blank/i.test(k))) blankQ++; continue; }
    if (keys.some((k, i) => k !== String.fromCharCode(65 + i))) gapKeys++;
    if (ans && [...ans].some(c => !keys.includes(c))) ansOOB++;
    if (keys.some(k => !String(opts[k] || "").trim())) emptyOpt++;
    if (!stem.trim()) emptyStem++;
    if (/<[a-z][^>]*>/i.test(stem) || keys.some(k => /<[a-z][^>]*>/i.test(opts[k]))) htmlLeft++;
    if (keys.some(k => { const m = String(opts[k]).match(/^\s*[A-F][.、．:：]\s*\S/); return m && m[0].trim()[0] === k; })) prefixLeft++;
    if (keys.length >= 3 && new Set(keys.map(k => String(opts[k]).replace(/\s/g, ""))).size === 1) imgMissing++;
  }
  P(`\n【${label}】题数 ${n}（填空 ${blankQ}）`);
  P(`  选项键跳号: ${gapKeys}   答案越界: ${ansOOB}   空选项: ${emptyOpt}   空题干: ${emptyStem}`);
  P(`  残留HTML: ${htmlLeft}   选项冗余前缀: ${prefixLeft}   选项全同(图片题): ${imgMissing}`);
  return { n, gapKeys, ansOOB, emptyOpt, emptyStem, htmlLeft, prefixLeft, imgMissing };
}

// 原始
const raw = {};
const files = [];
async function walk(d) { let e; try { e = await readdir(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = d + "/" + x.name; if (x.isDirectory()) await walk(p); else if (x.name.startsWith("极光_") && x.name.endsWith(".json") && !x.name.includes(".bak")) files.push(p); } }
await walk(WS);
const seen = new Set(); const rawQs = [];
for (const f of files) {
  let j; try { j = JSON.parse(await readFile(f, "utf8")); } catch { continue; }
  for (const c of (j.chapters || [])) for (const q of (c.questions || [])) { if (q.id && seen.has(q.id)) continue; if (q.id) seen.add(q.id); rawQs.push(q); }
}
const before = metrics(rawQs, "修复前（原始 极光_*.json）");

// 修复后
const fixedQs = [];
const gdir = WS + "/工程/题库调研/fixed/极光";
for (const f of await readdir(gdir)) {
  const j = JSON.parse(await readFile(gdir + "/" + f, "utf8"));
  for (const c of (j.chapters || [])) for (const q of (c.questions || [])) fixedQs.push(q);
}
const after = metrics(fixedQs, "修复后（fixed/极光/）");

P("\n=== 差异 ===");
for (const k of Object.keys(before)) P(`  ${k}: ${before[k]} → ${after[k]}  (${after[k] - before[k] >= 0 ? "+" : ""}${after[k] - before[k]})`);

// 逐题 diff 抽查：随机 20 条被改过的题
P("\n=== 抽样 diff（20 条）===");
const rawById = new Map(rawQs.map(q => [q.id, q]));
let shown = 0;
for (const q of fixedQs) {
  if (shown >= 20) break;
  const o = rawById.get(q.id); if (!o) continue;
  const ao = JSON.stringify(o.options), an = JSON.stringify(q.options);
  if (ao === an && o.content === q.content) continue;
  shown++;
  P(`\n- [${q.id}]`);
  if (o.content !== q.content) { P(`  题干: ${String(o.content).slice(0, 90)}`); P(`     → ${String(q.content).slice(0, 90)}`); }
  if (ao !== an) { P(`  选项: ${ao.slice(0, 190)}`); P(`     → ${an.slice(0, 190)}`); }
  if (String(o.correct_answer) !== String(q.correct_answer)) P(`  答案: ${JSON.stringify(o.correct_answer)} → ${JSON.stringify(q.correct_answer)}`);
}
await writeFile(WS + "/工程/题库调研/fixed/verify_fix.txt", out.join("\n"), "utf8");
console.log(out.slice(0, 20).join("\n"));
