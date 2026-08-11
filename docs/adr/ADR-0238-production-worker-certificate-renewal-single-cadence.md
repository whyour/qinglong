# ADR-0238：Production Worker 证书续期单 Cadence 装配

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-23、D-58、D-60、D-175、D-207、D-218、D-222
- 关联 ADR：ADR-0060、ADR-0061、ADR-0121、ADR-0234、ADR-0235、ADR-0236

## 背景

ADR-0061 已实现 Worker 本地 CSR、证书校验、原子 generation 安装和跨重启退避，
ADR-0234 又让 production credential provider 在每个 HTTPS request 前读取当前 active
identity。然而 production Worker 组合根没有调用续期协调器：部署即使提供外部 CA
adapter，也只能另建 timer、watcher 或旁路进程触发续期，无法继承既有 Session、drain、
错误隔离和 Edge/Node 资源预算。

把外部 CA 直接放入 `cluster-control` 会扩大常驻入口的签发权限；为续期再建 package、
sidecar 或 timer 又会把空闲成本推给低性能路由设备。需要在不改变 CA authority 边界的
前提下，把已有一次性续期操作接入唯一 production cadence，并证明正在运行的 Worker
可以在不替换 Session 的情况下完成信任收缩。

## 决策

### 1. 续期是可选 Profile capability，不是内建 CA

`ProductionWorkerHeadlessApplicationEnabledOptions` 接受可选的
`certificateRenewal.run()` capability。它只返回 ADR-0061 的低敏续期结果，不取得 CA
私钥、部署 Secret、listener 或数据库。

`runProductionWorkerProcess` 提供可选 `createCertificateRenewal(config, credentials)`
factory，让具体 Worker Profile 把 cert-manager、Vault、SPIFFE 或离线签发 adapter 与同一
证书目录组合。默认 CLI 未配置 adapter 时不构造 coordinator、不加载 enrollment PKI、
也不增加任何后台活动。

### 2. 复用唯一 cadence，固定先证书后网络业务

启动顺序固定为：

1. 取得 journal owner 并完成有界 startup reconciliation；
2. 执行一次证书维护；
3. 只有 identity 可用时才注册 Worker Session；
4. 启动既有唯一 `unref` cadence。

每个 cadence 的顺序固定为 certificate maintenance → Session heartbeat → execution
supervision/Pull。并发 tick 继续由 application 和 renewal coordinator 各自 coalesce；
不新增 timer、watcher、Agent、socket、Pool、进程或 sidecar。

`not_due`、`renewed` 和 `backing_off` 继续业务；`retry_scheduled` 在旧证书仍有效时继续
业务并发出稳定的 `certificate_renewal_failed` diagnostic。issuer 原始错误、CSR、PEM、
路径和 token 不进入 diagnostic 或 process event。

### 3. 身份不可用必须本地失败关闭

续期抛错或返回 `unavailable` 时，production Session lifecycle 同时：

- 把 Session coordinator 置为 blocked，使 `current()` 不再向 execution plane 暴露可用
  Session，阻止新的 Pull；
- 把 capacity oracle 置零，阻止后续 heartbeat 宣告空闲容量；
- 发出 `certificate_unavailable` 低敏 diagnostic；
- 仍运行 execution supervision，使已有本地执行可以按 durable Lease 到期停止，而不是
  因证书失败永久逃逸监督。

本地安装新证书本身不能解除 fence。只有同一 Session 的后续真实认证 heartbeat 成功，
Session coordinator 才清除 blocked，capacity oracle 才重新 active。这样不会把“CA 已
签发”冒充“网络路径、服务端信任和业务 credential 均已恢复”。

### 4. 换证复用一个 Agent，但不能复用旧 TLS socket

credential provider 继续每请求读取 active generation。共享 HTTPS Agent 的 pool key 同时
绑定 certificate、private key 与 trust anchors；active generation 改变后，下一请求使用
新的 pool key 和 TLS socket，不创建第二个 Agent。Ingress trust reload 继续轮换 TLS
generation、关闭 idle connection，并拒绝旧 generation socket。

### 5. CA overlap 与 trust contraction 由部署编排

常驻 QingLong 控制面仍不持有 CA 私钥，也不开放匿名 CSR endpoint。标准轮换顺序为：

1. ingress 先信任 CA-A + CA-B；
2. Worker 通过外部 issuer 取得 CA-B 证书并原子切换 active generation；
3. 下一次请求使用新 pool key；
4. ingress 显式 reload，只保留 CA-B；
5. 证明 CA-A 旧证书被拒、CA-B 新证书被接受；
6. 同一 Worker Session/generation 继续 heartbeat、Pull、Lease 与 completion。

Edge 可省略 adapter，或用低频外部 maintenance/离线 ceremony 注入 capability；Cluster
节点可由 cert-manager、Vault、SPIFFE 或 Secret rollout controller 注入。两者共享相同
一次性协调语义和失败关闭策略，不为资源档位复制 runtime。

