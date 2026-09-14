#!/usr/bin/env node
/* 一次性增量同步入口（本机补同步用，不参与部署流程）。
 * 发布白名单单一真源见 _whitelist.mjs；实际逻辑统一在 deploy.mjs（默认 = 增量同步：
 * copyFileSafe 逐文件 + 重试 + safeRm 清残留，本机稳，不裸用 fs.rmSync）。
 * 用法：node 工程/题库调研/_sync_dist.mjs */
import { main } from './deploy.mjs';
main('inc');
