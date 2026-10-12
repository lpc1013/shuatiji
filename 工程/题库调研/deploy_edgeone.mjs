/**
 * EdgeOne Pages 快速部署脚本（跳过 CLI 的框架探测，~45s 而不是 ~290s）
 *
 * 为什么需要它：
 *   `edgeone makers deploy -n <项目>` 不传「目录」位置参数时，CLI 会走 auto build：
 *     StaticAssetsBuilder → DescribeFramework（**远程探测框架**，本机实测卡 ~240s）
 *       → 把项目文件复制到 .edgeone/assets → 上传 .edgeone
 *   只有传入目录位置参数时才会跳过整段 auto build，直接上传该目录。
 *   于是我们本地自己完成「复制 + 写探测结果」，再传 ./.edgeone 即可。
 *   （探测结果落在 .edgeone/assets/.edgeone-assets-config.json = {"framework":"other","needsFallback":false}）
 *
 * 前置：site_dist 已由 `deploy.mjs --full` 重建完毕。
 * 用法：node 工程/题库调研/deploy_edgeone.mjs [项目名]
 *   项目名默认 architecture；CLI 路径可用环境变量 EDGEONE_CLI 覆盖。
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { safeRmSync } from './_safeRm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(__dirname, '..', '..');
const DIST = path.join(WS, 'site_dist');
const EO = path.join(DIST, '.edgeone');
const ASSETS = path.join(EO, 'assets');

const PROJ = process.argv[2] || 'architecture';
/* 直接跑 CLI 的底层 JS（进程内 node 执行），不走 .cmd 包装 ——
 * 新版 Node 的 spawn 不允许直接执行 .cmd/.bat（需 shell:true，而 shell 会引入 cmd.exe 转发与挂起风险）。 */
const CLI_JS = process.env.EDGEONE_CLI_JS
  || 'C:\\Users\\Pengcheng_Li\\.workbuddy\\binaries\\node\\cli-connector-packages\\node_modules\\edgeone\\edgeone-bin\\edgeone.js';

if (!fs.existsSync(DIST)) {
  console.error('[eo] ✗ 找不到 site_dist，请先跑 `node 工程/题库调研/deploy.mjs --full`');
  process.exit(1);
}

/* ---------- 1) 重建 .edgeone/assets ---------- */
console.log('[eo] 重建 .edgeone/assets …');
if (!safeRmSync(ASSETS)) { console.error('[eo] ✗ 无法清理 ' + ASSETS); process.exit(1); }
fs.mkdirSync(ASSETS, { recursive: true });

let copied = 0;
(function copyDir(src, dst, isRoot) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (isRoot && (e.name === '.edgeone' || e.name === '.env')) continue;   // 与 CLI builder 的排除项一致
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d, false); }
    else { fs.copyFileSync(s, d); copied++; }
  }
})(DIST, ASSETS, true);
console.log('[eo] 复制 ' + copied + ' 文件');

/* ---------- 2) 写探测结果 + 项目绑定 ---------- */
fs.writeFileSync(path.join(ASSETS, '.edgeone-assets-config.json'),
  JSON.stringify({ framework: 'other', needsFallback: false }, null, 2));
const projFile = path.join(EO, 'project.json');
if (!fs.existsSync(projFile)) fs.writeFileSync(projFile, JSON.stringify({ Name: PROJ }));
else {
  try {
    const j = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    if (j.Name !== PROJ) { j.Name = PROJ; fs.writeFileSync(projFile, JSON.stringify(j)); }
  } catch { fs.writeFileSync(projFile, JSON.stringify({ Name: PROJ })); }
}

/* ---------- 3) 部署（异步 spawn，别用 spawnSync —— 本机沙箱会偶发永久阻塞）---------- */
const args = ['makers', 'deploy', './.edgeone', '-n', PROJ, '--json'];
console.log('[eo] ▶ node edgeone.js ' + args.join(' '));
const t0 = Date.now();

const child = spawn(process.execPath, [CLI_JS, ...args], {
  cwd: DIST,
  env: { ...process.env, PAGES_SOURCE: 'skills' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
let out = '';
child.stdout.on('data', d => { out += d; process.stdout.write(d); });
child.stderr.on('data', d => { out += d; process.stderr.write(d); });

child.on('error', e => { console.error('\n[eo] ✗ 启动 CLI 失败：' + e.message); process.exit(1); });
child.on('exit', (code) => {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const m = out.match(/\{[\s\S]*"deploymentId"[\s\S]*\}/);
  if (code === 0 && m) {
    let j = null; try { j = JSON.parse(m[0]); } catch { /* 忽略 */ }
    if (j && j.url) {
      console.log('\n[eo] ✅ 部署成功（' + secs + 's）');
      console.log('[eo] Deploy URL : ' + j.url);
      console.log('[eo] Console URL: ' + j.consoleUrl);
      console.log('[eo] Deployment : ' + j.deploymentId);
      process.exit(0);
    }
  }
  console.error('\n[eo] ✗ 部署失败 exit=' + code + '（' + secs + 's）');
  process.exit(code || 1);
});
