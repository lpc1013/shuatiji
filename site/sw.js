/* 刷题记 · Service Worker
 * 策略：网络优先 + 离线回落（network-first）。
 *
 * 为什么是「网络优先」而不是「缓存优先」：
 *   本站是纯静态 + 分片懒加载，用户的进度全在 localStorage，最怕的是「新旧版本混排」——
 *   缓存优先会让 index.html 拿旧的、分片拿新的，字段对不上。网络优先在线时永远拿最新的，
 *   断网时才回落缓存，顺带白得离线可用。
 *
 * 为什么缓存名带版本号：
 *   取代以前「改 app.js 必须手动改 index.html 的 ?v=」。activate 时把旧的 shuati-* 全清掉，
 *   不会出现两个版本同时在缓存里打架。
 *
 * ⚠️ 只有 GET + 同源才处理；跨域（如 CloudBase 云函数的 AI 出题接口）一律直接放行。
 */
// 缓存名随注册 URL 的 ?v= 派生：index.html 每次 bump 版本 → 注册 URL 变化 →
// 浏览器拉取新 SW → activate 清掉旧 shuati-* 缓存，避免「改了代码却仍是旧壳」。
const VER = (self.location.search.match(/[?&]v=([^&]+)/) || [])[1] || 'v3';
const CACHE = 'shuati-shell-' + VER;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('shuati-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== location.origin) return;   // 跨域直连，不进缓存

  // 带 ?v= 的版本化资源（data 分片 / 带版本号的 js、css）走 cache-first：
  // 换版本 = 换 URL，天然不会串版本，故可直接用缓存，避免每次刷新都重新下载（单科 jg+ext 约 2MB）。
  const versioned = url.searchParams.has('v');
  if (versioned) {
    e.respondWith(
      caches.match(req).then(hit => {
        if (hit) return hit;
        return fetch(req)
          .then(r => {
            if (r && r.ok && r.type === 'basic') { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(req, c)).catch(() => {}); }
            return r;
          })
          .catch(() => caches.match(req).then(h => h || Response.error()));
      })
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then(r => {
        // 只缓存成功的同源响应（含 opaque 之外的 200）；否则不污染缓存
        if (r && r.ok && r.type === 'basic') {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(req).then(hit => hit || Response.error()))
  );
});
