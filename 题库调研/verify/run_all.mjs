/* 一键验证套件。
 * 默认跑「前端层」七步（秒级）：语法检查×3 + 静态审计 + 逻辑单测 + jsdom 全链路 + 交互冒烟
 *        + 发布目录一致性（警示级：dist 落后只提示不阻断）。
 * 加 --full 追加「数据层」四步（verify_schema_unified / verify_packs / verify_site / verify_id_zeroloss），
 *        并把发布目录一致性升级为硬闸门（--gate，漂移即 FAIL）——改动 merged2 或 build_* 脚本、
 *        动了题目 id、或发布前才需要；默认不跑（verify_site 要读 26MB 站点数据）。
 * 用法：node 题库调研/verify/run_all.mjs [--full] */
import { execSync } from 'child_process';
import fs from 'fs';
const NODE = 'C:/Users/Pengcheng_Li/.workbuddy/binaries/node/versions/22.12.0/node.exe';
const base = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学/';
const FULL = process.argv.indexOf('--full') >= 0;
const cmds = [
  [`"${NODE}" --check "${base}site/app.js"`, base],
  [`"${NODE}" --check "${base}site/features.js"`, base],
  [`"${NODE}" --check "${base}site/english.js"`, base],
  [`"${NODE}" "${base}题库调研/verify/verify_frontend.mjs"`, base + '题库调研'],
  [`"${NODE}" "${base}题库调研/verify/verify_jsdom.mjs"`, base + '题库调研'],
  [`"${NODE}" "${base}题库调研/verify/verify_actions_smoke.mjs"`, base + '题库调研'],
  // 发布目录一致性：site/ ↔ site_dist/ 逐文件 md5（0913 审查 P2-1：六套 verify 只校验 site/，零校验 site_dist/）
  // 白名单直接在脚本内从 build_dist.mjs 解析，新增站点资源不用改两处。
  // 两种强度：默认层 = 警示（dist 落后只 ⚠ 不阻断，保住日常改 site/ 的开发节奏）；
  //          --full 追加 --gate = 硬闸门（发布前任何漂移一律 FAIL）。
  [`"${NODE}" "${base}题库调研/verify/dist_parity.mjs"${FULL ? ' --gate' : ''}`, base + '题库调研'],
];
if (FULL) cmds.push(
  [`"${NODE}" "${base}题库调研/verify/verify_schema_unified.mjs"`, base + '题库调研'],
  [`"${NODE}" "${base}题库调研/verify/verify_packs.mjs"`, base + '题库调研'],
  [`"${NODE}" "${base}题库调研/verify/verify_site.mjs"`, base + '题库调研'],
  // 拿真实用户快照核对「换了 id 之后老进度还找得到题」——A02 统一 id 网的最终验收
  [`"${NODE}" "${base}题库调研/verify/verify_id_zeroloss.mjs"`, base + '题库调研'],
);
let out = '===== run_all.mjs | ' + (FULL ? '前端层 + 数据层' : '仅前端层（加 --full 跑数据层）') + '\n';
for (const [c, cwd] of cmds) {
  out += '\n===== ' + c + '\n';
  try { out += execSync(c, { encoding: 'utf8', cwd, maxBuffer: 1 << 28 }); out += '\n[rc=0]\n'; }
  catch (e) { out += (e.stdout || '') + '\n[FAIL] ' + (e.stderr || e.message) + '\n'; }
}
fs.writeFileSync(base + '题库调研/verify/_run.log', out, 'utf8');
console.log('done -> 题库调研/verify/_run.log');
