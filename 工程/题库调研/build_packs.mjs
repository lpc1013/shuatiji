/**
 * 按学期打包题库 → 工程/题库调研/packs/<学期>/{极光,扩展}/<学科>.json + explain/<学科>.json
 *
 * 设计要点：
 *  1. 学期粒度：大一/大二/大三/大四/水平测试（不分上下学期）
 *  2. 每组科目内分成【极光】与【扩展】两个文件夹
 *       极光 = 该题来自极光题库（含跨源题）→ **保留极光原始 UUID 作为 id**，保证用户既有刷题进度/收藏/错题不失效
 *       扩展 = 极光没有的新题（医考帮/考研真题/未知来源/自建）→ id = ext-<hash16>
 *  3. 主体文件瘦身（不含解析，可直接塞进前端）；解析单独放 explain/<学科>.json，做题时按需加载
 *  4. 极光题在打包时套用 lib_fix 修复（选项跳号/题干残留选项/冗余前缀/HTML）
 */
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { createHash } from "crypto";
import { fixQuestion } from "./lib_fix.mjs";

const WS = "D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学";
// 数据源：merged2（v2 合并键 = 病例摘要+题干+选项指纹，修正了 v1 只用题干造成的误合并）
const M = WS + "/工程/题库调研/merged2";
const OUT = WS + "/工程/题库调研/packs";
// 教材裁决产物：改判表 + 不可裁决清单
const OV = JSON.parse(await readFile(WS + "/工程/题库调研/merged2/answer_overrides.json", "utf8")).overrides || {};
const AMB = new Map();
{
  const r = JSON.parse(await readFile(WS + "/工程/题库调研/merged2/conflicts_single_source_resolved.json", "utf8"));
  for (const it of r.items || []) {
    if (it.status !== "ambiguous" && it.status !== "unresolved-auto") continue;
    const k = it.subject + "|" + String(it.stem).replace(/\s+/g, "").slice(0, 60);
    AMB.set(k, it.ambiguityReason || it.note || "源数据答案存在分歧");
  }
}
// 元数据索引（前端筛选面板 / 排序所需，由 enrich_index.mjs 生成）
//   极光：站点自身统计 —— 答题人次(热度)、正确率、收藏数、难度、图片数
//   iyixue：年份、题目来源、系统
const JGS = JSON.parse(await readFile(WS + "/工程/题库调研/index_jiguang_stats.json", "utf8"));
const YX = JSON.parse(await readFile(WS + "/工程/题库调研/index_iyixue_meta.json", "utf8"));
/* 极光题补标签 sidecar（tagging/tag_jiguang.mjs 产出）：merged2题id -> tags[]。
 * 只在 q.tags 为空时注入，扩展题原生 tags 一律不动。 */
const JGTAGS = JSON.parse(await readFile(WS + "/工程/题库调研/tagging/jiguang_tags.json", "utf8"));

const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
async function ensureDir(d) { for (let i = 0; i < 6; i++) { try { await mkdir(d, { recursive: true }); if (existsSync(d)) return true; } catch { } await new Promise(r => setTimeout(r, 200)); } return false; }

// ---------------- 学期归属表（63 学科） ----------------
const SEMESTER = {
  // 大一
  "系统解剖学": "大一", "组织学与胚胎学": "大一", "医学细胞生物学": "大一", "医用物理学": "大一",
  "python": "大一", "思想道德与法治": "大一", "军事理论": "大一",
  // 大二
  "生物化学": "大二", "生理学": "大二", "医学免疫学": "大二", "医学微生物学": "大二", "病理学": "大二",
  "病理生理学": "大二", "医学遗传学": "大二", "医学伦理学": "大二", "马克思主义原理": "大二",
  "医学人文": "大二", "局部解剖学": "大二",
  // 大三
  "诊断学": "大三", "实验诊断": "大三", "医学影像学": "大三", "核医学": "大三", "外基": "大三",
  "卫生学": "大三", "医学统计学": "大三", "近代史": "大三", "药理学": "大三", "预防医学": "大三",
  "人体寄生虫学": "大三", "流行病学": "大三", "医学心理学": "大三", "中医学": "大三", "介入放射学": "大三",
  // 大四
  "内科学": "大四", "外科学": "大四", "儿科学": "大四", "神经病学": "大四", "精神病学": "大四",
  "皮肤性病学": "大四", "眼科学": "大四", "耳鼻咽喉头颈外科学": "大四", "传染病学": "大四",
  "急诊与灾难医学": "大四", "小儿外科学": "大四", "医患沟通": "大四", "妇产科学": "大四",
  "临床麻醉学": "大四", "全科医学概论": "大四", "危重病医学": "大四", "口腔科学": "大四", "法医学": "大四",
  // 水平测试
  "代谢、内分泌系统": "水平测试", "儿科疾病": "水平测试", "全部": "水平测试", "呼吸系统": "水平测试",
  "女性生殖系统": "水平测试", "心血管系统": "水平测试", "泌尿系统（含男性生殖系统）": "水平测试",
  "消化系统": "水平测试", "精神、神经系统": "水平测试", "血液系统": "水平测试", "运动系统": "水平测试",
  "野题": "水平测试", "风湿免疫性疾病": "水平测试"
};
const SEM_ORDER = ["大一", "大二", "大三", "大四", "水平测试"];
const GEN_SUBJECTS = new Set(["python", "军事理论", "思想道德与法治", "近代史", "马克思主义原理", "医学伦理学", "医患沟通", "医学人文"]);
// 网站 site/data 的学科名是简称，兜底补齐时需先归一化，否则会因查不到学期而被静默跳过
const SUBJECT_ALIAS = {
  "生化": "生物化学", "生理": "生理学", "免疫": "医学免疫学", "微生物": "医学微生物学",
  "病理": "病理学", "病理生理": "病理生理学", "遗传": "医学遗传学", "组胚": "组织学与胚胎学",
  "细胞生物学": "医学细胞生物学", "伦理": "医学伦理学", "影像": "医学影像学",
  "传染病（test）": "传染病学", "临床诊断": "诊断学", "外科学（test）": "外科学",
  "内科学（test）": "内科学", "儿童医院社区实习": "儿科学", "外科基础": "外基",
  "生物化学与分子生物学": "生物化学"
};
const stdSubject = s => SUBJECT_ALIAS[s] || String(s || "").trim();

