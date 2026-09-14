/**
 * 字段统一 v3 专项校验（不依赖浏览器、不依赖已删除的 site/data/data.js）
 *
 * 证明链（用户进度零丢失）：
 *   merged2 的 id 集合在本次重建前后完全一致
 *     → packs 的极光 id ⊆ merged2 的 id
 *       → site 的题目 id ⊆ packs 的 id ∪ aliasIds
 * 再叠加：site 三科题数 14,877 → 14,880（只增不减）
 *
 * 另断言：新字段确实进包、9 个预留字段通道在 schema 中存在。
 * 用法: node 工程/题库调研/verify/verify_schema_unified.mjs
 */
import fs from 'fs';
import path from 'path';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const R = path.join(WS, '工程', '题库调研');
const PACKS = path.join(R, 'packs');
const DATA = path.join(WS, 'site', 'data');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const SEMS = ['大一', '大二', '大三', '大四', '水平测试'];

console.log('== 1) merged2 重建是否为纯增量 ==');
const snapBefore = rd(path.join(R, 'verify', 'baseline_ids_20260912.json'));
const curlHash = a => {
  const h = new Map(a.map(x => [x[0], x[1]]));
  return h;
};
const beforeMap = curlHash(snapBefore.pairs);
let mCount = 0, mIdChanged = 0, mAnsChanged = 0;
const mIds = new Set();
for (const f of fs.readdirSync(path.join(R, 'merged2', 'by_subject'))) {
  if (!f.endsWith('.json')) continue;
  for (const q of rd(path.join(R, 'merged2', 'by_subject', f))) {
    mCount++;
    mIds.add(q.id);
    if (!beforeMap.has(q.id)) mIdChanged++;
    else if (beforeMap.get(q.id) !== String(q.answerResolved ?? q.answer ?? '')) mAnsChanged++;
  }
}
ok(mCount === 108018, `merged2 题数 108018，实为 ${mCount}`);
ok(mIds.size === snapBefore.count, `merged2 唯一 id 数 = 变更前 ${snapBefore.count}，实为 ${mIds.size}`);
ok(mIdChanged === 0, `相对变更前新增/丢失 id ${mIdChanged} 条（应为 0）`);
ok(mAnsChanged === 0, `相对变更前答案变化 ${mAnsChanged} 条（应为 0）`);

console.log('== 2) packs 完整性 + 字段覆盖 ==');
const packIds = new Set();
let pTotal = 0, pCase = 0, pTags = 0, pStg = 0, pSt = 0, pExamYear = 0;
const reservedSeen = new Map();
/* 9 个预留字段 + questionRevision：
 *   - merged2 / packs 保留全部 10 个（questionRevision 是内容指纹，供「题干变更 → 复习记录定向失效」用）
 *   - site 只保留 9 个：前端当前不消费 questionRevision，而它 95% 有值 ≈ 0.3MB，
 *     不进前端分片是有意为之（要用时在 build_site_data 的 RESERVED_FIELDS 里加回即可） */
const RESERVED9 = ['mnemonic', 'knowledgePoint', 'knowledgePoints', 'optionExplanations', 'reasoningSteps', 'frequencyLevel', 'studyPoints', 'memoryCards', 'memoryCardMeta'];
const RESERVED = [...RESERVED9, 'questionRevision'];
for (const sem of SEMS) for (const grp of ['极光', '扩展']) {
  const d = path.join(PACKS, sem, grp);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    const arr = rd(path.join(d, f));
    if (!Array.isArray(arr)) continue;
    for (const q of arr) {
      pTotal++; packIds.add(q.id);
      if (q.flags && q.flags.aliasIds) for (const a of q.flags.aliasIds) packIds.add(a);
      if (q.caseInfo) pCase++;
      if (q.tags && q.tags.length) pTags++;
      if (q.suggestedTags && q.suggestedTags.length) pStg++;
      if (q.sourceType) pSt++;
      if (q.examYear) pExamYear++;
      for (const k of RESERVED) if (q[k] !== undefined) reservedSeen.set(k, (reservedSeen.get(k) || 0) + 1);
    }
  }
}
/* packs 总题数 = merged2 唯一题 − 跨组重复题（同稳定源 id 同时出现在极光/扩展，构建期故意跳过以免 id 分裂）
 *                  + 兜底补回（上一版有、本次未命中的题原位补回，保进度不丢）。
 * 权威值取 build_packs 自检通过的 manifest.totals.questions（已验证 == usedPrimary.size == 写盘回读数）。
 * 注：不能用 108018 + 兜底，因为那样会漏掉「跨组重复题被跳过」的 −20，造成误报 FATAL。 */
