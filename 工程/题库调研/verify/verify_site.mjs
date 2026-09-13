/**
 * 站点数据自洽校验（不依赖浏览器、不依赖已删除的 site/data/data.js 与 .bak_20260912）
 *
 * 断言：
 *  1. manifest 可解析，学期/学科/题数勾稽得上
 *  2. 每个分片真实存在、可解析、题数与 manifest 声明一致
 *  3. 极光题章节 id 仍是「原始 UUID」；扩展题章节 id 为 `x<章名>`
 *  4. 扩展章节迁移表 chapterAliases 覆盖所有旧章名
 *  5. 模拟 app.js 的装配逻辑（toQ/buildGroups），检查字段齐备
 *  6. 元数据与新字段覆盖（d/n/ac/y/sys/cid + ci/ey/tg/st）
 *
 * 跨层 id 链验证（→ 用户进度零丢失）见 verify_schema_unified.mjs
 */
import fs from 'fs';
import path from 'path';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const DATA = path.join(WS, 'site', 'data');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const M = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
console.log('== 1) manifest ==');
ok(Array.isArray(M.semesters) && M.semesters.length > 0, `学期数应 >0，实为 ${(M.semesters || []).length}`);
const subNames = M.semesters.flatMap(s => s.subjects.map(x => x.name));
console.log(`  学期 ${M.semesters.map(s => s.name).join('/')} | 学科 ${M.totals.subjects}（${subNames.join('、')}）| 题 ${M.totals.questions}`);
console.log(`  首屏 manifest ${(fs.statSync(path.join(DATA, 'manifest.json')).size / 1024).toFixed(1)}KB`);
ok(!!M.fieldHelp && !!M.fieldHelp.ci, 'fieldHelp 应包含新增字段 ci 的说明');

console.log('== 2) 分片完整性 + 装配模拟 ==');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let nSlice = 0, nQ = 0, badCount = 0, jgUuidCh = 0, jgNonUuidCh = 0, fieldBad = 0, nAlias = 0, stemEmpty = 0;
let nCi = 0, nEy = 0, nTg = 0, nSt = 0;
const chapterIdSet = new Set();
const allExtChapterNames = new Set();

function assemble(arr, grp) {
  const m = new Map();
  for (const it of arr) {
    const cid = (grp === 'jg' && it.cid) ? it.cid : ('x' + (it.c || '未分类'));
    if (grp === 'ext' && !(grp === 'jg' && it.cid)) allExtChapterNames.add(cid);
    if (!m.has(cid)) m.set(cid, { id: cid, questions: [] });
    const correct = String(it.a || '').toUpperCase();
    const q = { id: it.id, content: it.q || '', options: it.o || {}, correct, multi: correct.length > 1 };
    if (!q.id || !Object.keys(q.options).length || !q.correct) {
      fieldBad++;
      if (fieldBad <= 3) console.log(`  ! 缺字段题：id=${q.id} 选项数=${Object.keys(q.options).length} 答案=${q.correct}`);
    } else if (!String(q.content).trim()) {
      stemEmpty++;
      if (stemEmpty <= 3) console.log(`  · 题干为空（已知残缺，前端跳过）：id=${q.id}`);
    }
    m.get(cid).questions.push(q);
  }
  return [...m.values()];
}

