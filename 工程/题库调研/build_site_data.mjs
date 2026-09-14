/**
 * 题库包 → 站点数据（manifest + 分片懒加载）
 *
 * 读  工程/题库调研/packs/<学期>/{极光,扩展}/<学科>.json   （扁平数组，含元数据短字段）
 *     工程/题库调研/packs/<学期>/explain/<学科>.json       （{题目id: 解析}）
 * 写  site/data/manifest.json                          首屏唯一必载文件（只有计数与路径）
 *     site/data/packs/<学期>/<学科>-jg.json            极光分片
 *     site/data/packs/<学期>/<学科>-ext.json           扩展分片
 *     site/data/explain/<学期>/<学科>/<章节>.json       解析分片（按章节拆，做题按需加载）
 *
 * 学科 id 兼容：生化/生理/免疫沿用站点既有 id（bio/physiology/immunology），
 * 保证 localStorage 里的既有进度、收藏、错题、复习计划全部不失效。
 * 用法：node build_site_data.mjs
 */
import fs from 'fs';
import path from 'path';
import { safeRmSync } from './_safeRm.mjs';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const PACKS = path.join(WS, '工程', '题库调研', 'packs');
const OUT = path.join(WS, 'site', 'data');
const SEM_ORDER = ['大一', '大二', '大三', '大四', '水平测试'];

// 站点只收这几科（2026-09-12 拍板；医学英语数据待用户提供，先占好 id 与学期）
// 想加回某科：把它写进 ONLY 即可，其余不动。
const ONLY = new Set(['生物化学', '生理学', '医学免疫学', '医学英语']);
/* 9 个预留字段：iyixue 后续接口会填，site 层通道保留（稀疏：有值才带，壳值不写） */
const RESERVED_FIELDS = ['mnemonic', 'knowledgePoint', 'knowledgePoints', 'optionExplanations', 'reasoningSteps', 'frequencyLevel', 'studyPoints', 'memoryCards', 'memoryCardMeta'];
/* 壳值过滤：memoryCardMeta 全库为 {schemaVersion:1,generator,generatedAt:""}，写进前端纯属浪费体积 */
const SHELL_KEYS = new Set(['schemaVersion', 'generator', 'generatedAt']);
function hasRealValue(v) {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).some(k => !SHELL_KEYS.has(k) && v[k] !== '' && v[k] !== null);
  return true;
}
// 已上线的 3 科沿用旧 id —— 用户进度 key 不可变
const SUB_ID = {
  '生物化学': 'bio', '生理学': 'physiology', '医学免疫学': 'immunology',
  '医学英语': 'med-english',
};
// 指定学科的学期（覆盖 packs 里的学期目录；医学英语放大二）
const SEM_FORCE = { '医学英语': '大二' };
/* 选项污染兜底（iyixue 贡献题粘贴残留）：剔除「X. X. X.」重复前缀垃圾选项、剥单字母前缀 */
const _GARBAGE = /^([A-Ha-h])\.\s*(?:\1\.\s*){2,}/;
const _LETTER = /^([A-Ha-h])\.\s*/;
const SANITIZE_LOG = [];
function sanitizeOptions(options, qid, sink) {
  for (const k of Object.keys(options)) {
    const s = String(options[k]);
    if (_GARBAGE.test(s)) { delete options[k]; sink.push(qid + ' ' + k); continue; }
    if (_LETTER.test(s)) options[k] = s.replace(_LETTER, '').trim();
  }
  return options;
}

const subId = name => SUB_ID[name] || name;

/* ---------- 扩展章节归一（2026-09-12）----------
 * iyixue 的 system 字段是自由文本，直接用会乱序 + 同章异名 + 无章号裸名。
 * 四步：① 显式映射表逐题重定向（跨章混合名按题干/选项关键词拆分到对应章）；
 * ② 章名归一（去空白与「的」）合并同章异名；③ 同关键词不同章号（如肿瘤免疫 20/22 章）并入大章；
 * ④ 按章号数值排序输出，产出 chapterAliases（旧「x+章名」→ 新「x+章名」）供前端自迁移用户数据。
 * 极光组章节 UUID 不动，仅按章号排序分片内题目顺序。 */
