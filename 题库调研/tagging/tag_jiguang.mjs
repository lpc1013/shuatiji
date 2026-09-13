/**
 * 极光题补标签 — Tier A（合并伙伴继承）+ Tier B（词表语义匹配）
 * 产物：tagging/jiguang_tags.json  { <merged2题id>: ["tag", ...] }  —— sidecar，不直接改 merged2
 *       tagging/_report.txt        分层覆盖率报告
 *       tagging/_ai_todo.json      Tier C 待 AI 补标清单（题干/选项/章节/词表提示）
 *
 * 铁律：
 *  - 只填 tags 为空、且 sources 含 jiguang 的题；扩展题已有 tags 一律不动。
 *  - 元标签（A 必背 / X型题 等）绝不写入 —— 与前端 features.js isMetaTag 口径一致。
 *  - Tier B 不武断兜底：章节名本身不当标签，只作同章节词表使用频次的旁证；
 *    匹配不到就留空，交给 Tier C（AI）。
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

const WS = "D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学";
const M = WS + "/题库调研/merged2/by_subject";
const OUT_DIR = WS + "/题库调研/tagging";
const SITE_SUBJECTS = new Set(["生物化学", "生理学", "医学免疫学"]); // build_site_data.mjs ONLY（医学英语无关）

const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
async function ensureDir(d) { for (let i = 0; i < 6; i++) { try { await mkdir(d, { recursive: true }); if (existsSync(d)) return true; } catch { } await new Promise(r => setTimeout(r, 200)); } return false; }

/* Tier C AI 补标结果（允许新词）。存在即消费；校验覆盖率打在报告里 */
const AI_TAGS = existsSync(OUT_DIR + "/_ai_tags.json")
  ? JSON.parse(await readFile(OUT_DIR + "/_ai_tags.json", "utf8"))
  : {};

/* 与 site/features.js isMetaTag 同口径 */
const isMetaTag = t => {
  const s = String(t || "").trim();
  if (!s) return true;
  if (/型题|A\d+型|^(多选题|定义题|错题辨析)/.test(s)) return true;
  if (/(必背|高频|低频|中频|常规|考频|常考)/.test(s)) return true;
  return false;
};
const cleanTags = arr => [...new Set((arr || []).map(t => String(t || "").trim()).filter(t => t && !isMetaTag(t)))];