## 不采用方案

### 在 Worker 内再建续期 timer 或文件 watcher

拒绝。它会与 production cadence 竞争、增加 Edge 空闲资源，并在 Kubernetes 多文件
Secret 非原子更新时间窗读取混合材料。

### 由 cluster-control 在线签发 Worker 证书

拒绝。它把外部 transport 漏洞升级为设备根身份签发权，也混淆 transport possession 与
`ql3w`、Session、Lease 三层 authority。

### 续期成功后立即本地解除 Session fence

拒绝。证书可能尚未被 ingress 信任，网络或 credential 仍可能失败；恢复必须由真实
heartbeat 证明。

### 换证时重启 Worker 或创建第二个 Agent

拒绝。重启会扩大 Run/drain 恢复窗口，双 Agent 会增加 socket/RSS 并使旧证书连接的关闭
时点不清晰。credential-bound pool key 已能在单 Agent 内分离代际。

### 为 certificate lifecycle 新建 workspace package

拒绝。续期协调器、process composition、Session lifecycle 和 transport 已由同一 Worker
部署单元拥有；再拆包没有独立发布、authority 或 Profile 替换价值，只会恢复一文件一包。

## 影响

- workspace 保持 20 个 package；
- 不新增生产依赖、migration、表、角色、端口、listener、Pool、连接、timer、watcher、
  Agent、进程或 sidecar；
- disabled Worker 与未注入 CA adapter 的 Worker 保持零续期常驻成本；
- Edge/Node 继续只用同一个 runtime，通过现有 cadence/并发/页预算区分资源档；
- `ProductionWorkerSessionLifecycle` 增加可选 fail-closed capability；只有配置 certificate
  renewal 时才强制要求它，既有无续期 headless embedding 保持兼容；
- 外部 CA adapter、CA 私钥、Secret rollout 与 ingress reload authority 仍在部署层，不
  进入 Worker 或 Cluster 常驻业务入口。

## 验证

1. GitNexus 刷新后包含 35,661 nodes、81,415 edges、285 flows；upstream impact 中
   production headless composition 2 个直接调用者、production product root 0 个上游、
   process root 2 个上游、Worker Session coordinator 4 个上游、renewal coordinator 7 个
   上游，均为 LOW，未命中已知 execution flow。`detect-changes` 对 tracked compare 为 LOW、
   0 flow；Git 本身不会把尚未跟踪的 QL3 文件归入 compare，因此另以 strict 编译、入口
   测试、依赖审计和 live contract 补足；
2. Worker strict TypeScript closure check 通过；全量 132/132，覆盖启动前 identity
   unavailable 清理、单 cadence 顺序、
   unavailable fail-close、同 Session authenticated heartbeat 恢复和唯一 TLS Agent；
3. `test:worker-postgres-live:ql3` 在 Linux Node `24.18.0` 与 PostgreSQL
   `18.4 (Debian 18.4-1.pgdg13+1)` 上完成一次真实续期：issuer 调用 1 次，证书 SHA-256
   改变，ingress TLS generation 变为 2，CA-A 旧证书被拒，CA-B 新证书被接受；
4. trust contraction 后 Worker 保持同一 Session ID、generation 1，瞬时旧 socket 失败
   只产生有界 `session_tick_failed` diagnostic；后续真实认证请求恢复，无 Session replacement；
5. 最新一次同一合约随后完成 Offer→starting→running→67 次 Lease renew→31-byte Artifact→
   completion，Run/Attempt succeeded、Lease completed，并在运行中完成 `ql3w` credential
   A→B、A revoke、最终 drain/offline 与三个数据库角色权限断言；`gates.passed=true`；
6. 合约成功与失败路径均删除临时 PostgreSQL/Node 容器和私有证书目录，不保留 CA 私钥。
7. PostgreSQL 18.4 arm64 physical HA 独立复验 `remote_apply`、timeline 1→2、旧主先
   fencing、未确认分区写在晋升后不存在、`pg_rewind` 只读同步重入和两个 fresh control
   replicas，全部 gate `passed=true`；Worker/HA 临时容器与网络均已清理，既有
   `ql3-cnpg-evidence-control-plane` 未修改。

## 仍未完成

- cert-manager、Vault PKI、SPIFFE/SPIRE 或离线 CA 的正式 adapter/部署模板；
- Kubernetes credential/identity generation 与单节点 PVC rollout 已由 ADR-0239 完成；仍缺
  ingress reload controller、生产 RBAC、权限审计、CA overlap 分区与回滚；
- 证书到期、续期失败、blocked duration、TLS handshake 拒绝的 metric/alert；
- 真实 Kubernetes 多节点 CSI PVC detach/reattach、node loss 与 production 360 秒长 drain；
- TPM/PKCS#11/non-exportable private key provider；
- 固定 x64/arm64 路由设备的时钟跳变、断电、文件系统和资源门禁。
