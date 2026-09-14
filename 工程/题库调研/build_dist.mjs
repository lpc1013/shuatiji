#!/usr/bin/env node
/**
 * 部署整目录重建入口。
 *
 * 背景：site/ 是工作目录，历史上被塞进了 tavern/(533MB)、.bak_*、用户作答导出、zip 等与站点
 * 无关的东西。直接整目录部署 = ①上传 596MB ②把真实作答记录暴露到公网可下载。
 * 规则：**部署只指 site_dist/**，site/ 只当工作目录。
 *
 * 发布白名单单一真源见 _whitelist.mjs；实际打包逻辑统一在 deploy.mjs（--full = 整目录重建 + 泄漏扫描）。
 * 用法：node 工程/题库调研/build_dist.mjs
 */
import { main } from './deploy.mjs';
main('full');
