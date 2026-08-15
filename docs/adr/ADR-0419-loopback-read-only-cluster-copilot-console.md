# ADR-0419：Loopback-only Cluster Copilot 只读 Console

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-327、Phase 2

## 背景

D-324 至 D-326 已交付共享 Cluster Copilot client、stdio MCP 产品面和受限外部 MCP host 部署，但人的浏览器尚无 QingLong 3.0 UI ownership。仓库根 `src/pages` 属于 2.x Umi Web 应用，其 legacy session、`/api` proxy 和 controller contract 不能成为 3.0 Cluster API 的新依赖。让浏览器直接持有 `ql3c_` Project API credential 也会把可调用 authority 暴露给页面脚本、扩展和浏览器存储。

QingLong 同时面向低配路由设备和集群节点。本机 Console 不能进入 Edge/Standalone 默认闭包，也不应成为 Kubernetes 常驻 Pod；否则无人在场时仍会持续持有 Project credential、监听网络并增加资源成本。此前 workspace 已收敛为 18 个 package，Console 没有独立发布或部署闭包，不应为少量文件再拆第 19 个薄 package。

## 决策

1. Console 归属既有 `@qinglong/cluster-admin`，实现放入内聚 `copilot-console/` 目录并通过 `ql3-copilot-console` 与统一 `ql3-cluster-admin copilot-console` 暴露。它不是 2.x Web 页面、Cluster Control route、Kubernetes component 或新 workspace package。
2. 进程只监听 `127.0.0.1`，默认选择 ephemeral port，并只服务 digest-bound 的 HTML/CSS/JavaScript。静态资源不访问外部字体、图片、脚本或 CDN；包内资源的路径、realpath、文件类型、UTF-8、大小和 SHA-256 在监听前全部复验。
3. Browser 与 Cluster authority 分离。BFF 持有 canonical、current-owner、`0600` 的 `ql3c_` credential 并在每次上游请求重新读取；浏览器只提交另一份 exact 256-bit session key。服务端只保存 domain-separated SHA-256 session digest，页面只在内存保存明文，reload/pagehide 后丢弃，不使用 cookie、local/session storage、URL、argv 或 environment 传递 secret。
4. Browser BFF 仅开放 `inspect` 与显式 `output` 两个 POST。request exact-shape 只包含 Project、source Run 和 diagnosis request identity；不接受 endpoint、header、credential、trace、mutation、Provider、Model、Artifact 或 Policy 字段。没有 diagnose/cancel、轮询、WebSocket、SSE、ServiceWorker、缓存、队列、retry 或后台 timer。
5. 每个 read 同步复用 D-324 的 TypeScript client，不启动 CLI 子进程、不直连数据库/application capability。BFF 复验 exact Host、Origin、单一 Authorization header、content type/length 和 operation-route 一致性；未知或未授权 surface 统一为 `404`。
6. 资源边界固定为 4 KiB request、约 2 MiB response、2 个 in-flight read、16 个连接和 2 秒 shutdown ceiling。第三个并发请求立即 `429`，不排队。上游错误只投影 status、稳定 code、request identity 和有界 Retry-After。
7. 响应全部 `no-store`，CSP 默认拒绝并仅允许 same-origin script/style/connect，同时拒绝 frame、object、media、font、manifest 和 worker；无 cookie、无 credentialed fetch。模型输出只能通过 `textContent` 渲染，并在 UI 中持续标记为 untrusted advice 与无行动权。
8. 部署生命周期属于受信 operator workstation 的短期进程。发布包必须包含静态资源、CLI 与 BFF；`--check` 在监听前验证 config/credential/session 并发出一个无认证 TLS 1.3 `/readyz`。不得把 Console 放入 Kubernetes YAML、Cluster Pod sidecar、共享 LAN 或容器 `0.0.0.0` listener。
9. Edge/Standalone、Local MCP、Cluster Control 和 Cluster AI closure 不导入 Console。路由器默认制品字节、文件和 module 闭包必须保持不变；集群管理镜像可包含该短生命周期入口，但不会默认启动它。

## 不选择

- **修改 2.x Umi 页面**：会重新绑定 legacy session/controller/proxy，并使 3.0 UI ownership 无法独立演进。
- **浏览器直连 Cluster API**：必须把 `ql3c_` authority 和 CA/endpoint 细节交给浏览器，难以阻止存储、扩展读取与跨站误用。
- **Kubernetes Deployment/Ingress**：把仅供在场运维者使用的页面变成长生命周期 credential workload，并增加认证、TLS、HA 与资源治理面。
- **把 Console 合入 MCP host**：浏览器 HTTP lifecycle 与 stdio parent-session lifecycle 不同，合并会混淆 host ownership 和 authorization projection。
- **新增 workspace package**：没有独立 consumer/deployment closure，只会恢复用户已指出的单文件薄包问题。
- **自动 polling 或流式输出**：增加请求、连接和低配工作站资源，且掩盖“状态读取”与“敏感输出显式读取”的产品边界。

## 验收

1. contract/server 单测覆盖 exact read schema、digest-bound assets、Host/Origin/session、无 mutation route、无隐藏 queue、低敏错误和幂等关闭。
2. CLI 端到端覆盖 owner-private authority、无认证 TLS 1.3 readiness、ephemeral loopback 启动、真实页面读取与 signal 收敛。
3. 浏览器现场门覆盖 session 解锁、status read、output explicit reveal、恶意 HTML 仅作文本显示、响应式布局、键盘 focus 与零 console error。
4. package packlist、产品 catalog/help、OCI fixture 与真实 Admin image 都必须包含第十个 reviewed command 和三个静态资源。
5. 独立部署审计拒绝 2.x `src`/`back` 耦合、Kubernetes resident Console、`0.0.0.0`、storage/cookie/worker/WebSocket、diagnose/cancel 或 package/export 漂移。
6. 完整 Cluster Admin、18-package build/test、backend、架构/发布审计、真实 Admin image 与 14 档 Local artifact 全部通过后才允许 D-327 阶段提交。本 Gate 不修改 schema、migration、SQL、role、Pool、连接或 HA 拓扑，因此继续引用 D-323 PostgreSQL 18.6 physical HA 基线。
