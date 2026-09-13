/* 题库归一化 + 类目并集 + 全库导出
 * 输入：packs/<学期>/{极光,扩展}/<学科>.json  +  explain
 * 输出：归一化/{schema.json, subjects.json, enums.json, questions.jsonl, questions.csv,
 *              by_subject/<sid>.jsonl, explain/<sid>.jsonl, id_map.json, manifest.json}
 *
 * 铁律：
 *  1) 极光题 id 严格不变（原 UUID），同题的其它 id 进 aliases
 *  2) 扩展题 id 重排为 ext-<sid>-<6位>，旧 id 进 aliases；映射持久化在 id_map.json，
 *     重跑时已知题复用原号（只给新题追加），保证「加题不改老号」
 *  3) 只写 归一化/，不动 merged2 / packs / site
 */
import fs from 'fs';
import path from 'path';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const R = WS + '/题库调研';
const PACKS = R + '/packs';
const OUT = R + '/归一化';
const SEMS = ['大一', '大二', '大三', '大四', '水平测试'];
const GRPS = ['极光', '扩展'];

const ensureDir = d => { for (let i = 0; i < 6; i++) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { } if (fs.existsSync(d)) return true; } throw new Error('mkdir 失败: ' + d); };
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/* ---------- 规范词表（并集的 canonical 侧） ---------- */
const TYPE_MAP = {
  'A1': { code: 'a1', label: 'A1型单选题', kind: 'single' },
  'A2': { code: 'a2', label: 'A2型病例单选题', kind: 'single' },
  'A3': { code: 'a3', label: 'A3型病例组题', kind: 'single' },
  '多选': { code: 'multi', label: '多选题', kind: 'multi' },
  '判断': { code: 'tf', label: '判断题', kind: 'tf' },
  '填空': { code: 'blank', label: '填空题', kind: 'blank' },
};
const SOURCE_MAP = {
  '极光': { code: 'jiguang', label: '极光题库' },
  '医考帮': { code: 'ykb', label: '医考帮' },
  '考研真题': { code: 'kaoyan', label: '考研真题' },
  '未知来源': { code: 'unknown', label: '未知来源' },
  '自建': { code: 'oursite', label: '自建/AI出题' },
};
/* 站点在用 id 的 4 科 + 常用别名 → 固定代号（写进 subjects.json 后不再变） */
const KNOWN_CODE = {
  '生物化学': 'bio', '生理学': 'physiology', '医学免疫学': 'immunology', '医学英语': 'med-english',
};
/* iyixue 预留字段：当前多为空/壳值，但后续接口会填 → 归一化层通道保留（稀疏：有值才写） */
const RESERVED_FIELDS = ['mnemonic', 'knowledgePoint', 'knowledgePoints', 'optionExplanations', 'reasoningSteps', 'frequencyLevel', 'studyPoints', 'memoryCards', 'memoryCardMeta', 'questionRevision'];
const norm = s => String(s || '')
  .replace(/<[^>]*>/g, '')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[，。、；：？！“”‘’（）()【】\[\]《》<>·,.;:?!"'`~\-—_/\\|+*=#%&@$^]/g, '')
  .toLowerCase();

function parseSys(sys) {
  if (!sys) return { part: null, system: null, chapter: null };
  const t = String(sys).split(/[\s\u3000]+/).filter(Boolean);
  let part = null, system = null, chapter = null, i = 0;
  if (t.length >= 2 && (/^第.+[篇部]$/.test(t[i]) || /^[上下中]篇$/.test(t[i]))) { part = t[i]; i++; }
  if (t[i] && /^第.+[章节]/.test(t[i])) chapter = t.slice(i).join(' ');
  else if (t[i + 1] && /^第.+[章节]/.test(t[i + 1])) { system = t[i]; chapter = t.slice(i + 1).join(' '); }
  else if (t[i]) chapter = t.slice(i).join(' ');
  return { part, system, chapter };
}
function parseQs(qs) {
  if (!qs) return { kind: null, year: null };
  const m = /^(\d{4})年考研真题$/.exec(String(qs).trim());
  if (m) return { kind: 'kaoyan', year: +m[1] };
  if (/考研/.test(qs)) return { kind: 'kaoyan', year: null };
  return { kind: 'other', year: null };
}

/* ---------- 1. 读全部 packs ---------- */
log('扫描 packs ...');
const subjects = new Map();   // name -> {name, sem, jg, ext, chapters:Set, systems:Set}
const all = [];               // 归一化前的原始条目
for (const sem of SEMS) {
  for (const grp of GRPS) {
    const d = path.join(PACKS, sem, grp);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const subject = f.replace(/\.json$/, '');
      let arr; try { arr = rd(path.join(d, f)); } catch (e) { log('跳过坏文件 ' + f + ' :: ' + e.message); continue; }
      if (!Array.isArray(arr)) continue;
      let S = subjects.get(subject);
      if (!S) { S = { name: subject, sem, jg: 0, ext: 0, chapters: new Set(), systems: new Set() }; subjects.set(subject, S); }
      for (const q of arr) {
        all.push({ ...q, _sem: sem, _grp: grp === '极光' ? 'jg' : 'ext', _subject: subject });
        if (grp === '极光') S.jg++; else S.ext++;
        if (q.chapter) S.chapters.add(q.chapter);
        const ps = parseSys(q.sys);
        if (ps.system) S.systems.add(ps.system);
      }
    }
  }
}
log(`读取 ${all.length} 题 / ${subjects.size} 学科`);

