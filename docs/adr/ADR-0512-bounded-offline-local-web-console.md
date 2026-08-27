# ADR-0512：有界、离线的 Local Web Console

- 状态：Accepted
- 日期：2026-08-28
- 决策：D-417
- 关联：ADR-0367、ADR-0370、ADR-0371、ADR-0374、ADR-0375、ADR-0503、ADR-0511

## 背景

开发约二十天后，D-416 已把 Local Alpha 闭合为可在 fresh 目录直接启动的阶段产物，但常驻 Application 仍是 headless runtime。仓库已有可选 `@qinglong/local-api`：它在同一 Node.js 进程、同一 SQLite authority 和一个 loopback listener 上提供 Task/Run 读取、启动、取消、事件、步骤和日志 API。部署者仍需手写 HTTP 请求，无法把已有后端能力视为可操作产品。

直接把 2.x 前端带入 3.0 会重新引入大依赖树、旧 API 假设和低配设备负担；单独启动前端 sidecar 又会增加第二个常驻进程、端口和部署故障面。阶段性产品需要一个足够小、可离线、与现有 authority 同源的操作界面，同时必须诚实区分默认 headless Trial Kit 和显式 opt-in 的 `application-api` Profile。

## 决策

### 1. Console 属于既有 Local API 制品

Console 由 `@qinglong/local-api` 自带固定的 `/`、`/console.css`、`/console.js` 三文件闭包，通过既有 loopback HTTP surface 提供。它不新增 workspace package、前端框架、第三方运行时依赖、listener、sidecar、数据库连接、timer、watcher 或 cache；静态文件在进程启动时一次性加载并校验。

单文件上限为 96 KiB，总闭包上限为 192 KiB。当前三文件共 43,252 bytes。运行时 artifact pruner 只允许调用方显式保留 `local-api/assets/console/console.js`；路径必须是已安装、规范化的 package-relative regular file，不能用目录通配保留未审计脚本。

### 2. 第一阶段只关闭最常用操作回路

Console 提供：

- 按 Project 查看最多 64 个 Task，读取 revision、schema、content digest 和 enabled 状态；
- 对当前 Task 进行带 revision/content fence 的显式确认启动；
- 查看最多 64 个 durable Run，读取状态、version、执行归属和创建时间；
- 查看 Run 的最多 64 条 Event sequence 与 Workflow Step 数；
- 对未终止 Run 进行显式确认的 durable cancellation request。

页面不创建或编辑 Task，不管理 Identity/Policy/Secret/Plugin，不内嵌终端，也不把“取消已请求”展示成“执行已经停止”。超过窗口的数据继续通过 API keyset/pagination 读取。

### 3. 凭据和浏览器边界失败关闭

静态壳层无需凭据即可从 loopback 读取，所有 `/api/v3` 请求继续经过原 Bearer authentication、Project Policy、durable audit 和 authority re-confirm。Credential 只保存在当前页面 JavaScript closure；输入框在连接后清空并禁用，断开时清除状态。禁止 URL、Cookie、`localStorage`、`sessionStorage`、Service Worker 和外部资源保存或传输 credential。

服务端发送 `default-src 'none'` CSP、same-origin COOP/CORP、Permissions Policy、no-referrer、nosniff、DENY 和 no-store。HTML/CSS/JS 不引用网络字体、CDN、遥测或远程图片，不使用 inline script/style、`innerHTML` 或 `eval`。listener 继续只允许 `127.0.0.1|::1`；远程管理必须由部署者显式建立 SSH tunnel 或等价受信通道，Console 不把 Local API 扩展为 LAN/public listener。

### 4. 默认 Edge/Standalone 保持零增量

D-416 的 Local Trial Kit 和基础 `edge|standalone` Application 仍保持 headless，不包含 `@qinglong/local-api`。只有选择 `edge-application-api|standalone-application-api` 的制品才携带 Console，因此低配路由器不为未使用的 UI 支付包体、listener 或稳态 RSS；Cluster 节点继续使用 Cluster Control 的独立产品与部署路径。

本决策形成可构建、可运行的 `application-api` 阶段制品，但不声称当前 v3 Trial Kit 已经携带 Web Console。把 opt-in Console image/quickstart 变成面向路由/NAS 的实际下载物是下一交付切片。

## 被拒绝的替代方案

### 新建前端 workspace package

拒绝。三个离线资产没有独立领域 authority 或复用消费者；新包会重新制造用户此前指出的过细 package 和单文件包问题。

### 引入 React/Vue/Umi 构建链

拒绝。当前操作面规模不足以抵消依赖、漏洞、构建和低配包体成本；后续功能达到独立应用规模时再以新 ADR 评估。

### 独立静态服务器或 sidecar

拒绝。它增加常驻进程、端口、健康检查和跨 origin credential 处理，同时没有新的 authority 价值。

### 直接监听局域网地址

拒绝。Alpha 尚未关闭 TLS、CSRF、可信代理、会话撤销和远程暴露门；loopback + 显式 tunnel 保持风险可见。

## 影响

- `application-api` Edge/Standalone 制品当前为 3,953,346 / 3,953,490 bytes、467 files、12 packages，远低于 6 MiB/640-file budget；加载闭包为 90 modules，实测 import RSS delta 约 14.0 MiB；
- 基础 headless Edge/Standalone、D-416 Trial Kit、Cluster Profile 和 AI/MCP Profile 不因本切片新增 Console 进程或端口；
- Console 视觉和交互已在 1440×960 与 390×844 视口验证，工作态覆盖 Task detail、运行确认、Run evidence/Event sequence 和取消入口；
- 当前仍缺少面向部署用户的 Console Docker image/Trial Kit 选择、真实低性能物理 Edge 容量数据，以及受保护 public release。

## 验证

- Local API 完整测试 48/48：包含三资产闭包、离线/credential custody、真实 loopback 静态响应、favicon、GET body/query alias 拒绝，以及既有认证 API/SQLite/过载/drain 回归；
- runtime artifact pruner 11/11：显式 JS asset 保留、缺失/逃逸/重复路径在任何删除前失败关闭；
- `edge-application-api` 与 `standalone-application-api` artifact audit 均 `compatible=true`，且证明 Console 被 pack、未被 runtime pruning 删除；
- 完整 backend 为 1,637 total / 1,635 pass / 2 conditional skip / 0 fail，18-package clean build/test 退出 0；
- package boundary 保持 18 packages 且无 single-source/shallow package，Cluster dependency、122-module Edge import 与全部 14 档 Local artifact audit 均 `compatible=true`；远程 CI 结果在本切片推送后记录。
