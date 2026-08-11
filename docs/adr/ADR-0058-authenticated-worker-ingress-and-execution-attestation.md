# ADR-0058：Authenticated Worker Ingress 与 Execution Attestation

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-06、D-18、D-40、D-54 至 D-57
- 关联 ADR：ADR-0012、ADR-0013、ADR-0021、ADR-0045、ADR-0049、ADR-0050、ADR-0055 至 ADR-0057

## 上下文

ADR-0057 已把 Worker Session 与 Run Lease 从 Attempt 投影中拆成独立 PostgreSQL authority，但仍缺少可信网络入口。若直接复用 Project API bearer、Project Policy 或 runtime Pool，Worker 会获得与设备身份无关的业务 authority，甚至可能借 `FOR UPDATE` 被授予 Run/Attempt 写权限。另一方面，ADR-0055 只有 provider 抽象；Worker offline、Session expiry 或 Run Lease expiry都不能证明远端执行已经停止。

QingLong 需要一种同时适用于小型 Worker 和多副本 cluster-control 的协议：Worker 只保持一个稳定设备凭据和低频 Session/attestation 请求，控制面把认证、审计、fencing 和恢复证据持久化在共享 PostgreSQL 中；edge/standalone 仍不加载这些组件。

## 决策

### 1. Worker credential 是独立身份域

Worker 使用 `ql3w_<credential-id>_<32-byte-secret>`，以独立的 `qinglong-worker-credential-v1` HMAC 域和独立 pepper 生成 digest。它不得复用 Project API credential、User session 或 Run Lease token。

`worker_credentials` 按 credential ID/version 追加 active/revoked 事实并永久绑定一个 Worker ID。cluster-admin 通过强 User 或 service System principal 执行 issue/rotate/revoke；mutation、目标版本与低敏 audit 在一个 SERIALIZABLE transaction 提交。新 secret 只在首次 issue/rotate 响应出现，语义 replay 返回既有事实且 `token=null`。

长期设备 credential 只建立最长五分钟的进程内 Worker principal。请求 path 的 Worker ID 必须与 credential 绑定一致；session/generation/lease fence 仍需在每项 mutation 中独立复验，credential 本身不授予 Run 执行或恢复裁决 authority。

### 2. Worker ingress 使用独立 listener、组合根和数据库角色

`worker-ingress` 是 cluster-control Profile 下的显式 opt-in application，拥有独立 listener、64 KiB body/response 上限、最多 256 个 in-flight request 和专用 PostgreSQL Pool。它只暴露 exact POST route：Session register、heartbeat、transition 和 execution attestation。

listener application 只拥有 transport 生命周期、资源上限和 admission 安装顺序，不得直接 import PostgreSQL Worker adapter。外层 Profile composition root 在数据库打开后注入 `{evidence, pipeline}` assembly；PostgreSQL、未来 SQLite/内存测试 adapter 或其他受审实现都通过同一端口进入。这样轻量节点复用协议时不会被静态依赖图拉入 `pg`/Drizzle，transport 也不能自行实例化额外 repository 扩大权限。

固定顺序为 route → Worker authentication → durable low-sensitive audit → body → Repository。未知 route、Worker/path 不匹配、认证/审计不可用都在 Repository mutation 前 fail closed。它不安装 Project Policy，不接受 Project API bearer，也不取得 raw dispatch、completion、recovery claim/transition 或 migration authority。

`ql3_worker_ingress` 角色只允许：读取 migration/capability、Worker credential、Attempt/Run Lease fence；写安全审计；读写 Worker Session；读写 attestation。它对 Run、Project、RoleBinding、Identity、API credential、Worker credential mutation ledger 和 recovery control 都没有写权限，对 Run/Attempt/Run Lease 没有 UPDATE/DELETE。

### 3. Execution attestation 是 append-only 的精确证据

每条 attestation 绑定 Run/Attempt、Worker/session/generation、lease digest/generation/version、offer、callback sequence、executor handle、journal revision 和单调 sequence。Worker 只能提交 `running|stopped`，数据库写入接收时间；相同 attestation ID 只有全字段一致才能 replay。

一次提交必须同时复验当前 Attempt、Run Lease 和 Worker Session 的精确 identity，Attempt 必须处于 starting/running、Run Lease 必须仍为 leased。sequence 必须从 1 连续递增，journal revision 必须上升；`stopped` 后不能恢复为 running。任何缺失、旧 generation/version、不同 handle/callback 或跳号都返回稳定 fence rejection。

### 4. Attempt authority 使用跨角色 advisory fence

Worker ingress 不能为取得行锁而获得 Run/Attempt/Run Lease UPDATE 权限。所有会改变或证明远程 Attempt authority 的事务因此先取得同一 `ql3-attempt-authority:<attempt-id>` transaction advisory lock，再按既有顺序取得所需行锁或读取精确快照。