/* 9 个预留字段 + questionRevision：iyixue 侧当前多为空/壳值（预留 schema 位），
 * 但后续接口会填 → 打包通道必须保留。稀疏策略：有值才写，不写 null。 */
const RESERVED_FIELDS = [
  "mnemonic", "knowledgePoint", "knowledgePoints", "optionExplanations", "reasoningSteps",
  "frequencyLevel", "studyPoints", "memoryCards", "memoryCardMeta", "questionRevision"
];

/* 「有值才写」判据：壳值（如 memoryCardMeta = {schemaVersion:1,generator,generatedAt:""}）不算有值。
 * 通道保留指的是代码里的这段逻辑，不是把壳值物理写进产物 —— 否则 1.5 万题白白多写 0.7MB。 */
const SHELL_KEYS = new Set(["schemaVersion", "generator", "generatedAt"]);
function hasRealValue(v) {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).some(k => !SHELL_KEYS.has(k) && v[k] !== "" && v[k] !== null);
  return true;
}

/* ---------------- 富解析：explanationBlocks + 文本补全 ----------------
 * 源站把解析拆成了带类型的块（paragraph / table / list / callout）+ 小节标签。
 * 但它只覆盖 analysis/answerBasis/pitfalls/clinicalNotes 四类，**不含「教材出处」**
 * （文本里 1890 条有），所以必须用文本的 `### 小节` 补全，否则会丢内容。
 * 输出用紧凑数组而非对象：[[type, sec, title, ...payload]]，字段名省下来直接进前端分片体积。
 *   p  段落   ["p",  sec, title, text]
 *   c  提示   ["c",  sec, title, text, tone]
 *   l  列表   ["l",  sec, title, [items]]
 *   tb 表格   ["tb", sec, title, [cols], [[cell,...],...]]
 * sec 短码：an 考点解析 / ab 答案依据 / pf 易错点 / cn 临床要点 / tx 教材出处 */
const SEC_BY_SECTION = { analysis: "an", answerBasis: "ab", pitfalls: "pf", clinicalNotes: "cn" };
const SEC_BY_TITLE = [
  [/考点解析|题干分析|解题分析|解析/, "an"],
  [/正确答案依据|答案依据/, "ab"],
  [/易错点/, "pf"],
  [/临床与操作要点|临床要点/, "cn"],
  [/教材出处|教材依据|出处/, "tx"],
];
const secOfTitle = t => { for (const [re, s] of SEC_BY_TITLE) if (re.test(t)) return s; return "an"; };
const BLOCK_TYPE = { paragraph: "p", callout: "c", list: "l", table: "tb" };
function compactBlock(b) {
  const sec = SEC_BY_SECTION[b.section] || secOfTitle(b.title || "");
  const t = BLOCK_TYPE[b.type] || "p";
  if (t === "tb") return ["tb", sec, b.title || "", b.columns || [], b.rows || []];
  if (t === "l") return ["l", sec, b.title || "", b.items || (b.text ? [b.text] : [])];
  if (t === "c") return ["c", sec, b.title || "", b.text || "", b.tone || ""];
  return ["p", sec, b.title || "", b.text || ""];
}
const cellsOf = l => l.replace(/^\||\|$/g, "").split("|").map(s => s.trim());
/* 文本 Markdown → 块。只产出 blocks 未覆盖的小节（haveSecs 为已覆盖的短码集合）。 */
function blocksFromText(text, haveSecs) {
  const src = String(text || "");
  if (!src.trim()) return [];
  const parts = src.split(/^###\s*(.+)$/m);
  const out = [];
  if (parts.length < 3) return out;           // 无小节标题：交由调用方按纯文本兜底
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i].trim(), body = (parts[i + 1] || "").trim();
    if (!body) continue;
    const sec = secOfTitle(title);
    if (haveSecs.has(sec)) continue;          // blocks 已有该小节 → 不重复
    const lines = body.split("\n").map(s => s.trim()).filter(Boolean);
    const tblLines = lines.filter(l => /^\|/.test(l));
    if (tblLines.length >= 2) { out.push(["tb", sec, title, cellsOf(tblLines[0]), tblLines.slice(2).map(cellsOf)]); continue; }
    const li = lines.filter(l => /^[-*]\s+/.test(l));
    if (li.length >= 2) { out.push(["l", sec, title, li.map(l => l.replace(/^[-*]\s+/, ""))]); continue; }
    out.push(["p", sec, title, body.replace(/\*\*/g, "")]);
  }
  return out;
}

/* ---------------- 题目文本指纹（供「上一版 id 反查」用） ----------------
 * 为什么需要：扩展题历史上 id = `ext-<sha1(dupKey)>`，**与题干内容绑定** ——
 * 改一次去重规则或润一次题干，id 就漂移。要把存量老 id 收进新主 id 的 aliasIds
 * （网站据此零丢失迁移），必须先「按内容」把上一版 packs 里那道题找回来。
 * 这里**不复刻 merge2 的 dupKey**（那是修复前文本 + 并查集分组产物），
 * 而是对两边都算「最终入库文本」的指纹：上一版 packs 的 q/o 就是最终文本，
 * 本次构建的扩展组同样直接用 q.stem/q.options，两边口径一致。
 * norm 与 merge2.mjs 严格保持一致，避免同一文本算出两种指纹。 */
