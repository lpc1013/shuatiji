/**
 * 极光题库选项修复（预览/落盘）
 * 用法:
 *   node fix_jiguang_options.mjs            → 只输出预览（_fix_preview.txt），不写任何文件
 *   node fix_jiguang_options.mjs --apply    → 额外输出修复后题库到 题库调研/fixed/极光/<学科>.json
 * 原始 极光_*.json 始终保持只读。
 */
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { fixQuestion } from "./lib_fix.mjs";

const WS = "D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学";
const APPLY = process.argv.includes("--apply");
const out = []; const P = (...a) => out.push(a.join(" "));

const jgFiles = [];
async function walk(d) { let e; try { e = await readdir(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = d + "/" + x.name; if (x.isDirectory()) await walk(p); else if (x.name.startsWith("极光_") && x.name.endsWith(".json") && !x.name.includes(".bak")) jgFiles.push(p); } }
await walk(WS);

const fixedBySubject = new Map();  // 学科 → {subject, chapters:[{name, questions:[]}]}
const records = [];
const seen = new Set();
let total = 0;
for (const f of jgFiles) {
  let j; try { j = JSON.parse(await readFile(f, "utf8")); } catch { continue; }
  const subj = j.subject || f.split("/").pop().replace("极光_", "").replace(".json", "");
  if (!fixedBySubject.has(subj)) fixedBySubject.set(subj, { subject: subj, chapters: [] });
  const outChapters = fixedBySubject.get(subj).chapters;
  for (const c of (j.chapters || [])) {
    const oc = { name: c.name, questions: [] };
    for (const q of (c.questions || [])) {
      if (q.id && seen.has(q.id)) continue; if (q.id) seen.add(q.id);
      total++;
      const r = fixQuestion(q.content, q.options, q.correct_answer, q.display_type);
      const nq = { ...q };
      if (r.changed) {
        nq.content = r.stem; nq.options = r.options; nq.correct_answer = r.answer;
        if (r.imageMissing) nq.imageMissing = true;
        records.push({ file: f.split("/").slice(-3, -1).join("/"), subject: subj, chapter: c.name, id: q.id, changes: r.changes, needManual: r.needManual, ansBefore: r.answerBefore, ansAfter: r.answer, stemAfter: r.stem, optsAfter: r.options, stemBefore: String(q.content || ""), optsBefore: q.options });
      }
      oc.questions.push(nq);
    }
    if (oc.questions.length) outChapters.push(oc);
  }
}

P(`极光唯一题 ${total}；触发修复 ${records.length} 条\n`);
const tally = {}; for (const r of records) for (const c of r.changes) tally[c.type] = (tally[c.type] || 0) + 1;
P("修复类型统计: " + JSON.stringify(tally));
const bySubject = {}; for (const r of records) bySubject[r.subject] = (bySubject[r.subject] || 0) + 1;
P("按学科: " + JSON.stringify(Object.entries(bySubject).sort((a, b) => b[1] - a[1])));
P("需人工复核: " + records.filter(r => r.needManual).length + "\n");

P("#################### 修复明细（before → after） ####################");
for (const r of records) {
  P("\n--- [" + r.subject + "] " + r.changes.map(c => c.type + (c.detail && !c.detail.startsWith("{") ? ":" + c.detail : "")).join(" + ") + "  id=" + r.id);
  if (r.stemBefore !== r.stemAfter) { P("  题干前: " + r.stemBefore.slice(0, 150)); P("  题干后: " + r.stemAfter.slice(0, 150)); }
  P("  选项前: " + JSON.stringify(r.optsBefore).slice(0, 240));
  P("  选项后: " + JSON.stringify(r.optsAfter).slice(0, 260));
  P("  答案:   " + JSON.stringify(r.ansBefore) + " → " + JSON.stringify(r.ansAfter) + (r.needManual ? "  ⚠需人工" : ""));
  for (const c of r.changes) if (c.type.startsWith("R1")) P("    R1提取: " + c.detail);
}

await writeFile(WS + "/题库调研/_fix_preview.txt", out.join("\n"), "utf8");

if (APPLY) {
  const OUT = WS + "/题库调研/fixed/极光";
  for (let i = 0; i < 5; i++) { try { await mkdir(OUT, { recursive: true }); if (existsSync(OUT)) break; } catch { } await new Promise(r => setTimeout(r, 200)); }
  for (const [subj, data] of fixedBySubject) {
    const safe = subj.replace(/[\\/:*?"<>|]/g, "_");
    await writeFile(`${OUT}/${safe}.json`, JSON.stringify(data), "utf8");
  }
  // 修复清单
  await writeFile(WS + "/题库调研/fixed/fix_report.json", JSON.stringify({
    generatedAt: new Date().toISOString(),
    total, fixed: records.length,
    byType: tally, bySubject,
    needManual: records.filter(r => r.needManual).length,
    records: records.map(r => ({ subject: r.subject, id: r.id, changes: r.changes, needManual: r.needManual, ansBefore: r.ansBefore, ansAfter: r.ansAfter }))
  }, null, 1), "utf8");
  P("\n[APPLY] 已写出 " + fixedBySubject.size + " 个学科文件 → 题库调研/fixed/极光/");
}
console.log("preview written, records=" + records.length + (APPLY ? " [APPLIED]" : " [dry-run]"));