/* ---------- 2. 学科注册表（持久化，代号只增不变） ---------- */
ensureDir(OUT);
const SUBJ_FILE = path.join(OUT, 'subjects.json');
let subjReg = fs.existsSync(SUBJ_FILE) ? rd(SUBJ_FILE) : { version: 1, generatedAt: null, subjects: [] };
const usedCodes = new Set(subjReg.subjects.map(s => s.code));
const semNames = SEMS;
const sortedNames = [...subjects.keys()].sort((a, b) => {
  const sa = subjects.get(a).sem, sb = subjects.get(b).sem;
  if (sa !== sb) return SEMS.indexOf(sa) - SEMS.indexOf(sb);
  return subjects.get(a).jg + subjects.get(a).ext >= subjects.get(b).jg + subjects.get(b).ext ? -1 : 1;
});
let autoIdx = subjReg.subjects.length;
for (const name of sortedNames) {
  if (subjReg.subjects.some(s => s.name === name)) continue;
  let code = KNOWN_CODE[name];
  if (!code) { do { autoIdx++; code = 's' + String(autoIdx).padStart(2, '0'); } while (usedCodes.has(code)); }
  usedCodes.add(code);
  subjReg.subjects.push({ code, name, sem: subjects.get(name).sem, aliases: [] });
}
subjReg.generatedAt = new Date().toISOString();
const CODE_OF = Object.fromEntries(subjReg.subjects.map(s => [s.name, s.code]));
const SEM_OF = Object.fromEntries(subjReg.subjects.map(s => [s.name, s.sem]));
fs.writeFileSync(SUBJ_FILE, JSON.stringify(subjReg, null, 1), 'utf8');
log(`学科注册表共 ${subjReg.subjects.length} 科`);

/* ---------- 3. 章节 → 系统 反查表（多数票） ---------- */
const chapSys = new Map();  // chapter -> Map(system->count)
for (const q of all) {
  const ps = parseSys(q.sys);
  const chap = ps.chapter || q.chapter;
  if (!chap || !ps.system) continue;
  if (!chapSys.has(chap)) chapSys.set(chap, new Map());
  const m = chapSys.get(chap); m.set(ps.system, (m.get(ps.system) || 0) + 1);
}
const CHAPTER_SYS = {};
for (const [chap, m] of chapSys) {
  let best = null, bc = -1;
  for (const [sys, c] of m) if (c > bc) { bc = c; best = sys; }
  CHAPTER_SYS[chap] = best;
}