const kw = (q, re) => re.test((q.stem || '') + ' ' + Object.values(q.options || {}).join(' '));
const CANON_RULES = {
  '生物化学': {
    '酶与维生素': q => kw(q, /维生素|vitamin|Vit[A-Z]/i) ? '第六章 维生素' : '第二章 酶与酶促反应',
    '蛋白质结构与功能': '第一章 蛋白质的结构与功能',
    '核酸结构与功能': '第三章 核酸的结构与功能',
    '细胞信号与癌基因': q => kw(q, /癌|肿瘤|原癌|抑癌|Ras|myc/i) ? '第二十三章 癌症的分子基础' : '第二十章 细胞信号转导与疾病',
    '肝胆血液生化': q => kw(q, /血液|血浆|红细|贫血|血红蛋白|凝血|血小板/) ? '第二十六章 血液的生物化学' : '第二十五章 肝的生物化学',
    'RNA转录': '第十五章 RNA的生物合成',
    '基因表达调控与工程': q => kw(q, /重组|克隆|载体|酶切|质粒|PCR|印迹| blot|文库|转基因|CRISPR|限制性内切/i) ? '第十九章 DNA重组和重组DNA技术' : '第十七章 基因表达调控',
    '蛋白质合成与加工': '第十六章 蛋白质的合成',
    'DNA复制与修复': q => kw(q, /损伤|修复|突变|紫外|切除|光复活|错配/) ? '第二十一章 DNA损伤和损伤修复' : '第十四章 DNA 的合成',
    '第十五章 RNA的合成': '第十五章 RNA的生物合成',
    '第二十章 细胞信号转导': '第二十章 细胞信号转导与疾病',
    '其他/综合': '其他/综合',
  },
  '生理学': {
    '尿生成与排出': '第八章 尿的生成和排出',
    '血液循环': '第四章 血液循环',
    '血液': '第三章 血液',
    '细胞基本功能': '第二章 细胞的基本功能',
    '呼吸': '第五章 呼吸',
    '消化与吸收': '第六章 消化和吸收',
    '内分泌与生殖': q => kw(q, /生殖|精子|卵|月经|妊娠|睾|雌|孕|胎盘|避孕|分娩|卵巢|子宫/) ? '第十二章 生殖' : '第十一章 内分泌',
    '神经系统': '第十章 神经系统的功能',
    '骨骼肌与神经肌接头': '第二章 细胞的基本功能',
    '感觉器官': '第九章 感觉器官的功能',
    '能量代谢与体温': '第七章 能量代谢与体温',
    '绪论/稳态与调节': '第一章 绪论',
  },
  '医学免疫学': {},
};
const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) {
  s = String(s).trim();
  if (/^\d+$/.test(s)) return +s;
  if (/^十/.test(s)) return 10 + (s.length > 1 ? CN[s[1]] || 0 : 0);
  const m = s.match(/^([零一二三四五六七八九])十([零一二三四五六七八九])?$/);
  if (m) return CN[m[1]] * 10 + (m[2] ? CN[m[2]] : 0);
  return CN[s] ?? null;
}
function chapNum(name) {
  const m = String(name).match(/^第(.+?)章/);
  return m ? cnNum(m[1]) : null;
}
function normName(s) { return String(s).replace(/\s+/g, '').replace(/的/g, ''); }
function restName(s) { return normName(String(s).replace(/^第.+?章\s*/, '')); }

