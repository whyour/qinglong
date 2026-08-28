# ADR-0515：Local Console 的有界 Run 日志观察面

- 状态：Accepted
- 日期：2026-08-28
- 对应 RFC 切片：D-420
- 关联：ADR-0377、ADR-0378、ADR-0379、ADR-0512、ADR-0513、ADR-0514

## 背景

D-419 已让 Console Trial Kit 使用真实 Owner credential 完成示例 Task read、带 revision/content digest 围栏的显式启动、`succeeded` 终态和 bounded log marker 验证。但 marker 只由原生 CI 直接读取 HTTP API；部署者在 Web Console 里仍只能看到 Run、Step 数和 Event sequence，无法确认脚本实际输出。对连续研发约二十天后的阶段产物而言，“测试知道工作完成”不能代替“试用者能在产品面观察工作结果”。

既有 `run.log.read` 已具备 Project 掩蔽、`artifact.read` Policy、durable audit、credential re-confirm、32 KiB Application 上限和 retention/truncation 状态。缺口是一个不放大低配设备常驻成本、也不把内部 Artifact authority 暴露给浏览器的显示层。

## 决策

### 1. Run HTTP 详情只追加 latest Attempt 的低敏摘要

Local API 在既有 Run 详情中追加 `latestAttempt`：仅包含 Attempt ID、序号、状态、创建/开始/完成时间和 `logAvailable` 布尔值。它不返回 `executorHandle`、PID、Worker、Artifact ID、文件路径、错误摘要或内部 lease。

该摘要由 Local API 自己调用 `findLatestAttemptByRunId` 并严格验证 Run ownership、ID、状态和时间边界。共享 `executeBoundedRunReadProjection` 保持不变：GitNexus 将其判定为 HIGH 风险，直接修改会同时影响内建 Run read/compare Tool。Local 产品增强不得悄然改变 AI/Tool 投影语义。

### 2. Console 每次只读首个 32 KiB 窗口

用户选择 Run 时，Console 使用 `latestAttempt.id` 调用既有 authenticated log API，固定请求 `offset=0&length=32768`。返回内容必须是有界 base64，浏览器解码后只通过 `textContent` 写入 `<pre>`；不使用 HTML 插值、下载链接或 Artifact 路径。

界面明确区分：

- `available`：显示 byte range、total bytes、truncation fact，并在存在 `nextOffset` 时说明后续内容应经 API 分页读取；
- `pending`：说明日志尚未发布，可由用户显式刷新；
- `retired`：说明日志已按 retention 清理，但 Run/Event 事实仍保留；
- `not_found|unavailable`：不扩大存在性信息，也不遮蔽已经取得的 Run/Event。

Console 不新增轮询、WebSocket、timer、后台缓存或整文件下载。用户刷新仍是当前 Alpha 的资源控制边界。

### 3. 低配与集群部署边界不变

新增资产仍只进入 opt-in `edge-application-api|standalone-application-api` 和 Console Trial Kit。默认 headless 路由/NAS 不携带 Console，也不增加 listener、请求、RSS、进程或稳态 I/O。Cluster 节点继续使用独立 Cluster Control/Console authority，不复用 SQLite Attempt 或本机 Owner credential 路径。

### 4. Task mutation 不搭便车进入常驻 HTTP

现有 `task.put` 是强认证、短生命周期 CLI：一次进程只激活一个 credential fence，并在 SQLite 事务内复验 credential、Project/RoleBinding、Audit 和 mutation。常驻 HTTP 若直接复用其进程级 active fence，会引入并发凭据串线和撤销竞态。

D-420 不以单因子 Bearer 或非原子的 HTTP adapter 绕过该边界。Web Task 创建/修订必须另行设计“每请求 credential fence + 同事务 Policy/Audit/mutation”，并继续保持 headless/Cluster 分层。

## 不采用的方案

- 不修改共享 Run read projection：其 HIGH 风险上游包含内建 Run read/compare Tool，Local UI 字段不应进入通用 Tool contract。
- 不把 Artifact ID 或路径返回浏览器：Attempt ID 已足够调用受 Policy 保护的读取能力。
- 不自动轮询或推送日志：这会给低配设备增加持续请求、timer 和连接状态；当前 Alpha 由用户刷新。
- 不一次读取或渲染整份日志：日志大小不受 UI 控制，首窗口足以完成阶段自动化观察，后续仍由 API 分页。
- 不顺便开放 Web `task.put`：现有强认证事务不能安全地转换为长期进程的共享 active fence。

## 结果与验证边界

D-420 把 D-419 的“CI 能从 API 看见 marker”推进为“部署者能在 Console 看见实际输出”，同时保持 Run/Event 为独立事实源。三项离线 Console 资产现为 48,318 bytes，仍低于 192 KiB 总闭包和单文件 96 KiB 门；没有新增 workspace package、第三方依赖或默认 Profile 资源。`edge-application-api|standalone-application-api` 为 3,960,535 / 3,960,679 bytes、467 files、12 packages、90 loaded modules，距 6 MiB 分别保留 2,330,921 / 2,330,777 bytes；import RSS delta 为 14,745,600 / 14,794,752 bytes，低于 28 MiB 门。默认 headless Edge 仍为 2,669,390 bytes、325 files、3 packages、58 modules，证明没有携带 Console 增量。

定向验证包括 Local API 49/49、真实 SQLite/loopback/Bearer/Policy/Audit/log range 集成，以及 1440×960 和 390×844 的真实浏览器工作态。Local artifact 三档、Local image、package/source boundary、122-module Edge import 和 Cluster dependency audit 均 compatible；workspace 仍为 18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。完整 backend 为 `1,650 total / 1,648 pass / 2 Linux conditional skip / 0 fail`，18-package clean build/test 在允许 loopback TLS 的宿主门中退出 0。双架构远端门仍按本切片提交继续验证；这些门通过也不等于首份真实双架构 v5 Trial Kit 已生成，实际大 archive 仍需维护者显式授权。
