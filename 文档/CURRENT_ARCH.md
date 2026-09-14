# 当前架构（2026-09-14 重构后）

> 先读这里，避免被旧记忆（.workbuddy/memory/2026-07-08~09 等）里已废弃的 `site/build_data.js`、`site/data/data.js` 误导——它们已不存在。

## 构建链路（数据 → 站点）
```
merged2/by_subject/*.json
   │  build_packs.mjs          → packs/<学期>/{极光,扩展}/<学科>.json + explain/<学科>.json
   │                            （统一 id 网 / 章节归一 / 富解析注入 / 兜底补齐上一版 id）
   ▼
packs/
   │  build_site_data.mjs      → site/data（manifest + 按科分片题包 + 按章节拆分解析）
   ▼
site/data/
   │  deploy.mjs --full（= build_dist.mjs）  → site_dist/（白名单打包 + 泄漏扫描）
   ▼
site_dist/   ← 部署只指这里
```
校验：`工程/题库调研/verify/run_all.mjs [--full]`

## 关键目录职责
- `site/` 生产环境前端源码（index.html / app.js / styles.css / data / 原文 等）。**部署只指 site_dist/**，site/ 只当工作目录。
- `site_dist/` 发布产物，由 `deploy.mjs --full` 白名单生成（绝不整目录部署 site/）。
- `工程/题库调研/` 构建与数据加工：`build_packs.mjs` → `build_site_data.mjs` → `deploy.mjs`；`verify/` 校验套件；`tagging/` 打标。
- `极光爬虫/` 爬虫脚本 + 凭证（须在该目录内运行）。
- `题源数据/` 各年级题源（极光_*.json + 人读 .txt）。
- `文档/` 审计报告（A02 别名网、对抗性审计、知识星图等）。
- `归档/` 旧备份 / 一次性脚本（已 gitignore，不入仓）。

## 已废弃的旧架构（勿参考）
- 旧：`site/data/data.js`（11.7MB 全量）+ `site/build_data.js` + `site/serve.js` 整目录部署。
- 新：`manifest.json` + 分片（packs/<学期>/<学科>-jg/ext.json、explain/<学期>/<学科>/<章节>.json），首屏只下 manifest，题包/解析惰性加载。

## 2026-09-14 抽出的共享工具
- `工程/题库调研/_safeRm.mjs`：安全递归删除（重试 + rename 挪 trash），替代裸 `fs.rmSync(recursive)`（本机 0xC0000409 根因）。build_dist / build_site_data / deploy 均复用。
- `工程/题库调研/_whitelist.mjs`：发布白名单单一真源（FILES / DIRS / 黑名单），被 build_dist / _sync_dist / deploy / dist_parity 共享，防漂移。
- `工程/题库调研/deploy.mjs`：发布打包单一真源（`--full` 整目录重建 / 默认增量同步）；`build_dist.mjs` 与 `_sync_dist.mjs` 是其薄入口。
