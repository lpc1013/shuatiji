// 独立复验：site/data 分片的题目 id 是否 100% 落在 packs 里（含 aliasIds）、答案是否一致、
// 以及教材改判/不可裁决标记是否真的写进包。
//
// ⚠️ 原实现读 site/data/data.js —— 该文件已被「manifest + 分片懒加载」方案取代而删除，
//    脚本会直接抛错。现改为直接读 site/data 分片（语义等价，且更贴近真实分发内容）。
import fs from 'fs';
import path from 'path';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const OUT = path.join(WS, '工程', '题库调研', 'packs');
const DATA = path.join(WS, 'site', 'data');
const SEMS = ['大一', '大二', '大三', '大四', '水平测试'];

// 收集 packs 内全部 id（主 id + 别名）
const packed = new Map();
for (const sem of fs.readdirSync(OUT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
  if (!SEMS.includes(sem)) continue;
  for (const grp of ['极光', '扩展']) {
    const gd = path.join(OUT, sem, grp);
    if (!fs.existsSync(gd)) continue;
    for (const f of fs.readdirSync(gd)) {
      if (!f.endsWith('.json')) continue;
      const arr = JSON.parse(fs.readFileSync(path.join(gd, f), 'utf8'));
      for (const it of arr) {
        const rec = { sem, grp, subj: f.replace(/\.json$/, ''), answer: it.answer, flags: it.flags || {}, primary: it.id };
        packed.set(it.id, rec);
        // 别名 id 也要登记：网站可能正用着别名那个 id 存进度，主 id 不是它
        for (const a of (it.flags && it.flags.aliasIds) || []) if (!packed.has(a)) packed.set(a, { ...rec, isAlias: true });
      }
    }
  }
}
console.log('packs 内唯一 id 总数:', packed.size);

// 读 site/data 分片
const man = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
const siteQ = [];
for (const sem of man.semesters) for (const s of sem.subjects) {
  for (const key of ['jiguang', 'extension']) {
    const d = s[key]; if (!d) continue;
    for (const it of JSON.parse(fs.readFileSync(path.join(DATA, d.file), 'utf8'))) {
      siteQ.push({ id: it.id, subj: s.name, correct: it.a, stem: it.q });
    }
  }
}

let miss = [], ansDiff = [], ambiguous = 0, stemInc = 0, adjusted = 0, aliasCarrying = 0, caseInfo = 0;
for (const q of siteQ) {
  const p = packed.get(q.id);
  if (!p) { miss.push(q); continue; }
  if (q.correct !== undefined && q.correct !== null && p.answer !== q.correct) ansDiff.push({ id: q.id, site: q.correct, pack: p.answer, subj: p.subj, flags: p.flags });
  if (p.flags.answerAmbiguity) ambiguous++;
  if (p.flags.stemIncomplete) stemInc++;
  if (p.flags.answerAdjusted) adjusted++;
  if (p.flags.aliasIds) aliasCarrying++;
  if (q.caseInfo) caseInfo++;
}
console.log('site 题数:', siteQ.length);
console.log('未命中:', miss.length, miss.slice(0, 10).map(m => m.id + '/' + m.subj));
console.log('答案被改的 site 题:', ansDiff.length);
for (const d of ansDiff) console.log('   ', d.subj, d.id, 'site=', d.site, '→ pack=', d.pack, JSON.stringify(d.flags));
console.log('包内带 answerAmbiguity 的 site 题:', ambiguous, '| stemIncomplete:', stemInc, '| answerAdjusted:', adjusted, '| 带 aliasIds:', aliasCarrying);
console.log('\nmanifest totals:', JSON.stringify(man.totals));
process.exit(miss.length ? 1 : 0);
