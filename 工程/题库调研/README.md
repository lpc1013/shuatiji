# 工程/题库调研 —— 构建与数据加工

题库数据加工主战场。构建链按顺序执行，不要跳步；每步产出供下一步消费。

## 顶层入口（推荐）
- `release.mjs` — 一键全链路发布（fail-fast）：build_packs → build_site_data → deploy --full → verify --full。
  - `node release.mjs` 全流程（含 packs 重建，基线 = 当前 packs 目录）；`node release.mjs --skip-packs` 跳过 packs 重建（日常改动 build_site_data/deploy/前端后）。
  - 任一步非 0 退出立即中止，保证发布前全链路验收通过。
  - ⚠️ 直接运行即可；**不要**用 `> log.txt` 重定向 stdout 到文件（本机沙箱下子进程会偶发挂死），需要日志用 `| tee log.txt`。

## 调用顺序（release.mjs 内部串的就是这四步）
1. `build_packs.mjs` — merged2 → packs（统一 id 网 / 章节归一 / 富解析注入 / 兜底补齐上一版 id）
2. `build_site_data.mjs` — packs → site/data（manifest + 按科分片题包 + 按章节拆分解析；含 ONLY 白名单每科 count>0 兜底断言）
3. `deploy.mjs --full`（或 `build_dist.mjs`）— site → site_dist（白名单打包 + 泄漏扫描）
4. `verify/run_all.mjs [--full]` — 前端层 7 步 +（--full）数据层 4 步 + dist_parity 闸门

增量补同步：`deploy.mjs`（默认增量）或 `_sync_dist.mjs`。

## 脚本职责
- **核心**：`build_packs.mjs` / `build_site_data.mjs` / `deploy.mjs` / `_whitelist.mjs`（发布白名单单一真源）/ `_safeRm.mjs`（安全删除）
- **校验**：`verify/`（run_all 编排；`verify_*` 为断言；`probe_*` 为诊断）
- **打标**：`tagging/`（sidecar，build_packs 注入 `item.tags`，不进 merged2）
- **一次性 / 中间产物（下划线前缀，慎用，可能含历史残留）**：`merge2.mjs`、`compare.mjs`、`resolve_conflicts.mjs`、`normalize_export.mjs`、`place_packs.mjs`、`backfill_tx.mjs`、`_inspect_exp.mjs`、`_emoji_fix.mjs` 等

## 铁律
- packs 题目 id 绝不能变（`build_packs.mjs` 读上一版 packs 作基线，ID 铁律见项目 MEMORY）。
- 改完 site/ 必须 `deploy.mjs --full` 重建 site_dist，并跑 `verify`（dist_parity）确认一致。
- 本机 `fs.rmSync(recursive)` 会 fast-fail 0xC0000409；删除统一走 `_safeRm.mjs` 的 safeRmSync。
- 新增站点资源（js/css/图标/manifest）必须登记到 `_whitelist.mjs` 的 FILES/DIRS，否则发布会丢失或触发泄漏告警。
