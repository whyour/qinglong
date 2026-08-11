# ADR-0192：Kubernetes 私有管理隧道客户端

- 状态：Accepted
- 日期：2026-07-29
- 关联：RFC D-145、D-175、D-181、D-182；ADR-0145、ADR-0185、ADR-0191

## 背景

D-181 已交付只接受私有文件、固定 TLS 1.3 的 one-command/one-request client，但
Cluster production Service 是 ClusterIP，NetworkPolicy 只允许同 namespace 的 labelled
Pod。部署者若直接创建 Job，必须把 assertion 先写入 Kubernetes Secret；Secret volume
又是 root-owned symlink，既让短期身份凭据进入 etcd，也不满足 canonical/current-UID
`0600` 文件门。

把 Service 改成 LoadBalancer、通过公共 Ingress 暴露、关闭 hostname 验证，或要求在低配
节点常驻管理 sidecar，都不是可接受的产品交付。

## 决策

### 1. 增加短生命周期 Kubernetes tunnel client

在既有 `@qinglong/cluster-admin` 内新增：

- `./plugin-package-management-kubernetes-client` subpath；
- `ql3-plugin-package-client-kubernetes` executable。

它运行在 operator workstation，而不是 Cluster Pod。它不创建 Secret、ConfigMap、
Pod、Job、ServiceAccount 或 listener，只列出目标 management Pod 并通过 Kubernetes
`pods/portforward` 建立一个 8443 WebSocket tunnel。一次进程只 list 一次、打开一个
tunnel、发送一个 D-181 command，然后关闭 tunnel。

不新增 workspace package、生产依赖、镜像或常驻资源；现有 cluster-admin image/npm
closure 已包含 `@kubernetes/client-node`。

### 2. Kubernetes authority 是独立私有入口

port-forward 流量由 API server/kubelet 建立，不能声称由 CNI NetworkPolicy 的 labelled
Pod ingress 规则证明。它是另一条显式私有入口，必须同时满足：

- operator kubeconfig 对目标 namespace 具有 `list pods` 与
  `create pods/portforward`；
- management HTTPS 仍执行 TLS 1.3、显式 CA、Service DNS hostname 与短期 User
  assertion 验证；
- client 只选择 exact management labels、Running、Ready、无删除时间且
  `automountServiceAccountToken=false` 的 1–2 个 Pod；
- list 上限为 3，存在 continue、超过两个 ready target 或返回异常对象时失败关闭；
- 不自动切换 context、namespace、Pod、端口或重试。

Kubernetes RBAC 只能控制 port-forward subresource，不能代替 QingLong Project Policy、
双人审批或 durable quota。

### 3. kubeconfig 必须是显式、封闭的短期凭据

CLI 增加第四个路径参数：

- `--kubernetes=/absolute/kubernetes.json`

该 `0600` 文件精确包含 schema v1、`kubeconfigFile`、`context`、`namespace` 与
`apiTimeoutMs`。kubeconfig 也必须是当前 UID、canonical、no-follow `0600` regular
file，最大 256 KiB；禁止 ambient/default kubeconfig 和 context fallback。

为避免上游 parser 在审查前读取 `token-file` 或执行 credential provider，本客户端只接受
专用 exact JSON kubeconfig：必须恰有一个 cluster、一个 user、一个 context，且
`current-context` 与显式 context 完全一致。选中 context 必须绑定：

- canonical HTTPS API server、显式内嵌 CA、`skipTLSVerify=false`；
- 无 proxy、无外部 CA/client certificate/key 文件；
- 内嵌短期 token，或匹配的内嵌 client certificate/private key；
- 无 exec plugin、auth-provider、basic auth、impersonation 或文件引用。

这会排除依赖云厂商 exec credential plugin 的 ambient kubeconfig。部署者应由身份系统
签发一个最小权限、短生命周期、材料内嵌的专用 kubeconfig；后续若支持 credential
plugin，必须作为独立审计切片，不能隐式执行任意本机程序。

