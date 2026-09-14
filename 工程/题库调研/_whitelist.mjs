/**
 * 发布白名单单一真源。
 *
 * build_dist.mjs（整目录重建）、_sync_dist.mjs（增量同步）、verify/dist_parity.mjs（md5 校验）
 * 均从此读取 FILES / DIRS / 黑名单，避免三处各维护一份导致漂移与 dist_parity 误报 FAIL。
 *
 * 新增站点资源（新的 js/css/图标/manifest）必须在此登记。
 */
export const FILES = [
  'index.html',
  'styles.css', 'themes.css',
  'app.js', 'features.js', 'english.js', 'sync.js',
  'sw.js',
  'favicon.svg', 'manifest.webmanifest',
  'lixiangguo.html',   // 成就页「学累了放松」入口：理想国导读，全屏浮层 iframe 同源按需加载
];
// 原文/ = 理想国导读资源（lixiangguo.html 硬依赖 href="原文/..."）；登记进白名单，否则重建会删掉 777 文件
export const DIRS = ['data', '原文'];

// 防御性黑名单：就算哪天有东西被放回 site/，也绝不进发布目录
export const DENY_TOP = /^(tavern|cloud|_preview|deploy_galaxy)$|^\.bak|^database_export|^刷题记|\.zip$|\.pdf$|\.py$|^serve\.js$|^build_data\.js$|^星系分析\.html$/;
export const DENY_ANY = /database_export|备份|\.zip$|\.bak/i;

export default { FILES, DIRS, DENY_TOP, DENY_ANY };
