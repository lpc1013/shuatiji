// fix_biochem_secondary.mjs
// 处理生物化学 8 题「options 含 F-H 且为次级损坏（串题/答案片段）」的数据清理。
// 与 fix_option_mangling.mjs 不同：这里是按题 id 精准操作（污染形态各异，不能一刀切）。
//
// 用法（workspace 根目录运行）：
//   node fix_biochem_secondary.mjs            # dry-run，打印拟改动
//   node fix_biochem_secondary.mjs --apply    # 写回 极光_生化.json
//
// 策略：
//   - 6 题安全自动修：删掉混进 options 的下一题题干/答案片段（F/G/H 垃圾）；q63 额外清题干串题；q148 把真实答案 IP3 从 F 挪到 E。
//   - 2 题（q60 id=73ce32b7 / q66 id=56547563）A-E 基础选项本身损坏，不自动改，输出提示需重爬或人工校对。
//   - 只改 q.options / q.content，不动 id、顺序、其它字段 → localStorage 进度保留。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const FILE = '../../题源数据/大二/生化/1.题库/极光_生化.json';

// 按 id 的精准操作
const OPS = {
  // 删 F/G/H 垃圾（下一题题干/答案片段混入）
  'd65bf543': { remove: ['F', 'G', 'H'], contentStrip: '\n64维持蛋白质一级结构的化学键是' }, // ch1 q63
  '478fd779': { remove: ['F', 'G', 'H'] }, // ch1 q75
  '1fdf2b51': { remove: ['F', 'G', 'H'] }, // ch2 q144
  '0244f47c': { remove: ['F', 'G', 'H'] }, // ch15 q100
  '76068254': { remove: ['F', 'G', 'H'] }, // ch16 q128
  // q148：真实答案 IP3 错放在 F，E=DA 是垃圾 → 把 F 挪到 E，删 F
  'e7435eb4': { moveFtoE: true },
};
const FLAGGED = ['73ce32b7', '56547563']; // q60 / q66 深度损坏，不自动改

function applyOp(q, op) {
  const report = { removed: [], contentBefore: q.content, optionsBefore: { ...q.options } };
  if (op.remove) {
    for (const k of op.remove) { if (k in q.options) { delete q.options[k]; report.removed.push(k); } }
  }
  if (op.moveFtoE) {
    if ('F' in q.options) { q.options.E = q.options.F; delete q.options.F; report.removed.push('F→E'); }
  }
  if (op.contentStrip && q.content && q.content.includes(op.contentStrip)) {
    q.content = q.content.replace(op.contentStrip, '').trim();
  }
  report.optionsAfter = { ...q.options };
  report.contentAfter = q.content;
  return report;
}

const p = path.resolve(ROOT, FILE);
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
const changes = [], flagged = [];
for (const c of d.chapters) {
  c.questions.forEach((q) => {
    const id = q.id.slice(0, 8);
    if (OPS[id]) {
      const before = JSON.stringify({ content: q.content, options: q.options });
      const rep = applyOp(q, OPS[id]);
      const after = JSON.stringify({ content: q.content, options: q.options });
      if (before !== after) changes.push({ id, ch: c.sort_order + ' ' + c.name, q: c.questions.indexOf(q) + 1, rep });
    } else if (FLAGGED.includes(id)) {
      flagged.push({ id, ch: c.sort_order + ' ' + c.name, q: c.questions.indexOf(q) + 1, ca: q.correct_answer, options: q.options });
    }
  });
}

console.log('============ 拟自动修复（生化 6 题）============');
for (const f of changes) {
  console.log(`\n● [${f.ch}] 第${f.q}题 (id=${f.id})`);
  console.log(`  移除: ${f.rep.removed.join(', ') || '-'}`);
  if (f.rep.contentBefore !== f.rep.contentAfter) console.log(`  题干前: ${f.rep.contentBefore.replace(/\n/g, ' ')}\n  题干后: ${f.rep.contentAfter}`);
  console.log(`  options后: ${JSON.stringify(f.rep.optionsAfter)}`);
}
console.log(`\n自动修复总计: ${changes.length} 题`);

console.log('\n============ 生化 2 题深度损坏（不自动改，需重爬/人工）============');
flagged.forEach(b => console.log(`  [${b.ch}] 第${b.q}题 id=${b.id} ca=${JSON.stringify(b.ca)} options=${JSON.stringify(b.options)}`));

if (APPLY) {
  fs.writeFileSync(p, JSON.stringify(d), 'utf8');
  console.log(`\n[已写回] ${FILE}（改动 ${changes.length} 题）`);
} else {
  console.log('\n>>> 当前为 dry-run，未写回。确认无误后加 --apply 执行。');
}