function canonChapters(items, subject) {
  const rules = CANON_RULES[subject] || {};
  // 旧章名 → {新章名: 题数}，最后取 argmax 生成别名（一对多拆分时不丢方向）
  const aliasCnt = new Map();
  const bump = (o, n) => { if (o === n) return; if (!aliasCnt.has(o)) aliasCnt.set(o, new Map()); const m = aliasCnt.get(o); m.set(n, (m.get(n) || 0) + 1); };
  // 预扫描：带章号名字 rest → 最高频完整名（给裸名通用兜底用）
  const restBest = new Map();
  for (const q of items) {
    const n = q.chapter || '未分类';
    if (chapNum(n) === null) continue;
    const r = restName(n);
    const cur = restBest.get(r);
    if (!cur) restBest.set(r, { name: n, cnt: 1 });
    else cur.cnt++;
  }
  // ① 逐题重定向：显式规则 > 裸名 rest 唯一匹配兜底
  for (const q of items) {
    const old = q.chapter || '未分类';
    let target = null;
    const r = rules[old];
    if (r !== undefined) target = (typeof r === 'function') ? r(q) : r;
    else if (chapNum(old) === null && old !== '其他/综合' && old !== '未分类') {
      const rb = restBest.get(restName(old));
      if (rb && rb.name !== old) target = rb.name;
    }
    if (target) { bump(old, target); q.chapter = target; }
  }
  // ② 归一同章异名（去空白/「的」）→ 统一回写为最高频写法
  const groups = new Map();
  for (const q of items) {
    const name = q.chapter || '未分类';
    const k = normName(name);
    if (!groups.has(k)) groups.set(k, { key: k, names: new Map(), items: [] });
    const g = groups.get(k);
    g.names.set(name, (g.names.get(name) || 0) + 1);
    g.items.push(q);
  }
  const displayOf = g => [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (const g of groups.values()) {
    const disp = displayOf(g);
    for (const q of g.items) { if (q.chapter !== disp) { bump(q.chapter, disp); q.chapter = disp; } }
  }
  // ③ 同关键词不同章号（如肿瘤免疫 20/22）→ 并入题数最多者
  const byRest = new Map();
  for (const g of groups.values()) {
    const name = displayOf(g);
    const rest = restName(name);
    if (rest.length >= 2 && chapNum(name) !== null) {
      if (!byRest.has(rest)) byRest.set(rest, []);
      byRest.get(rest).push(g);
    }
  }
  for (const [, gs] of byRest) {
    if (gs.length < 2) continue;
    const big = gs.slice().sort((a, b) => b.items.length - a.items.length)[0];
    const targetName = displayOf(big);
    for (const g of gs) {
      if (g === big) continue;
      for (const [n, c] of g.names) big.names.set(n, (big.names.get(n) || 0) + c);
      for (const q of g.items) { if (q.chapter !== targetName) { bump(q.chapter, targetName); q.chapter = targetName; } big.items.push(q); }
      groups.delete(g.key);
    }
  }
  // ④ 排序：章号升序；其他/综合 999，其余无章号 998
  const ordered = [...groups.values()].sort((a, b) => {
    const na = displayOf(a), nb = displayOf(b);
    const va = chapNum(na) ?? (restName(na) === '其他/综合' ? 999 : 998);
    const vb = chapNum(nb) ?? (restName(nb) === '其他/综合' ? 999 : 998);
    return va - vb;
  });
  const out = [];
  for (const g of ordered) out.push(...g.items);
  const aliases = {};
  for (const [o, m] of aliasCnt) aliases['x' + o] = 'x' + [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { items: out, aliases };
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); if (!fs.existsSync(d)) throw new Error('mkdir failed ' + d); }
function cleanDir(d) { if (fs.existsSync(d)) safeRmSync(d); ensureDir(d); }
// 章节名 → 安全文件名（去非法字符、空格转下划线）。前端按 chapters[].name 精确匹配 file，不重算此名。
function safeChapName(ch) {
  return String(ch).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 80) || '未分类';
}

cleanDir(path.join(OUT, 'packs'));
cleanDir(path.join(OUT, 'explain'));

const manifest = {
  // 版本闸口：分片路径带 ?v=<version>，数据一变 version 就变，浏览器不会吃旧缓存
  version: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12),
  generatedAt: new Date().toISOString(),
  semesters: [],
  totals: { subjects: 0, questions: 0, jiguang: 0, extension: 0, withMeta: { difficulty: 0, answerCount: 0, year: 0 } },
  fieldHelp: {
    d: '难度（极光 1–5；0/无 = 未标注）',
    n: '答题人次（极光站真实热度）',
    ac: '正确率 %',
    fv: '收藏数',
    y: '年份（考研真题）',
    qs: '题目来源',
    sys: '系统',
    img: '原图张数',
    ci: '病例摘要（A2/A3 题干的前置情境）',
    ey: '考研年份（examYear）',
    tg: '标签',
    stg: '建议标签',
    st: '抓取来源类型（network|contribution|legacy）'
  },
  explainHelp: {
    note: '解析分片 explain/<学期>/<sid>/<章节>.json = {题目id: 富解析}（按章节拆，前端按需加载）。富解析 {bf, b}：bf=一句话解析；b=块数组 [type, sec, title, …payload]。每个学科 manifest 里 entry.explain = {dir, chapters:[{name,file,count}], count}。',
    type: { p: '段落', c: '提示框', l: '列表', tb: '表格' },
    sec: { an: '考点解析', ab: '答案依据', pf: '易错点', cn: '临床与操作要点', tx: '教材出处' },
    fallback: '极少数无小节标题的题为 {t: 纯文本}，前端必须两种都兼容'
  }
};

