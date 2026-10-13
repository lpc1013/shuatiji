/* 一键验证套件。
 * 默认跑「前端层」七步（秒级）：语法检查×3 + 静态审计 + 逻辑单测 + jsdom 全链路 + 交互冒烟
 *        + 发布目录一致性（警示级：dist 落后只提示不阻断）。
 * 加 --full 追加「数据层」四步（verify_schema_unified / verify_packs / verify_site / verify_id_zeroloss），
 *        并把发布目录一致性升级为硬闸门（--gate，漂移即 FAIL）——改动 merged2 或 build_* 脚本、
 *        动了题目 id、或发布前才需要；默认不跑（verify_site 要读 26MB 站点数据）。
 * 用法：node 工程/题库调研/verify/run_all.mjs [--full]
 * 执行方式（1013 审计后调整）：可移植化 NODE/base 推导 + 异步 spawn（不经 cmd.exe）——
 *   旧版 execSync 走 cmd.exe /c 包装，本机偶发 spawnSync EBUSY / 永久阻塞（0914 实录），
 *   改为 spawn 直启 node.exe（shell 默认 false），绕开 cmd.exe 顺带修掉该环境病；
 *   NODE 用 process.execPath、base 从本文件位置推导，换机器不再依赖硬编码路径。 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const NODE = process.execPath.replace(/\\/g, '/');
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').replace(/\\/g, '/') + '/';
const FULL = process.argv.indexOf('--full') >= 0;
const cmds = [
  [['--check', base + 'site/app.js'], base],
  [['--check', base + 'site/features.js'], base],
  [['--check', base + 'site/english.js'], base],
  [[base + '工程/题库调研/verify/verify_frontend.mjs'], base + '工程/题库调研'],
  [[base + '工程/题库调研/verify/verify_jsdom.mjs'], base + '工程/题库调研'],
  [[base + '工程/题库调研/verify/verify_actions_smoke.mjs'], base + '工程/题库调研'],
  // 发布目录一致性：site/ ↔ site_dist/ 逐文件 md5（0913 审查 P2-1：六套 verify 只校验 site/，零校验 site_dist/）
  // 白名单单一真源在 _whitelist.mjs（被 build_dist/_sync_dist/deploy/dist_parity 共享），dist_parity 直接解析它。
  // 两种强度：默认层 = 警示（dist 落后只 ⚠ 不阻断，保住日常改 site/ 的开发节奏）；
  //          --full 追加 --gate = 硬闸门（发布前任何漂移一律 FAIL）。
  [[base + '工程/题库调研/verify/dist_parity.mjs', ...(FULL ? ['--gate'] : [])], base + '工程/题库调研'],
];
if (FULL) cmds.push(
  [[base + '工程/题库调研/verify/verify_schema_unified.mjs'], base + '工程/题库调研'],
  [[base + '工程/题库调研/verify/verify_packs.mjs'], base + '工程/题库调研'],
  [[base + '工程/题库调研/verify/verify_site.mjs'], base + '工程/题库调研'],
  // 拿真实用户快照核对「换了 id 之后老进度还找得到题」——A02 统一 id 网的最终验收
  [[base + '工程/题库调研/verify/verify_id_zeroloss.mjs'], base + '工程/题库调研'],
);

/* 异步 spawn 直启（不经 cmd.exe / 不用 spawnSync——本机 spawnSync 有 EBUSY/挂死前科），
 * stdout/stderr 全量收集，进程退出才 resolve。 */
function runOne(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(NODE, args, { cwd, windowsHide: true });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    p.on('error', (e) => resolve({ code: -1, out: buf + '\n[SPAWN ERROR] ' + (e && e.message || e) }));
    p.on('close', (code) => resolve({ code, out: buf }));
  });
}

let out = '===== run_all.mjs | ' + (FULL ? '前端层 + 数据层' : '仅前端层（加 --full 跑数据层）') + '\n';
let failed = 0;
for (const [args, cwd] of cmds) {
  out += '\n===== ' + NODE + ' ' + args.join(' ') + '\n';
  const r = await runOne(args, cwd);
  if (r.code === 0) { out += r.out + '\n[rc=0]\n'; }
  else { failed++; out += r.out + '\n[FAIL rc=' + r.code + ']\n'; }
}
fs.writeFileSync(base + '工程/题库调研/verify/_run.log', out, 'utf8');
console.log('done -> 工程/题库调研/verify/_run.log');
/* 步骤失败必须让编排器自身也非零退出——否则「测试挂了但 run_all 报成功」，闸门形同虚设 */
if (failed) { console.error(`[run_all] ✗ ${failed}/${cmds.length} 步失败，详见 verify/_run.log`); process.exitCode = 1; }
else console.log(`[run_all] ✓ ${cmds.length} 步全绿`);
