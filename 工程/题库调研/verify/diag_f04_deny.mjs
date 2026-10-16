// F04 验证：新 DENY_ANY 不误伤现有白名单文件 + 注入敏感文件被拒绝
import fs from 'fs'; import path from 'path';
import { DENY_ANY, FILES, DIRS } from '../_whitelist.mjs';
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'site');

let bad = 0;
const walk = p => {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    if (e.isDirectory()) walk(fp);
    else if (DENY_ANY.test(e.name)) { console.log('误伤现有文件:', path.relative(ROOT, fp)); bad++; }
  }
};
for (const d of DIRS) walk(path.join(SRC, d));
console.log('现有白名单文件误伤总数 =', bad, bad === 0 ? 'OK' : 'FAIL');

// 注入测试（内存级判定，不真写盘）：报告中的 4 类敏感文件名必须被拒
const injections = ['.env', 'credentials.json', 'private.key', 'api_key.txt', 'secrets.yaml', 'id_rsa', 'token_access.json', 'x.env.local'];
for (const n of injections) console.log(DENY_ANY.test(n) ? '  拒 ✓ ' + n : '  漏 ✗ ' + n);
// 正常名字不能误伤
for (const n of ['bio-jg.json', '第一章_糖代谢.json', '理想国_郭斌和张竹明译本.html', 'p1.jpeg', 'manifest.webmanifest'])
  console.log(DENY_ANY.test(n) ? '  误伤 ✗ ' + n : '  放行 ✓ ' + n);
process.exit(bad === 0 ? 0 : 1);
