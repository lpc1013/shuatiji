/**
 * release.mjs — 顶层发布编排器（单一入口，fail-fast）
 *
 * 串联完整发布链路，任何一步非 0 退出立即中止，保证发布前全链路验收通过：
 *   build_packs.mjs      → 重建 packs（id 稳定性依赖基线：默认 = 当前 packs 目录）
 *   build_site_data.mjs  → packs → site/data（manifest + 分片 + 按章节拆 explain）
 *   deploy.mjs --full    → 清场重建 site_dist（白名单单一真源 + 安全删除 + 泄漏扫描）
 *   verify/run_all.mjs --full → 前端层 7 步 + 数据层 4 步 + dist_parity 硬闸门
 *
 * 用法：
 *   node release.mjs              # 全流程（含 packs 重建）
 *   node release.mjs --skip-packs # 跳过 packs 重建（仅 rebuild site data + 发布 + 校验）
 *                                   日常改动 build_site_data / deploy / 前端后使用
 *
 * 说明：build_packs 重建会重新套用 lib_fix 并重算 id 网，基线默认指向当前 packs 目录
 *       （argv[2]），属「原地重建」模式——务必保证 packs 当前版本是已验证基线，否则可能
 *       触发 id 漂移。merged2 未变更时优先用 --skip-packs。
 *
 * ⚠️ 环境注记（本机沙箱实测）：子步骤用「异步 spawn + await exit」执行（stdio 实时透传）。
 *    不要改回 spawnSync：本机沙箱下 spawnSync 起的子进程会偶发永久阻塞（同一条命令
 *    前两次成功、第三次挂死），异步 spawn 稳定。用 `> file` 重定向 stdout 到文件时，
 *    沙箱子进程同样可能挂死——需要留存日志请用管道 `| tee`，或直接看终端输出。
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const skipPacks = process.argv.includes('--skip-packs');

const steps = [];
if (!skipPacks) steps.push(['build_packs.mjs', []]);
steps.push(['build_site_data.mjs', []]);
steps.push(['deploy.mjs', ['--full']]);
steps.push(['verify/run_all.mjs', ['--full']]);

// 异步 spawn 子步骤，实时透传 stdio，返回退出码
function runStep(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [script, ...args], { stdio: 'inherit', cwd: __dirname });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code == null ? 1 : code));
  });
}

console.log(`[release] 启动（${steps.length} 步${skipPacks ? '，已跳过 packs 重建' : ''}）`);

let i = 0;
for (const [rel, extra] of steps) {
  i++;
  const script = path.join(__dirname, rel);
  const args = [...extra];
  const label = `node ${rel}${args.length ? ' ' + args.join(' ') : ''}`;
  console.log(`\n[release ${i}/${steps.length}] ▶ ${label}`);
  let code;
  try {
    code = await runStep(script, args);
  } catch (e) {
    console.error(`\n[release] ✗ 步骤 ${i}（${rel}）启动失败：${e.message}，已中止。`);
    process.exit(1);
  }
  if (code !== 0) {
    console.error(`\n[release] ✗ 步骤 ${i}（${rel}）失败，exit=${code}，已中止。后续步骤未执行。`);
    process.exit(code || 1);
  }
  console.log(`[release ${i}/${steps.length}] ✓ ${label} 完成`);
}

console.log(`\n[release] ✅ 全链路发布验收通过（${steps.length} 步均 0 退出）。`);