let grandQ = 0, grandJg = 0, grandExt = 0, mD = 0, mN = 0, mY = 0, subCount = 0;

const usedIds = new Set();   // 全站已发主 id 集合（含主包与已写孤儿），防跨包 id 碰撞覆盖

// —— 兜底断言（防整科静默丢失）：packs 中「实际存在分片且属于 ONLY 白名单」的学科，build 后必须产出 >0 题。
// 注意：医学英语在 ONLY 但若 packs 无分片则不属于期望，不会误伤（尚未提供数据）。
const expectedSubs = new Set();
for (const sem of SEM_ORDER) {
  const semDir = path.join(PACKS, sem);
  if (!fs.existsSync(semDir)) continue;
  for (const grp of ['极光', '扩展']) {
    const gp = path.join(semDir, grp);
    if (!fs.existsSync(gp)) continue;
    for (const f of fs.readdirSync(gp)) {
      const s = f.replace(/\.json$/, '');
      if (ONLY.has(s)) expectedSubs.add(s);
    }
  }
}
const producedSubs = new Set();   // 实际产出 >0 题的学科（sub 名）

for (const sem of SEM_ORDER) {
  const semDir = path.join(PACKS, sem);
  if (!fs.existsSync(semDir)) continue;
  const semEntry = { id: sem, name: sem, subjects: [] };
  const subs = new Set();
  for (const grp of ['极光', '扩展']) {
    const gp = path.join(semDir, grp);
    if (!fs.existsSync(gp)) continue;
    for (const f of fs.readdirSync(gp)) if (f.endsWith('.json')) subs.add(f.replace(/\.json$/, ''));
  }

  for (const sub of [...subs].sort()) {
    if (!ONLY.has(sub)) continue;                                  // 白名单之外一律不打包
    if (SEM_FORCE[sub] && SEM_FORCE[sub] !== sem) continue;         // 学期归属以 SEM_FORCE 为准
    const id = subId(sub);
    const entry = { id, name: sub, semester: sem };
    let total = 0;
    const chapOf = new Map();   // 本学科「题id → 章节」映射（极光+扩展两组都收），供 explain 按章节拆分

    for (const [grp, key] of [['极光', 'jiguang'], ['扩展', 'extension']]) {
      const src = path.join(semDir, grp, sub + '.json');
      if (!fs.existsSync(src)) continue;
      const arr0 = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (!arr0.length) continue;
      let arr = arr0;
      const isExt = grp === '扩展';
      // 扩展组：章节归一 + 排序（极光组仅排序，UUID 章节键不动）
      const aliases = {};
      if (isExt) { const r = canonChapters(arr0, sub); arr = r.items; Object.assign(aliases, r.aliases); }
      else arr = arr0.slice().sort((a, b) => (chapNum(a.chapter) ?? 998) - (chapNum(b.chapter) ?? 998));
      for (const q of arr) if (q.id && q.chapter) chapOf.set(q.id, q.chapter);   // 收进 id→章节 映射
      if (isExt && Object.keys(aliases).length) {
        manifest.chapterAliases = manifest.chapterAliases || {};
        manifest.chapterAliases[subId(sub)] = Object.assign({}, manifest.chapterAliases[subId(sub)], aliases);
      }
      const dir = path.join(OUT, 'packs', sem);
      ensureDir(dir);
      const dst = path.join(dir, `${id}-${grp === '极光' ? 'jg' : 'ext'}.json`);
      // 逐题只保留需要的键，去掉空值，压体积
      const slim = arr.map(q => {
        const o = { id: q.id, t: q.type, c: q.chapter, q: q.stem, o: sanitizeOptions({ ...q.options }, q.id, SANITIZE_LOG), a: q.answer, s: q.source };
        if (q.d) o.d = q.d;
        if (q.n) o.n = q.n;
        if (q.ac != null) o.ac = q.ac;
        if (q.fv) o.fv = q.fv;
        if (q.y) o.y = q.y;
        if (q.qs) o.qs = q.qs;
        if (q.sys) o.sys = q.sys;
        if (q.img) o.img = q.img;
        if (q.cid) o.cid = q.cid;
        if (q.flags) o.f = q.flags;
        /* ---- 统一 schema 扩展字段（稀疏；命名与打包层对照见 schema_unified.json） ---- */
        if (q.caseInfo) o.ci = q.caseInfo;              // 病例摘要（A2/A3）→ 前端 toQ 消费
        if (q.examYear) o.ey = q.examYear;              // 考研年份（此前在 site 层被丢弃）
        if (q.tags && q.tags.length) o.tg = q.tags;
        if (q.suggestedTags && q.suggestedTags.length) o.stg = q.suggestedTags;
        if (q.sourceType) o.st = q.sourceType;          // 抓取来源类型
        for (const k of RESERVED_FIELDS) {              // 预留字段：通道保留（有值才写）
          if (hasRealValue(q[k])) o[k] = q[k];
        }
        return o;
      });
      fs.writeFileSync(dst, JSON.stringify(slim), 'utf8');
      const bytes = fs.statSync(dst).size;
      entry[key] = { file: `packs/${sem}/${path.basename(dst)}`, count: slim.length, bytes };
      total += slim.length;
      if (key === 'jiguang') grandJg += slim.length; else grandExt += slim.length;
      for (const q of slim) { if (q.d) mD++; if (q.n) mN++; if (q.y) mY++; usedIds.add(q.id); }
    }

    const exSrc = path.join(semDir, 'explain', sub + '.json');
    if (fs.existsSync(exSrc)) {
      const o = JSON.parse(fs.readFileSync(exSrc, 'utf8'));
      const n = Object.keys(o).length;
      if (n) {
        // 按章节拆分（性能：避免首次看解析整科拉 6MB+；按章节小文件 + 前端按需加载）
        const byChap = new Map();
        for (const [qid, exp] of Object.entries(o)) {
          const ch = chapOf.get(qid) || '未分类';
          if (!byChap.has(ch)) byChap.set(ch, {});
          byChap.get(ch)[qid] = exp;
        }
        const dir = path.join(OUT, 'explain', sem, id);
        ensureDir(dir);
        const chapters = [];
        for (const [ch, obj] of byChap) {
          const fn = safeChapName(ch) + '.json';
          fs.writeFileSync(path.join(dir, fn), JSON.stringify(obj), 'utf8');
          chapters.push({ name: ch, file: `explain/${sem}/${id}/${fn}`, count: Object.keys(obj).length });
        }
        entry.explain = { dir: `explain/${sem}/${id}`, chapters, count: n };
      }
    }

    entry.count = total;
    entry.jgCount = entry.jiguang ? entry.jiguang.count : 0;
    entry.extCount = entry.extension ? entry.extension.count : 0;
    if (!total) continue;
    producedSubs.add(sub);   // 该科成功产出 >0 题
    semEntry.subjects.push(entry);
    grandQ += total;
    subCount++;
  }

  semEntry.count = semEntry.subjects.reduce((a, s) => a + s.count, 0);
  semEntry.jgCount = semEntry.subjects.reduce((a, s) => a + s.jgCount, 0);
  semEntry.extCount = semEntry.subjects.reduce((a, s) => a + s.extCount, 0);
  if (semEntry.subjects.length) manifest.semesters.push(semEntry);
}

