# ADR-0241：Kubernetes Worker Credential TokenRequest Session

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-23、D-58、D-175、D-224、D-225
- 关联 ADR：ADR-0060、ADR-0061、ADR-0124、ADR-0192、ADR-0234、ADR-0240
- 收窄：ADR-0240 的 TokenRequest 签发与销毁产品接线；不替代其双 namespace、prepared target 或 delivery RBAC 决策

## 背景

ADR-0240 已把 Kubernetes credential delivery 收窄到短期 ServiceAccount token 与双
namespace 最小 RBAC，但当时的 live fixture 仍直接执行 `kubectl create token`。该命令会把
bearer token 返回给 shell/caller；若产品入口沿用这种方式，token 可能进入终端滚屏、命令替换、
进程内长期变量或临时 kubeconfig，而且无法在真正写入 Secret 前证明 issuer 与 delivery
身份均没有意外扩权。

同时，TokenRequest issuer 和 delivery ServiceAccount 是两个不同 authority：前者只能为
一个预定 ServiceAccount 签发 token，后者才能访问 stage 与精确 target。把两者合并到
admin kubeconfig、常驻 control 或 Worker 会扩大凭据泄漏后的 blast radius，也让低配设备
承担不必要的 Kubernetes SDK、连接或后台生命周期。

## 决策

### 1. Token issuer 是外部、短生命周期管理身份

生产 manifest 将外部认证主体组
`qinglong:worker-credential-operators` 绑定到 staging namespace 中唯一 Role。该 Role 只允许
对 exact `ql3-worker-credential-admin` 的 `serviceaccounts/token` 执行 `create`；不得读取
Secret、Deployment、Pod、Namespace，也不得为其他 ServiceAccount 签发 token。

issuer kubeconfig 由部署者在受保护的管理工作站或受控管理作业中提供。它不是 Worker/control
Pod 的 Secret 或 volume，也不绑定 delivery ServiceAccount、普通 control 身份或广域管理员组。

### 2. 每次 delivery 创建一个有界 TokenRequest session

`cluster-admin` 既有 package 增加显式
`worker-credential-kubernetes-token-request` subpath。每次 `withDelivery()` 必须按以下顺序执行：

1. 先以 issuer 身份完成 1 条应允许与 8 条应拒绝的 SelfSubjectAccessReview；任何意外允许、
   意外拒绝或 API 不可用均在 TokenRequest 前失败关闭；
2. 只向 staging namespace 的 exact ServiceAccount 请求 600 秒 token；
3. 对 API 响应施加 16 KiB 上限、canonical JWT 结构、非 `none` 算法、exact ServiceAccount
   subject、`iat/exp` 安全整数、30–600 秒 lifetime、API expiration 与 JWT expiration 一致性；
4. 只在内存中构造 restricted KubeConfig，立即清空 TokenRequest response 中的 token 引用；
5. 以 delivery 身份完成 8 条应允许与 20 条应拒绝的 SelfSubjectAccessReview，确认与
   ADR-0240 的 stage/target/Deployment 权限矩阵精确一致后才调用业务 operation；
6. callback 只得到既有 delivery adapter 和低敏计数证据，不返回 token、KubeConfig 或原始
   Kubernetes clients；成功、业务失败、校验失败都在 `finally` 清空 token 并使 restricted
   KubeConfig 失效。销毁失败同样失败关闭，但只暴露稳定、无敏感内容的领域错误。

该 session 不把 JWT payload 当成独立认证来源；Kubernetes API 仍是签发与鉴权事实源。本地
结构检查只用于拒绝错误主体、异常寿命和畸形响应，不能替代 API server 的签名验证。

### 3. 保持可选依赖与 Profile 边界

实现不新增 workspace package、生产依赖、timer、watcher、listener、sidecar 或数据库对象。
Kubernetes client 由调用方显式注入，只在短生命周期 Cluster Admin 路径加载；Edge、
Standalone、Worker 和未启用 Cluster 路径不导入该 SDK、不创建连接，也没有空闲成本。

