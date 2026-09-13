# 极光题库 API 端点（从前端 main.dart.js 提取，2026-08-27 实测）

> 来源：Flutter Web 前端 `https://app.ji-guang.top/main.dart.js`（2026-08-22 构建）。
> 注意：前端站点 nginx 把 HTML/JS 标成 `application/octet-stream` 导致浏览器下载，
> 但 API 域名 `api.ji-guang.top` 正常返回 200，**不影响接口调用**。

## 基础地址
- Base URL: `https://api.ji-guang.top/api/v1`
- 鉴权头：`Authorization: Bearer <token>`

## 登录 / 鉴权
- **密码登录**：`POST /user/auth/login-password`，JSON body：`{"phone": "<手机号>", "password": "<密码>"}`
  - 空 body 实测返回 `422 VALIDATION_ERROR`，证明路由存在（只缺字段）
- 验证码登录：`POST /user/auth/login-code`，body：`{"phone": "<手机号>", "code": "<验证码>"}`
- 发送验证码：`POST /user/auth/send-code`，body：`{"phone": "<手机号>"}`
- 注册：`POST /user/auth/register`，body：`{"phone","password","code","inviteCode","nickname"}`
- 登出：`POST /user/auth/logout`
- 改密 / 重置：`/user/auth/change-password`、`/user/auth/reset-password`

## 数据接口（需登录）
- 学科列表（公开，无需 token）：`GET /user/subjects/?skip=0&limit=50`
- 学科章节：`GET /user/chapters/{chapterId}?mode=practice&skip=0&limit=10000`
- 题目：`GET /user/subjects/{subjectId}/questions?skip=0&limit=100`
- 章节题目：`GET /user/chapters/{chapterId}/questions?mode=practice&skip=&limit=`

## 风控 / 权限
- 鉴权从 JWT 演化为有状态 session：过期或 revoke 均拒绝（401/403）。
- VIP 学科 `has_access=false`（截至 2026-08-26：儿科学、内科学 test、医学免疫学、
  耳鼻喉、影像、传染病 test、病理学 等）需开通 VIP 才能拉题，无法绕过。

## 登录流程建议（拿到账号密码后）
1. `POST /user/auth/login-password` 拿 token
2. 后续请求带 `Authorization: Bearer <token>`
3. 用已有 `jiguang_new_subjects_crawl.mjs` 续爬（眼科学 +402），命令：
   `node jiguang_new_subjects_crawl.mjs '<JWT>' '大四/眼科学' budget=900`

## 待办
- [ ] 用户提供账号密码（或当前有效 JWT）后即可启动眼科学续爬
- [ ] 清理临时文件 `jg_main.js`（从前端下载的 5.7MB 产物，用于提取端点）