/* ---------- 孤儿题包（轻量救回未上线科的历史引用，不新增科目）----------
 * 仅打包 curated 列表（工程/题库调研/orphans_src.json）里的少数题，如用户进度引用、
 * 但所在科未进白名单的外基题。让 qById 可解析、错题本/收藏不再悬空；体积仅这几题，
 * 不违背「轻量 + 个人自用」原则（绝不用整科进 ONLY）。 */
function slimOrphan(q) {
  const o = { id: q.id, t: q.type, c: q.chapter, q: q.stem, o: sanitizeOptions({ ...q.options }, q.id, SANITIZE_LOG), a: q.answer, s: q.source };
  if (q.d) o.d = q.d;
  if (q.n) o.n = q.n;
  if (q.ac != null) o.ac = q.ac;
  if (q.fv) o.fv = q.fv;
  if (q.y) o.y = q.y;
  if (q.qs) o.qs = q.qs;
  if (q.sys) o.sys = q.sys;
  if (q.img) o.img = q.img;
  if (q.cid) o.cid = q.cid;
  if (q.flags) o.f = q.flags;
  if (q.caseInfo) o.ci = q.caseInfo;
  if (q.examYear) o.ey = q.examYear;
  if (q.tags && q.tags.length) o.tg = q.tags;
  if (q.suggestedTags && q.suggestedTags.length) o.stg = q.suggestedTags;
  if (q.sourceType) o.st = q.sourceType;
  for (const k of RESERVED_FIELDS) if (hasRealValue(q[k])) o[k] = q[k];
  return o;
}
const ORPHAN_SRC = path.join(WS, '工程', '题库调研', 'orphans_src.json');
if (fs.existsSync(ORPHAN_SRC)) {
  try {
    const list = JSON.parse(fs.readFileSync(ORPHAN_SRC, 'utf8'));
    const oarr = [];
    for (const it of list) {
      const src = path.join(PACKS, it.sem, it.grp, it.sub + '.json');
      if (!fs.existsSync(src)) { console.log('  ⚠ 孤儿源缺失: ' + src); continue; }
      const arr = JSON.parse(fs.readFileSync(src, 'utf8'));
      const q = arr.find(x => x.id === it.id);
      if (!q) { console.log('  ⚠ 孤儿题未找到: ' + it.id + ' @ ' + it.sub); continue; }
      if (usedIds.has(q.id)) { console.log('  ⚠ 孤儿 id 已存在于主包，跳过去重: ' + q.id); continue; }
      oarr.push(slimOrphan(q));
      usedIds.add(q.id);
    }
    if (oarr.length) {
      fs.writeFileSync(path.join(OUT, 'orphans.json'), JSON.stringify(oarr), 'utf8');
      console.log(`孤儿包写出：${oarr.length} 题 → site/data/orphans.json`);
    }
  } catch (e) { console.log('  ⚠ 孤儿包生成失败: ' + e.message); }
}