const PUNC = /[，。、；：？！""''（）【】《》\.,;:?!'"()\[\]{}<>~`\-_—…·\/\\|@#$%^&*+=\s]/g;
function norm(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/<[^>]*>/g, "").replace(/&[a-z]+;|&#\d+;/gi, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(PUNC, "").toLowerCase().trim();
}
function fpOf(stem, options, caseInfo) {
  const opts = options || {};
  const vals = Object.keys(opts).filter(k => /^[A-Z]$/.test(k)).map(k => norm(opts[k])).filter(v => v.length > 0);
  const s = norm(stem), c = norm(caseInfo || "");
  // 选项值全同（如全是「见图」）→ 图片题，选项无法区分，退回「只用题干」，与 merge2 一致
  if (vals.length >= 2 && new Set(vals).size === 1) return "\u0004" + s;
  return (c.length > 5 ? c + "\u0002" : "") + s + "\u0003" + [...vals].sort().join("\u0001");
}

// ---------------- 上一版 packs 基线（必须在「清理输出目录」之前读取）----------------
// 原实现读 site/data/data.js 取「网站当前正在用的 id」；该文件已被分片方案取代而删除，
// 导致 siteIds 恒为空 → 主 id 退化为 allIds[0]，有 id 漂移风险。
// 改为直接读上一版 packs：语义等价（site/data 就是由 packs 生成的），且必须读在 rm 之前。
/* 基线目录：默认 OUT（上一版 packs）。可传 argv[2] 指向一份外部「干净历史 packs」快照 ——
 * 重建时就不必先把基线镜像回 OUT（robocopy 刚写完的文件句柄会与随后的 rm 抢锁，
 * 曾导致 rm 只删掉一部分、输出目录残缺）。 */
const PREV = process.argv[2] || OUT;
const prevPacks = new Map();  // 主 id -> item（含 _subject/_sem/_grp，用于兜底补回）
const prevAlias = new Map();  // 别名 id -> 主 id
const prevByFp = new Map();   // 文本指纹 -> 上一版主 id（"__AMBIG__" = 撞键，反查时跳过）
{
  const SEMS_ALL = ["大一", "大二", "大三", "大四", "水平测试"];
  for (const sem of SEMS_ALL) {
    for (const grp of ["极光", "扩展"]) {
      const d = `${PREV}/${sem}/${grp}`;
      if (!existsSync(d)) continue;
      for (const f of await readdir(d)) {
        if (!f.endsWith(".json")) continue;
        let arr; try { arr = JSON.parse(await readFile(`${d}/${f}`, "utf8")); } catch { continue; }
        if (!Array.isArray(arr)) continue;
        for (const q of arr) {
          if (!q || !q.id) continue;
          if (!prevPacks.has(q.id)) prevPacks.set(q.id, { ...q, _subject: f.replace(/\.json$/, ""), _sem: sem, _grp: grp });
          if (q.flags && q.flags.aliasIds) for (const a of q.flags.aliasIds) if (!prevAlias.has(a)) prevAlias.set(a, q.id);
          /* 文本指纹 → 上一版主 id：本次构建据此把「旧 ext-<hash>」收进新主 id 的 aliasIds，
           * 这是老进度零丢失的关键一环（旧 id 不在 sourceDetail 里，只能这样捞回来）。
           * 同一指纹撞上不同 id（图片题 / 重复题）时标 __AMBIG__，反查时保守跳过。 */
          const fp = fpOf(q.stem, q.options, q.caseInfo);   // ⚠️ packs item 用长字段 stem/options，不是 merge2 的短字段 q/o
          const prev = prevByFp.get(fp);
          if (prev === undefined) prevByFp.set(fp, q.id);
          else if (prev !== q.id) prevByFp.set(fp, "__AMBIG__");
        }
      }
    }
  }
}
const siteIds = new Set([...prevPacks.keys(), ...prevAlias.keys()]);
log(`上一版 packs id 基线 ${siteIds.size}（主 ${prevPacks.size} + 别名 ${prevAlias.size}）← ${PREV}`);

log("清理输出目录");
const { rm, rename } = await import("fs/promises");
for (let i = 0; i < 5; i++) { try { await rm(OUT, { recursive: true, force: true }); } catch { } if (!existsSync(OUT)) break; await new Promise(r => setTimeout(r, 300)); }
if (existsSync(OUT)) {
  /* 句柄占用（Defender/索引/刚写完的 robocopy）会导致 rm 只删掉一部分 ——
   * 那样后续写入会与残留文件混在一起，产出「大二整个缺失」这类残档且不报错。
   * 兜底：改名挪走（rename 不删文件，通常能成），再彻底删。仍不行就硬失败。 */
  const trash = `${OUT}_trash_${Date.now()}`;
  try { await rename(OUT, trash); rm(trash, { recursive: true, force: true }).catch(() => { }); } catch { }
  for (let i = 0; i < 5 && existsSync(OUT); i++) { try { await rm(OUT, { recursive: true, force: true }); } catch { } await new Promise(r => setTimeout(r, 300)); }
}
if (existsSync(OUT)) { console.error("FATAL 输出目录清不掉（有进程占用）: " + OUT); process.exit(1); }
if (!await ensureDir(OUT)) { console.error("FATAL ensureDir"); process.exit(1); }

// ---------------- 读取 merged ----------------

const subs = (await readdir(M + "/by_subject")).filter(f => f.endsWith(".json"));
log(`读入 ${subs.length} 个学科分片`);
const buckets = new Map();  // `${sem}|${group}` → Map(subject → [items])
const explainMap = new Map(); // `${sem}|${subject}` → {qid: 富解析 {bf?, b:[块]|t:文本}}
const packedIds = new Set();  // 已入包的极光 id（含别名），用于兜底补齐网站遗漏题
const stat = { total: 0, jg: 0, ext: 0, bySem: {}, bySource: {}, fixed: 0, unfixed: [], unknownSem: {}, siteFilled: 0, overridden: 0, ambiguous: 0, stemIncomplete: 0, metaD: 0, metaN: 0, metaAc: 0, metaY: 0 };
const hash = s => createHash("sha1").update(s).digest("hex").slice(0, 16);
/* —— 主 id 唯一性守卫 ——
 * 一题一主 id：绝不允许两题共用一个主 id（否则网站里两题共用一个进度键、互相覆盖）。
 * 触发场景：同源题因题干脏/净差异被 merge2 分成两条，两条的 sourceDetail 却是同一个源 id。
 * 别名延迟落盘：等全部主 id 定完，再把「其实是别人主 id」的候选剔除 —— 否则
 * ALIAS[别题的主 id] 会把那题指向本题（qById 走 ALIAS[id]||id 会认错题）。 */
const usedPrimary = new Set();
// 跨组稳定源 id 锚定：同一稳定源 id 同时出现在「极光组」「扩展组」两条记录时，应合并为同一主 id，
// 而非各发一个（id 分裂 → 站内同题两条、进度对不上）。先到者认领，后到者判定同源重复题并跳过。
const stableAnchor = new Map();
const stableOf = q => [...new Set((q.sourceDetail || []).map(d => String(d.id || "").replace(/^(jiguang|oursite|iyixue|self):/, "")).filter(id => id && !/^ext-/.test(id) && !/^jg-/.test(id)))];
const aliasRecs = [];
const pickUnused = cands => { for (const x of cands) if (x && !usedPrimary.has(x)) return x; return null; };

for (const f of subs) {
  const subject = f.replace(/\.json$/, "");
  const sem = SEMESTER[subject];
  if (!sem) { stat.unknownSem[subject] = (stat.unknownSem[subject] || 0) + 1; continue; }
  let arr; try { arr = JSON.parse(await readFile(M + "/by_subject/" + f, "utf8")); } catch (e) { log(`SKIP ${f}: ${e.message}`); continue; }
  stat.bySem[sem] = (stat.bySem[sem] || 0) + arr.length;

  for (const q of arr) {
    stat.total++;
    stat.bySource[q.originGroup] = (stat.bySource[q.originGroup] || 0) + 1;
    const sids = stableOf(q);
    const dupAnchor = sids.find(s => stableAnchor.has(s));
    if (dupAnchor) { stat.dupCrossGroup = (stat.dupCrossGroup || 0) + 1; continue; }
    const isJg = q.originGroup === "极光";
    let id, stem = q.stem, options = q.options, answer = q.answerResolved || q.answer;
    let flags = null;
    let meta = null;
    let aliasCands = null;   // 别名候选（延迟落盘，见 usedPrimary 注释）

    if (isJg) {
      stat.jg++;
      // 极光同题可能有多个 id（极光内部重复副本 + 我方站点早期另建的 UUID）。
      // ⚠️ 必须把 jiguang 与 oursite 两套 id 全部纳入别名集合：
      //    网站进度/收藏/错题/复习计划以 id 为 key，任何一个漏掉都会让那部分用户数据失效。
      //    优先采用「网站当前正在用的 id」作为主 id。
      const allIds = [...new Set((q.sourceDetail || [])
        .filter(d => d.id && (d.platform === "jiguang" || d.platform === "oursite"))
        .map(d => d.id))];
      const self = String(q.id || "").replace(/^(jiguang|oursite|iyixue|self):/, "");
      if (self && !allIds.includes(self)) allIds.unshift(self);
      /* 增补：其它平台（iyixue 等）的 id **只要已在「网站当前在用」集合里**（说明确实有人
       * 存过它）也纳入别名。只收在用的 —— 把 8 万个从没人存过的源 id 灌进 aliasIds
       * 只会白白撑大前端分片，对用户进度毫无帮助。 */
      for (const d of (q.sourceDetail || [])) {
        if (d.id && !allIds.includes(d.id) && siteIds.has(d.id)) allIds.push(d.id);
      }
      /* 上一版 id 反查：极光题主 id 是极光 UUID，通常 siteIds 直接命中；这里只是兜住
       * 「某题被重新归类 / 主 id 曾变过」的情况，命中则优先沿用。 */
      {
        const hfp = fpOf(q.stem, q.options, q.caseInfo);
        const hprev = prevByFp.get(hfp);
        if (hprev && hprev !== "__AMBIG__" && !allIds.includes(hprev) && siteIds.has(hprev)) allIds.push(hprev);
      }
      // 优先「网站当前在用」的 id；若该 id 已被别题占用则退而求其次（保证主 id 唯一）
      let primary = pickUnused([...allIds.filter(x => siteIds.has(x)), ...allIds]);
      if (!primary) { const b = "jg-" + hash(q.dupKey || q.stem); primary = b; let _i = 1; while (usedPrimary.has(primary)) primary = b + "-" + (_i++); }
      id = primary;
      usedPrimary.add(id);
      aliasCands = allIds.filter(x => x !== id);
      const r = fixQuestion(stem, options, answer, q.type);
      if (r.changed) { stat.fixed++; stem = r.stem; options = r.options; answer = r.answer; }
      if (r.imageMissing) (flags ||= {}).imageMissing = true;
      if (r.missingOption) (flags ||= {}).missingOption = r.missingOption;
      if (!String(stem).trim()) (flags ||= {}).stemEmpty = true;
      // 极光站点统计（同一题可能有多个 id，任一命中即可）
      const js = allIds.map(x => JGS[x]).find(Boolean);
      if (js) meta = {
        d: js.d || null,
        n: js.ta || 0,
        ac: js.ta > 0 ? Math.round(100 * js.tc / js.ta) : null,
        fv: js.tf || 0,
        img: js.img || 0,
        cid: js.cid || null   // 极光章节 UUID —— 站点靠它保持「分章进度 / 断点会话」与旧版一致
      };
    } else {
      stat.ext++;
      /* —— 统一 id 网（扩展组）——
       * 旧实现 id = ext-<sha1(dupKey)> **与题干内容绑定**：改一次去重规则 / 润一次题干，
       * 这一整批题的 id 就集体漂移，旧 id 又被兜底补回 → 站内同题两条、用户进度对不上。
       * 现在锚在「来源」上，优先级：
       *   ① 上一版在用 且 是稳定锚（源 id / UUID）→ 沿用，零迁移
       *   ② 源站稳定 id（ykb_<年月>_<卷>_<题号> / school_… / UUID）→ 与题干彻底解绑
       *   ③ 上一版 ext-<hash>（靠文本指纹反查拿回）→ 老进度兼容
       *   ④ ext-<hash(dupKey)> → 兜底（全新题且无任何来源 id）
       * 其余候选一律进 flags.aliasIds，网站运行期据此把老 id 映射回主 id。 */
      const allIds = [...new Set((q.sourceDetail || []).filter(d => d.id).map(d => d.id))];
      const self = String(q.id || "").replace(/^(jiguang|oursite|iyixue|self):/, "");
      if (self && !allIds.includes(self)) allIds.unshift(self);
      const stable = x => !!x && !/^ext-/.test(x);
      const efp = fpOf(q.stem, q.options, q.caseInfo);
      const eHit = prevByFp.get(efp);
      const prevId = (eHit && eHit !== "__AMBIG__") ? eHit : null;
      if (prevId) stat.extFpHit = (stat.extFpHit || 0) + 1; else stat.extFpMiss = (stat.extFpMiss || 0) + 1;
      // 与上面 极光 相同：候选按优先级排队，取第一个「还没被别题占用」的
      let primaryExt =
        pickUnused([(prevId && stable(prevId)) ? prevId : null, ...allIds.filter(stable)].filter(Boolean))
        || pickUnused([prevId, ...allIds].filter(Boolean));
      if (!primaryExt) { const b = "ext-" + hash(q.dupKey || (q.stem + JSON.stringify(q.options))); primaryExt = b; let _i = 1; while (usedPrimary.has(primaryExt)) primaryExt = b + "-" + (_i++); }
      id = primaryExt;
      usedPrimary.add(id);
      if (stable(primaryExt)) stat.extStable = (stat.extStable || 0) + 1;
      const aliasSet = new Set(allIds.filter(x => x !== primaryExt));
      if (prevId && prevId !== primaryExt) aliasSet.add(prevId);
      /* A02 修复：继承「上一版该题（prevId）挂着的全部别名」——
       * 防「前前版 id」在多次主 id 变更后静默丢失（本次事故正因：A02 基线已不含 ext-，
       * 且扩展组不继承 aliasIds → lpc 270 条 ext- 死链）。配合用 A02 前的历史基线重建，
       * 旧 ext-<hash> 经 prevId 进入别名网。 */
      const prevItem = prevId ? prevPacks.get(prevId) : null;
      if (prevItem && prevItem.flags && prevItem.flags.aliasIds)
        for (const a of prevItem.flags.aliasIds) if (a !== primaryExt) aliasSet.add(a);
      aliasCands = [...aliasSet];
      // iyixue 元数据（年份 / 题目来源 / 系统）
      const ym = (q.sourceDetail || [])
        .filter(d => d.platform === "iyixue" && d.id)
        .map(d => YX[d.id]).find(Boolean);
      if (ym) meta = { y: ym.year || null, qs: ym.qs || null, sys: ym.sys || null };
      if (q.difficulty && q.difficulty !== "medium") meta = { ...(meta || {}), d: q.difficulty };
    }
    for (const s of sids) stableAnchor.set(s, id);

    if (q.hasConflict && q.needManualReview) (flags ||= {}).needManualReview = true;
    else if (q.hasConflict) (flags ||= {}).answerAdjusted = q.answerRule || true;
    if (q.conflictType === "singleSourceNumeric") (flags ||= {}).sourceAmbiguity = true;

    // —— 教材裁决结果落盘 ——
    // 1) 改判（answer_overrides.json）：主答案与教材结论冲突 → 覆盖
    const ov = OV[q.dupKey];
    if (ov && ov.to) {
      if (answer !== ov.to) { (flags ||= {}).answerAdjusted = "textbook:" + (ov.confidence || "mid"); answer = ov.to; }
      stat.overridden = (stat.overridden || 0) + 1;
    }
    // 2) 不可裁决（图片题 / 病例正文缺失）→ 保留原答案但打标记，网站可提示
    const ambKey = subject + "|" + String(q.stem).replace(/\s+/g, "").slice(0, 60);
    if (AMB.has(ambKey)) {
      flags = flags || {};
      flags.answerAmbiguity = true;
      flags.ambiguityReason = AMB.get(ambKey);
      stat.ambiguous = (stat.ambiguous || 0) + 1;
    }
    // 3) 病例题缺正文（题干即小问，且无 caseInfo）
    if (/^该患者|^最可能的诊断|^此患者/.test(String(q.stem).trim()) && !q.caseInfo) {
      (flags ||= {}).stemIncomplete = true;
      stat.stemIncomplete = (stat.stemIncomplete || 0) + 1;
    }

    const item = { id, type: q.type, chapter: q.chapter, stem, options, answer, source: q.originGroup };
    // 元数据（字段名压到最短，纯前端分片，体积敏感）
    if (meta) {
      if (meta.d) { item.d = meta.d; stat.metaD++; }            // 难度
      if (meta.n) { item.n = meta.n; stat.metaN++; }            // 答题人次（热度）
      if (meta.ac != null) { item.ac = meta.ac; stat.metaAc++; } // 正确率 %
      if (meta.fv) item.fv = meta.fv;                            // 收藏数
      if (meta.y) { item.y = meta.y; stat.metaY++; }            // 年份
      if (meta.qs && meta.qs !== q.originGroup) item.qs = meta.qs; // 题目来源（与来源组不同才存）
      if (meta.sys) item.sys = meta.sys;                         // 系统
      if (meta.img) item.img = meta.img;                          // 原图数量
      if (meta.cid) item.cid = meta.cid;                          // 章节 UUID（进度兼容）
    }
    if (q.examYear) item.examYear = q.examYear;
    // —— 统一 schema 扩展字段（稀疏：有值才带；字段字典见 工程/题库调研/schema_unified.json）——
    if (q.caseInfo) item.caseInfo = q.caseInfo;                        // 病例摘要（A2/A3）—— 前端做题必须显示，否则题干是不可读的小问
    if (q.tags && q.tags.length) item.tags = q.tags;                   // 标签（iyixue 原生 tags）
    else if (isJg && Array.isArray(JGTAGS[q.id]) && JGTAGS[q.id].length) {
      item.tags = JGTAGS[q.id];                                        // 极光题：sidecar 补标签（继承/语义匹配/AI）
      stat.jgTags = (stat.jgTags || 0) + 1;
    }
    if (q.suggestedTags && q.suggestedTags.length) item.suggestedTags = q.suggestedTags;
    if (q.sourceType) item.sourceType = q.sourceType;                  // network|contribution|legacy，污染溯源用
    for (const k of RESERVED_FIELDS) {
      if (!hasRealValue(q[k])) continue;                               // 9 个预留字段：通道保留，壳值不写
      item[k] = q[k];
    }
    if (flags) item.flags = flags;

    const bkey = `${sem}|${isJg ? "极光" : "扩展"}`;
    if (!buckets.has(bkey)) buckets.set(bkey, new Map());
    const sm = buckets.get(bkey);
    if (!sm.has(subject)) sm.set(subject, []);
    sm.get(subject).push(item);
    packedIds.add(id);
    if (aliasCands) {
      // 别名先登记进 packedIds（兜底补齐据此判断「该旧题没丢」），真正落盘延后到主 id 全定之后
      for (const a of aliasCands) packedIds.add(a);
      aliasRecs.push({ item, cands: aliasCands.filter(x => x !== id) });
    }

    // 富解析：blocks 为主 + 文本小节补全（见 blocksFromText 注释）
    const expText = q.explanation || "";
    const rawBlocks = Array.isArray(q.explanationBlocks) ? q.explanationBlocks : [];
    if (rawBlocks.length || expText) {
      const blocks = rawBlocks.map(compactBlock);
      const merged = blocks.concat(blocksFromText(expText, new Set(blocks.map(b => b[1]))));
      let entry = null;
      if (merged.length) entry = { b: merged };
      else if (expText.trim()) entry = { t: expText };   // 无小节标题的纯文本 → 原样回退
      if (entry) {
        if (q.briefExplanation) entry.bf = q.briefExplanation;
        const ekey = `${sem}|${subject}`;
        if (!explainMap.has(ekey)) explainMap.set(ekey, {});
        explainMap.get(ekey)[id] = entry;
      }
    }
  }
}

log(`总题 ${stat.total} | 极光组 ${stat.jg}（修复 ${stat.fixed}） | 扩展组 ${stat.ext} | 极光补标签 ${stat.jgTags || 0} | 教材改判 ${stat.overridden} | 不可裁决标记 ${stat.ambiguous} | 病例缺正文 ${stat.stemIncomplete}`);
log(`统一 id 网：扩展组主 id 为稳定锚 ${stat.extStable || 0}/${stat.ext} | 上一版反查命中 ${stat.extFpHit || 0}（未命中 ${stat.extFpMiss || 0}：靠源 id 或 ext-hash 兜底）`);
log(`元数据覆盖：难度 ${stat.metaD} / 答题人次 ${stat.metaN} / 正确率 ${stat.metaAc} / 年份 ${stat.metaY}`);

// ---------------- 兜底：上一版 packs 有、本次合并未命中的题，原位补回（保证进度 100% 不丢） ----------------
// （原实现读 site/data/data.js，该文件已不存在；且上一版 item 是「短字段」形态，需还原成长字段）
if (prevPacks.size) {
  for (const [pid, p] of prevPacks) {
    if (packedIds.has(pid)) continue;
    const subject = stdSubject(p._subject);
    const sem = SEMESTER[subject] || p._sem;
    if (!sem || !SEM_ORDER.includes(sem)) { stat.unknownSem[subject] = (stat.unknownSem[subject] || 0) + 1; continue; }
    const item = {
      // ⚠️ 上一版 packs item 用长字段（type/chapter/stem/options/answer）；
      //    早期版本曾用短字段（t/c/q/o/a），这里两种都兼容，否则会补出「空题干」的废题。
      id: pid, type: p.type || p.t || "A1", chapter: p.chapter || p.c || "",
      stem: String(p.stem ?? p.q ?? ""), options: p.options || p.o || {}, answer: p.answer ?? p.a,
      source: p.source || p.s || "极光",
      flags: { ...(p.flags || {}), fromPrevPacks: true }
    };
    for (const k of ["d", "n", "ac", "fv", "y", "qs", "sys", "img", "cid", "caseInfo", "tags", "suggestedTags", "sourceType", ...RESERVED_FIELDS]) {
      if (hasRealValue(p[k])) item[k] = p[k];
    }
    const bkey = `${sem}|${p._grp === "扩展" ? "扩展" : "极光"}`;
    if (!buckets.has(bkey)) buckets.set(bkey, new Map());
    const sm = buckets.get(bkey);
    if (!sm.has(subject)) sm.set(subject, []);
    sm.get(subject).push(item);
    packedIds.add(pid);
    usedPrimary.add(pid);
    if (p.flags && p.flags.aliasIds) for (const a of p.flags.aliasIds) packedIds.add(a);
    stat.siteFilled++;
  }
  log(`兜底补齐上一版遗漏题 ${stat.siteFilled} 条`);
}

// ---------------- 别名最终化（必须在全部主 id 定下之后）----------------
// 剔除「恰好是别题主 id」的候选：留着会让 ALIAS 把那道题指向本题（qById 用 ALIAS[id]||id 会认错）。
{
  let dropped = 0, kept = 0;
  for (const rec of aliasRecs) {
    const al = rec.cands.filter(x => x && !usedPrimary.has(x));
    dropped += rec.cands.length - al.length;
    kept += al.length;
    if (al.length) { rec.item.flags = rec.item.flags || {}; rec.item.flags.aliasIds = al; }
  }
  log(`统一 id 网：别名登记 ${aliasRecs.length} 题 / 保留 ${kept} 个别名 / 因与别题主 id 相撞剔除 ${dropped} 个 | 主 id 共 ${usedPrimary.size}`);
}

// ---------------- 写出 ----------------
const manifest = { generatedAt: new Date().toISOString(), semesters: {}, note: [] };
manifest.note = [
  "id 规则（统一 id 网）：一题 = 一个终身主 id + 一串别名。极光组主 id = 极光原始 UUID（优先沿用上一版 packs 在用的那个）；扩展组优先级 = ①上一版在用且为稳定锚 ②源站稳定 id（ykb_<年月>_<卷>_<题号> / school_… / UUID）③上一版 ext-<hash>（按文本指纹反查拿回）④ext-<sha1> 兜底。①② 锚在「来源」而非题干内容 → 改去重规则或润题干都不会再让 id 漂移",
  "flags.aliasIds：除主 id 外该题的全部其它 id（极光内部重复副本 / 我方站点早期 UUID / 医考帮源 id / 历史 ext-<hash>）—— 网站运行期建 ALIAS 表把老 id 映射到主 id，用户 localStorage 无需改写，进度零丢失",
  "选项修复：极光题在打包时套用 lib_fix（R1题干残留补项 / R1b尾部片段补项 / R2选项值内嵌拆分 / R3键名重排 / R4 HTML清洗 / R6冗余前缀剥离）",
  "flags.imageMissing = 图片题（选项全为「见图」，原图丢失）；flags.missingOption = 原题本身缺该项；flags.sourceAmbiguity = 同源答案分歧已按规则采纳；flags.answerAdjusted = 跨源冲突已自动裁决（textbook:* = 经教材人工裁决改判）",
  "flags.answerAmbiguity = 源数据答案存在分歧且文本层不可裁决（图片题/病例正文缺失），保留原答案不硬改；flags.ambiguityReason 为人话原因",
  "flags.stemIncomplete = 题干是小问（如「该患者最可能的诊断是」）但病例正文未随题保存，属源数据残缺",
  "元数据短字段（前端筛选/排序用）：d=难度(极光1-5；0或缺失=未标注) n=答题人次(极光站真实热度) ac=正确率%(极光，由对/答算出) fv=收藏数 img=原图张数 y=年份(考研真题) qs=题目来源(仅当与来源组不同时存) sys=系统(按器官系统归类)",
  "扩展字段（稀疏：有值才带）：caseInfo=病例摘要（A2/A3 题干的前置情境，前端做题必须显示，否则题干只是「该患者最可能的诊断是」这类小问）；tags/suggestedTags=标签；sourceType=抓取来源类型(network|contribution|legacy)；examYear=考研年份",
  "预留字段（通道保留，当前多为空/壳值）：mnemonic/knowledgePoint/knowledgePoints/optionExplanations/reasoningSteps/frequencyLevel/studyPoints/memoryCards/memoryCardMeta/questionRevision —— iyixue 后续接口会填，前端一律用 `?? ''` 兜底，勿删",
  "flags.fromPrevPacks = 该题上一版 packs 有、本次合并未命中，为保住用户进度而原位补回",
  "解析不在此包内，见 同目录 explain/<学科>.json = {题目id: 富解析}，做题时按需加载",
  "富解析格式：{bf: 一句话解析, b: [块…]}；块为紧凑数组 [type, sec, title, …payload]，type ∈ p 段落 | c 提示 | l 列表 | tb 表格（[列名], [行]），sec ∈ an 考点解析 | ab 答案依据 | pf 易错点 | cn 临床要点 | tx 教材出处",
  "富解析来源：explanationBlocks（源站已带类型的结构化块）为主，文本 `### 小节` 补全其未覆盖的部分（源站 blocks 不含「教材出处」，1890 条），两者按 sec 去重后合并",
  "极少数无小节标题的题（约 0.3%）回退为 {t: 纯文本}，前端两种都要兼容"
];

for (const sem of SEM_ORDER) {
  const semDir = `${OUT}/${sem}`;
  await ensureDir(semDir);
  const semStat = { subjects: 0, jg: 0, ext: 0, explain: 0, bytes: 0, files: [] };
  for (const group of ["极光", "扩展"]) {
    const sm = buckets.get(`${sem}|${group}`);
    if (!sm || !sm.size) continue;
    await ensureDir(`${semDir}/${group}`);
    for (const [subject, items] of sm) {
      const safe = subject.replace(/[\\/:*?"<>|]/g, "_");
      const p = `${semDir}/${group}/${safe}.json`;
      await ensureDir(`${semDir}/${group}`);
      await writeFile(p, JSON.stringify(items), "utf8");
      const sz = (await import("fs")).statSync(p).size;
      semStat.bytes += sz;
      if (group === "极光") semStat.jg += items.length; else semStat.ext += items.length;
      semStat.files.push({ group, subject, count: items.length, bytes: sz });
    }
  }
  const em = new Map();
  for (const [k, v] of explainMap) { const [s, subj] = k.split("|"); if (s === sem) em.set(subj, v); }
  if (em.size) {
    await ensureDir(`${semDir}/explain`);
    for (const [subj, obj] of em) {
      const safe = subj.replace(/[\\/:*?"<>|]/g, "_");
      const p = `${semDir}/explain/${safe}.json`;
      await writeFile(p, JSON.stringify(obj), "utf8");
      semStat.explain += Object.keys(obj).length;
      semStat.bytes += (await import("fs")).statSync(p).size;
    }
  }
  semStat.subjects = new Set(semStat.files.map(f => f.subject)).size;
  manifest.semesters[sem] = {
    subjects: semStat.subjects, questions: semStat.jg + semStat.ext,
    jiguang: semStat.jg, extension: semStat.ext, withExplanation: semStat.explain,
    megabytes: +(semStat.bytes / 1048576).toFixed(2),
    version: new Date().toISOString().slice(0, 10).replace(/-/g, "")
  };
  log(`${sem}: ${semStat.subjects} 科 / ${semStat.jg + semStat.ext} 题 (极光 ${semStat.jg} + 扩展 ${semStat.ext}) / ${(semStat.bytes / 1048576).toFixed(2)} MB`);
}

await writeFile(`${OUT}/semester_map.json`, JSON.stringify({ map: SEMESTER, order: SEM_ORDER, counts: stat.bySem, generalSubjects: [...GEN_SUBJECTS] }, null, 1), "utf8");
manifest.totals = { questions: usedPrimary.size, jiguang: stat.jg + stat.siteFilled, extension: stat.ext, bySemester: stat.bySem, bySource: stat.bySource, jiguangFixed: stat.fixed, siteBackfilled: stat.siteFilled, textbookOverridden: stat.overridden, answerAmbiguity: stat.ambiguous, stemIncomplete: stat.stemIncomplete, meta: { difficulty: stat.metaD, answerCount: stat.metaN, accuracy: stat.metaAc, year: stat.metaY } };
if (Object.keys(stat.unknownSem).length) manifest.unmappedSubjects = stat.unknownSem;
await writeFile(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1), "utf8");

// ---------------- 写盘自检 ----------------
// 重新读回产物清点题数：必须与统计一致，且不得有 0 条。曾出现「输出目录被占用 → 只写了一半
// 却不报错」，产出「大二整个缺失」的残档。这里硬校验，防止残档被当成果发出。
{
  let readBack = 0, emptyStem = 0, missingDirs = [];
  for (const sem of SEM_ORDER) {
    for (const grp of ["极光", "扩展"]) {
      const m = manifest.semesters[sem];
      const shouldHave = m && (grp === "极光" ? m.jiguang : m.extension) > 0;
      let fs2 = []; try { fs2 = await readdir(`${OUT}/${sem}/${grp}`); } catch { fs2 = []; }
      const jsons = fs2.filter(f => f.endsWith(".json"));
      if (shouldHave && !jsons.length) missingDirs.push(`${sem}/${grp}`);
      for (const f of jsons) {
        const arr = JSON.parse(await readFile(`${OUT}/${sem}/${grp}/${f}`, "utf8"));
        readBack += arr.length;
        for (const q of arr) if (!String(q.stem || "").trim()) emptyStem++;
      }
    }
  }
  /* 期望落盘数 = 实际分配的主 id 数，而非 stat.total+siteFilled：
   * stat.total 含跨组重复题（dupCrossGroup，同稳定源 id 同时出现在极光/扩展 → 故意跳过避免 id 分裂），
   * 这些题不进 usedPrimary 也不落盘，若用 total 计会虚高 20 条触发误报 FATAL。 */
  const expect = usedPrimary.size;
  log(`写盘自检：回读 ${readBack} 题（期望 ${expect}）| 空题干 ${emptyStem} | 主 id ${usedPrimary.size}`);
  if (missingDirs.length) { console.error("FATAL 分片目录缺失: " + missingDirs.join(", ")); process.exit(2); }
  if (readBack !== expect) { console.error(`FATAL 写盘不完整：回读 ${readBack} != 期望 ${expect}`); process.exit(2); }
}
log("完成 → " + OUT);
