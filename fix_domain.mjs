// 一次性批量修复旧爬虫脚本的 API 域名: http://ji-guang.top -> https://api.ji-guang.top
// 只处理含旧 http 调用的脚本(含 'http'+'.request'), 新脚本(jiguang_update_crawl / jiguang_check_updates)用 https, 自动跳过。
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SKIP = new Set(['jiguang_update_crawl.mjs', 'jiguang_check_updates.mjs', 'fix_domain.mjs']);
// 用拼接避免本脚本自身被字符串匹配命中
const OLD_REQ = 'http' + '.request';
const OLD_IMPORT = "import http from 'http';";
const OLD_REQUIRE = "const http = require('http')";

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; walk(fp, out); }
    else if (e.name.endsWith('.mjs')) out.push(fp);
  }
}
const files = [];
walk(ROOT, files);

let changed = 0, skipped = 0;
for (const f of files) {
  const base = path.basename(f);
  if (SKIP.has(base)) { skipped++; continue; }
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes(OLD_REQ)) { continue; } // 不是旧 http 爬虫, 跳过
  const before = s;
  s = s.split("import http from 'http';").join("import https from 'https';");
  s = s.split("const http = require('http')").join("const https = require('https')");
  s = s.split(OLD_REQ).join('https' + '.request');
  s = s.split('http://ji-guang.top').join('https://api.ji-guang.top');
  s = s.split('u.port || 80').join('u.port || 443');
  if (s !== before) { fs.writeFileSync(f, s); changed++; console.log('FIX', f.replace(ROOT, '.')); }
}
console.log(`\n完成: 修改 ${changed} 个旧脚本, 跳过 ${skipped} 个(SKIP/非旧脚本)`);
