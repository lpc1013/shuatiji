# jiguang-shuati

个人医学题库爬取脚本 + 纯前端刷题学习网站。

> ⚠️ 仅用于个人学习，非商用、不公开传播。题库内容版权归极光题库所有。

## 目录结构
- `大二/ 大三/ 大四/ 大一/ 水平测试/`：各科目 `1.题库/极光_*.json`（结构化）+ `.txt`（人读版），以及 `2.爬虫文件/` 下的爬取脚本
- `site/`：纯前端刷题网站（`index.html` / `app.js` / `styles.css` + 由题库生成的 `data/data.js`）
- 根目录 `jiguang_*.mjs`、`fix_*.mjs`：增量更新、选项修复、域名迁移等工具脚本

## 重新生成网站数据
`site/build_data.js` 读取各科目 `极光_*.json`，归一化输出 `site/data/data.js`：

```bash
cd site && node build_data.js
```

> `data/data.js` 是生成产物，未入库；重新生成后 `index.html` 中 `?v=` 版本号会自动更新以打破浏览器/CDN 缓存。

## 题库更新
1. 从浏览器 Local Storage 复制 `flutter.access_token`（JWT，约每周过期）
2. `JIGUANG_TOKEN=<token> node jiguang_update_crawl.mjs`（或先跑 `jiguang_check_updates.mjs` 审计）

## 部署
纯静态站点，可直接托管到任意静态服务（EdgeOne Pages / CloudBase / GitHub Pages 等）。
