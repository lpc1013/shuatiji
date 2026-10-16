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

/* ---------- 0) 发布闸门（F03，20261015）：上传前强制完整校验 ----------
 * 直接跑上传入口不再可能绕过发布验收：run_all --full（含 dist_parity 发布闸门、
 * schema 数据比对、前端 92+211 项测试）任一步非 0 即中止，CLI 子进程不会启动。
 * 逃生口 EDGEONE_SKIP_VERIFY=1 仅限紧急人工使用（会打 ⚠ 并继续）。 */
function runGate(onPass) {
  if (process.env.EDGEONE_SKIP_VERIFY === '1') {
    console.error('[eo] ⚠ EDGEONE_SKIP_VERIFY=1：已跳过发布校验（紧急通道，产物未经验收）');
    onPass();
    return;
  }
  console.log('[eo] ▶ 发布闸门：node 工程/题库调研/verify/run_all.mjs --full（通过才允许上传）');
  const RUN_ALL = path.join(__dirname, 'verify', 'run_all.mjs');
  const child = spawn(process.execPath, [RUN_ALL, '--full'], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
  });
  child.on('error', e => { console.error('[eo] ✗ 启动校验失败：' + e.message); process.exit(1); });
  child.on('exit', code => {
    if (code !== 0) {
      console.error('[eo] ✗ 发布校验未通过（exit=' + code + '），已阻止上传。修复后重试，或先跑 release.mjs。');
      process.exit(1);
    }
    console.log('[eo] ✓ 发布校验通过');
    onPass();
  });
}

/* ---------- 1) 重建 .edgeone/assets ---------- */
function upload() {
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
}

runGate(upload);
