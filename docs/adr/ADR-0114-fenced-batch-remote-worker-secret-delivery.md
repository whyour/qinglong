# ADR-0114：围栏化 Remote Worker 批量 Secret 交付

- 状态：Accepted
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-24、D-72、D-85、D-109、D-111、D-112、D-113
- 关联 ADR：ADR-0058、ADR-0073、ADR-0108、ADR-0109、ADR-0110、ADR-0113

> 2026-08-24：ADR-0496 为 Cluster Legacy Env 增加 typed environment bundle，wire 已升级为
> `qinglong/remote-secret-delivery@v2`。本 ADR 的 v1 普通 Secret 围栏、顺序与预算语义继续有效；
> v2 的双 ref-set、96 KiB bundle carrier 和 256 KiB response cap 以 ADR-0496 为准。

## 背景

ADR-0113 已固定 Secret-before-Artifact 的 Worker materializer，但只留下抽象 provider。
若 provider 仅凭 Project/Task/SecretRef 向控制面取值，被替换 Session、过期 Lease、旧
Attempt 或被篡改 execution revision 都可能重放同一 Secret capability；若把 lease token
直接交给通用 provider，又会扩大 bearer capability 的内存与日志暴露面。

独立 Worker ingress 使用最小权限 `ql3_worker_ingress` PostgreSQL role。该角色按既有
架构不能读取 Run execution revision，更不能获得 Run/Lease mutation 权限；因此不能为
实现 Secret 路由而把 runtime authority 临时塞进 HTTP handler 的数据库连接。

## 决策

### 1. 使用一个 exact versioned 批量协议

当前协议为 `qinglong/remote-secret-delivery@v2`；原 v1 是普通 Secret-only 的历史基线。
单次 request 最多 64 KiB，分为最多 64 个唯一普通 `secretRefs` 与最多一个
`environmentBundleRefs`，两组不得重叠；response 最多 256 KiB。普通单值最多 16 KiB、值总量
最多 64 KiB，bundle carrier 最多 96 KiB。response 必须按两组请求顺序分别返回 exact
`{secretRef,value}`，并回绑 Run、Attempt、offer 与 execution digest；未知字段、缺项、乱序、
重复、跨 Project reference、NUL、超限或身份漂移全部 fail closed。

Worker 继续复用 ADR-0112 的单一 `WorkerIngressHttpsClient`、TLS 1.3 mTLS credential
provider 与最多一个 keep-alive socket。现有 offer/activation 的默认 request 上限保持
4 KiB；只有 `/secrets` 显式申请 64 KiB，client 仍以 64 KiB 作为不可提升的硬上限。

### 2. 明文解析前必须验证完整数据库权威围栏

每次 delivery command 必须同时绑定：

- 认证 path 的 Worker ID 与 Session ID；
- Worker generation；
- Run、Attempt、Project、Task 与 pinned Task revision；
- offer ID 与 execution digest；
- Lease generation、token 与 expected version；
- 完整且有序的普通 SecretRef 与 environment bundle SecretRef 两组集合。

runtime authority repository 在 Attempt advisory transaction lock 下使用 PostgreSQL 时钟，
要求 Run=`dispatching`、Attempt=`starting`、executor=`remote_worker`、Session 为当前
`online|draining` 且未过期、Lease=`leased` 且未过期，并逐项比较 Attempt/Session/Lease
中的 worker、generation、offer、token digest 与 version。随后重新规范化 immutable
`task_execution_revisions.plan_json`，要求 execution digest 与两组 SecretRef 集合完全一致。
任一漂移都在调用明文 provider 前拒绝。

同一仍然有效的 starting fence 可以因网络丢包进行幂等重试；它不产生“已消费”事实。
Lease/Session/version/Attempt 状态变化后的重放必须被拒绝。这样既不因响应丢失让 Worker
无法启动，也不允许旧 capability 跨 authority 生命周期继续取密。

### 3. 保持 ingress role 与 provider capability 最小化

PostgreSQL authority repository 只从 runtime entrypoint 导出。独立 Worker ingress 只能
接收由外层 composition root 注入的受保护 delivery service；`ql3_worker_ingress` role
不新增 Run、Task revision 或 Lease 权限。HTTP pipeline 只负责 mTLS/`ql3w` principal、
path identity、低敏 audit 与 wire projection。

Worker materializer 的通用 Secret provider 请求只增加 capability-free 的 offer ID 与
execution digest，仍不包含 lease token/digest、Worker credential、command、callback 或
完整 Offer。具体 HTTPS provider 从单一私有 inbox 重读 canonical Offer，完整复验请求后
才在其内部装配 lease capability。控制面完成 authority 后才调用外置 Secret/KMS/Vault
provider；该 provider 接收不含 token 的 authority projection。

Secret 明文不得持久化、进入 audit/diagnostic/错误文本或普通日志。transport bytes 在解析
后清零，provider resolution 必须支持失败与 handoff 后 cleanup；JavaScript string 无法可靠
zeroize，因此实现不得缓存它，并在 materialized context dispose 后释放全部引用。

### 4. 默认仍不可达

本 ADR 不选择具体 KMS/Vault/Secret store，不实现 Artifact writer、Executor 或 production
headless composition，也不新增 package、数据库表、timer、watcher或第三方依赖。未注入
authority repository 或 plaintext provider 时 `/secrets` 返回 unavailable；现有默认关闭
行为不变。

## 被否决的替代方案

1. **只按 Project/SecretRef 取值**：无法证明请求仍属于当前 Attempt/Lease。
2. **把 lease token 交给通用 materializer provider**：扩大 bearer capability 的传播面。
3. **让 worker-ingress role 直接读取所有 Run/Task 表**：破坏独立入口最小权限与 ADR-0109
   的受保护 runtime boundary。
4. **每个 Secret 单独请求**：最多 64 次 TLS/JSON 往返，不适合低性能路由设备。
5. **使用一次性消费记录**：响应丢失会让合法启动无法重试，并额外引入表和清理生命周期。
6. **为 delivery 新拆 package**：协议、服务、adapter 都已有明确现有归属，无独立部署责任。

## 影响与剩余门禁

已完成：runtime wire contract、完整 authority repository、受保护 service、认证 ingress
route、共享 mTLS client 的 opt-in 64 KiB request、Worker inbox-bound HTTPS provider、exact
ref/value/response identity、stale Session/Lease/version/Attempt 与 capability 泄漏负向测试。

仍未完成：具体 cluster KMS/Vault adapter、Secret 管理与轮换产品面、Artifact writer/upload/
retention、具体 Executor 输出绑定、completion/lease-loss/cancellation/recovery 组合，以及
固定 Edge 与多架构真实传输资源证据。生产 Worker execution 继续默认关闭。

## 验收证据

1. authority repository 在读取 execution revision 前取得 Attempt advisory lock，并使用数据库
   时钟拒绝过期 Session/Lease。
2. stale Lease version、running Attempt、错误 digest 或非完整 SecretRef 集合都不会调用
   plaintext provider。
3. Worker provider 请求不含 lease capability；只有 inbox-bound HTTPS adapter 内部装配它。
4. response 不包含 lease token/digest，且 Run/Attempt/offer/digest 任一漂移都被 Worker 拒绝。
5. offer、activation 与 Secret delivery 共用一个 Agent；普通请求仍受 4 KiB 默认上限。
6. package 数、依赖树、数据库 schema 与 `ql3_worker_ingress` privileges 不增加。
