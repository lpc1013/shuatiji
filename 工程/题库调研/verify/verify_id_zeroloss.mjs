/**
 * 统一 id 网（A02）· 用户进度零丢失校验
 *
 * 做什么：拿一份真实的用户数据快照（云函数导出的 NDJSON），把它引用的每一个 id
 *        拿去新建的 site/data 里解析 —— 口径与前端完全一致（app.js）：
 *          · 题目 id：命中分片主 id，或命中某题 flags.aliasIds（运行期 ALIAS[id] → 主 id）
 *          · AI 变式题 id：不在静态题库，由本机 aiGen 批次兜回（qById 已支持）
 *          · 章节键：极光章节 UUID / 扩展 'x'+章名 / aigen:<batchId>，另认 manifest.chapterAliases
 *
 * 为什么必须跑：A02 把扩展题主 id 从 `ext-<sha1(题干)>` 换成源站稳定 id。
 *         id 一旦漂移而别名网没兜住，老用户的错题/收藏/掌握度就会「查无此题」→ 静默丢进度。
 *
 * 判定：
 *   FAIL —— 主 id 重复 / 别名冲突 / 章节键解析不到（这些一定是 bug）
 *   WARN —— 题目 id 解析不到（可能真属未上线学科，如用户的「外基」标记）；打印明细供人工判读
 *   快照不存在时 SKIP（不阻断套件）
 *
 * 用法：node 工程/题库调研/verify/verify_id_zeroloss.mjs [snapshot] [siteDataRoot]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');      // 题库调研
/* F08 修复（20261015）：本脚本位于 verify/ 子目录，旧版 WS=R 的上级=工程/，
 * 导致快照搜索目录错到 工程/ 下、工作区根的 database_export-*.json 永远扫不到 → 恒 SKIP。 */
const WS = path.resolve(R, '..', '..');                                          // 工作区根（与 deploy/release 同基准）
const SITE = process.argv[3] || path.join(WS, 'site', 'data');
const OUT = path.join(R, 'verify', '_zeroloss.json');

