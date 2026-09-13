/**
 * 发布目录一致性断言（P2-1）：site/ 与 site_dist/ 的「白名单文件 + 原文/」逐文件 md5 对照。
 * 背景：对抗性审查发现六套 verify 全只校验 site/，发布漂移（手工 cp 漏文件 / 原文/ 被静默删）
 * 设计上抓不到。本脚本补这个盲区。
 *
 * 两种模式（由 --gate 决定，run_all.mjs 里默认层不带、--full 带）：
 *   · 默认（无 --gate）= 警示层：发现 dist 落后只打 ⚠ 提示，exit 0 —— 日常改 site/ 后立即能看到
 *     「dist 落后了」，但不阻断「改 CSS 也得先 build_dist 才能过 verify」的开发摩擦。
 *   · --gate = 发布闸门：任何漂移一律 exit 1 —— 发布前（--full）必须全一致。
 *
 * 用法: node 题库调研/verify/dist_parity.mjs [--gate]
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const SRC = path.join(WS, 'site');
const DIST = path.join(WS, 'site_dist');
const bd = fs.readFileSync(path.join(WS, '题库调研/build_dist.mjs'), 'utf8');
const arrOf = name => {
  const m = bd.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
};
const FILES = arrOf('FILES'), DIRS = arrOf('DIRS');
const md5 = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
function walk(d) {
  const out = [];
  (function w(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) w(fp); else out.push(fp);
    }
  })(d);
  return out;
}
const GATE = process.argv.indexOf('--gate') >= 0;   // 有 = 硬闸门（exit 1）；无 = 警示（exit 0）
if (!fs.existsSync(DIST)) {
  console.log(`  ${GATE ? '✗' : '⚠'} 发布目录 site_dist/ 不存在 —— 先重建：node 题库调研/build_dist.mjs`);
  process.exit(GATE ? 1 : 0);
}
let fail = 0;
const relOf = (base, p) => path.relative(base, p).split(path.sep).join('/');

for (const f of FILES) {
  const s = path.join(SRC, f), d = path.join(DIST, f);
  if (!fs.existsSync(s)) { console.log('  ✗ site 缺失 ' + f); fail++; continue; }
  if (!fs.existsSync(d)) { console.log('  ✗ site_dist 缺失 ' + f); fail++; continue; }
  const a = md5(s), b = md5(d);
  if (a !== b) { console.log(`  ✗ md5 不一致 ${f} (site ${a} / dist ${b})`); fail++; }
  else console.log(`  ✓ ${f}`);
}
for (const dir of DIRS) {
  const sd = path.join(SRC, dir), dd = path.join(DIST, dir);
  if (!fs.existsSync(sd)) { console.log('  ✗ site 缺目录 ' + dir); fail++; continue; }
  if (!fs.existsSync(dd)) { console.log('  ✗ site_dist 缺目录 ' + dir); fail++; continue; }
  const sf = walk(sd), df = walk(dd);
  const sm = new Map(sf.map(p => [relOf(SRC, p), md5(p)]));
  const dm = new Map(df.map(p => [relOf(DIST, p), md5(p)]));
  let miss = 0, diff = 0;
  for (const [k, v] of sm) if (!dm.has(k)) { miss++; } else if (dm.get(k) !== v) diff++;
  for (const k of dm.keys()) if (!sm.has(k)) miss++;
  if (miss || diff) { console.log(`  ✗ ${dir}/ 不一致（dist 缺/多出 ${miss} 文件，内容差异 ${diff}）`); fail += miss + diff; }
  else console.log(`  ✓ ${dir}/ （${sf.length} 文件，md5 全一致）`);
}
if (fail) {
  console.log(`\n=== 发布目录一致性：${GATE ? '✗ 失败 ' + fail + ' 项（发布闸门：阻止发布）' : '⚠ 有 ' + fail + ' 项漂移（警示，不阻断；发布前请跑 build_dist 重建）'} ===`);
  process.exit(GATE ? 1 : 0);
}
console.log('\n=== 发布目录一致性：通过 全部一致 ===');
process.exit(0);
