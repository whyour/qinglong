# ADR-0530：有界 Local 面板能力发现与启动适配

- 状态：Accepted（D-428 本地同源装配候选已闭合，等待远端 CI 与双架构可下载实物门）
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
- 旧面板仍不进入 headless 产物。Console opt-in 镜像只装配经过闭包裁剪与哈希锁定的静态资源：240 files、11,947,127 bytes，上限为 256 files / 13 MiB / 单文件 3 MiB；`.gz` 副本与 Monaco Editor 不进入产物。
- 装配后的 `/`、`/login`、`/crontab` 与 `/error` 服务受限旧面板，原生 3.0 管理 Console 固定保留在 `/console`，二者共享同一个 loopback Local API，不启动第二个 Web 服务。
- 静态资源使用 64 KiB stream；Edge 的 API admission 为 4、静态资源 admission 为 16，Standalone 分别为 32/64。两类请求共享 drain 生命周期但不互相挤占预算，避免旧 Umi 并行加载 chunk 时饿死 API 或收到 503。
- 旧 Umi 前端暂用 Node 20 构建只是 legacy migration toolchain，不改变 QingLong 3.0 Node 24 runtime、双架构镜像或支持等级。该过渡门必须在 CI 中独立命名，不能让 Node 20 定义新 package 的运行时兼容性。
- Edge 与 Standalone 使用同一代码、不同预算；Cluster 节点不加载 Local SQLite/POSIX authority，也不通过本 Adapter 访问控制面。

## 验证与剩余门禁

本地装配候选已经通过 12-package Console closure、719 files / 16,162,123 bytes（上限 768 files / 20 MiB）镜像审计，以及面板 240-file 哈希/磁盘闭包复核。最终 arm64 Edge 镜像 `sha256:27472cf1bdd66d9fa4e937622ef69d4e36f74918a759de62818b4e59d265714c` 已完成 fresh setup/replay、Owner provision/challenge/claim/presentation/ack、首个 Task 执行与日志标记、graceful stop、SQLite integrity 和 HTTP 200/401 边界，结果为 `compatible=true`。

真实浏览器已验证现有页面使用内存中的 `ql3c_` credential 完成 `/login` → `/crontab`，53 个同源静态请求全部为 200，`/api/health`、`/api/system`、`/api/v3/capabilities`、`/api/user`、`/api/system/config` 和 `/api/crons` 均为 200；最终镜像同时验证 `/console` 原生管理台与 `/login` 旧页面共存。旧页面仍引用的外部图标/装饰图片被严格 CSP 阻止，页面功能可用但这些装饰会缺失；本阶段不为消除装饰错误而放宽网络或 CSP。远端 CI 和可下载双架构实物仍待闭合。

仍未完成：

1. 推送后通过远端完整 CI，并生成、下载和离线复核 exact amd64/arm64 Console Trial Kit 与 milestone；
2. 把旧面板引用的外部图标和装饰图片转为受审本地资产，做到严格 CSP 下无外部请求；
3. 为旧页面增加 Run/Log 只读 adapter 后再开放日志入口；
4. 写操作必须逐项映射到 3.0 revision、Policy、presence/approval、audit 和 mutation fence，不能用通配兼容路由一次性开放。

在远端实物门完成前，本 ADR 声明的是“当前提交可装配并实跑现有面板的受控子集”，不是 Public Release，也不声明完整 2.x 面板可以零修改直连。
