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

## 题库源更新（题源数据 变动时，跑在 build_packs 之前）
0. `merge2.mjs` — 扫描全工作区 `极光_*.json` 原始库 → `merged2/`（**会整目录清空 merged2**）
   - ⚠️ 它不保留 3 个手工文件：`answer_overrides.json` / `conflicts_resolved_manual.json` / `conflicts_single_source_resolved.json`
     → 跑完必须从真源 `_merged2_manual_backup/` 拷回（否则 build_packs 直接 ENOENT 崩）。
   - `enrich_index.mjs` — 重建 `index_jiguang_stats.json`（题难度/答题人次/章节 cid），**只读源**；
     新增题目若缺 `cid`，站点会退化成 `x<章名>` 分组 → verify_site 会报「非 UUID 章节」与「缺 cid」。
     题源更新后必须重跑（顺序：merge2 → enrich_index → build_packs）。

## 部署到 EdgeOne Pages（快路径，~45s）
```bash
node 工程/题库调研/deploy.mjs --full        # 先重建 site_dist
node 工程/题库调研/deploy_edgeone.mjs       # 再部署（默认项目 architecture，可传项目名覆盖）
```
- `deploy_edgeone.mjs` 本地重建 `site_dist/.edgeone/assets`（排除 `.edgeone`/`.env`）+ 写探测结果，再以
  **目录位置参数** 调 CLI → 跳过 auto build，实测 **45s**。
- ❌ 别用 `edgeone makers deploy -n <项目>`（不传目录）：CLI 会走 auto build，其中
  `DescribeFramework` 远程框架探测在本机实测卡 **~240s**（Deploy 总耗时 ~290s）。
  传目录（`makers deploy ./.edgeone -n <项目>`）即跳过；`.edgeone/assets/.edgeone-assets-config.json`
  = 探测结果 `{"framework":"other","needsFallback":false}`（纯静态站正确值）。

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