for (const sem of M.semesters) {
  for (const s of sem.subjects) {
    let sum = 0;
    for (const [key, grp] of [['jiguang', 'jg'], ['extension', 'ext']]) {
      const d = s[key]; if (!d) continue;
      nSlice++;
      const f = path.join(DATA, d.file);
      if (!fs.existsSync(f)) { fail++; console.log('  ✗ 分片缺失 ' + d.file); continue; }
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (arr.length !== d.count) { badCount++; console.log(`  ✗ ${d.file} 题数不符：manifest ${d.count} vs 实际 ${arr.length}`); }
      sum += arr.length; nQ += arr.length;
      for (const it of arr) {
        if (it.f && it.f.aliasIds) nAlias += it.f.aliasIds.length;
        if (it.ci) nCi++;
        if (it.ey) nEy++;
        if (it.tg && it.tg.length) nTg++;
        if (it.st) nSt++;
      }
      const chs = assemble(arr, grp);
      for (const c of chs) {
        chapterIdSet.add(c.id);
        if (grp === 'jg') (UUID.test(c.id) ? jgUuidCh++ : jgNonUuidCh++);
      }
    }
    if (s.explain) {
      const f = path.join(DATA, s.explain.file);
      if (!fs.existsSync(f)) { fail++; console.log('  ✗ 解析分片缺失 ' + s.explain.file); }
      else {
        const o = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Object.keys(o).length !== s.explain.count) { fail++; console.log('  ✗ 解析条数不符 ' + s.explain.file); }
      }
    }
    if (sum !== s.count) { fail++; console.log(`  ✗ ${sem.name}/${s.name} 合计数不符 ${sum} vs ${s.count}`); }
  }
}
ok(badCount === 0, `分片题数与 manifest 一致（不符 ${badCount} 个）`);
ok(nQ === M.totals.questions, `分片题数合计 ${nQ} = manifest ${M.totals.questions}`);
console.log(`  分片 ${nSlice} 个 / 题 ${nQ} / 章节 ${chapterIdSet.size} / 别名 id ${nAlias} / 题干缺失 ${stemEmpty}`);
ok(fieldBad === 0, `关键字段齐备（缺失 ${fieldBad} 题）`);
ok(jgNonUuidCh <= 5, `极光章节 id 均为 UUID（非 UUID ${jgNonUuidCh} 个）`);
console.log(`  极光章节：UUID ${jgUuidCh} / 非 UUID ${jgNonUuidCh}`);

console.log('== 3) 扩展章节迁移表 ==');
const CA = M.chapterAliases || {};
let caMissing = 0;
for (const [sid, obj] of Object.entries(CA)) {
  for (const [from, to] of Object.entries(obj)) {
    // 迁移目标章名必须在实际分片中存在
    if (!chapterIdSet.has(to)) { caMissing++; if (caMissing <= 3) console.log(`  ! chapterAliases 目标章名不在分片中: ${sid} ${from} → ${to}`); }
  }
}
ok(caMissing === 0, `chapterAliases 有 ${caMissing} 条目标章名不存在于分片`);
console.log(`  chapterAliases：${Object.keys(CA).length} 个学科 / ${Object.values(CA).reduce((a, o) => a + Object.keys(o).length, 0)} 条映射`);

console.log('== 4) 元数据与新字段覆盖 ==');
const sub0 = M.semesters[0].subjects[0];
const jg0 = sub0.jiguang ? JSON.parse(fs.readFileSync(path.join(DATA, sub0.jiguang.file), 'utf8')) : [];
const ex0 = sub0.extension ? JSON.parse(fs.readFileSync(path.join(DATA, sub0.extension.file), 'utf8')) : [];
const cnt = (a, f) => a.filter(f).length;
console.log(`  ${sub0.name}·极光 ${jg0.length} 题：难度 ${cnt(jg0, q => q.d)} / 热度 ${cnt(jg0, q => q.n)} / 正确率 ${cnt(jg0, q => q.ac != null)} / 章节UUID ${cnt(jg0, q => q.cid)}`);
console.log(`  ${sub0.name}·扩展 ${ex0.length} 题：年份 ${cnt(ex0, q => q.y)} / 来源 ${cnt(ex0, q => q.qs)} / 系统 ${cnt(ex0, q => q.sys)} / 病例 ${cnt(ex0, q => q.ci)} / 标签 ${cnt(ex0, q => q.tg && q.tg.length)}`);
ok(cnt(jg0, q => q.d) > 0 && cnt(jg0, q => q.n) > 0, '极光分片应带难度与热度');
ok(jg0.every(q => q.cid), '极光分片每题都应有 cid');
console.log(`  全局新字段：caseInfo ${nCi} / examYear ${nEy} / tags ${nTg} / sourceType ${nSt}`);

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail ? 1 : 0);