### 4. TokenRequest session 不等于审批产品入口

本 ADR 只关闭“受批执行之后如何安全签发并消费短期 delivery capability”。正式产品命令仍须
先使用既有强 User principal、Project/Policy、separation-of-duty Approved Action、持久审计与
exact replay，再在执行阶段进入 session。测试中的 impersonated User 只是 RBAC fixture，不能
替代 OIDC/client certificate 身份认证、双人审批或 durable execution receipt。

## 不采用方案

### 继续调用 `kubectl create token`

拒绝。命令的正常输出就是 bearer token，调用者必须自行管理 stdout、变量、临时文件和销毁，
也无法把 issuer/delivery 两层权限校验与 adapter 生命周期封装成一个 fail-closed 边界。

### 将 TokenRequest authority 交给 delivery ServiceAccount

拒绝。这会允许受限 delivery token 自签新 token，并延长或复制 compromise authority。
issuer 必须是外部管理身份，delivery ServiceAccount 明确通过 deny matrix 证明不能自签。

### 复用 cluster-admin kubeconfig 完成 delivery

拒绝。广域 kubeconfig 绕过 exact-name RBAC，任何 adapter 缺陷都会升级为集群级 mutation。

### 常驻 controller 自动轮换

拒绝。它会把 issuer credential、Kubernetes SDK、连接、timer/watch 与 leader/retry 状态带入
常驻面，既扩大攻击面，也把路由设备无需承担的成本引入共同架构。

## 影响

- credential-admin deployment 资产新增一个 exact TokenRequest issuer Role/RoleBinding；
- `cluster-admin` 新增一个显式 subpath 和内存 session，不新增 package 或第三方依赖；
- live Gate 不再读取、打印或返回 delivery token，也不再手工构造 restricted kubeconfig；
- session 是一次性 callback scope，调用方不能缓存 adapter 跨 operation 使用；
- issuer/delivery 权限漂移会在 Secret/Deployment mutation 前被发现并失败关闭；
- durable approval 产品命令仍是后续独立切片，不因本 ADR 自动完成。

## 验证

1. GitNexus upstream impact：session 为 LOW，仅 1 个直接上游 KubeConfig wrapper，0 条已识别
   production execution flow；
2. strict TypeScript 与定向 6/6 通过，覆盖成功销毁、issuer/delivery 意外扩权、错误 subject、
   畸形/超长/expiry 不一致响应、TokenRequest 错误和销毁错误的无敏感映射；
3. deployment audit 与 `kubectl kustomize` 验证 exact
   `serviceaccounts/token` + `resourceNames=[ql3-worker-credential-admin]`，production subject
   是外部 Group 而非 delivery ServiceAccount；
4. 固定 `rancher/k3s:v1.34.3-k3s1` 的真实 arm64 Gate 创建 2 个独立 600 秒 session，完成
   issuer 1 allow/8 deny、delivery 8 allow/20 deny、credential A→B、Recreate 顺序、PVC
   强制 Pod 丢失恢复与 identity A→B；token 未从 session 返回，每次 restricted client 均销毁，
   全部 gate `passed=true`；
5. PostgreSQL 18.4 arm64 physical HA 随后重跑通过：`remote_apply`、timeline 1→2、旧主
   fencing、未确认分区提交排除、`pg_rewind` 只读同步重入、两个 fresh control replica 及全部
   domain COMMIT-response-loss gate 均为 true；
6. 成功/失败后的 `ql3-worker-rollout-live-*` 与 `ql3-ha-*` Docker 容器均无残留。

## 仍未完成

- 强 User 登录、双人批准、durable execution receipt 与该 session 的正式产品命令组合；
- production OIDC/client certificate issuer group 的真实外部 IdP ceremony、撤销与审计；
- 多节点 Kubernetes API/CSI、API partition、TokenRequest latency/expiry race 与控制面升级矩阵；
- production Worker image 的真实 360 秒 Session drain，以及固定 x64/arm64 低配设备资源证据。