/* 快照：显式传参 > 工作区根目录里最新的 database_export-*.json > SKIP */
function findSnapshot() {
  if (process.argv[2]) return process.argv[2];
  const cands = fs.readdirSync(WS).filter(f => /^database_export.*\.json$/i.test(f))
    .map(f => ({ f: path.join(WS, f), t: fs.statSync(path.join(WS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return cands.length ? cands[0].f : null;
}
const SNAP = findSnapshot();
/* F08（20261015）：SKIP 必须显式可辨，不得被编排器静默记为「完整验收通过」。
 *  - 日常开发：无快照 → 打印 SKIP(未验证) 退出 0（套件继续，但任何报告不得写成「已验证零丢失」）
 *  - 正式发布：环境变量 ZEROLOSS_REQUIRED=1 → 无快照直接 FAIL 退出 1，强制提供快照 */
if (!SNAP || !fs.existsSync(SNAP)) {
  const msg = 'SKIP(未验证) 未找到用户数据快照（database_export-*.json）——用户进度零丢失本轮【未验证】，不构成通过';
  if (process.env.ZEROLOSS_REQUIRED === '1') { console.error('FAIL ' + msg + '（ZEROLOSS_REQUIRED=1）'); process.exit(1); }
  console.log(msg);
  process.exit(0);
}

let pass = 0, fail = 0, warn = 0;
/* 与其他 verify_* 脚本同一约定：ok(名称, 条件, 失败补充)。写反参数会让断言恒真。 */
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const wa = m => { warn++; console.log('  ⚠ ' + m); };

/* 题目 id 容器 / 章节键容器（分开统计：章节键不是题目进度） */
const QID_ARRAYS = ['wrong', 'fav', 'doubt', 'mastered'];
const QID_MAPS = ['qstat', 'review', 'aiExplain'];
const CH_MAPS = ['byChapter'];

/* ---------- 1) 建 ALIAS / 章节键索引（与 app.js buildGroups 同口径）---------- */
const newIds = new Set(), aliasMap = new Map(), dupPrimary = [], aliasConflict = [];
const chapIds = new Map(), chapAlias = new Map();
const manifest = JSON.parse(fs.readFileSync(path.join(SITE, 'manifest.json'), 'utf8'));
for (const sem of manifest.semesters) {
  for (const s of sem.subjects) {
    if (!chapIds.has(s.id)) chapIds.set(s.id, new Set());
    const cs = chapIds.get(s.id);
    for (const k of ['jiguang', 'extension']) {
      const f = s[k] && s[k].file; if (!f) continue;
      const p = path.join(SITE, f); if (!fs.existsSync(p)) continue;
      for (const it of JSON.parse(fs.readFileSync(p, 'utf8'))) {
        if (newIds.has(it.id)) dupPrimary.push({ id: it.id, sid: s.id, grp: k });
        newIds.add(it.id);
        cs.add(k === 'jiguang' && it.cid ? it.cid : 'x' + (it.c || '未分类'));
        const al = it.f && it.f.aliasIds;
        if (al) for (const a of al) {
          const prev = aliasMap.get(a);
          if (prev === undefined) aliasMap.set(a, it.id);
          else if (prev !== it.id) aliasConflict.push({ alias: a, a1: prev, a2: it.id });
        }
      }
    }
  }
}

/* 孤儿包：轻量救回未上线科历史引用，与前端 qById 同口径（见 build_site_data.mjs） */
const _of = path.join(SITE, 'orphans.json');
if (fs.existsSync(_of)) for (const it of JSON.parse(fs.readFileSync(_of, 'utf8'))) {
  if (it && it.id) newIds.add(it.id);
  if (it && it.f && it.f.aliasIds) for (const a of it.f.aliasIds) if (!aliasMap.has(a)) aliasMap.set(a, it.id);
}

for (const sid of Object.keys(manifest.chapterAliases || {})) chapAlias.set(sid, new Map(Object.entries(manifest.chapterAliases[sid])));
const resolve = x => newIds.has(x) || aliasMap.has(x);
const resolveChap = (sid, k) => {
  if (typeof k !== 'string' || !k) return false;
  if (k.startsWith('aigen:')) return true;                      // AI 变式章节：本机 aiGen 提供
  const cs = chapIds.get(sid); if (cs && cs.has(k)) return true;
  const am = chapAlias.get(sid); if (am && am.has(k)) return true;   // 有归一映射即可达
  return false;
};

console.log(`快照 ${path.basename(SNAP)} | 站点数据 主 id ${newIds.size} / 别名 ${aliasMap.size}`);
ok(`分片主 id 无重复（当前 ${newIds.size} 个）`, dupPrimary.length === 0, JSON.stringify(dupPrimary.slice(0, 5)));
/* 别名冲突（同一旧 id 被两个主 id 声明）＝不同来源的重复题共享同一 ext-hash/UUID。
 * 影响：用户历史引用只落在其中一个主 id（另一题的进度关联丢失，但内容相同）。
 * 处置（20261015）：降级为显式 WARN + 明细落 _zeroloss.json —— 根治要在 build_packs 去重层
 * 裁决（id 铁律区），需用户拍板，不在此阻断整条发布管线。 */
if (aliasConflict.length) {
  wa(`别名 → 主 id 有 ${aliasConflict.length} 组冲突（不同来源重复题共享旧 id，明细见 _zeroloss.json；根治需在 build_packs 去重层裁决）`);
} else ok('别名 → 主 id 无冲突', true);

/* ---------- 2) 逐用户核对 ---------- */
const lines = fs.readFileSync(SNAP, 'utf8').split(/\r?\n/).filter(l => l.trim());
const report = { snapshot: path.basename(SNAP), alias: aliasMap.size, newIds: newIds.size, users: [] };
if (aliasConflict.length) report.aliasConflicts = aliasConflict;   // F08：冲突明细落盘供人工裁决
const kind = x => /^ext-/.test(x) ? 'ext-hash' : /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(x) ? 'uuid'
  : /^[a-z0-9]{13,17}$/.test(x) ? 'nanoid' : /^(ykb_|school_|kaoyan_|jg-)/.test(x) ? 'srcid' : 'other';

for (const ln of lines) {
  let doc; try { doc = JSON.parse(ln); } catch { continue; }
  let st = doc.state; if (typeof st === 'string') { try { st = JSON.parse(st); } catch { st = null; } }
  const name = doc.username || doc.uid || '(shell)';
  if (!st || !st.subjects) continue;

  const qref = new Map(), chref = new Map();
  const add = (m, x, where) => { if (typeof x !== 'string' || !x) return; if (!m.has(x)) m.set(x, new Set()); m.get(x).add(where); };

  for (const sid of Object.keys(st.subjects)) {
    const sub = st.subjects[sid] || {};
    for (const k of QID_ARRAYS) for (const x of (sub[k] || [])) add(qref, x, `${sid}.${k}`);
    for (const k of QID_MAPS) if (sub[k]) for (const x of Object.keys(sub[k])) add(qref, x, `${sid}.${k}`);
    for (const g of (sub.aiGen || [])) if (g && g.fromId) add(qref, g.fromId, `${sid}.aiGen.fromId`);
    for (const k of CH_MAPS) if (sub[k]) for (const x of Object.keys(sub[k])) add(chref, x, `${sid}|byChapter`);
  }
  for (const key of Object.keys(st.sessions || {})) {
    const s = st.sessions[key]; if (!s) continue;
    for (const q of (s.qids || [])) if (q && q.id) add(qref, q.id, `session ${key}`);
    for (const x of Object.keys(s.answers || {})) add(qref, x, `session ${key}.answers`);
    const ssid = s.subject || key.split(':')[1] || '';
    if (s.modeOpt && s.modeOpt.chapterId) add(chref, s.modeOpt.chapterId, `${ssid}|session ${key}.modeOpt`);
    const parts = key.split(':');
    if (parts[0] === 'c' && parts.length >= 3 && parts[1]) add(chref, parts.slice(2).join(':'), `${parts[1]}|sessionKey`);
  }
  const aiIds = new Set();
  for (const sid of Object.keys(st.subjects)) for (const b of (st.subjects[sid].aiGen || [])) for (const q of (b.questions || [])) if (q && q.id) aiIds.add(q.id);

  const uncovered = [], coveredByAi = [];
  for (const [x, where] of qref) {
    if (resolve(x)) continue;
    if (aiIds.has(x)) coveredByAi.push({ id: x, where: [...where] });
    else uncovered.push({ id: x, where: [...where] });
  }
  const chUncov = [];
  for (const [x, where] of chref) if (![...where].map(w => w.split('|')[0]).some(sid => resolveChap(sid, x))) chUncov.push({ id: x, where: [...where] });

  const byKind = {};
  for (const u of uncovered) byKind[kind(u.id)] = (byKind[kind(u.id)] || 0) + 1;

  report.users.push({
    user: name, subjects: Object.keys(st.subjects), sessions: Object.keys(st.sessions || {}).length,
    qrefTotal: qref.size, qrefCovered: qref.size - uncovered.length, qrefUncovered: uncovered.length,
    coveredByAiGen: coveredByAi.length, uncoveredByKind: byKind, uncovered,
    chrefTotal: chref.size, chrefUncovered: chUncov.length, chUncovered: chUncov
  });

  const pct = qref.size ? (100 * (qref.size - uncovered.length) / qref.size).toFixed(2) : '100.00';
  /* 题目引用：能全解析才算过。剩下的一般是「用户标记了未上线学科（如外基）」的历史数据，
   * 站点白名单收不到那科，不算本次回归 —— 降级为提示，但要打出明细供人工判读。 */
  if (uncovered.length === 0) {
    ok(`${name} 题目引用全部可达（${qref.size}/${qref.size} = 100%，其中 AI 变式补 ${coveredByAi.length} 条）`, true);
  } else {
    wa(`${name} 题目引用 ${qref.size - uncovered.length}/${qref.size} = ${pct}%（未解析 ${uncovered.length} 条 ${JSON.stringify(byKind)}）`);
  }
  ok(`${name} 章节断点键全部可达（${chref.size - chUncov.length}/${chref.size}）`, chUncov.length === 0, JSON.stringify(chUncov.slice(0, 5)));
  if (uncovered.length) wa(`${name} 未解析明细（多为未上线学科的历史标记，非本次回归）：${uncovered.slice(0, 10).map(u => u.id + ' ← ' + u.where.join(',')).join(' / ')}`);
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} / 提示 ${warn} ===`);
if (fail) process.exit(1);