/* ---------- 4. id 重排（扩展） + 别名（极光） ---------- */
const IDMAP_FILE = path.join(OUT, 'id_map.json');
let idmap = fs.existsSync(IDMAP_FILE) ? rd(IDMAP_FILE) : { version: 1, extMap: {}, jgAliases: {} };
idmap.extMap ||= {}; idmap.jgAliases ||= {};

// 每科已用最大序号
const maxSeq = {};
for (const [oldId, newId] of Object.entries(idmap.extMap)) {
  const m = /^ext-([a-z0-9\-]+)-(\d{6})$/.exec(newId);
  if (m) maxSeq[m[1]] = Math.max(maxSeq[m[1]] || 0, +m[2]);
}
// 待分配的扩展题：确定性排序
const extBySub = {};
for (const q of all) {
  if (q._grp !== 'ext') continue;
  (extBySub[q._subject] ||= []).push(q);
}
let extNew = 0, extReuse = 0;
for (const [subject, list] of Object.entries(extBySub)) {
  const code = CODE_OF[subject];
  list.sort((a, b) => {
    const ca = String(a.chapter || ''), cb = String(b.chapter || '');
    if (ca !== cb) return ca < cb ? -1 : 1;
    const na = norm(a.stem), nb = norm(b.stem);
    if (na !== nb) return na < nb ? -1 : 1;
    const oa = Object.keys(a.options || {}).map(k => a.options[k]).join('\u0001');
    const ob = Object.keys(b.options || {}).map(k => b.options[k]).join('\u0001');
    return oa < ob ? -1 : oa > ob ? 1 : 0;
  });
  let seq = maxSeq[code] || 0;
  for (const q of list) {
    if (idmap.extMap[q.id]) { q._newId = idmap.extMap[q.id]; extReuse++; continue; }
    seq++;
    const nid = `ext-${code}-${String(seq).padStart(6, '0')}`;
    idmap.extMap[q.id] = nid;
    q._newId = nid;
    extNew++;
    maxSeq[code] = seq;
  }
}
// 极光别名
for (const q of all) {
  if (q._grp !== 'jg') continue;
  const al = (q.flags && q.flags.aliasIds) || [];
  const list = [...new Set([...(idmap.jgAliases[q.id] || []), ...al])].filter(x => x !== q.id);
  if (list.length) idmap.jgAliases[q.id] = list;
}
log(`扩展重排：复用 ${extReuse} / 新编号 ${extNew}；极光别名 ${Object.keys(idmap.jgAliases).length} 组`);

/* ---------- 5. 归一化输出 ---------- */
ensureDir(path.join(OUT, 'by_subject'));
ensureDir(path.join(OUT, 'explain'));

const enumAcc = {
  subject: new Map(), type: new Map(), source: new Map(), qsource: new Map(),
  part: new Map(), system: new Map(), chapter: new Map(), year: new Map(), difficulty: new Map(),
};
const bump = (dim, key) => { if (key === null || key === undefined || key === '') return; const m = enumAcc[dim]; m.set(key, (m.get(key) || 0) + 1); };

const csvEsc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const CSV_COLS = ['id', 'oldId', 'sem', 'sid', 'subject', 'grp', 'src', 'type', 'part', 'system', 'chapter', 'chapterId', 'year', 'qsource', 'qsourceKind', 'difficulty', 'stat_n', 'stat_ac', 'stat_fv', 'img', 'stem', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'answer', 'flags', 'aliases'];

const bySubLines = {};
const csvLines = [CSV_COLS.join(',')];
const jsonlAll = [];
const explainOut = {};

