# ADR-0421：显式 Cluster Run、Task 与 Workflow 观察台

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-329、Phase 2
- 扩展：ADR-0419

## 背景

ADR-0419/0420 已冻结 loopback-only Console 与签名 Admin OCI 分发，但人的观察面仍只覆盖 Copilot diagnosis。值班人员要判断“有哪些 Task、某个 Run 走到哪一步、Workflow Run 是否截断或失败”，仍需手工拼接 Cluster API URL。让浏览器获得通用 proxy、任意 path 或 `ql3c_` credential 会直接破坏既有 BFF 边界；为这组 UI/transport 文件再建 workspace package，也会恢复已经清理的薄包和额外制品闭包。

现有 Cluster Control 已拥有 Project-scoped、Policy-checked、有界的 Run list/detail/events/steps、Task list/detail，以及 Plugin Package Workflow list 和 Workflow Run list/detail/events/steps。D-329 不需要新增 route、repository、schema 或数据库读取模型，只需要把既有低敏投影组合成可用、显式且失败关闭的运维产品面。

## 决策

1. 观察面继续归属 `@qinglong/cluster-admin/copilot-console` 和同一个签名 Admin OCI；workspace 保持 18 个 package，不新增浏览器依赖、生产依赖、服务或第二分发物。名称保留以兼容已发布命令，但页面产品语义升级为 Cluster field ledger。
2. BFF 固定开放 13 个只读 operation：Copilot `inspect|output`；Run list/detail/events/steps；Task list/detail；Workflow list 与 Workflow Run list/detail/events/steps。服务端为每种 operation 生成 exact Cluster API `GET` path/query，浏览器不能提交 URL、method、header、credential、permission 或 response shape。
3. `ql3c_` credential 每次请求从 canonical、current-owner、0600 文件重新读取，TLS 继续固定 1.3、显式 CA/DNS、identity encoding、无 redirect/proxy/compression/connection reuse。新 Project read transport 只接受审核过的 Run/Task/Workflow path grammar，并明确拒绝 start/cancellation、绝对 URL、路径穿越与未知 query。
4. Run 与 Workflow 共用 `run.read`，Task 使用 `task.read`，Copilot output 继续使用既有 `artifact.read`；部署推荐 credential 只授予这三项 read permission。UI 即使收到权限更宽的 credential，也没有 mutation route 或通用转发器。
5. list 默认每页 32、上限 64；只有响应明确 `hasMore|truncated` 且携带下一 cursor 时，页面才出现“显式读取下一页”。读取列表不会自动读取 detail/steps/events，读取 Run 也不会自动级联。没有 poller、watcher、SSE、WebSocket、retry、queue、cache 或后台 timer。
6. 页面采用“现场证据账本”而非通用 Dashboard：每次人工读取形成一条仅存于页面内存的按时序 evidence，所有远端值和模型文本都用 `textContent` 写入。reload/pagehide 清空 session 与账本；不使用 cookie、local/session storage、IndexedDB、ServiceWorker、外部 asset/font/CDN。
7. BFF 保留 ADR-0419 的 exact Host/Origin/session、default-deny CSP、no-store、4 KiB request、约 2 MiB response、2 in-flight、16 connections 与第三请求即时 429。未知 route、route/operation mismatch、额外字段、cursor 半对、非法 ID/UUID/limit 一律在上游调用前失败关闭。
8. Console 仍是短生命周期 operator-workstation process，不成为 Kubernetes Deployment/Ingress/sidecar 或共享 LAN listener。它不进入 Edge/Standalone、Local API/MCP 或 Cluster Control/AI 默认 closure；路由设备的默认制品必须保持不变。

## 不选择

- **浏览器通用反向代理**：即使只允许 GET，也会把未来新增 path 静默暴露给页面，无法证明 operation vocabulary 与权限边界。
- **扩展 Copilot command schema**：Run/Task/Workflow 是普通 Cluster observation，不应伪装成 diagnosis command；BFF executor 在内部按领域分派。
- **复制第二套 TLS/credential client**：会产生配置、TOCTOU、header、body ceiling 与错误投影漂移；D-329 复用同一 Project API authority transport。
- **自动加载详情或实时刷新**：扩大读取次数与资源占用，也让值班人员无法区分 durable fact 与页面自行触发的背景读。
- **回接 2.x Web 或新建 package**：前者恢复 legacy session/controller/proxy，后者为单一消费者制造薄包和额外发布矩阵。

## 验收

1. contract 单测覆盖全部 13 个 operation、exact field set、cursor pair、ID/package/workflow/UUID/limit、固定 path/query 与 mutation/absolute URL 拒绝。
2. TLS 端到端覆盖 owner-private credential、TLS 1.3、Bearer、GET-only、request-ID exact matching、远端低敏错误与 credential buffer 清理；既有 Copilot client/MCP/product CLI 回归必须保持兼容。
3. Console server/CLI 覆盖 Host/Origin/session、route confusion、无任意 path、并发即时 429、digest-bound assets、container-published-loopback 和 13-operation manifest。
4. 真实浏览器覆盖 session unlock、Run/Task/Workflow/Copilot 手动读取、显式下一页、恶意内容纯文本、窄屏/键盘与零 console error；真实 Admin image 复验相同页面、非 root、read-only/no-capability/no-new-privileges 与 host-loopback publication。
5. Console、distribution、package、dependency、Edge import、Cluster deployment 审计零 finding；18-package clean build/test、Cluster Admin、backend、14 档 Local artifact 全部通过后，本 ADR 才转为 Accepted 并进行 D-329 阶段提交。

## 接受证据

- 13-operation contract、Console server/CLI 与 TLS client 定向门 23/23；Cluster Admin 378 pass、3 条件 skip；完整 18-package test 退出 0；backend 1,223 pass、2 条件 skip、0 fail。
- 真实浏览器完成 Run、Task、Workflow 三类 BFF 读取、Task 显式下一页、恶意 HTML 纯文本、390×844 无横向溢出和 0 error/0 warning；验收同时发现并修正了 `[hidden]` 被 panel layout 覆盖的问题。
- 真实 arm64 Admin image `qinglong3-cluster-admin:d329-local` 为 344,518,724 bytes；在 non-root `10001:10001`、read-only root、network none、drop ALL、no-new-privileges、0.25 CPU、128 MiB、32 PIDs 下验证 10 个产品命令、原生/host-published Console 与内置分发文件。
- Console/distribution/package/dependency/Cluster deployment/image release 审计零 finding。npm pack dry-run 为 245 files、262,246-byte tarball、1,642,267-byte unpacked；workspace 保持 18 package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。
- 14 档 Local artifact 全部 compatible；默认 Edge/Standalone 精确保持 2,589,890/2,589,968 bytes、315 files、56 modules，application+AI 保持 4,493,043/4,493,175 bytes，MCP 保持 7,315,930/7,316,038 bytes。
- 本 Gate 不修改 schema、migration、SQL、role、Pool、连接或 HA 拓扑，因此不重复消耗 PostgreSQL HA 现场门，继续引用 D-323 的 PostgreSQL 18.6 arm64 142/142 与 timeline `1→2` 基线。
