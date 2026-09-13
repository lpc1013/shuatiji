/**
 * 三方题库统一化 / 去重 / 合并脚本（只读源数据，产出 merged/，不改动 site/）
 * 用法: node merge.mjs
 * 优先级: jiguang(极光) > oursite(我方站) > iyixue
 */
import { readFile, readdir, writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";

const WS = "D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学";
const OUT = `${WS}/题库调研/merged`;
// Windows 下 mkdir 可能假成功，写入前一律 ensureDir；rm 也重试
async function ensureDir(d) { for (let i = 0; i < 5; i++) { try { await mkdir(d, { recursive: true }); if (existsSync(d)) return true; } catch {} await new Promise(r => setTimeout(r, 200)); } return false; }
async function rmrf(d) { for (let i = 0; i < 5; i++) { try { await rm(d, { recursive: true, force: true }); } catch {} if (!existsSync(d)) return true; await new Promise(r => setTimeout(r, 300)); } return !existsSync(d); }
const log = m => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };
log("cleaning output dir");
await rmrf(OUT);
if (!await ensureDir(OUT)) { console.error("FATAL: cannot create " + OUT); process.exit(1); }
if (!await ensureDir(`${OUT}/by_subject`)) { console.error("FATAL: cannot create by_subject"); process.exit(1); }
if (!await ensureDir(`${OUT}/by_origin`)) { console.error("FATAL: cannot create by_origin"); process.exit(1); }
log("output dir ready");

// ---------- 学科名统一映射 ----------
const SUBJECT_ALIAS = {
  "生化": "生物化学", "生理": "生理学", "免疫": "医学免疫学", "微生物": "医学微生物学",
  "病理": "病理学", "病理生理": "病理生理学", "遗传": "医学遗传学", "组胚": "组织学与胚胎学",
  "细胞生物学": "医学细胞生物学", "伦理": "医学伦理学", "影像": "医学影像学",
  "传染病（test）": "传染病学", "临床诊断": "诊断学", "外科学（test）": "外科学",
  "内科学（test）": "内科学", "小儿外科学": "小儿外科学", "儿童医院社区实习": "儿科学",
  "生物化学与分子生物学": "生物化学", "外科基础": "外基", "医学人文": "医学人文"
};
const stdSubject = s => SUBJECT_ALIAS[s] || (s || "未分类").trim();