for (const q of all) {
  const isJg = q._grp === 'jg';
  const newId = isJg ? q.id : (q._newId || q.id);
  const aliases = isJg
    ? (idmap.jgAliases[q.id] || [])
    : [q.id, ...(q.flags && q.flags.aliasIds ? q.flags.aliasIds : [])].filter(x => x !== newId);
  const t = TYPE_MAP[q.type] || { code: 'other', label: q.type || '未知', kind: 'other' };
  const s = SOURCE_MAP[q.source] || { code: 'other', label: q.source || '未知' };
  const ps = parseSys(q.sys);
  const chapter = ps.chapter || q.chapter || null;
  const system = ps.system || (chapter ? (CHAPTER_SYS[chapter] || null) : null);
  const qsInfo = parseQs(q.qs);
  const year = q.y || q.examYear || qsInfo.year || null;
  const sid = CODE_OF[q._subject] || 'unknown';
  const flags = q.flags ? Object.keys(q.flags).join('|') : '';

  const rec = {
    id: newId,
    oldId: isJg ? null : q.id,
    sem: q._sem,
    sid,
    subject: q._subject,
    grp: q._grp,
    src: s.code,
    type: t.code,
    kind: t.kind,
    chapter,
    chapterId: q.cid || null,
    system,
    year,
    qsource: q.qs || null,
    qsourceKind: qsInfo.kind,
    difficulty: q.d ?? null,
    stats: { n: q.n ?? null, ac: q.ac ?? null, fv: q.fv ?? null },
    img: q.img ?? 0,
    stem: q.stem,
    options: q.options || {},
    answer: q.answer,
    /* ---- 统一 schema 扩展字段（稀疏：无值写 null；字段字典见 schema_unified.json） ---- */
    caseInfo: q.caseInfo || null,
    tags: (q.tags && q.tags.length) ? q.tags : null,
    suggestedTags: (q.suggestedTags && q.suggestedTags.length) ? q.suggestedTags : null,
    sourceType: q.sourceType || null,
    nativeYear: q.nativeYear ?? null,
    flags: flags || null,
    aliases: aliases.length ? aliases : null,
  };
  for (const k of RESERVED_FIELDS) if (q[k] !== undefined && q[k] !== null) rec[k] = q[k];
  const line = JSON.stringify(rec);
  jsonlAll.push(line);
  (bySubLines[sid] ||= []).push(line);

  const o = rec.options;
  const csvRow = [
    newId, rec.oldId, rec.sem, sid, q._subject, rec.grp, s.code, t.code, ps.part, system, chapter, rec.chapterId, year, rec.qsource, rec.qsourceKind,
    q.d ?? '', q.n ?? '', q.ac ?? '', q.fv ?? '', q.img ?? 0,
    q.stem, o.A, o.B, o.C, o.D, o.E, o.F, o.G, o.H, q.answer, flags, rec.aliases ? rec.aliases.join('|') : '',
  ];
  if (csvRow.length !== CSV_COLS.length) throw new Error(`CSV 列数不符: 行 ${csvRow.length} vs 表头 ${CSV_COLS.length} (id=${newId})`);
  csvLines.push(csvRow.map(csvEsc).join(','));

  bump('subject', q._subject); bump('type', q.type); bump('source', q.source);
  bump('qsource', q.qs || null); bump('part', ps.part); bump('system', system); bump('chapter', chapter);
  bump('year', year); bump('difficulty', q.d ?? null);
}

/* ---------- 6. 解析分片 ---------- */
/* packs 的 explain 自 v4 起是「富解析」{bf, b:[块]}（见 schema_unified.explainFormat）。
 * 归一化层是给检索/分析用的，统一摊平成纯文本（富结构原样保留在 packs/site）。 */
