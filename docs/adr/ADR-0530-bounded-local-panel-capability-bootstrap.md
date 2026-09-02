# ADR-0530：有界 Local 面板能力发现与启动适配

- 状态：Proposed（D-428 源码候选，等待可下载同源装配与双架构实物门）
- 日期：2026-09-02
- 关联 RFC：QL-RFC-0001 D-428、D-427、D-423、D-424

## 背景

ADR-0529 已交付认证后的只读 `/api/crons` Adapter，但现有 2.x 面板启动时还会读取 `/api/system`、`/api/system/config`、`/api/user`，并假设用户名/密码登录、Local Storage JWT、完整菜单和 WebSocket 可用。仅有 Cron API 时，页面仍不能安全接入；若伪造完整 2.x 能力，则会把尚未实现的写操作、Env、Script、Subscription 和日志入口暴露给用户。

因此第二切片必须先让页面明确发现“这是 QingLong 3.0、当前 Profile 有哪些能力”，再只启用已闭合的页面和认证方式。兼容层继续是翻译边界，不恢复旧 Express Service、JWT authority 或数据库直写。

## 决策

### 能力与启动契约

- Local API 新增公开只读 `GET /api/health`、`GET /api/system`、`GET /api/v3/capabilities`。它们只接受无 body 的 exact path 与可选单个数字 `t`，仅返回版本、Local Profile、认证种类、能力开关和有界预算，不返回 principal、credential、Project 数据或存储路径。
- `GET /api/user` 与 `GET /api/system/config` 继续走正式 Bearer authentication、`task.read` Policy、durable audit 和 credential reconfirm；operation 固定为 `panel.user.get` 与 `panel.system.config.get`，且面板身份只接受 User principal，service credential 失败关闭。
- capability schema 固定为 v1。Edge 最多暴露 64 条 Cron、16 KiB 日志块；Standalone 最多 256 条 Cron、32 KiB 日志块；单页最多 64 条。Cluster 不复用该 Local capability shell，后续由独立 Panel Gateway 发布其能力。
- 明确声明 `legacyLogin=false`、`legacyMutations=false`、`subscriptions=false`、`scripts=false`、`environmentVariables=false`、`webSocket=false`。现有 v3 Task/Trigger/Run/Log 读 API 可以存在，但本切片的旧页面只启用 Crontab 只读投影。

### 现有面板源码降级

- 面板在登录页同源读取 `/api/v3/capabilities`；只有严格匹配 v1 契约才进入 QingLong 3.0 模式，否则保持 2.x 行为。
- QingLong 3.0 模式只接受 `ql3c_` API Credential。凭据只保存在当前 JavaScript 模块内存，通过 Authorization Bearer 发送；不写 Local Storage、Cookie、IndexedDB 或 URL，刷新和关闭页面后必须重新输入。
- 成功读取 `/api/user` 后进入 `/crontab`。菜单只保留登录、错误页和定时任务；不建立 WebSocket，不请求 Cron View、Subscription 或非空搜索/排序。
- Crontab 只展示名称、命令描述符、状态和计划；隐藏创建、选择、批量操作、详情、脚本跳转、日志和全部写 Modal。分页被 capability budget 限制，最后一个不足整页的 Edge/Standalone 窗口仍可读取。
- 2.x 模式的数据流、Local Storage token、登录接口、菜单和页面行为保持不变。

## 部署与资源边界

- 默认 headless 产物不包含 `@qinglong/local-api` 或旧面板，不新增端口、连接、timer、watcher、后台进程或稳态内存。
- 当前约 33 MiB 的旧面板源码构建结果不自动塞入 headless/Console Alpha；同源静态资源装配与体积预算必须作为独立门完成。
- 旧 Umi 前端暂用 Node 20 构建只是 legacy migration toolchain，不改变 QingLong 3.0 Node 24 runtime、双架构镜像或支持等级。该过渡门必须在 CI 中独立命名，不能让 Node 20 定义新 package 的运行时兼容性。
- Edge 与 Standalone 使用同一代码、不同预算；Cluster 节点不加载 Local SQLite/POSIX authority，也不通过本 Adapter 访问控制面。

## 验证与剩余门禁

源码候选已通过 Local API 12-package closure build、89/89 测试、真实 SQLite/credential/Policy/audit HTTP 集成、Node 20 的旧面板 production build、18-package 完整测试与 package/import/dependency audit。Playwright 同源源码旅程也已验证 capability 登录页、内存 credential、只读 Crontab、隐藏写入口与排序/过滤，以及刷新后回到登录页；最终页为 0 console error，仅保留既有国际化 warning。远端 CI 和可下载实物仍待闭合。

仍未完成：

1. 在一个可下载 Console 产物中同源装配改造后的面板静态资源，并证明 CSP、缓存和 API 路由优先级；
2. 在装配后的 exact Console + Local API + SQLite 上使用真实 `ql3c_` credential 重跑登录 → `/crontab` → 分页 → 401/刷新清凭据的浏览器 journey；
3. 为旧页面增加 Run/Log 只读 adapter 后再开放日志入口；
4. 双架构资源与 artifact gate，以及对面板体积的可解释预算；
5. 写操作必须逐项映射到 3.0 revision、Policy、presence/approval、audit 和 mutation fence，不能用通配兼容路由一次性开放。

在上述门禁完成前，本 ADR 只说明“现有面板源码能受控接入”，不声明当前已发布 Console artifact 包含该页面，也不声明 2.x 面板可以零修改直连。
