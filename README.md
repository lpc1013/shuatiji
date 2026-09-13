# jiguang-shuati

个人医学题库爬取脚本 + 纯前端刷题学习网站。

> ⚠️ 仅用于个人学习，非商用、不公开传播。题库内容版权归极光题库所有。

## 目录结构（2026-09-14 重构后，四级）

| 目录 | 内容 |
|---|---|
| `题源数据/` | 各年级题源：`大一/ 大二/ 大三/ 大四/ 水平测试/`，每科目 `1.题库/极光_*.json`（结构化）+ `.txt`（人读版）+ `2.爬虫文件/` |
| `极光爬虫/` | 极光题库爬虫全套：`jiguang_*.mjs` 脚本 + 运行时状态/凭证（`jiguang_token*.txt`、`proxies`、`window_state`）。**必须在本目录内运行**（相对路径 `../题源数据/<年级>/`） |
| `工程/` | 构建与数据加工：`题库调研/`（build_packs → build_site_data → build_dist、verify 校验套件、tagging 打标）、`iyixue_top/`、`haimamed_english/`、`爬虫与构建产物/`（日志与过程记录存档） |
| `文档/` | 各轮调研/审计报告（A02 别名网、对抗性审计、知识星图、错题模块调研等） |
| `归档/` | 旧备份、一次性脚本、APK、杂项探针产物（留档，不入仓） |
| `site/` | 🌐 **生产环境**：纯前端刷题网站源码（`index.html` / `app.js` / `styles.css` / `data/`） |
| `site_dist/` | 🌐 **生产环境**：发布打包产物（由 `build_dist.mjs` 按白名单生成，部署只指这个目录） |

> ⚠️ `site/` 与 `site_dist/` 为生产环境，**保留在项目根、不参与目录搬迁**。改动后必须同步两侧（用 `dist_parity` 校验）。

根目录仅保留：`README.md`、`.gitignore`、`ch.json`（构建输入）、`database_export-*.json`（用户进度快照）。

## 常用命令

```bash
# 构建链（在 工程/题库调研/ 下）
node 工程/题库调研/build_packs.mjs          # merged2 → packs（题源打包 + id 网）
node 工程/题库调研/build_site_data.mjs       # packs → site/data
node 工程/题库调研/build_dist.mjs            # site → site_dist（发布白名单）

# 校验（前端层 7 步；加 --full 追加数据层 4 步 + 发布闸门）
node 工程/题库调研/verify/run_all.mjs [--full]

# 本地预览
node 工程/题库调研/serve_site.mjs 8790       # → http://127.0.0.1:8790/

# 题库增量更新（在 极光爬虫/ 下运行）
cd 极光爬虫 && node jiguang_update_crawl.mjs
```

## 题库更新
1. 从浏览器 Local Storage 复制 `flutter.access_token`（JWT，约每周过期）
2. `cd 极光爬虫 && JIGUANG_TOKEN=<token> node jiguang_update_crawl.mjs`（或先跑 `jiguang_check_updates.mjs` 审计）

## 部署
`site_dist/` 为纯静态站点，可直接托管到任意静态服务（CloudBase Hosting / EdgeOne Pages / GitHub Pages 等）。
云函数见 `site/cloud/functions/quiz`（英语跨设备同步 `english-push/pull/reset` + AI 接口）。