function richToText(e) {
  if (typeof e === 'string') return e;
  if (!e) return '';
  if (e.t) return e.t;
  const out = [];
  if (e.bf) out.push(e.bf);
  for (const b of (e.b || [])) {
    const [ty, , title] = b;
    if (title) out.push('### ' + title);
    if (ty === 'tb') { out.push((b[3] || []).join(' | ')); for (const r of (b[4] || [])) out.push(r.join(' | ')); }
    else if (ty === 'l') out.push((b[3] || []).map(x => '- ' + x).join('\n'));
    else out.push(String(b[3] || '').replace(/^[-*]\s+/, ''));
  }
  return out.filter(Boolean).join('\n\n');
}
let nExplain = 0;
for (const sem of SEMS) {
  for (const cand of [path.join(PACKS, sem, 'explain'), path.join(PACKS, 'explain')]) {
    if (!fs.existsSync(cand)) continue;
    for (const f of fs.readdirSync(cand)) {
      if (!f.endsWith('.json')) continue;
      const subject = f.replace(/\.json$/, '');
      const sid = CODE_OF[subject] || 'unknown';
      let em; try { em = rd(path.join(cand, f)); } catch { continue; }
      const store = (explainOut[sid] ||= {});
      for (const [id, v] of Object.entries(em)) {
        if (!v || store[id]) continue;
        store[id] = richToText(v);
        nExplain++;
      }
    }
  }
}
// 主 id 与旧 id 双向登记解析（做题时按 id 取）
for (const [sid, store] of Object.entries(explainOut)) {
  const extra = {};
  for (const [oldId, newId] of Object.entries(idmap.extMap)) if (store[oldId] && !store[newId]) extra[newId] = store[oldId];
  Object.assign(store, extra);
}

/* ---------- 7. 落盘 ---------- */
log('写出 JSONL / CSV ...');
fs.writeFileSync(path.join(OUT, 'questions.jsonl'), jsonlAll.join('\n'), 'utf8');
fs.writeFileSync(path.join(OUT, 'questions.csv'), '\uFEFF' + csvLines.join('\r\n'), 'utf8');
for (const [sid, lines] of Object.entries(bySubLines)) fs.writeFileSync(path.join(OUT, 'by_subject', sid + '.jsonl'), lines.join('\n'), 'utf8');
for (const [sid, store] of Object.entries(explainOut)) fs.writeFileSync(path.join(OUT, 'explain', sid + '.jsonl'), Object.entries(store).map(([k, v]) => JSON.stringify({ id: k, explanation: v })).join('\n'), 'utf8');

/* 类目并集字典 */
const dimMeta = {
  subject: { label: '学科', keyOf: x => x },
  type: { label: '题型', keyOf: x => x },
  source: { label: '来源', keyOf: x => x },
  qsource: { label: '题目出处', keyOf: x => x },
  part: { label: '分部/篇', keyOf: x => x },
  system: { label: '系统/模块', keyOf: x => x },
  chapter: { label: '章节', keyOf: x => x },
  year: { label: '年份', keyOf: x => String(x) },
  difficulty: { label: '难度', keyOf: x => String(x) },
};
const enums = { version: 1, generatedAt: new Date().toISOString(), dimensions: {} };
for (const [dim, m] of Object.entries(enumAcc)) {
  const items = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ value: k, count: c }));
  let extra = {};
  if (dim === 'subject') extra = Object.fromEntries(items.map(it => [it.value, { code: CODE_OF[it.value] || 'unknown', sem: SEM_OF[it.value] || null }]));
  if (dim === 'type') extra = Object.fromEntries(items.map(it => [it.value, TYPE_MAP[it.value] || { code: 'other', label: it.value, kind: 'other' }]));
  if (dim === 'source') extra = Object.fromEntries(items.map(it => [it.value, SOURCE_MAP[it.value] || { code: 'other', label: it.value }]));
  enums.dimensions[dim] = { label: dimMeta[dim].label, distinct: items.length, items: items.map(it => ({ ...it, ...(extra[it.value] || {}) })) };
}
// 原始 sys 并集（保留未规范化的原值，便于追溯）
const sysRaw = new Map();
for (const q of all) if (q.sys) sysRaw.set(q.sys, (sysRaw.get(q.sys) || 0) + 1);
enums.dimensions.systemRaw = { label: '系统（原始值）', distinct: sysRaw.size, items: [...sysRaw.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })) };
fs.writeFileSync(path.join(OUT, 'enums.json'), JSON.stringify(enums, null, 1), 'utf8');

