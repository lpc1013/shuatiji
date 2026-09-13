import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

const WS = "D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学";
const OUT = `${WS}/题库调研`;
await mkdir(OUT, { recursive: true });

const PUNC = /[，。、；：？！""''（）【】《》\.,;:?!'"()\[\]{}<>~`\-_—…·\/\\|@#$%^&*+=\s]/g;
function norm(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;|&#\d+;/gi, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(PUNC, "")
    .toLowerCase()
    .trim();
}
function normAns(a) {
  if (a === null || a === undefined || Array.isArray(a) && !a.length) return "";
  if (Array.isArray(a)) a = a.join("");
  return String(a).replace(/[\s\u3000]/g, "").toUpperCase().trim();
}
function addIdx(map, stem, rec) { if (!stem) return; if (!map.has(stem)) map.set(stem, []); map.get(stem).push(rec); }

// ---------- 1. 极光 ----------
const jgFiles = [];
async function walk(d) {
  let e; try { e = await readdir(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) {
    const p = `${d}/${x.name}`;
    if (x.isDirectory()) await walk(p);
    else if (x.name.startsWith("极光_") && x.name.endsWith(".json")) jgFiles.push(p);
  }
}
await walk(WS);
const jgById = new Map();
const jgByStem = new Map();
let jgRaw = 0, jgDupId = 0;
for (const f of jgFiles) {
  let j; try { j = JSON.parse(await readFile(f, "utf8")); } catch { continue; }
  const subj = j.subject || f.split("/").pop().replace("极光_", "").replace(".json", "");
  for (const c of (j.chapters || [])) {
    for (const q of (c.questions || [])) {
      jgRaw++;
      if (q.id && jgById.has(q.id)) { jgDupId++; continue; }
      const rec = { id: q.id, subject: subj, chapter: c.name, stem: norm(q.content), ans: normAns(q.correct_answer), type: q.display_type || String(q.q_type), src: "jiguang" };
      if (q.id) jgById.set(q.id, rec);
      addIdx(jgByStem, rec.stem, rec);
    }
  }
}

// ---------- 2. iyixue ----------
const iy = [];
for (const bank of ["school", "kaoyan"]) {
  const bd = `${WS}/工程/iyixue_top/${bank}`;
  if (!existsSync(bd)) continue;
  for (const sd of await readdir(bd, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue;
    const sdir = `${bd}/${sd.name}`;
    for (const f of await readdir(sdir)) {
      if (!f.endsWith(".json")) continue;
      let arr; try { arr = JSON.parse(await readFile(`${sdir}/${f}`, "utf8")); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const q of arr) {
        iy.push({
          id: q.id, subject: q.subject || sd.name, system: q.system || "", bank,
          stem: norm(q.question), ans: normAns(q.answer), type: q.type,
          source: q.questionSource || "", file: `${bank}/${sd.name}/${f}`
        });
      }
    }
  }
}
const iyByStem = new Map();
for (const q of iy) addIdx(iyByStem, q.stem, q);

// ---------- 3. 我方网站 ----------
const raw = await readFile(`${WS}/site/data/data.js`, "utf8");
const obj = new Function("return (" + raw.slice(raw.indexOf("=") + 1).replace(/;\s*$/, "") + ")")();
const mine = [];
for (const k of Object.keys(obj)) {
  for (const c of (obj[k].chapters || [])) {
    for (const q of (c.questions || [])) {
      mine.push({ id: q.id, subject: obj[k].name, chapter: c.name, stem: norm(q.content), ans: normAns(q.correct), type: q.type, src: "oursite" });
    }
  }
}
const mineByStem = new Map();
for (const q of mine) addIdx(mineByStem, q.stem, q);

// ---------- 4. 比对 ----------
function intersect(a, b) {
  const common = [];
  for (const k of a.keys()) if (b.has(k)) common.push(k);
  return common;
}
const commonJG_IY = intersect(jgByStem, iyByStem);
const commonMINE_JG = intersect(mineByStem, jgByStem);
const commonMINE_IY = intersect(mineByStem, iyByStem);

function countQs(map, stems) { let n = 0; for (const s of stems) n += map.get(s).length; return n; }

// 冲突：同题干，答案集合无交集（只比单选类：答案为纯字母且长度<=4）
const conflicts = [];
let compared = 0;
for (const s of commonJG_IY) {
  const jr = jgByStem.get(s), ir = iyByStem.get(s);
  const ja = new Set(jr.map(x => x.ans).filter(a => /^[A-Z]{1,4}$/.test(a)));
  const ia = new Set(ir.map(x => x.ans).filter(a => /^[A-Z]{1,4}$/.test(a)));
  if (!ja.size || !ia.size) continue;
  compared++;
  const inter = [...ja].filter(x => ia.has(x));
  if (!inter.length) {
    conflicts.push({ stem: s.slice(0, 60), jg: jr[0], iy: ir[0] });
  }
}

// 学科级统计
function subjectStats(all, byStem, common) {
  const tot = new Map(), mch = new Map();
  for (const q of all) { const k = q.subject || "(未知)"; tot.set(k, (tot.get(k) || 0) + 1); }
  for (const s of common) for (const r of byStem.get(s)) { const k = r.subject || "(未知)"; mch.set(k, (mch.get(k) || 0) + 1); }
  return [...tot.entries()].map(([k, v]) => ({ subject: k, total: v, overlap: mch.get(k) || 0, rate: +(((mch.get(k) || 0) / v) * 100).toFixed(1), only: v - (mch.get(k) || 0) })).sort((a, b) => b.total - a.total);
}
const iySubjectStats = subjectStats(iy, iyByStem, commonJG_IY);
const jgSubjectStats = subjectStats([...jgById.values()], jgByStem, commonJG_IY);

// iyixue 来源分布 + jg 来源重合核查
const srcDist = new Map(), srcMatch = new Map();
for (const q of iy) {
  const k = q.source || "(无)";
  srcDist.set(k, (srcDist.get(k) || 0) + 1);
  if (jgByStem.has(q.stem)) srcMatch.set(k, (srcMatch.get(k) || 0) + 1);
}
const sourceStats = [...srcDist.entries()].map(([k, v]) => ({ source: k, total: v, overlapWithJiguang: srcMatch.get(k) || 0, rate: +(((srcMatch.get(k) || 0) / v) * 100).toFixed(1) })).sort((a, b) => b.total - a.total);

const report = {
  generatedAt: new Date().toISOString(),
  corpus: {
    jiguang: { files: jgFiles.length, rawQuestions: jgRaw, duplicateById: jgDupId, uniqueById: jgById.size, uniqueByStem: jgByStem.size },
    iyixue: { questions: iy.length, uniqueByStem: iyByStem.size },
    oursite: { questions: mine.length, uniqueByStem: mineByStem.size }
  },
  overlap: {
    "jiguang∩iyixue": {
      commonStems: commonJG_IY.length,
      jiguangQuestionsMatched: countQs(jgByStem, commonJG_IY),
      iyixueQuestionsMatched: countQs(iyByStem, commonJG_IY),
      jiguangOnlyStems: jgByStem.size - commonJG_IY.length,
      iyixueOnlyStems: iyByStem.size - commonJG_IY.length,
      pctOfJiguang: +((countQs(jgByStem, commonJG_IY) / jgById.size) * 100).toFixed(1),
      pctOfIyixue: +((countQs(iyByStem, commonJG_IY) / iy.length) * 100).toFixed(1)
    },
    "oursite∩jiguang": { commonStems: commonMINE_JG.length, ourQuestionsMatched: countQs(mineByStem, commonMINE_JG) },
    "oursite∩iyixue": { commonStems: commonMINE_IY.length, ourQuestionsMatched: countQs(mineByStem, commonMINE_IY), pctOfOursite: +((countQs(mineByStem, commonMINE_IY) / mine.length) * 100).toFixed(1) }
  },
  answerConflicts: { comparedStems: compared, conflictStems: conflicts.length, samples: conflicts.slice(0, 60) },
  iyixueSourceBreakdown: sourceStats,
  byIyixueSubject: iySubjectStats,
  byJiguangSubject: jgSubjectStats
};
await writeFile(`${OUT}/overlap_report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  corpus: report.corpus,
  overlap: report.overlap,
  answerConflicts: { comparedStems: compared, conflictStems: conflicts.length },
  iyixueSourceBreakdown: sourceStats.slice(0, 8),
  topIyixueSubjects: iySubjectStats.slice(0, 12),
  topJiguangSubjects: jgSubjectStats.slice(0, 12)
}, null, 1));