manifest.totals = {
  subjects: subCount, questions: grandQ, jiguang: grandJg, extension: grandExt,
  withMeta: { difficulty: mD, answerCount: mN, year: mY }
};

// —— 兜底断言：期望学科必须产出 >0 题，否则视为整科静默丢失，阻断发布 ——
for (const s of expectedSubs) {
  if (!producedSubs.has(s)) {
    console.error(`FATAL 学科「${s}」在 packs 中存在分片，但 build_site_data 后未产出任何题目（整科静默丢失？请检查 merged2/by_subject 与该学科分片）`);
    process.exit(1);
  }
}

ensureDir(OUT);
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest), 'utf8');

// ---- 报告 ----
console.log(`manifest 写出：${fs.statSync(path.join(OUT, 'manifest.json')).size} 字节`);
for (const s of manifest.semesters) {
  let bytes = 0;
  for (const sub of s.subjects) {
    for (const k of ['jiguang', 'extension']) if (sub[k]) bytes += sub[k].bytes;
  }
  console.log(`  ${s.id.padEnd(6)} ${String(s.subjects.length).padStart(2)} 科 ${String(s.count).padStart(6)} 题 单学期全量 ${(bytes / 1048576).toFixed(2)}MB`);
}
console.log(`总计 ${subCount} 科 / ${grandQ} 题（极光 ${grandJg} + 扩展 ${grandExt}）`);
console.log(`元数据覆盖：难度 ${mD} / 答题人次 ${mN} / 年份 ${mY}`);
