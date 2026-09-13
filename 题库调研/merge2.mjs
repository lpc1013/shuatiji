/**
 * merge v2 —— 修正合并键：题干 + 选项指纹（v1 只用题干 → 同题干多版本题被误合并）
 * 用法: node merge2.mjs
 * 产出: 题库调研/merged2/  (+ _compare.txt 与 v1 的差异）
 *
 * 与 v1 的差别：
 *  1. 严格键 = 病例摘要 + 归一化题干 + 排序后的归一化选项值
 *  2. 「选项值全同」的题（图片题/见图）不做跨题合并，每题独立
 *  3. 二次合并：同题干且选项集合 Jaccard ≥ 0.75 才并（容忍错别字/选项序差异）
 *  4. 其余（裁决规则、输出格式）与 v1 一致
 */
import { readFile, readdir, writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";

const WS = "D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学";
const OUT = `${WS}/题库调研/merged2`;
async function ensureDir(d) { for (let i = 0; i < 5; i++) { try { await mkdir(d, { recursive: true }); if (existsSync(d)) return true; } catch {} await new Promise(r => setTimeout(r, 200)); } return false; }
async function rmrf(d) { for (let i = 0; i < 5; i++) { try { await rm(d, { recursive: true, force: true }); } catch {} if (!existsSync(d)) return true; await new Promise(r => setTimeout(r, 300)); } return !existsSync(d); }
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

if (!await rmrf(OUT)) { console.error("FATAL: cannot clean " + OUT); process.exit(1); }
if (!await ensureDir(`${OUT}/by_subject`) || !await ensureDir(`${OUT}/by_origin`)) { console.error("FATAL: cannot create out dirs"); process.exit(1); }

const SUBJECT_ALIAS = {
  "生化": "生物化学", "生理": "生理学", "免疫": "医学免疫学", "微生物": "医学微生物学",
  "病理": "病理学", "病理生理": "病理生理学", "遗传": "医学遗传学", "组胚": "组织学与胚胎学",
  "细胞生物学": "医学细胞生物学", "伦理": "医学伦理学", "影像": "医学影像学",
  "传染病（test）": "传染病学", "临床诊断": "诊断学", "外科学（test）": "外科学",
  "内科学（test）": "内科学", "小儿外科学": "小儿外科学", "儿童医院社区实习": "儿科学",
  "生物化学与分子生物学": "生物化学", "外科基础": "外基", "医学人文": "医学人文"
};
const stdSubject = s => SUBJECT_ALIAS[s] || (s || "未分类").trim();

const WEAK_STEM_LEN = 6;
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
for (const bank of ["school", "kaoyan"]) {
  const bd = `${WS}/iyixue_top/${bank}`;
  if (!existsSync(bd)) continue;
  for (const sd of await readdir(bd, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue;
    const sdir = `${bd}/${sd.name}`;
    for (const f of await readdir(sdir)) {
      if (!f.endsWith(".json")) continue;
      let arr; try { arr = JSON.parse(await readFile(`${sdir}/${f}`, "utf8")); } catch { continue; }
      const list = Array.isArray(arr) ? arr : (arr.data || arr.questions || []);
      if (!Array.isArray(list)) continue;
      for (const q of list) {
        const og = iyixueOrigin(q.questionSource, bank);
        recs.push({
          source: "iyixue", sourceId: q.id || "", subject: stdSubject(q.subject || sd.name),
          chapter: q.system || "", bank,
          type: unifyType(q.type, q.options), stem: String(q.question || ""),
          options: unifyOptions(q.options), answer: normAns(q.answer), answerRaw: q.answer ?? "",
          explanation: String(q.explanation || ""), aiExplanation: null,
          // ⚠️ tags 必须用原生 q.tags（12,866 有值）；旧代码用 q.knowledgePoints（全库仅 1 条有值）等于把标签丢了
          difficulty: q.difficulty || null, tags: q.tags || [], sourceLabel: q.questionSource || "",
          _group: og.group, _label: og.label, _year: og.year,
          _method: null, _bank: bank, _case: String(q.caseInfo || ""),
          /* ---- 结构性解析与元信息（原白名单漏掉，全部补回） ---- */
          explanationBlocks: q.explanationBlocks || null,   // 99.7% 有值：分块解析（section/title/text）
          briefExplanation: q.briefExplanation || null,     // 12.5%：一句话解析
          suggestedTags: q.suggestedTags || null,           // 10.1%：建议标签
          sourceType: q.sourceType || null,                 // network|contribution|legacy
          nativeYear: q.year ?? null,                       // 原生年份字段（26%，比从 questionSource 正则更全）
          ext: q.extensions || null,                        // 溯源：examQno / textSource / originalQuestionType
          /* ---- 9 个预留字段：当前多为空/壳值，但后续 iyixue 接口会填，通道必须保留 ---- */
          mnemonic: q.mnemonic ?? null,
          knowledgePoint: q.knowledgePoint ?? null,
          knowledgePoints: q.knowledgePoints ?? null,
          optionExplanations: q.optionExplanations ?? null,
          reasoningSteps: q.reasoningSteps ?? null,
          frequencyLevel: q.frequencyLevel ?? null,
          studyPoints: q.studyPoints ?? null,
          memoryCards: q.memoryCards ?? null,
          memoryCardMeta: q.memoryCardMeta ?? null,
          questionRevision: q.questionRevision ?? null
        });
      }
    }
  }
  log(`读取 iyixue/${bank} 完成, recs=${recs.length}`);
}
/* 我方站点自建题：site/data/data.js 已被「manifest + 分片懒加载」方案取代（文件已不存在），
 * 旧代码读它会直接抛错 → 改读持久语料 题库调研/oursite_source.json（由 _export_oursite 从上一版 merged2 导出）。 */
const OS_FILE = `${WS}/题库调研/oursite_source.json`;
if (existsSync(OS_FILE)) {
  const osArr = JSON.parse(await readFile(OS_FILE, "utf8"));
  for (const q of osArr) {
    recs.push({
      source: q.source || "oursite", sourceId: q.sourceId || "",
      subject: stdSubject(q.subject), chapter: q.chapter || "",
      type: unifyType(q.type, q.options, q.multi),
      stem: String(q.stem || ""), options: unifyOptions(q.options),
      answer: normAns(q.answer), answerRaw: q.answerRaw ?? q.answer ?? "",
      explanation: String(q.explanation || ""), aiExplanation: q.aiExplanation || null,
      difficulty: q.difficulty ?? null, tags: q.tags || [], sourceLabel: "oursite",
      _group: q._group || "自建", _label: q._label || "自建(我方站点)", _year: q._year ?? null,
      _method: q._method ?? null, _bank: "", _case: String(q.caseInfo || q._case || "")
    });
  }
  log(`读取自建题语料完成, recs=${recs.length}`);
} else log("⚠️ 未找到 oursite_source.json，跳过自建题源（不致命）");

// ---------- 预处理：题干/选项指纹 ----------
let degenerate = 0, noOpt = 0;
for (const r of recs) {
  r._stemN = norm(r.stem);
  r._caseN = norm(r._case || "");
  const keys = Object.keys(r.options || {}).filter(k => /^[A-Z]$/.test(k));
  r._optVals = keys.map(k => norm(r.options[k])).filter(v => v.length > 0);
  r._optSet = new Set(r._optVals);
  r._optSorted = [...r._optVals].sort().join("\u0001");
  // 选项值全同（如全部“见图”）→ 图片题，文本层无法区分，独立成组
  r._degenerate = r._optVals.length >= 2 && r._optSet.size === 1;
  if (r._degenerate) degenerate++;
  if (r._optVals.length === 0) noOpt++;
}
log(`预处理完成：图片型(选项全同)=${degenerate} 无选项题=${noOpt}`);

// ---------- Union-Find ----------
const parent = recs.map((_, i) => i);
const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

// Pass1 严格键
const strict = new Map();
recs.forEach((r, i) => {
  if (r._degenerate) return;
  const base = r._stemN + "\u0003" + r._optSorted;
  const key = (r._caseN.length > 5 ? r._caseN + "\u0002" : "") + base;
  r._key = key;
  if (strict.has(key)) uni(strict.get(key), i); else strict.set(key, i);
});
log(`Pass1 严格键分组: ${strict.size}`);

// Pass2 同题干 + 选项集合高重合（容忍错别字/顺序）
const byStem = new Map();
recs.forEach((r, i) => {
  if (r._degenerate) return;
  const k = (r._caseN.length > 5 ? r._caseN + "\u0002" : "") + r._stemN;
  if (!byStem.has(k)) byStem.set(k, []);
  byStem.get(k).push(i);
});
const jac = (A, B) => {
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};
let pass2Merges = 0;
for (const [, idxs] of byStem) {
  if (idxs.length < 2) continue;
  // 只对“选项集合大小≥3”的题做模糊合并，避免 2 选项题误并
  const cand = idxs.filter(i => recs[i]._optSet.size >= 3);
  for (let a = 0; a < cand.length; a++) {
    for (let b = a + 1; b < cand.length; b++) {
      if (find(cand[a]) === find(cand[b])) continue;
      if (jac(recs[cand[a]]._optSet, recs[cand[b]]._optSet) >= 0.75) { uni(cand[a], cand[b]); pass2Merges++; }
    }
  }
}
log(`Pass2 模糊合并次数: ${pass2Merges}`);

// ---------- 分组 ----------
const groups = new Map();
recs.forEach((r, i) => {
  let root = find(i);
  if (r._degenerate) root = -i - 1; // 独立成组
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(r);
});
log(`最终分组: ${groups.size}`);

const PRIO = { jiguang: 0, oursite: 1, iyixue: 2 };
const PRIO_ORIGIN = { "极光": 0, "考研真题": 1, "医考帮": 2, "未知来源": 3, "自建": 4 };
/* 统一 schema 的扩展字段白名单（稀疏输出：有值才写）。
 * 前 6 项：iyixue 有值、旧版被丢；后 10 项：iyixue 预留字段，当前多为空/壳，但后续接口会填 → 通道必须保留。
 * 极光侧这些字段天然缺省（不写 null），下游一律用 `?? ''` 兜底。 */
const EXT_FIELDS = [
  'explanationBlocks', 'briefExplanation', 'suggestedTags', 'sourceType', 'nativeYear', 'ext',
  'mnemonic', 'knowledgePoint', 'knowledgePoints', 'optionExplanations', 'reasoningSteps',
  'frequencyLevel', 'studyPoints', 'memoryCards', 'memoryCardMeta', 'questionRevision'
];
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
  if (topSet.length === 1)
    return { rule: "priority", answer: topSet[0], manual: false, by: topItems.find(i => i.ans === topSet[0]).label, votes: `${cnt[topSet[0]]}/${total}` };
  const expAns = [...new Set(topItems.filter(i => i.hasExp).map(i => i.ans))];
  if (expAns.length === 1)
    return { rule: "priority+exp", answer: expAns[0], manual: false, by: topItems.find(i => i.ans === expAns[0] && i.hasExp).label + "(有解析)", votes: `${cnt[expAns[0]]}/${total}` };
  const [topAns, n] = sorted[0];
  if (n * 2 > total) return { rule: "majority", answer: topAns, manual: false, votes: `${n}/${total}` };
  return { rule: "manual", answer: main.answer, manual: true, note: "最高优先级来源内部自冲突且无多数", votes: `${n}/${total}` };
}

const merged = [], conflicts = [], manualReview = [], answerPatch = {};
let conflictCount = 0, patchedExplanation = 0;
let statPriority = 0, statMajority = 0, statWeak = 0, statText = 0, statManual = 0, statAgree = 0, statOpt = 0, statPrioExp = 0;
for (const [, g] of groups) {
  g.sort((a, b) => (PRIO[a.source] - PRIO[b.source]) || ((b.explanation.length || 0) - (a.explanation.length || 0)));
  const main = g[0];
  if (!main.explanation) {
    const alt = g.find(x => x !== main && x.explanation);
    if (alt) { main.explanation = alt.explanation; patchedExplanation++; }
  }
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
      dupKey: main._key || main._stemN, subject: main.subject, chapter: main.chapter, type: main.type,
      stem: main.stem.slice(0, 200), mainAnswer: main.answer, mainOrigin: main._group,
      options: main.options,
      decision: { answer: decision.answer, rule: decision.rule, by: decision.by || null, votes: decision.votes || null, note: decision.note || null },
      needManualReview: decision.manual,
      manualType: decision.manual ? ([...new Set(g.map(x => x._group))].length === 1 ? "singleSource" : "crossSource") : null,
      answers: g.map(x => ({ source: x.source, originGroup: x._group, origin: x._label, answer: x.answerRaw ?? x.answer, subject: x.subject, id: x.sourceId || "" }))
    };
    conflicts.push(rec);
    if (decision.manual) manualReview.push(rec);
    else answerPatch[main._key || main._stemN] = { answer: decision.answer, rule: decision.rule, by: decision.by || null };
  } else statAgree++;
  const detail = g.map(x => ({
    platform: x.source, group: x._group, label: x._label,
    year: x._year || undefined, method: x._method || undefined,
    bank: x._bank || undefined, subject: x.subject, id: x.sourceId || ""
  }));
  // 病例摘要：主记录没有时从同组其他记录借（极光无 caseInfo，iyixue 有）
  const caseInfo = main._case || (g.find(x => x._case) || {})._case || undefined;
  const out = {
    id: `${main.source}:${main.sourceId || (main._key || main._stemN).slice(0, 12)}`,
    subject: main.subject, chapter: main.chapter, type: main.type,
    stem: main.stem, options: main.options, answer: main.answer,
    caseInfo,
    answerResolved: decision ? decision.answer : main.answer,
    answerRule: decision ? decision.rule : "none",
    needManualReview: decision ? !!decision.manual : false,
    conflictType: !decision ? "none" : ([...new Set(g.map(x => x._group))].length === 1 ? "singleSourceNumeric" : "crossSource"),
    conflictRule: decision ? decision.rule : null,
    explanation: main.explanation, aiExplanation: main.aiExplanation || null,
    difficulty: main.difficulty, tags: main.tags,
    originGroup: main._group, origin: main._label, examYear: main._year || undefined,
    importMethod: main._method || undefined,
    sourceTags: [...new Set(g.map(x => x._label))],
    originGroups: [...new Set(g.map(x => x._group))],
    sources: [...new Set(g.map(x => x.source))],
    sourceDetail: detail, sourceCount: g.length, dupKey: main._key || main._stemN,
    hasConflict: conflict, altAnswers: conflict ? answers : undefined
  };
  /* ---- 扩展字段透传（稀疏：非空才写，避免 10 万题 × 空字段白涨体积；schema 见 schema_unified.json）---- */
  const nonEmpty = v => !(v === undefined || v === null || v === '' ||
    (Array.isArray(v) && !v.length) ||
    (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length));
  for (const k of EXT_FIELDS) {
    let v = nonEmpty(main[k]) ? main[k] : undefined;
    if (v === undefined) { const alt = g.find(x => x !== main && nonEmpty(x[k])); if (alt) v = alt[k]; }
    if (v !== undefined) out[k] = v;
  }
  merged.push(out);
}

