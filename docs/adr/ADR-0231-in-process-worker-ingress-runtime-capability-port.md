# ADR-0231：Worker ingress 复用 control 进程并注入 runtime capability port

- 状态：Accepted
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-02、D-57、D-104、D-118、D-214、D-215
- 关联 ADR：ADR-0058、ADR-0059、ADR-0108—0110、ADR-0119、ADR-0230

## 背景

Worker transport、mTLS listener、认证、Session、attestation、offer、activation、
Secret delivery、Artifact、completion 和 lease-control contract 已分别存在，但正式
`cluster-control` process 只启动用户 API listener。Worker ingress 只能从测试或外部
caller 手工组合，因此 Remote Worker 无法通过 production deployment 接入。

直接让 `ql3_worker_ingress` Pool 构造 completion/lease adapter 虽会在数据库 ACL
处失败关闭，却模糊了能力所有权；另起 sidecar 与内部 HTTP/Unix RPC 又会增加进程
RSS、socket、认证、shutdown 和部署故障域。对可能运行在小型设备上的统一产品，
Edge/Standalone 也不能因为 Cluster 功能而加载 S3 SDK 或读取 Worker Secret。

## 决策

### 1. 使用同进程 capability port，不建立内部 RPC

`bootstrapClusterControlRuntime` 在 runtime Pool readiness 之后构造冻结的
`ClusterWorkerRuntimePort`。它只公开：

- offer claim；
- starting/running/start-failure ACK；
- 可选 Secret delivery；
- Artifact upload；
- completion；
- lease renew/stop。

port 不公开 Pool、SQL client 或 repository。production composition 把该对象注入
Worker admission pipeline；HTTPS transport 不 import runtime PostgreSQL adapter。

runtime Pool 继续拥有所有 Run/Attempt/Lease mutation。Worker ingress 的独立 Pool
只拥有 credential resolve、Session、attestation 与 write-only security audit。
`@qinglong/cluster-postgres/worker-ingress` 不再导出 completion 和 lease-control
mutation adapter。

### 2. 一个 control 进程、两个 listener、两个最小权限 Pool

既有 `ql3-cluster-control` binary 同时拥有：

- 5800：control API/probe listener；
- 5801：TLS 1.3 + mandatory client certificate 的 Worker listener。

不新增 workspace package、sidecar、内部 listener、timer、watcher、queue 或 IPC。
Worker ingress 默认最多 4 个 PostgreSQL 连接，control runtime Pool 继续使用原上限。
Worker listener 的启动属于 application lifecycle：readiness/recovery 完成后启动，
失败时 production activation 失败关闭；停止时先撤 admission，再关闭 Worker Pool
与 listener。

### 3. Artifact provider 只在启用 Worker ingress 后加载

Worker completion 必须先有 immutable、digest-authenticated Artifact evidence。
启用 Worker ingress 时配置必须提供受限 S3 bucket 与 region，可选 private endpoint、
path style、expected owner 和 KMS。S3 client/binding 由 process 动态 import，默认
control、Edge、Standalone 和 disabled Worker ingress 不加载 AWS SDK，也不读取其
配置。

S3 adapter 仍只有 `s3ArtifactStore.ts` 一个第三方 provider importer。process 关闭时
无论启动或 emit 是否失败，都会停止已启动 application 并销毁 S3 client；清理失败
不能覆盖更早的根错误。

Secret provider 保持可选注入。没有 provider 时 `/secrets` 稳定返回不可用，不会
回退到环境变量、数据库明文或空值；不含 Secret reference 的执行仍可使用其余完整
链路。

### 4. 部署显式分离 Secret 与端口

Kustomize base 增加 `worker-mtls` 5801 Service/container port，以及独立
`ql3-cluster-worker-ingress` Secret：

- Worker credential pepper；
- server key/certificate 与 Worker client CA；
- Worker ingress PostgreSQL URL/CA；
- Artifact bucket/provider 配置。

CloudNativePG overlay 删除通用 Worker DSN，改用
`ql3-postgres-worker-ingress-auth` 与 `ql3-postgres-ca`。control Pod 不取得
migration/admin/package authority，Worker listener 不取得 runtime password。

## 不采用的方案

### 独立 Worker ingress sidecar

拒绝作为当前默认。它需要定义并保护第二套内部 wire protocol，增加每 Pod 的 Node
进程、RSS、socket、健康检查和 shutdown 顺序，而当前 modular-monolith 权限边界可由
对象 capability 与独立数据库角色完整表达。未来只有在独立扩缩容或强进程隔离有
实测收益时才重新评审。

### 给 `ql3_worker_ingress` 增加 Run mutation GRANT

拒绝。外部 Worker transport 被攻破时会直接获得控制面写权限，也绕过 runtime
recovery/fencing owner。数据库 ACL 与代码 entrypoint 都必须拒绝这条捷径。

### 为 Worker ingress 新拆 workspace package

拒绝。它与现有 cluster-control 共享部署、版本、依赖与生命周期；拆出单用途薄包会
回到 D-207 已拒绝的碎片化。当前仍为 20 个 workspace package。

### 在所有 Profile 启动时加载 S3

拒绝。Artifact provider 只属于启用的 Cluster Worker ingress。路由设备上的
Edge/Standalone 不应承担其模块、配置、credential chain 或空闲连接成本。

## 当前验证

1. cluster-control 全量 150 项为 148 pass、2 条外部服务条件 skip、0 fail；新增
   bootstrap/production/process/config 测试证明 capability port 不暴露 Pool、Worker
   lifecycle 幂等启停、缺 runtime port 失败关闭、Artifact binding 惰性创建与销毁；
2. cluster-postgres 全量 238 项为 237 pass、1 条真库条件 skip、0 fail；
   entrypoint 测试证明 Worker ingress 无 Secret/completion/lease mutation adapter；
3. deployment audit 无 findings，base/CloudNativePG 分离 runtime 与 Worker
   credential、CA、mTLS material，并只暴露 5800/5801 两个命名端口；
4. Linux arm64 Node 24.18.0 在 512 MiB、2 CPU、256 PID、零 swap、非 root、只读
   root/workspace 下通过：`memory.peak=41431040` bytes、模块加载 RSS 增量
   `24195072` bytes、零 OOM/oom_kill；
5. `QL3_HA_SKIP_IMAGE_PULL=true` 的 PostgreSQL 18.4 arm64 HA 门再次通过
   physical streaming、`remote_apply`、timeline 1→2、旧主 fencing、
   `pg_rewind` 只读同步重入、两个 fresh control replica 与全部领域 gate，总
   `passed=true`；
6. workspace 保持 20 包，没有新增 migration、表、生产依赖、timer、watcher、
   queue、sidecar 或内部 RPC。

## 尚未关闭

1. Cluster Secret material 的正式 provider 与 rotation/retention 产品入口；当前
   Secret-bearing Remote Worker task 继续失败关闭；
2. Remote Worker expiry/lost/retry 的 production lifecycle、部署启动装配与容量
   telemetry；
3. 真实 Kubernetes 多 Pod Worker Session replacement、网络分区、operator/proxy、
   STONITH、S3 outage/backpressure 与独立扩缩容证据。