/* 中文文本归一化：去空白与标点（词表 tag 是连续医学名词，子串匹配前两侧同规约） */
const PUNC = /[，。、；：？！""''（）【】《》\s\.,;:?!"'()\[\]{}<>~`\-_—…·\/\\|@#$%^&*+=]/g;
const norm = s => String(s || "").replace(PUNC, "").toLowerCase();
const isJg = q => Array.isArray(q.sources) && q.sources.includes("jiguang");

await ensureDir(OUT_DIR);
const sidecar = {};                 // merged2 题id -> tags[]
const report = { subjects: {} };
const aiTodo = {};

for (const subj of SITE_SUBJECTS) {
  const arr = JSON.parse(await readFile(`${M}/${subj}.json`, "utf8"));
  const r = report.subjects[subj] = { jg: 0, tierA: 0, tierB: 0, tierC: 0, stillEmpty: 0, vocabSize: 0 };

  // ---- 词表：本科全部题的 tags + suggestedTags（去元标签），记频次与章节分布 ----
  const vocab = new Map();          // tag -> {freq, chapters:Map}
  for (const q of arr) {
    const tags = cleanTags([...(q.tags || []), ...(q.suggestedTags || [])]);
    for (const t of tags) {
      let v = vocab.get(t);
      if (!v) vocab.set(t, v = { freq: 0, chapters: new Map() });
      v.freq++;
      const ch = q.chapter || "(空)";
      v.chapters.set(ch, (v.chapters.get(ch) || 0) + 1);
    }
  }
  r.vocabSize = vocab.size;

  // ---- 同章节使用次数（Tier B 旁证）：章节 -> tag -> 次数 ----
  const chapVote = new Map();
  for (const q of arr) {
    for (const t of cleanTags(q.tags || [])) {
      const ch = q.chapter || "(空)";
      if (!chapVote.has(ch)) chapVote.set(ch, new Map());
      const m = chapVote.get(ch);
      m.set(t, (m.get(t) || 0) + 1);
    }
  }

  // ---- Tier A + Tier B ----
  for (const q of arr) {
    if (!isJg(q)) continue;
    r.jg++;
    const exist = cleanTags(q.tags || []);
    if (exist.length) { sidecar[q.id] = exist; continue; }   // 已有原生 tags（罕见）：照抄，不动

    // Tier A：合并伙伴继承 —— suggestedTags 即去重合并时保下来的搭档标签
    const aTags = cleanTags(q.suggestedTags || []);
    if (aTags.length) { sidecar[q.id] = aTags; r.tierA++; continue; }

    // Tier B：词表语义匹配（非武断兜底）
    const stemN = norm((q.caseInfo || "") + " " + (q.stem || ""));
    const optN = norm(Object.values(q.options || {}).join(" "));
    const ch = q.chapter || "(空)";
    const votes = chapVote.get(ch) || new Map();
    const scored = [];
    for (const [tag, v] of vocab) {
      if (tag.length < 2) continue;
      const inStem = stemN.includes(norm(tag));
      const inOpt = optN.includes(norm(tag));
      if (!inStem && !inOpt) continue;
      const cv = votes.get(tag) || 0;
      let score = (inStem ? 2 : 0) + (inOpt ? 1 : 0) + (cv >= 3 ? 2 : cv > 0 ? 1 : 0);
      scored.push({ tag, score, freq: v.freq });
    }
    scored.sort((a, b) => b.score - a.score || b.freq - a.freq);
    const picked = scored.slice(0, 3).filter(s => s.score >= 2).map(s => s.tag);
    if (picked.length) { sidecar[q.id] = picked; r.tierB++; continue; }

    // Tier C：AI 补标 —— _ai_tags.json（允许新词，词表优先），没有才进待办
    const ai = AI_TAGS[q.id];
    if (ai && ai.length) { sidecar[q.id] = cleanTags(ai); r.tierC++; continue; }
    r.tierC++;
    aiTodo[q.id] = {
      subject: subj, chapter: q.chapter || "",
      stem: q.stem || "", caseInfo: q.caseInfo || "",
      options: q.options || {},
      hint: [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t)
    };
  }
  r.stillEmpty = r.jg - r.tierA - r.tierB - (Object.keys(aiTodo).length ? 0 : 0); // tierC 即剩余，全导出
}

const total = Object.values(report.subjects).reduce((s, r) => s + r.jg, 0);
const aSum = Object.values(report.subjects).reduce((s, r) => s + r.tierA, 0);
const bSum = Object.values(report.subjects).reduce((s, r) => s + r.tierB, 0);
const cSum = Object.values(report.subjects).reduce((s, r) => s + r.tierC, 0);
const cAi = cSum - Object.keys(aiTodo).length;   // AI 已补标数 = C 总数 - 仍待办数

await writeFile(OUT_DIR + "/jiguang_tags.json", JSON.stringify(sidecar, null, 1), "utf8");
await writeFile(OUT_DIR + "/_ai_todo.json", JSON.stringify(aiTodo, null, 1), "utf8");
const lines = [
  `极光题补标签（Tier A 继承 + Tier B 词表匹配 + Tier C AI 补标）`,
  `总极光题 ${total} | A 继承 ${aSum} (${(aSum / total * 100).toFixed(1)}%) | B 匹配 ${bSum} (${(bSum / total * 100).toFixed(1)}%) | C AI已补 ${cAi} / 待办 ${Object.keys(aiTodo).length} | 合计覆盖 ${total - Object.keys(aiTodo).length}/${total} (${((total - Object.keys(aiTodo).length) / total * 100).toFixed(1)}%)`,
  ...Object.entries(report.subjects).map(([s, r]) =>
    `  ${s}: 极光 ${r.jg} | A ${r.tierA} | B ${r.tierB} | C ${r.tierC} | 词表 ${r.vocabSize}`)
];
await writeFile(OUT_DIR + "/_report.txt", lines.join("\n"), "utf8");
console.log(lines.join("\n"));