// ---------- 输出 ----------
const bySubject = new Map();
for (const q of merged) { if (!bySubject.has(q.subject)) bySubject.set(q.subject, []); bySubject.get(q.subject).push(q); }
let wi = 0;
for (const [subj, arr] of bySubject) {
  const safe = subj.replace(/[\\/:*?"<>|]/g, "_");
  await writeFile(`${OUT}/by_subject/${safe}.json`, JSON.stringify(arr));
  if (++wi % 20 === 0) log(`by_subject ${wi}/${bySubject.size}`);
}
log(`by_subject done: ${bySubject.size} 个学科`);

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
  await writeFile(`${OUT}/by_origin/${grp}.json`, JSON.stringify(brief, null, 1));
  log(`by_origin/${grp}.json (${brief.length})`);
}

const report = {
  generatedAt: new Date().toISOString(),
  mergeVersion: "v2 (stem + option-fingerprint + fuzzy union)",
  input: { jiguangUnique: seenJg.size, totalRecords: recs.length },
  merged: { uniqueQuestions: merged.length, dedupRemoved: recs.length - merged.length },
  degenerateImageQuestions: degenerate,
  pass2FuzzyMerges: pass2Merges,
  bySourceCount: merged.reduce((a, q) => { const k = q.sources.join("+"); a[k] = (a[k] || 0) + 1; return a; }, {}),
  byOriginGroup: merged.reduce((a, q) => { a[q.originGroup] = (a[q.originGroup] || 0) + 1; return a; }, {}),
  conflicts: conflictCount,
  conflictResolution: {
    total: conflictCount,
    autoResolved: statPriority + statMajority + statOpt + statPrioExp,
    byPriority: statPriority, byPriorityWithExplanation: statPrioExp, byOptionCheck: statOpt, byMajority: statMajority,
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
await writeFile(`${OUT}/conflicts_manual_cross_source.json`, JSON.stringify(manualReview.filter(c => c.manualType === "crossSource"), null, 1));
await writeFile(`${OUT}/conflicts_manual_single_source.json`, JSON.stringify(manualReview.filter(c => c.manualType === "singleSource"), null, 1));
await writeFile(`${OUT}/answer_patch.json`, JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: "key = 病例摘要+题干+选项指纹 归一化，value = 裁决答案",
  patch: answerPatch
}, null, 1));

log(`v2 结果: 唯一题 ${merged.length}（v1 104991）｜冲突 ${conflictCount}（v1 1504）｜需人工 ${manualReview.length}（v1 295）`);
console.log(JSON.stringify(report.conflictResolution, null, 1));
