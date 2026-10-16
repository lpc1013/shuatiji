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
/* F04 加固（20261015）：DENY_ANY 原先只挡 备份/zip/bak，挡不住被误放进白名单目录的
 * 凭证类文件（.env / credentials.json / private.key / *.pem / token* 等）。
 * 现补齐敏感文件名模式；正常资源（data/*.json、原文/*.jpeg|.html）不受影响（已盘点 87+777 文件）。 */
export const DENY_ANY = new RegExp(
  [
    'database_export', '备份', '\\.zip$', '\\.bak$',          // 原有
    '\\.(env|pem|key|p12|pfx|keystore|jks|htpasswd)$',        // 凭证/私钥扩展名（含 .env）
    'credential', 'password', 'secret',                       // 凭证关键词
    'api[_-]?key', 'private[_-]?key', 'id_rsa', 'access[_-]?token', 'token',
    '\\.env[.-]', '^\\.env',                                  // .env / .env.local / xx.env
  ].join('|'),
  'i'
);

export default { FILES, DIRS, DENY_TOP, DENY_ANY };
