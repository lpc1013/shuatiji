/**
 * 本地静态服务器（仅本机自查用，不参与部署）
 * 用法：node 工程/题库调研/serve_site.mjs [端口]
 * 作用：把 site/ 以静态站方式跑起来，验证「分片懒加载 + Service Worker + 富解析渲染」在真实
 *       HTTP 环境下的表现。用 file:// 直接打开 index.html 会因为 fetch 的 CORS 限制拿不到分片。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');
const PORT = Number(process.argv[2] || 8790);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + rel); return; }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',            // 本地自查一律不吃缓存，避免看到旧版本
    'Service-Worker-Allowed': '/',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`site/ 已启动 → http://127.0.0.1:${PORT}/   （Ctrl+C 停止）`);
});
