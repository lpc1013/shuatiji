#!/usr/bin/env node
/**
 * 发布白名单打包：把 site/ 中「站点运行真正需要」的文件同步到 site_dist/。
 *
 * 为什么需要它：site/ 是工作目录，历史上被塞进了 tavern/(533MB)、.bak_*、用户数据
 * 导出、zip、手册 pdf 等与站点无关的东西。直接整目录部署 = ①上传 596MB
 * ②把你的真实作答记录（database_export-*.json）暴露到公网可下载。
 * 规则：**部署只指 site_dist/**，site/ 只当工作目录。
 *
 * 用法：node 题库调研/build_dist.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'site_dist');

/* 白名单：只有这些会进发布目录。新增站点资源（新的 js/css/图标/manifest）必须在此登记。 */
const FILES = [
  'index.html',
  'styles.css', 'themes.css',
  'app.js', 'features.js', 'english.js', 'sync.js',
  'sw.js',
  'favicon.svg', 'manifest.webmanifest',
  'lixiangguo.html',   // 成就页「学累了放松」入口：理想国导读，全屏浮层 iframe 同源按需加载
];
const DIRS = ['data', '原文'];   // 原文/ = 理想国导读资源（lixiangguo.html 硬依赖 href="原文/..."）；登记进白名单，否则重建会 fs.rmSync 把 777 文件静默删掉

/* 防御性黑名单：就算哪天有东西被放回 site/，也绝不进发布目录 */
const DENY_TOP = /^(tavern|cloud|_preview|deploy_galaxy)$|^\.bak|^database_export|^刷题记|\.zip$|\.pdf$|\.py$|^serve\.js$|^build_data\.js$|^星系分析\.html$/;
const DENY_ANY = /database_export|备份|\.zip$|\.bak/i;
const nfkc = s => String(s).normalize('NFKC');   // 防 fullwidth 文件名绕过（如 ｄａｔａｂａｓｅ_export）

const err = [];
for (const f of FILES) if (!fs.existsSync(path.join(SRC, f))) err.push('缺失必需文件: site/' + f);
for (const d of DIRS) if (!fs.existsSync(path.join(SRC, d))) err.push('缺失必需目录: site/' + d);
if (err.length) { console.error(err.join('\n')); process.exit(1); }

/* 进度日志写盘（不经 stdout 缓冲）：这个脚本曾在 fs.cpSync 处让 node 直接 fast-fail
 * （退出码 0xC0000409），stdout 全丢、只剩半个 site_dist 却看不出卡在哪。 */
const LOG = path.join(ROOT, '题库调研', '_dist.log');
fs.writeFileSync(LOG, '', 'utf8');
const log = m => fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

/* 手写递归复制：不用 fs.cpSync（Windows 上曾整进程崩掉），且跳过符号链接等非常规条目 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyTree(s, d);
    else if (e.isFile()) { fs.copyFileSync(s, d); n++; }
    else log('SKIP 非常规条目（符号链接等）: ' + s);
  }
  return n;
}

log('清理 ' + DIST);
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const f of FILES) { fs.copyFileSync(path.join(SRC, f), path.join(DIST, f)); }
log(`白名单文件 ${FILES.length} 个已复制`);
for (const d of DIRS) { const c = copyTree(path.join(SRC, d), path.join(DIST, d)); log(`目录 ${d}/ 复制 ${c} 个文件`); }

const top = fs.readdirSync(DIST);
const unexpected = top.filter(x => !FILES.includes(x) && !DIRS.includes(x));
const denied = top.filter(x => DENY_TOP.test(x));

let n = 0, bytes = 0;
(function walk(p) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    if (e.isDirectory()) walk(fp); else { n++; bytes += fs.statSync(fp).size; }
  }
})(DIST);

const leaks = [];
(function scan(p) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    const rel = path.relative(DIST, fp);
    // 全路径 + NFKC 归一化匹配：堵住「嵌套在 data/ 下」「fullwidth 文件名」两类绕过
    if (DENY_ANY.test(e.name) || DENY_ANY.test(nfkc(rel))) leaks.push(rel);
    if (e.isDirectory()) scan(fp);
  }
})(DIST);

const rep = { dist: DIST, files: n, MB: +(bytes / 1048576).toFixed(2), top, unexpected, denied, leaks };
log('结果 ' + JSON.stringify(rep));
console.log(JSON.stringify(rep, null, 2));
if (unexpected.length || denied.length || leaks.length) {
  console.error('FAIL: 发布目录出现非白名单 / 敏感文件');
  log('FAIL 非白名单/敏感文件');
  process.exit(1);
}
console.log('OK  site_dist 就绪 → 部署请指向 ' + DIST);
log('OK');