### 4. tunnel 不降低 D-181 TLS/HTTP 门

WebSocket 只提供 raw byte stream。D-181 client 在其上重新建立 TLS，继续强制：

- Service DNS `ql3-plugin-package-management.<namespace>.svc` 与 port 8443；
- servername、显式 management CA、TLS 1.3 min/max；
- one request、无 redirect、无压缩、无 retry、bounded response/timeout；
- assertion/command/output 脱敏和结果 exact-shape 校验。

Kubernetes API TLS 与 management TLS 是两个独立验证层。API server、kubelet 或 tunnel
不能伪造通过 management CA/hostname 校验的服务。

### 5. Profile 与资源边界

Edge/Standalone 不安装或启动 tunnel client；它只属于 cluster-admin operator 制品。
路由器作为 Edge 节点新增零 idle CPU/RSS、零 socket、零 timer。单节点开发 Cluster 与
2-replica production Cluster 都可选择 1 个 ready target；production 服务端副本与
PostgreSQL HA 基线不因本客户端降低。

## 不采用方案

### Kubernetes Job + Secret volume

会让 assertion 进入 etcd/Secret 生命周期；projected volume 还是 root-owned symlink，
与 D-181 私有文件门冲突。

### 公共 Ingress、LoadBalancer 或关闭 hostname verification

扩大攻击面并移除现有私有网络假设；管理 assertion 不是公开暴露的理由。

### `kubectl exec`/stdin 注入文件

会重新引入 stdin secret protocol、Pod lifecycle 和清理语义，且难以用产品测试证明
exact bytes/owner/mode。

### 常驻 sidecar/gateway

为低频 operator command 增加常驻资源、证书轮换和故障面，对小型节点不合适。

### 自动重试或自动换 Pod

管理 COMMIT 结果可能不确定。自动重建 tunnel/换 Pod 会隐藏 exact replay 边界；失败后
必须由 operator 使用原 command 显式重放。

## 验收证据

- Kubernetes client 专项 9/9：exact JSON kubeconfig、私有文件、内嵌 token 与匹配
  client cert/key、proxy/skip TLS/file/exec/auth-provider/basic auth/impersonation 拒绝、
  ready Pod overflow/continue/unready/token-mount 拒绝、remote error 透传、response-loss
  no-retry 和 CLI 脱敏均通过。
- 使用真实 `@kubernetes/client-node` `PortForward` 类和注入的 WebSocket handler，证明
  exact `/api/v1/namespaces/qinglong3-system/pods/<name>/portforward?ports=8443`、
  v5 channel 前缀、双向 raw bytes 与 graceful close；随后以真实本机 TLS server 证明
  tunnel 上仍为 Service DNS hostname + management CA + TLS 1.3。
- cluster-admin 全量为 130 pass、0 fail、1 条既有真实 Kubernetes 条件 skip；
  deployment/dependency 两套测试 50/50。cluster image release、22-importer dependency、
  CloudNativePG、deployment 与 edge-import 审计全部无 finding。
- npm dry-run pack 为 68 entries、88,472 bytes compressed、542,810 bytes unpacked；新增
  tunnel library/CLI 的 JavaScript 与 declarations 共 27,132 unpacked bytes，已被
  package export/bin 和 deployment audit 精确绑定。
- workspace 保持 22 包；cluster-admin 使用既有 `@kubernetes/client-node@1.4.0`，未新增
  生产依赖、镜像、Secret、Pod、Job、listener、timer 或 controller。Edge import 仍为
  121 modules，Edge/Standalone 零 idle 资源增量。
- 当前证据不冒充真实 production Kubernetes/OIDC ceremony；真实 API server
  port-forward、RBAC 和两 User assertion 仍属于 release/live evidence gate，而不是
  放宽本 ADR 的静态权限与协议边界。