该协议至少覆盖 Run Attempt CAS、Run Lease claim/renew/release 和 attestation submit。它既序列化 runtime 与 Worker-ingress 两种角色，又避免向 Worker 入口泄露调度写权限；新 completion、expiry、cancellation adapter 只要会改变相同 authority，也必须加入该锁协议。

### 5. Remote Worker recovery 只信任精确 attestation

cluster-control 内建 `remote-worker` evidence provider，只查询与 recovery target 全字段一致的最新 attestation：

- 精确 `stopped` 返回 `not_running`；
- 数据库时间内仍新鲜的 `running` 返回 `running`；
- 缺失、过期、畸形、取消或存储错误一律返回 `unknown(provider_unavailable)`。

Worker offline、Session/Run Lease expiry、HTTP 断开和没有心跳都不得返回 `not_running`。provider 只有读证据能力，不得调用 Worker、stop、retry、completion 或取得 recovery claim。

### 6. Schema capability 与交付门禁

`pg-0010-worker-ingress-attestation` 将 control-core 推进至 v9，新增 `worker_credential:1`、`worker_attestation:1` 和三张表。migration、冻结 checksum、Drizzle schema、catalog contract，以及 runtime/admin/worker-ingress 三套权限 readiness 必须 lockstep。

ADR-0059 已补齐应用内 TLS 1.3 mTLS、独立 bounded transport 配置和 worker-ingress Pool 配置；启用入口不再允许明文降级。它仍不是默认生产入口：certificate/credential enrollment、recovery/rotation ceremony、动态证书 reload、撤销机制与多架构资源门禁尚未完成。

## 被否决的替代方案

1. **复用 Project API credential/Policy**：设备身份、Project 权限和执行 authority 是不同安全域，复用会产生 confused deputy。
2. **把 Worker route 放入普通业务 listener/Pool**：会扩大常驻 runtime 权限与故障域，无法证明 Worker 入口没有 dispatch/recovery mutation capability。
3. **给 Worker ingress Run/Attempt UPDATE 以使用 `FOR UPDATE`**：只是为锁权限泄露调度写 authority；共享 advisory fence 可以在零业务写权限下完成串行化。
4. **用 Session offline 或 lease expiry 作为 stopped**：只证明控制面失去 authority，远端进程仍可能产生副作用。
5. **允许 Worker 覆盖最新状态行**：会丢失 sequence、journal revision 和旧 fence 取证，迟到 Worker 也可覆盖新 Session 事实。
6. **缺失 attestation 时回退到通用 provider**：会把不可观察错误扩大为可信负证据，违反 ADR-0055 的默认保守原则。

## 影响与未完成项

正向影响：

- Worker 与 Project API credential 完全隔离，credential 版本、设备绑定和撤销可审计；
- Worker ingress 对调度和 recovery mutation 保持零权限；
- Worker transport 与 PostgreSQL adapter 的依赖方向由 assembly 注入和 package audit 强制执行；
- Remote Worker `not_running` 具备精确、append-only、可重放验证的来源；
- runtime/Worker-ingress 多副本通过同一 Attempt fence 协调；
- 低规格 Worker 只需 HMAC token、一个 Session 和有界 JSON 请求，不要求本地 PostgreSQL 或常驻 sidecar。

仍未完成：

- enrollment/re-enrollment、mTLS、credential recovery 与 pepper rotation ceremony；
- certificate/credential enrollment、撤销、recovery、rotation 与动态 reload；
- TLS handshake/认证失败指标、受审 proxy termination 和多架构资源压测；
- PostgreSQL ACK/completion/expiry/cancellation/retry 原子事务全部加入 Attempt authority lock；
- attestation retention/partition、clock/freshness 运维指标和多 Pool lock-wait/failover 压测；
- headless Worker transport、Artifact/日志上传和生产 Dispatcher lifecycle。

## 验证

1. runtime-core tests 验证 credential exact shape、独立 HMAC 域、canonical token 和 attestation 完整 fence。
2. admission tests 验证认证/审计先于 body、credential Worker/path 绑定、完整 attestation fence 透传和稳定错误映射。
3. migration/Drizzle/schema/readiness tests 冻结 v9、`pg-0010`、19 表及三套精确权限。
4. PostgreSQL 16.14 四角色真实测试验证全部 migration、runtime/admin 隔离、Worker credential/session/attestation、sequence/replay/fencing、Remote Worker stopped evidence，并证明 Worker ingress 无 Run/Attempt/Run Lease 写权限。
5. Run Repository、recovery `applyLost` 与 Run Lease 集成回归验证共享 Attempt advisory fence 没有改变原 CAS/状态机语义。
6. edge import/dependency audit 必须继续证明 Worker ingress 和 PostgreSQL bundle 不进入 edge/standalone 产物。
7. cluster dependency audit 必须拒绝 Worker listener 对 PostgreSQL worker-ingress entrypoint 的直接 import，只允许外层 composition root 注入 assembly。
