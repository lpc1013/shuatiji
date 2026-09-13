// 停止所有极光相关 node 进程 (本机 PowerShell 工具输出被吞 / wmic 无输出, 改用 EncodedCommand 拿 PID)
// 用法: node jiguang_kill.mjs          -> 只列出
//       node jiguang_kill.mjs kill     -> 列出并终止 (默认保留 kill 自身)
import { execSync } from 'child_process';

const DO_KILL = process.argv.includes('kill');
// 用 -EncodedCommand 传递 PowerShell, 彻底规避 git-bash / cmd 的引号地狱
const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*jiguang*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
const b64 = Buffer.from(ps, 'utf16le').toString('base64');

let items = [];
try {
  const out = execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const p = JSON.parse(out);
  items = Array.isArray(p) ? p : (p ? [p] : []);
} catch (e) {
  console.log('获取进程列表失败:', e.message.slice(0, 200));
  process.exit(1);
}

const me = process.pid;
for (const it of items) {
  const pid = it.ProcessId, cl = (it.CommandLine || '');
  if (!pid || pid === me) continue;
  const name = (cl.match(/jiguang[a-z0-9_]*\.mjs/) || ['?'])[0];
  console.log(`  PID ${pid}  ${name}`);
  if (DO_KILL) {
    try { process.kill(pid, 'SIGTERM'); console.log(`    -> 已终止`); }
    catch (e) { console.log(`    -> 失败: ${e.message.slice(0, 60)}`); }
  }
}
console.log(DO_KILL ? `共处理 ${items.length} 个进程` : `共 ${items.length} 个进程 (加 kill 参数才终止)`);