/* id 映射 */
idmap.jgAliasesFrozen = Object.keys(idmap.jgAliases).length;
idmap.generatedAt = new Date().toISOString();
fs.writeFileSync(IDMAP_FILE, JSON.stringify(idmap, null, 1), 'utf8');

/* schema */
const schema = {
  version: 2,
  note: '归一化后的统一题目 schema。分类字段一律用 canonical code，显示名见 enums.json。完整字段字典（含三源名映射、各层裁剪、已丢弃字段）见 题库调研/schema_unified.json。',
  fields: {
    id: '主 id。极光=极光原始 UUID（永不变）；扩展=ext-<学科代号>-<6位序号>',
    oldId: '仅扩展题有：重排前的 id（ext-<hash>），用户旧数据靠它迁移',
    sem: '学期：大一/大二/大三/大四/水平测试',
    sid: '学科代号，见 subjects.json',
    subject: '学科中文名',
    grp: 'jg=极光题库 / ext=扩展题库',
    src: '来源 canonical code：jiguang|ykb|kaoyan|unknown|oursite',
    type: '题型 canonical code：a1|a2|a3|multi|tf|blank',
    kind: '按题型推导的作答方式：single|multi|tf|blank',
    chapter: '章节名（并集自各来源）',
    chapterId: '章节 id。极光=极光章节 UUID（保留，兼容旧分章进度）；扩展=x<章名>',
    part: '篇/部分（并集；如「第二篇」「上篇」）',
    system: '系统/模块（并集；由 sys 首段或章节反查表得出）',
    year: '年份',
    qsource: '题目出处原值（如「2024年考研真题」「待整理来源」）',
    qsourceKind: 'kaoyan|other',
    difficulty: '难度 1-5（极光原始 difficulty）',
    stats: '{n:答题人次, ac:正确率%, fv:收藏数}',
    img: '原图数量',
    stem: '题干',
    options: '选项对象 {A:..,B:..}',
    answer: '答案字母串（多选为多个字母）',
    caseInfo: '病例摘要（A2/A3 题干的前置情境）；无则 null',
    tags: '标签（iyixue 原生 tags）；无则 null',
    suggestedTags: '建议标签；无则 null',
    sourceType: '抓取来源类型 network|contribution|legacy；无则 null',
    nativeYear: 'iyixue 原生 year 字段（与 year 可能不同源）；无则 null',
    flags: '标记（| 分隔）：imageMissing|missingOption|aliasIds|answerAdjusted|...',
    aliases: '同题的其它 id（用户旧数据可能存的是这些）',
  },
  reservedFields: {
    note: 'iyixue 预留字段位，当前多为空/壳值但后续接口会填 → 稀疏透传（有值才出现）。前端一律 `?? \'\'` 兜底，不得删除。',
    list: RESERVED_FIELDS,
  },
};

let nJg = all.filter(q => q._grp === 'jg').length;
let nExt = all.length - nJg;
const manifest = {
  version: 'N1-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  generatedAt: new Date().toISOString(),
  totals: { questions: all.length, jiguang: nJg, extension: nExt, subjects: subjects.size, explain: nExplain, csvRows: csvLines.length - 1 },
  idPolicy: {
    jiguang: '原 UUID 不变，同题其它 id 进 aliases',
    extension: 'ext-<sid>-<000001> 顺序号；映射持久化于 id_map.json，重跑复用旧号，新增题只追加',
  },
  enums: Object.fromEntries(Object.entries(enums.dimensions).map(([k, v]) => [k, v.distinct])),
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
fs.writeFileSync(path.join(OUT, 'schema.json'), JSON.stringify(schema, null, 1), 'utf8');

log(`完成：${all.length} 题（极光 ${nJg} / 扩展 ${nExt}）| 解析 ${nExplain} | 学科 ${subjects.size}`);
log(`类目并集：` + Object.entries(manifest.enums).map(([k, v]) => `${k}=${v}`).join(' '));
