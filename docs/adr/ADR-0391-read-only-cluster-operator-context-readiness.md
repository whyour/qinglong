# ADR-0391：Read-only Cluster Operator Context Readiness

- 状态：Accepted
- 日期：2026-08-13
- 关联 RFC：QL-RFC-0001 D-303
- 前置决策：ADR-0247、ADR-0250、ADR-0388、ADR-0389、ADR-0390

## 上下文

ADR-0390 的 `context validate` 能在完全离线状态证明 context、TLS、mTLS 与 Kubernetes 配置可解析，但不能证明发布窗口中的目标进程已就绪、证书链仍被线上端点接受或 Kubernetes tunnel 可建立。用任一 management POST 试探会读取短生命周期 assertion 和 command，并可能进入认证、审计、quota 或 mutation 路径；在工作站另写 curl/kubectl 流程则会绕过生产 client 的 hostname、TLS 1.3、mTLS 与 PortForward 约束。

## 决策

1. 在既有 Cluster Admin facade 内增加 `context probe --context=/absolute/operator-context.json`。它不是第八个远程业务命令，不新增 binary、package、依赖、常驻进程或部署 authority。
2. probe 必须先调用完整离线 `context validate`。所有 entry 均通过后才能产生第一个网络请求，避免前项已访问而后项配置错误的部分探测。
3. 每项只使用与 production client 相同的 config preparation、CA、servername、TLS 1.3 和 mTLS client certificate。Kubernetes 项复用受审 kubeconfig preparation、单个 ready Pod 选择与 PortForward tunnel；不得读取 ambient kubeconfig。
4. 唯一请求为 `GET /readyz`，无 Authorization、Content-Type 或 body。它不读取 command/assertion，不调用 management route，不查询数据库，不产生 mutation，不重试，也不在连接失败后切换 Pod。
5. 响应硬限 1 KiB、identity encoding、精确 JSON content type/schema；只接受 `200 {schemaVersion:1,status:"ready"}` 或 `503 {schemaVersion:1,status:"not_ready"}`，拒绝 redirect、额外字段、重复/错误长度、压缩、畸形 UTF-8/JSON 和其他状态。
6. 输出只包含固定 command 名、`https|kubernetes-port-forward`、`ready|not_ready`、固定 method/path 与 `mutation:false`。不得输出 endpoint、port、namespace、Pod、路径、证书主体或错误对象。全部 ready 退出 0；任一 not-ready、连接或协议失败退出 69；离线配置错误仍退出 78；语法错误退出 64。
7. management route 与 client-certificate class 只有一个 package-private policy 真源。配置 preparation 和 readiness 实现不从 package manifest 导出；既有公开 client subpath、POST 语义、错误码与调用方保持不变。
8. 能力只存在于短生命周期 Cluster Admin image。Local/Edge、Cluster Control、Worker 的依赖闭包、文件、RSS、listener、timer、数据库与制品不得变化。

## 不采用方案

- **直接执行一条 inspect 命令**：仍需 assertion/command，会留下认证或审计事实，且把 readiness 与业务授权混为一体。
- **通用 URL/方法探针**：扩大 SSRF 与 authority 面，无法约束到受审 endpoint 和固定路径。
- **自动重试或多 Pod failover**：隐藏单次现场状态、增加窗口时间，并把短生命周期诊断工具变成控制器。
- **把 probe 放进 Cluster Control 或 sidecar**：会给常驻运行时增加网络、定时器和依赖成本，低配 Local/Edge 也没有该需求。
- **为 readiness 新建 package**：只有 Cluster Admin 一个制品消费者，拆包会复制 manifest、发布和供应链表面。

## 操作顺序

1. `ql3-cluster-admin context validate --context=/absolute/operator-context.json`
2. `ql3-cluster-admin context probe --context=/absolute/operator-context.json`
3. 只有前两步符合维护计划，操作者才另行提供精确 command 与短生命周期 assertion 执行业务命令。

probe 不是持续监控、负载均衡健康检查或 mutation 成功保证；退出 0 只表示这一时刻全部受审 readiness 端点返回 ready。

## 验收门

- 无证书 TLS 与 mTLS 真实握手、ready/not-ready、不可达、redirect、畸形与超限响应；
- Kubernetes 单 Pod tunnel、连接丢失时无重试/切换，以及低敏错误映射；
- context 全量离线先验、固定顺序、无 command/assertion/Authorization/body 与输出 secret scan；
- 真实 Admin image 在 non-root、read-only root、network none 容器内启动本地 TLS fixture，证明固定 GET 契约及资源上限；
- Cluster Admin、18-package clean build/test、backend、package/dependency/deployment/image/Local image、14 Local Profile artifact 与 PostgreSQL HA 全量不回归。

## 当前证据

- readiness/TLS/mTLS/Kubernetes tunnel、context product 与 release 定向契约 93/93。Cluster Admin 完整 304 tests、302 pass/2 条外部服务条件 skip/0 fail；18-package clean build/test 退出 0；backend 1,190 tests、1,188 pass/2 skip/0 fail。
- workspace 保持 18 package；Cluster Admin 99 source 中 98 nested/1 个既有 root binary，无 single-source/shallow package且未增加依赖或公开 subpath。package/dependency/deployment/image release/Local image 五项边界审计均 compatible、零 finding。
- 当前源码真实 arm64 Admin image 为 330,487,296 bytes，较 D-302 增加 23,768 bytes；在 `10001:10001`、read-only root、network none、drop ALL、no-new-privileges、0.25 CPU、128 MiB/32 PIDs 下启动同容器 loopback TLS fixture，报告 `contextReadiness=true`，并证明精确 `GET /readyz`、无 Authorization、0-byte body。
- 14 个 Local Profile artifact 全部 compatible 且与 D-302 字节数一致：最小 Edge 为 2,467,343 bytes/295 files/53 modules，最大 Standalone MCP 为 7,168,978 bytes/778 files/213 modules，证明 Router/Edge 闭包零增量。
- PostgreSQL 18.4 arm64 HA 123 项 gate 全绿，timeline `1→2`；私有报告 SHA-256 为 `e7c1743e932f2d7c35dc9153cdf5bc4a03356a38d93fce5507354652aa207a05`，独立 evidence audit `compatible=true`、零 finding，测试容器、网络与卷均零残留。