// ---------- 归一化 ----------
const WEAK_STEM_LEN = 6;   // 归一化后题干短于此长度 → 弱键，需拼选项指纹 / 标人工
const PUNC = /[，。、；：？！""''（）【】《》\.,;:?!'"()\[\]{}<>~`\-_—…·\/\\|@#$%^&*+=\s]/g;
function norm(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/<[^>]*>/g, "").replace(/&[a-z]+;|&#\d+;/gi, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(PUNC, "").toLowerCase().trim();
}
function normAns(a) {
  if (a === null || a === undefined) return "";
  if (Array.isArray(a)) a = a.join("");
  return String(a).replace(/[\s\u3000]/g, "").toUpperCase().trim();
}
function unifyType(t, opts, multi) {
  const s = String(t || "").toUpperCase();
  if (/多选|X|MULTI/.test(s)) return "多选";
  if (/判断|JUDGE|TRUE/.test(s)) return "判断";
  if (/填空|F$|FILL|BLANK/.test(s)) return "填空";
  if (/^[ABC][123]?$/.test(s)) return s.slice(0, 2);
  if (multi === true) return "多选";
  if (opts && typeof opts === "object" && Object.keys(opts).some(k => /^blank/.test(k))) return "填空";
  return s || "A1";
}
/** 统一选项为 {A:"...", B:"..."} 或 {blank_1:[...]} */
function unifyOptions(o) {
  if (!o) return {};
  if (Array.isArray(o)) {
    const r = {};
    for (const it of o) {
      const m = String(it).match(/^\s*([A-Z])[.、．:：\s]\s*(.*)$/i);
      if (m) r[m[1].toUpperCase()] = m[2].trim();
    }
    return r;
  }
  return o;
}

// ---------- 来源标注 ----------
// originGroup 粗分组: 极光 | 医考帮 | 考研真题 | 未知来源 | 自建
// origin      细标签: 如 "考研真题·2020年" / "极光(经乐学医题)" / "未知来源(待整理)"
const ORIGIN_KEYS = ["极光", "医考帮", "考研真题", "未知来源", "自建"];
function iyixueOrigin(label, bank) {
  const s = String(label || "").trim();
  if (!s) return { group: "未知来源", label: "未知来源", year: null };
  if (s === "医考帮") return { group: "医考帮", label: "医考帮", year: null };
  if (s === "jg") return { group: "极光", label: "极光(经乐学医题)", year: null };
  if (s === "待整理来源") return { group: "未知来源", label: "未知来源(待整理)", year: null };
  const ym = s.match(/(\d{4})\s*年?考研真题/);
  if (ym) return { group: "考研真题", label: `考研真题·${ym[1]}年`, year: Number(ym[1]) };
  if (/考研/.test(s)) return { group: "考研真题", label: "考研真题", year: null };
  return { group: "未知来源", label: `未知来源(${s})`, year: null };
}
/** 极光录入方式（源数据有乱码，按前缀归类） */
function importMethod(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  if (/^Excel/i.test(s) || /^Ｅ/i.test(s)) return "Excel导入";
  if (/^Word/i.test(s) || /^Ｗ/i.test(s)) return "Word导入";
  if (/admin/i.test(s)) return "后台录入";
  if (s.includes("自创")) return "自创";
  return s;
}

const recs = [];
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
log(`极光文件 ${jgFiles.length} 个`);
const seenJg = new Set();
for (const f of jgFiles) {
  let j; try { j = JSON.parse(await readFile(f, "utf8")); } catch { continue; }
  const subj = stdSubject(j.subject || f.split("/").pop().replace("极光_", "").replace(".json", ""));
  for (const c of (j.chapters || [])) {
    for (const q of (c.questions || [])) {
      if (q.id && seenJg.has(q.id)) continue;
      if (q.id) seenJg.add(q.id);
      recs.push({
        source: "jiguang", sourceId: q.id || "", subject: subj, chapter: c.name || "",
        type: unifyType(q.display_type, q.options, q.multi),
        stem: String(q.content || ""), options: unifyOptions(q.options),
        answer: normAns(q.correct_answer), answerRaw: q.correct_answer ?? "",
        explanation: String(q.explanation || ""), aiExplanation: q.ai_explanation || null,
        difficulty: q.difficulty ?? null, tags: q.tags || [], sourceLabel: q.source || "",
        _group: "极光", _label: "极光", _year: null,
        _method: importMethod(q.source), _bank: "", _case: ""
      });
    }
  }
}
log("读取极光完成, recs=" + recs.length);
// ---------- 2. iyixue ----------
for (const bank of ["school", "kaoyan"]) {
  const bd = `${WS}/iyixue_top/${bank}`;
  if (!existsSync(bd)) continue;
  for (const sd of await readdir(bd, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue;
    const sdir = `${bd}/${sd.name}`;
    for (const f of await readdir(sdir)) {
      if (!f.endsWith(".json")) continue;
      let arr; try { arr = JSON.parse(await readFile(`${sdir}/${f}`, "utf8")); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const q of arr) {
        const og = iyixueOrigin(q.questionSource, bank);
        recs.push({
          source: "iyixue", sourceId: q.id || "", subject: stdSubject(q.subject || sd.name),
          chapter: q.system || "", bank,
          type: unifyType(q.type, q.options), stem: String(q.question || ""),
          options: unifyOptions(q.options), answer: normAns(q.answer), answerRaw: q.answer ?? "",
          explanation: String(q.explanation || ""), aiExplanation: null,
          difficulty: q.difficulty || null, tags: q.knowledgePoints || [], sourceLabel: q.questionSource || "",
          _group: og.group, _label: og.label, _year: og.year,
          _method: null, _bank: bank, _case: String(q.caseInfo || "")
        });
      }
    }
  }
  log(`读取 iyixue/${bank} 完成, recs=${recs.length}`);
}
// ---------- 3. 我方 ----------
const raw = await readFile(`${WS}/site/data/data.js`, "utf8");
const obj = new Function("return (" + raw.slice(raw.indexOf("=") + 1).replace(/;\s*$/, "") + ")")();
for (const k of Object.keys(obj)) {
  for (const c of (obj[k].chapters || [])) {
    for (const q of (c.questions || [])) {
      recs.push({
        source: "oursite", sourceId: q.id || "", subject: stdSubject(obj[k].name),
        chapter: c.name || "", type: unifyType(q.type, q.options, q.multi),
        stem: String(q.content || ""), options: unifyOptions(q.options),
        answer: normAns(q.correct), answerRaw: q.correct ?? "",
        explanation: String(q.explanation || ""), aiExplanation: null,
        difficulty: q.difficulty ?? null, tags: q.tags || [], sourceLabel: "oursite",
        _group: "自建", _label: "自建(我方站点)", _year: null,
        _method: null, _bank: "", _case: String(q.caseInfo || "")
      });
    }
  }
}

// ---------- 分组去重 ----------
const PRIO = { jiguang: 0, oursite: 1, iyixue: 2 };
const groups = new Map();
for (const r of recs) {
  let key = norm(r.stem);
  if (!key) continue;
  // A2/A3 病例题：共用小问题干（「最可能的诊断是」）会大面积误合并 → 病例摘要入键
  const caseKey = norm(r._case || "");
  if (caseKey.length > 5) key = caseKey + "|" + key;
  // 短题干（归一化 < 6 字）单独拼选项指纹，避免「见图」「直肠」这类误合并
  if (key.length < WEAK_STEM_LEN) key = key + "||" + norm(JSON.stringify(r.options || {})).slice(0, 80);
  r._key = key;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

// ---------- 答案冲突裁决 ----------
const PRIO_ORIGIN = { "极光": 0, "考研真题": 1, "医考帮": 2, "未知来源": 3, "自建": 4 };
function resolveConflict(g, main) {
  const optKeys = Object.keys(main.options || {}).filter(k => /^[A-Z]$/.test(k));
  const validAns = a => optKeys.length === 0 ? true : [...String(a)].every(ch => optKeys.includes(ch));
  let items = g.map(x => ({
    origin: x._group, label: x._label,
    ans: normAns(x.answerRaw ?? x.answer), raw: String(x.answerRaw ?? x.answer ?? ""),
    hasExp: !!(x.explanation && x.explanation.length > 10)
  })).filter(i => i.ans);
  const distinct = [...new Set(items.map(i => i.ans))];
  if (distinct.length <= 1) return { rule: "agree", answer: main.answer, manual: false };
  if (norm(main.stem).length < WEAK_STEM_LEN && norm(main._case || "").length <= 5)
    return { rule: "weakStem", answer: main.answer, manual: true, note: "归一化题干过短，疑误合并" };
  if (main.type === "填空" || main.type === "判断" || !distinct.every(a => /^[A-Z]+$/.test(a)))
    return { rule: "textAnswer", answer: main.answer, manual: true, note: "非字母答案（填空/文本），需人工核对" };
  // 选项越界（如答案是 E 但选项只有 A-D）→ 剔出证据
  const kept = items.filter(i => validAns(i.ans));
  const droppedInvalid = items.length - kept.length;
  if (kept.length && [...new Set(kept.map(i => i.ans))].length === 1)
    return { rule: "optionCheck", answer: kept[0].ans, manual: false, note: `剔除 ${droppedInvalid} 条选项越界记录`, votes: `${kept.length}/${items.length}` };
  const use = kept.length ? kept : items;
  const cnt = {};
  for (const i of use) cnt[i.ans] = (cnt[i.ans] || 0) + 1;
  const total = use.length, sorted = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  const prio = i => PRIO_ORIGIN[i.origin] ?? 9;
  const bestPrio = Math.min(...use.map(prio));
  const topItems = use.filter(i => prio(i) === bestPrio);
  const topSet = [...new Set(topItems.map(i => i.ans))];
  if (topSet.length === 1) {
    const byLabel = topItems.find(i => i.ans === topSet[0]).label;
    return { rule: "priority", answer: topSet[0], manual: false, by: byLabel, votes: `${cnt[topSet[0]]}/${total}` };
  }
  // 同优先级内部冲突 → 有解析者优先
  const expAns = [...new Set(topItems.filter(i => i.hasExp).map(i => i.ans))];
  if (expAns.length === 1) {
    const byLabel = topItems.find(i => i.ans === expAns[0] && i.hasExp).label;
    return { rule: "priority+exp", answer: expAns[0], manual: false, by: byLabel + "(有解析)", votes: `${cnt[expAns[0]]}/${total}` };
  }
  const [topAns, n] = sorted[0];
  if (n * 2 > total) return { rule: "majority", answer: topAns, manual: false, votes: `${n}/${total}` };
  return { rule: "manual", answer: main.answer, manual: true, note: "最高优先级来源内部自冲突且无多数", votes: `${n}/${total}` };
}

const merged = [];
const conflicts = [];
const manualReview = [];
const answerPatch = {};
let conflictCount = 0, patchedExplanation = 0;
let statPriority = 0, statMajority = 0, statWeak = 0, statText = 0, statManual = 0, statAgree = 0, statOpt = 0, statPrioExp = 0;
for (const [key, g] of groups) {
  g.sort((a, b) => (PRIO[a.source] - PRIO[b.source]) || ((b.explanation.length || 0) - (a.explanation.length || 0)));
  const main = g[0];
  // 补解析
  if (!main.explanation) {
    const alt = g.find(x => x !== main && x.explanation);
    if (alt) { main.explanation = alt.explanation; patchedExplanation++; }
  }
  // 答案冲突
  const answers = [...new Set(g.map(x => x.answer).filter(Boolean))];
  const conflict = answers.length > 1;
  let decision = null;
  if (conflict) {
    conflictCount++;
    decision = resolveConflict(g, main);
    if (decision.rule === "priority") statPriority++;
    else if (decision.rule === "priority+exp") statPrioExp++;
    else if (decision.rule === "optionCheck") statOpt++;
    else if (decision.rule === "majority") statMajority++;
    else if (decision.rule === "weakStem") statWeak++;
    else if (decision.rule === "textAnswer") statText++;
    else statManual++;
    const rec = {
      dupKey: key, subject: main.subject, chapter: main.chapter, type: main.type,
      stem: main.stem.slice(0, 200),
      mainAnswer: main.answer, mainOrigin: main._group,
      options: main.options,
      decision: { answer: decision.answer, rule: decision.rule, by: decision.by || null, votes: decision.votes || null, note: decision.note || null },
      needManualReview: decision.manual,
      manualType: decision.manual ? ([...new Set(g.map(x => x._group))].length === 1 ? "singleSource" : "crossSource") : null,
      answers: g.map(x => ({
        source: x.source, originGroup: x._group, origin: x._label,
        answer: x.answerRaw ?? x.answer, subject: x.subject, id: x.sourceId || ""
      }))
    };
    conflicts.push(rec);
    if (decision.manual) manualReview.push(rec);
    else answerPatch[key] = { answer: decision.answer, rule: decision.rule, by: decision.by || null };
  } else statAgree++;
  const detail = g.map(x => ({
    platform: x.source, group: x._group, label: x._label,
    year: x._year || undefined, method: x._method || undefined,
    bank: x._bank || undefined, subject: x.subject, id: x.sourceId || ""
  }));
  merged.push({
    id: `${main.source}:${main.sourceId || key.slice(0, 12)}`,
    subject: main.subject, chapter: main.chapter, type: main.type,
    stem: main.stem, options: main.options, answer: main.answer,
    caseInfo: main._case || undefined,
    answerResolved: decision ? decision.answer : main.answer,
    answerRule: decision ? decision.rule : "none",
    needManualReview: decision ? !!decision.manual : false,
    conflictType: !decision ? "none"
      : ([...new Set(g.map(x => x._group))].length === 1 ? "singleSourceNumeric" : "crossSource"),
    conflictRule: decision ? decision.rule : null,
    explanation: main.explanation, aiExplanation: main.aiExplanation || null,
    difficulty: main.difficulty, tags: main.tags,
    // ---- 来源标注 ----
    originGroup: main._group,        // 主来源粗分组: 极光/医考帮/考研真题/未知来源/自建
    origin: main._label,             // 主来源细标签
    examYear: main._year || undefined,
    importMethod: main._method || undefined,
    sourceTags: [...new Set(g.map(x => x._label))],        // 全部来源细标签
    originGroups: [...new Set(g.map(x => x._group))],      // 全部来源粗分组
    sources: [...new Set(g.map(x => x.source))],           // 平台: jiguang/oursite/iyixue
    sourceDetail: detail,
    sourceCount: g.length, dupKey: key,
    hasConflict: conflict, altAnswers: conflict ? answers : undefined
  });
}

// ---------- 输出 ----------
const bySubject = new Map();
for (const q of merged) {
  if (!bySubject.has(q.subject)) bySubject.set(q.subject, []);
  bySubject.get(q.subject).push(q);
}
let wi = 0;
for (const [subj, arr] of bySubject) {
  const safe = subj.replace(/[\\/:*?"<>|]/g, "_");
  await ensureDir(`${OUT}/by_subject`);
  await writeFile(`${OUT}/by_subject/${safe}.json`, JSON.stringify(arr));
  if (++wi % 10 === 0) log(`by_subject ${wi}/${bySubject.size}`);
}
log(`by_subject done: ${bySubject.size} 个学科`);
// ---------- 来源索引（方便后续按来源整理） ----------
const byGroup = {}, byLabel = {}, examYears = {}, importMethods = {}, subjMatrix = new Map();
for (const g of ORIGIN_KEYS) byGroup[g] = { count: 0, byLabel: {}, subjects: {}, ids: [] };
for (const q of merged) {
  const grp = byGroup[q.originGroup] || (byGroup[q.originGroup] = { count: 0, byLabel: {}, subjects: {}, ids: [] });
  grp.count++;
  grp.ids.push(q.id);
  for (const lb of q.sourceTags) grp.byLabel[lb] = (grp.byLabel[lb] || 0) + 1;
  grp.subjects[q.subject] = (grp.subjects[q.subject] || 0) + 1;
  byLabel[q.origin] = (byLabel[q.origin] || 0) + 1;
  if (q.examYear) examYears[q.examYear] = (examYears[q.examYear] || 0) + 1;
  if (q.importMethod) importMethods[q.importMethod] = (importMethods[q.importMethod] || 0) + 1;
  if (!subjMatrix.has(q.subject)) subjMatrix.set(q.subject, { subject: q.subject, 极光: 0, 医考帮: 0, 考研真题: 0, 未知来源: 0, 自建: 0, total: 0 });
  const row = subjMatrix.get(q.subject);
  for (const g2 of q.originGroups) if (row[g2] !== undefined) row[g2]++;
  row.total++;
}
const sourceIndex = {
  generatedAt: new Date().toISOString(),
  legend: {
    极光: "极光题库 ji-guang.top（含 iyixue 中标记为 jg 的同源题）",
    医考帮: "医考帮导入题（iyixue questionSource=医考帮）",
    考研真题: "考研西医综合历年真题（iyixue kaoyan bank）",
    未知来源: "iyixue 的「待整理来源」及未标注题（实测约 92% 与极光重合，疑似极光题）",
    自建: "我方刷题记站点自有题（AI 解析）"
  },
  fieldGuide: {
    originGroup: "主来源粗分组（极光/医考帮/考研真题/未知来源/自建）",
    origin: "主来源细标签（如 考研真题·2020年 / 极光(经乐学医题) / 未知来源(待整理)）",
    sourceTags: "该题全部来源细标签（并集，跨源重复题会有多个）",
    originGroups: "该题全部来源粗分组（并集）",
    sources: "平台集合 jiguang/oursite/iyixue",
    sourceDetail: "逐条明细 {platform,group,label,year,method,bank,subject,id}",
    examYear: "考研真题年份",
    importMethod: "极光录入方式（Word导入/Excel导入/后台录入/自创）"
  },
  byGroup, byLabel, examYears, importMethods,
  subjectMatrix: [...subjMatrix.values()].sort((a, b) => b.total - a.total)
};
sourceIndex.note = [
  "口径A（主来源，互斥）：byGroup / byLabel / merge_report.byOriginGroup —— 每题只归入优先级最高的一个来源（极光 > 自建 > 医考帮/考研真题/未知来源），各项之和 = 104,284",
  "口径B（并集，可重叠）：subjectMatrix —— 一题若同时命中多个来源，各列各计一次，因此一行各项之和 ≥ total",
  "「未知来源」= iyixue 的「待整理来源」标签中未被极光/医考帮覆盖的部分；实测该标签下约 92% 的题与极光重合，已归入极光组（细标签仍保留在 sourceTags）",
  "「极光(经乐学医题)」= iyixue 中 questionSource=jg 的题，绝大多数与极光本地语料重复，已合并入极光组"
];
await writeFile(`${OUT}/source_index.json`, JSON.stringify(sourceIndex, null, 1));
log("source_index.json written");

// 精简来源清单（按粗分组分文件，体积小，便于人看/筛选）
const briefByGroup = new Map();
for (const q of merged) {
  if (!briefByGroup.has(q.originGroup)) briefByGroup.set(q.originGroup, []);
  briefByGroup.get(q.originGroup).push({
    id: q.id, subject: q.subject, chapter: q.chapter, type: q.type,
    origin: q.origin, examYear: q.examYear, difficulty: q.difficulty,
    answer: q.answer, hasExplanation: !!q.explanation,
    crossSource: q.originGroups.length > 1, stem: q.stem.slice(0, 60)
  });
}
for (const [grp, brief] of briefByGroup) {
  await ensureDir(`${OUT}/by_origin`);
  await writeFile(`${OUT}/by_origin/${grp}.json`, JSON.stringify(brief, null, 1));
  log(`by_origin/${grp}.json (${brief.length})`);
}

const report = {
  generatedAt: new Date().toISOString(),
  input: { jiguangUnique: seenJg.size, totalRecords: recs.length },
  merged: { uniqueQuestions: merged.length, dedupRemoved: recs.length - merged.length },
  bySourceCount: merged.reduce((a, q) => { const k = q.sources.join("+"); a[k] = (a[k] || 0) + 1; return a; }, {}),
  byOriginGroup: Object.fromEntries(Object.entries(byGroup).map(([k, v]) => [k, v.count])),
  byOriginLabel: byLabel,
  conflicts: conflictCount,
  conflictResolution: {
    total: conflictCount,
    autoResolved: statPriority + statMajority + statOpt + statPrioExp,
    byPriority: statPriority,
    byPriorityWithExplanation: statPrioExp,
    byOptionCheck: statOpt,
    byMajority: statMajority,
    needManual: statWeak + statText + statManual,
    manualBreakdown: { weakStem: statWeak, textAnswer: statText, noMajority: statManual },
    noConflict: statAgree
  },
  explanationPatched: patchedExplanation,
  subjects: [...bySubject.entries()].map(([s, a]) => ({ subject: s, count: a.length })).sort((x, y) => y.count - x.count)
};
await writeFile(`${OUT}/merge_report.json`, JSON.stringify(report, null, 1));
await writeFile(`${OUT}/conflicts.json`, JSON.stringify(conflicts, null, 1));
await writeFile(`${OUT}/conflicts_manual_review.json`, JSON.stringify(manualReview, null, 1));
const mrCross = manualReview.filter(c => c.manualType === "crossSource");
const mrSingle = manualReview.filter(c => c.manualType === "singleSource");
await writeFile(`${OUT}/conflicts_manual_cross_source.json`, JSON.stringify(mrCross, null, 1));
await writeFile(`${OUT}/conflicts_manual_single_source.json`, JSON.stringify(mrSingle, null, 1));
await writeFile(`${OUT}/answer_patch.json`, JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: "key = dupKey（题干归一化 hash），value = 裁决答案。可用于二次写回或校对。",
  patch: answerPatch
}, null, 1));
log(`conflicts=${conflictCount} 自动裁决=${statPriority + statMajority + statOpt + statPrioExp}(优先级 ${statPriority}/解析优先 ${statPrioExp}/选项校验 ${statOpt}/多数 ${statMajority}) 需人工=${manualReview.length}`);
console.log(JSON.stringify(report, null, 1));