const pManifest = rd(path.join(PACKS, 'manifest.json'));
const backfilled = (pManifest.totals && pManifest.totals.siteBackfilled) || 0;
ok(pTotal === pManifest.totals.questions, `packs 题数应 = manifest.totals.questions（构建自检值 ${pManifest.totals.questions}，含跨组去重 −${108018 + backfilled - pManifest.totals.questions} + 兜底补回 ${backfilled}），实为 ${pTotal}`);
console.log(`  兜底补回（上一版有、本次未命中，为保进度原位补回）：${backfilled} 条`);
console.log(`  packs 唯一 id（含别名）${packIds.size}`);
console.log(`  新字段覆盖：caseInfo ${pCase} / tags ${pTags} / suggestedTags ${pStg} / sourceType ${pSt} / examYear ${pExamYear}`);
ok(pCase > 2000, `caseInfo 应 >2000 条，实为 ${pCase}`);
ok(pTags > 1000, `tags 应 >1000 条，实为 ${pTags}`);
ok(pSt > 50000, `sourceType 应 >50000 条，实为 ${pSt}`);
console.log(`  预留字段在 packs 中的出现次数：${JSON.stringify(Object.fromEntries(reservedSeen)) || '(全为 0，符合预期：源数据为空/壳值)'}`);

// packs 的极光 id 是「裸 UUID」（无 `jiguang:` 前缀），merged2 的 id 带前缀 → 比较前剥前缀
const mIdsBare = new Set([...mIds].map(x => String(x).replace(/^[a-z]+:/, '')));
let jgNotInMerged = 0;
for (const sem of SEMS) {
  const d = path.join(PACKS, sem, '极光');
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    for (const q of rd(path.join(d, f))) if (!mIdsBare.has(q.id)) jgNotInMerged++;
  }
}
ok(jgNotInMerged === 0, `packs 极光组有 ${jgNotInMerged} 题 id 不在 merged2 中（应为 0）`);

console.log('== 3) site/data 用户进度兼容 ==');
const man = rd(path.join(DATA, 'manifest.json'));
let sTotal = 0, sMiss = 0, sCase = 0, sEy = 0, sTg = 0, sSt = 0;
for (const sem of man.semesters) for (const s of sem.subjects) {
  for (const key of ['jiguang', 'extension']) {
    const d = s[key]; if (!d) continue;
    const arr = rd(path.join(DATA, d.file));
    if (arr.length !== d.count) fail++, console.log(`  ✗ ${d.file} 题数与 manifest 不符`);
    for (const q of arr) {
      sTotal++; if (!packIds.has(q.id)) sMiss++;
      if (q.ci) sCase++;
      if (q.ey) sEy++;
      if (q.tg && q.tg.length) sTg++;
      if (q.st) sSt++;
    }
    console.log(`  · ${s.name}/${key} ${arr.length} 题`);
  }
}
ok(sTotal === man.totals.questions, `site 分片题数合计 ${sTotal} = manifest ${man.totals.questions}`);
ok(sMiss === 0, `site 有 ${sMiss} 题 id 不在 packs 中（应为 0 → 用户进度零丢失）`);
console.log(`  site 新字段：caseInfo ${sCase} / examYear ${sEy} / tags ${sTg} / sourceType ${sSt}`);
ok(sCase > 40, `site 应带 caseInfo（实为 ${sCase}）`);
ok(sTg > 40, `site 应带 tags（实为 ${sTg}）`);
console.log(`  site 三科题数 ${sTotal}（上一版 14877，本次 +${sTotal - 14877}）`);
ok(sTotal >= 14877, `site 题数不得少于上一版 14877，实为 ${sTotal}`);

console.log('== 4) 预留字段通道（schema 层）==');
const bsd = fs.readFileSync(path.join(R, 'build_site_data.mjs'), 'utf8');
const bp = fs.readFileSync(path.join(R, 'build_packs.mjs'), 'utf8');
const mg = fs.readFileSync(path.join(R, 'merge2.mjs'), 'utf8');
ok(RESERVED9.every(k => bsd.includes(k)), 'build_site_data.mjs 含 9 个预留字段通道（不含前端不消费的 questionRevision）');
ok(RESERVED.every(k => bp.includes(k)), 'build_packs.mjs 含全部 10 个预留字段通道');
ok(RESERVED.every(k => mg.includes(k)), 'merge2.mjs 含全部 10 个预留字段通道');
// 只查「运行期引用」：注释里提到 data.js 是说明性文字，不算引用
const hasLiveDataJsRef = src => src.split('\n').some(l => {
  const t = l.trim();
  return l.includes('data.js') && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
});
ok(!hasLiveDataJsRef(mg) && !hasLiveDataJsRef(bp), '已移除对已删除 data.js 的运行期引用（注释除外）');
ok(!bsd.includes('site/data/data.js'), 'build_site_data.mjs 不引用 data.js');

console.log('== 5) 富解析分片（blocks + 文本补全）==');
const EX_SUB = [['大二', '生物化学', 'bio'], ['大二', '生理学', 'physiology'], ['大二', '医学免疫学', 'immunology']];
let exN = 0, exObj = 0, exStr = 0, exBrief = 0, exBlocks = 0, exTx = 0, exTb = 0, exCallout = 0, exList = 0;
const secSeen = {}, tySeen = {};
// 聚合 site 按章节拆分的分片（explain/<学期>/<sid>/<章节>.json）为单对象，便于与 packs 源逐条比对
function loadSiteExplain(sem, sid) {
  const dir = path.join(DATA, 'explain', sem, sid);
  if (!fs.existsSync(dir)) return null;
  const agg = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    Object.assign(agg, rd(path.join(dir, f)));
  }
  return agg;
}
for (const [sem, sub, sid] of EX_SUB) {
  const pp = path.join(PACKS, sem, 'explain', sub + '.json');
  const spDir = path.join(DATA, 'explain', sem, sid);
  const spFiles = fs.existsSync(spDir) ? fs.readdirSync(spDir).filter(f => f.endsWith('.json')) : [];
  ok(fs.existsSync(pp) && spFiles.length > 0, `${sub} packs/site 两侧 explain 分片都存在（site 章节文件 ${spFiles.length} 个）`);
  if (!fs.existsSync(pp) || spFiles.length === 0) continue;
  const po = rd(pp), so = loadSiteExplain(sem, sid);
  const pk = Object.keys(po), sk = Object.keys(so);
  ok(sk.length === pk.length, `${sub} site explain 条目数 = packs（${pk.length} vs ${sk.length}）`);
  // site 分片必须是 packs 的逐条复制（富解析结构不丢）
  let mismatch = 0;
  for (const k of pk.slice(0, 50)) if (JSON.stringify(so[k]) !== JSON.stringify(po[k])) mismatch++;
  ok(mismatch === 0, `${sub} site explain 与 packs 内容一致（抽检 50 条）`);
  for (const k of sk) {
    exN++;
    const v = so[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) exObj++;
    else if (typeof v === 'string') exStr++;
    if (v && v.bf) exBrief++;
    for (const b of (v && v.b) || []) {
      exBlocks++;
      tySeen[b[0]] = (tySeen[b[0]] || 0) + 1;
      secSeen[b[1]] = (secSeen[b[1]] || 0) + 1;
      if (b[1] === 'tx') exTx++;
      if (b[0] === 'tb') exTb++;
      if (b[0] === 'c') exCallout++;
      if (b[0] === 'l') exList++;
    }
  }
}
console.log(`  三科富解析条目 ${exN}（对象 ${exObj} / 纯文本回退 ${exStr}）· 块 ${exBlocks}`);
console.log(`  块类型 ${JSON.stringify(tySeen)}`);
console.log(`  小节分布 ${JSON.stringify(secSeen)}`);
console.log(`  一句话解析 ${exBrief} / 教材出处块 ${exTx} / 表格块 ${exTb} / 提示块 ${exCallout} / 列表块 ${exList}`);
ok(exObj > exN * 0.99, `富解析对象应覆盖 >99%，实为 ${exObj}/${exN}`);
ok(exBrief > 4000, `一句话解析（briefExplanation）应 >4000 条，实为 ${exBrief}`);
ok(exTx > 3000, `「教材出处」必须由文本补全（源站 blocks 不含该小节），实为 ${exTx}`);
ok(exTb > 1000, `表格块应 >1000，实为 ${exTb}`);
ok((tySeen.tb || 0) > 0 && (tySeen.p || 0) > 0 && (tySeen.l || 0) > 0 && (tySeen.c || 0) > 0, '四种块类型齐备（p/tb/l/c）');
// 壳值过滤：memoryCardMeta 全库为壳值，不应写进任何产物
let shellLeak = 0;
for (const sem of SEMS) for (const grp of ['极光', '扩展']) {
  const d = path.join(PACKS, sem, grp);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    for (const q of rd(path.join(d, f))) if (q.memoryCardMeta) shellLeak++;
  }
}
ok(shellLeak === 0, `壳值字段 memoryCardMeta 不应进包（实为 ${shellLeak} 条）`);

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail ? 1 : 0);
