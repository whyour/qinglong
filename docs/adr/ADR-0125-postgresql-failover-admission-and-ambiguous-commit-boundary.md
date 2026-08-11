# ADR-0125：PostgreSQL Failover Admission 与不确定提交边界

- 状态：Proposed（PostgreSQL 18 六角色、可写主库 activation readiness、物理流复制、`remote_apply` 同步确认、专用复制链分区、fence-before-promote、timeline promotion、旧主 `pg_rewind`/新 slot/只读同步重入、稳定测试端点切换、双 control 进程摘流与双 fresh activation、Package manager/executor 晋升前后 readiness、scheduler claim-held promotion/expiry takeover、scheduler decision、Worker credential delivery v1/v2/v3/v4、Remote Worker completion、用户 cancellation intent 与 cancellation convergence 的 COMMIT-response-loss，以及通用写后 COMMIT 前/post-COMMIT 连接丢失窗口已验证；生产 operator/proxy TLS、基础设施 STONITH、真实 Pod 网络分区与 raw-wire packet-loss 待实现）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-06、D-34、D-41、D-45、D-53、D-57、D-104、D-106、D-123
- 关联 ADR：ADR-0039、ADR-0045、ADR-0053、ADR-0054、ADR-0105、ADR-0107、ADR-0124

## 背景

QingLong 3.0 已在本机 arm64 PostgreSQL 18.4 上完成 22 条 migration、capability v21、35 张表、六角色最小权限和两个独立 runtime pool 的 scheduler 竞争验证。`pg-0017` 把 Database/schema/table GRANT 从 CI/fixture 手工 SQL 收回 reviewed stream，并增加 role attribute/CONNECT readiness；ADR-0137 的 `pg-0018` 又加入 admin-only Plugin Package installation 三表和受审 Project lock function；ADR-0141 的 `pg-0019` 加入 admin-only ApprovalRequest/Approved Action dispatch 两表、digest 防漂移与受审 Policy fence function，`pg-0020` 再加入 admin-only Package admission receipt，`pg-0021` 增加 admin-only immutable Package proposal 与 Approved Action execution/start-barrier 两表及精确 FK/CHECK/ACL；ADR-0144 的 `pg-0022` 再把 Package proposal/management 与 execution/recovery 拆成 manager/executor 两个最小权限角色，均不扩大 runtime/worker authority。后续 `qinglong/postgresql-ha-contract@v1` 已增加真实物理流复制、`remote_apply` 同步确认、专用复制网络隔离、旧 primary 停止 fencing、standby timeline 1→2 promotion、旧主 `pg_rewind` 后以新 replication slot 只读同步重入、测试专用稳定单写端点切换、两个独立 control 进程的摘流与 fresh activation、Package manager/executor 晋升前后 readiness、持 schedule claim 跨 promotion 后按数据库 expiry 接管并 exact admission，以及 scheduler decision、Worker credential delivery v1/v2/v3/v4、Remote Worker completion、用户 cancellation intent 和 cancellation convergence 在 COMMIT-response-loss 后按耐久事实收敛。它证明了数据库 primary failover 基础链路和这些已提交领域事务的幂等恢复窗口，但测试端点与 promotion guard 不是生产 operator/proxy 或基础设施 STONITH，故障位于 PostgresClient/受控 Docker 网络边界而非 raw-wire packet-loss。

ADR-0147 已将上述历史基线推进为 24 条 migration、capability v23、37 张表，并在同一
physical HA fixture 中增加 manager-only durable quota 和 identity keyset ledger：
quota 双实例并发 16 个请求精确 8 allow/8 reject；keyset 双实例同代竞争、全新实例
旧代拒绝、同代 rewrite/隐式移除拒绝与 COMMIT response loss 均收敛。当前具体 HA
gate 为 24 个。

当前 cluster-control 在启动时先验证 schema/readiness、完成 recovery，再安装 HTTP admission；这一顺序是安全的。但激活后的 `/readyz` 只投影 admission 是否仍安装。`pg.Pool` 的空闲连接错误交给调用方 callback，而借出的 `PoolClient` 会移除 Pool 自己的 idle error listener，必须由借用方在整个持有期接管连接级 `error` 事件。两条路径都必须定义该错误如何撤销 admission、处理在途请求，以及数据库恢复后何时允许重新开放。否则旧主停机时，Pod 既可能继续向负载均衡报告 ready，也可能因 checked-out client 的未处理 EventEmitter error 直接退出。

主备切换还会产生不确定提交窗口：客户端可能在 COMMIT 已成功后才丢失响应。对 scheduler、credential delivery、completion 或 cancellation 做通用自动重试，会把“连接恢复”错误提升为重复副作用。

## 决策

### 1. 数据库 HA 由稳定写端点提供

常驻 runtime 与 worker-ingress 只接受一个受信、TLS 校验的稳定 read-write endpoint，例如 Kubernetes Service、PostgreSQL operator primary Service 或受审 proxy。QingLong 不在进程内实现主从选举、DNS 轮询、多 host 猜测或自建连接代理。

endpoint 必须只把新连接导向当前可写 primary。runtime、worker-ingress、admin 和 migration 继续使用独立 credential/Pool；admin/migration 不变成常驻 failover sidecar。runtime、admin 与 worker-ingress 的 activation readiness 必须先确认 `pg_is_in_recovery()=false` 且 `transaction_read_only=off`，否则以 `server_not_writable_primary` 失败关闭，再在目标 promotion generation 上验证现行 server version、migration history、capability、catalog 与精确权限。migration 的 DDL 仍由 PostgreSQL 在只读目标上原生拒绝；后续可增加同名显式 preflight，但不得因此创建第二套选主逻辑。

### 2. 活跃 admission 必须有单向 availability fence

cluster-control application 增加进程内、无 timer 的 availability fence：

`starting -> ready -> unavailable -> stopped`

- 只有 startup readiness、recovery 与 lifecycle 全部成功后才能进入 `ready`；
- active Pool idle error、连接类 SQLSTATE、read-only primary、schema/capability 漂移或显式 health probe 失败，必须幂等地从 `ready` 推进到 `unavailable`；
- 第一次推进必须立即让 `/readyz` 返回 503，在读取新 `/api/v3` body 前拒绝，并 Abort/有界 drain 已安装 admission；
- `/livez` 可以继续报告进程存活，供编排器区分“需要摘流/重启”与进程死亡；
- 多个 Pool/error callback 只能合并为一次撤销，不创建 per-error timer、队列或无界错误集合。

`unavailable` 不允许在原 activation 上只因下一次查询成功而自动回到 `ready`。重新开放必须新建 activation，重新执行 schema/role readiness、startup recovery、lifecycle start 与 admission install。首个实现可以选择让编排器重启 Pod；未来若支持进程内 reactivation，也必须经过完全相同的 gate。

worker-ingress 使用相同原则，但拥有独立 listener/admission fence。runtime 与 worker-ingress 任一关键数据库 authority 不可用时，部署层必须将对应 endpoint 摘流；不能让一个 Pool 的成功掩盖另一个 Pool 的失效。

### 3. Pool error callback 只报告，不得抛出或直接重试业务

`pg.Pool` 的 idle-client `error` callback 和 checked-out `PoolClient` 的连接级 `error` event 都是 availability signal，不是异常重抛点。每条新建物理连接必须安装一个覆盖其完整生命周期的 availability listener；client binding 仍在 acquire 后安装自己的有界 listener，并在 release 前只移除该 checkout listener，release 后由 Pool 恢复 idle listener。物理连接 listener 不随 checkout 切换而移除，用于覆盖旧主停机时“首个 error 已触发摘流、Pool 正在 drain、同一连接又发出后续 error”的窗口。生产组合必须把这些路径交给上述 fence 与低敏 diagnostic sink；listener/callback 内抛异常会绕过有序 drain，也不能证明事务是否提交。

普通 repository 查询仍保留当前有界 timeout 和领域错误映射。availability 分类至少覆盖 PostgreSQL connection exception class `08`、`57P01`、`57P02`、`57P03`、read-only transaction 与 endpoint identity/readiness 漂移；constraint、fence conflict 和合法业务拒绝不得误触发全 Pod 摘流。

### 4. 禁止通用透明事务重试

连接恢复只允许 Pool 为后续新操作建立新连接，不允许基础层自动重放未知事务。每个 mutation 继续依赖现有领域幂等键、版本 fence、immutable receipt 或数据库事实完成裁决：

- 明确在事务开始前失败，可以由上层按既有 bounded policy 重新发起；
- 事务内失败且 PostgreSQL 已确认 rollback，可以返回可重试的 unavailable；
- COMMIT 响应丢失属于 `outcome_unknown`，必须在新 activation/recovery 中读取 durable evidence，禁止原样盲重放外部副作用；
- scheduler 未提交的 claim 只由数据库时间 expiry takeover；已提交的 Run/idempotency key 决定 exact replay；
- credential delivery/discard、Worker completion 与 cancellation 使用各自 ledger/receipt/fence，不共享一个“重试所有 SQL”开关。

### 5. 发布证据必须拆开三类故障

不得把一种测试扩大为另一种结论：

1. **control replica failover**：同一 primary 上两个独立 Pool/进程竞争与 replica 退出；
2. **connection fail-closed**：backend terminate、endpoint 无路由、read-only 切换期间立即 not-ready、拒绝新 body、在途有界 drain；
3. **database primary failover**：真实 PostgreSQL 18 primary/standby promotion、稳定 endpoint 切换和新 activation recovery。

正式 HA 门禁至少使用两个 cluster-control 进程或 Pod，并在下列窗口注入故障：连接前、BEGIN 后首个写前、写后 COMMIT 前、COMMIT 响应丢失、claim 持有期间、Worker credential delivery v1/v2/v3/v4、Run completion 与 cancellation。每个场景必须记录 promotion generation、endpoint、旧/新 backend、恢复时间、HTTP readiness 时间线、Run/Event/ledger 数量与重复副作用为零的证据。

网络分区测试必须包含旧 primary 隔离和 fencing；仅停止一个容器再原地启动不构成 split-brain 证据。远端 CI 的 PostgreSQL 16/18 × x64/arm64 单节点矩阵继续保留，但不能替代这一 HA job。

### 6. 同步确认、分区、Promotion 与旧主重入

Cluster mutation 对客户端返回成功前，至少一个合格 standby 必须已应用对应 WAL；首个 production
contract 使用 `synchronous_commit=remote_apply` 和显式同步 standby。部署若选择异步复制，只能声明
非零 RPO，不能使用 QingLong 3.0 的零 acknowledged-write-loss HA 声明。单 standby 分区时，安全优先于
写可用性：mutation 会停在 `SyncRep`，调用方超时或连接终止后只能得到 outcome unknown。该事务可能
已存在于旧主本地 WAL，但在 promotion candidate 不存在；它既不是已确认成功，也不能被错误宣称
rollback，必须在新 generation 读取耐久事实后裁决。

promotion 必须严格晚于可验证的旧主 fencing。QingLong 内部不执行 STONITH；生产 operator/proxy 必须
证明旧主不再可写，再暴露新 primary endpoint。测试 guard 只能证明应用门禁顺序，不能替代节点电源、
存储或网络层 fencing。

每个 promoted generation 必须重新应用并复验同步策略，因为 `ALTER SYSTEM` 的
`postgresql.auto.conf` 不是 WAL 复制事实。旧主重入固定为：

1. promoted primary 创建新的物理 replication slot；
2. 保留足够 WAL，或从受审 archive 恢复 rewind 所需 segment；
3. 对已停止旧主执行 `pg_rewind --write-recovery-conf`；
4. recovery connection 改回专用 replication role 和新 slot，不复用 rewind superuser；
5. 证明旧主 `pg_is_in_recovery=true`、receiver streaming，且新主将其标为 `sync`；
6. 证明分叉期仅存在旧主的未确认事务已消失，并完成一次 post-rejoin `remote_apply` marker；
7. 以上全部成立后，稳定 endpoint 与 fresh control activation 才可开放。

fixture 的 `wal_keep_size=128MB` 只是当前有界测试工作集，不是生产容量默认值。生产保留量必须按最大
分区时长、写入速率、checkpoint 和 archive RTO 计算；WAL 不足时只能执行新的 base backup，不能把
rewind 失败的旧主直接启动。

### 7. 资源与部署边界

本决策不影响 edge/standalone：它们继续使用单 SQLite authority。cluster-control 不新增 workspace package、常驻 sidecar、watcher 或 per-Run timer。稳定 endpoint/proxy/operator 属于集群部署依赖，必须单独记录资源、版本、TLS 和故障域，不能计入路由器 Profile。

## 拒绝的方案

- `pg.Pool` 报错后仍保持 ready，等每个 handler 自行 503：拒绝，因为负载均衡会持续发送新流量并放大故障。
- callback 内直接 `throw`：拒绝，因为绕过 admission drain，且无法裁决不确定提交。
- 查询成功一次就原地恢复 ready：拒绝，因为没有重跑 schema/role readiness 和 startup recovery。
- 所有连接错误统一重试事务：拒绝，因为 COMMIT response loss 会导致重复 mutation 或外部副作用。
- 应用内自建多 host 选主：拒绝，因为复制数据库 operator/proxy 的职责，难以证明 split-brain fencing。
- 用双 Pool row-lease 测试宣称 PostgreSQL HA：拒绝，因为没有 primary promotion 或 endpoint 切换。

## 当前证据

- 本机 `postgres:18` 为 PostgreSQL 18.4、arm64，镜像摘要 `sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a`；22 条 migration、capability v21、35 张表。`pg-0017` 先复验四个非特权 LOGIN role，再由 migration stream 安装精确 Database/schema/table GRANT；`pg-0018` 只为 admin 安装 Plugin Package 三表及单用途 Project lock function；`pg-0019` 只为 admin 安装 ApprovalRequest/dispatch 两表及 Policy fence function；`pg-0020` 只为 admin 安装 Package admission receipt；`pg-0021` 只为 admin 安装 immutable Package proposal 与 Approved Action execution/start-barrier 两表；`pg-0022` 再把 Package proposal/management 与 execution/recovery 分离为 manager/executor 两个非特权 LOGIN role，HA fixture 不复制手工 GRANT。
- ADR-0147 的当前增量为 24 条 migration、capability v23、37 张表；`pg-0023`
  给 manager 安装 durable management quota，`pg-0024` 增加单行 keyset ledger，
  其他五角色不扩权。
- cluster-postgres 六角色真库 integration 31 pass、1 个同角色 backend termination 条件 skip、0 fail；cluster-control PostgreSQL integration 6/6、0 skip。
- 两个独立 runtime pool 的 backend PID 不同；初始化与同一 occurrence 各只有一个赢家，持 claim 的 pool 关闭并强制数据库时间过期后由另一 owner 收敛。
- 当前审计同时发现并修正 capability v15 后 CI admin/worker-ingress GRANT 漂移，以及 Worker listener 的旧 capability 魔法数字/缺失 versioned register schema。
- cluster-control 已实现单 listener、无 timer/重试/历史队列的 one-way availability fence；生产入口从同一 enabled config 原子创建 runtime Pool 与 fence，禁止部署侧分别装配而发生错配。
- fake HTTP/Pool 路径已证明 ready→unavailable、并发/早期 signal 合并、body 前 503、`/readyz` 503、`/livez` 200 和 stop 幂等；2026-07-24 cluster-control 全量测试 141 项中 139 pass、2 个外部服务条件 skip、0 fail。
- 本机 PostgreSQL 18.4 已用 migration superuser 执行 `pg_terminate_backend` 终止 production runtime Pool 的唯一 idle backend；真实 `pg.Pool` error 触发摘流，cluster-control integration 6/6、0 skip。
- PostgreSQL adapter 对 query、transaction client acquire/query、checked-out client connection event、物理连接生命周期和 idle Pool 五条路径统一报告 availability；查询路径只接受 SQLSTATE class 08、`25006`、`57P01`–`57P04` 与明确网络错误。唯一键、serialization/deadlock、lock timeout 和 statement cancellation 保留原异常但不触发整 Pod fence。2026-07-25 HA 重跑暴露出更窄的双 error 竞态：第一个 `57P01` 已触发 availability drain 后，同一物理连接在 checkout listener 移除与 Pool teardown 期间又发出 error，导致旧 control 进程退出。连接级 lifetime listener 修复后，cluster-postgres 全量测试为 132 pass、1 个真库条件 skip、0 fail，cluster-admin 为 74 pass、1 个 Kubernetes 条件 skip、0 fail，完整物理 HA 门重新通过。
- runtime、admin 与 worker-ingress readiness 的首个 server observation 现在同时读取 `pg_is_in_recovery()` 与 `transaction_read_only`；standby 和 read-only transaction 均在 migration history、catalog、role capability 与 application assembly 前以 `server_not_writable_primary` 拒绝。package/legacy parity 的正向报告固定包含 `writablePrimary:true`，并有两个独立负向门禁。
- 旧 activation 摘流后不会原地恢复；测试显式停止旧 application，再以同一稳定配置创建全新 production activation。新实例重新通过 schema/role readiness、startup recovery 与 lifecycle gate，以不同 backend PID 返回 ready。
- `pnpm test:postgres-ha:ql3` 使用 `postgres:18`（repo digest `sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a`）创建两个独立数据卷、primary/standby 管理网络和专用复制网络。初始 standby 必须同时满足 recovery/streaming/sync；`remote_apply` marker 返回前必须已在 standby 可见。
- PostgreSQL 18 镜像声明的 volume root 是 `/var/lib/postgresql`，而实际 `PGDATA` 是
  `/var/lib/postgresql/18/docker`；fixture 必须把 primary/standby 具名卷挂到前者，并
  显式把后者作为 `PGDATA`，不能只挂子目录而让 Docker 为父级再创建匿名卷。所有临时
  container 以 `rm -v` 回收，但具名卷仍由 exact name 单独删除。2026-08-04 no-start
  `docker create` smoke 的实际 Mounts 只有预期具名卷，专用 smoke container/volume
  随后均已删除。释放 Docker overlay 并补齐空 standby `PGDATA` 创建后，完整 promotion
  门在 18.4 arm64 上退出 0：timeline 1→2、`remote_apply`、旧主 fence/rewind/只读同步
  重入、双 fresh control 及总 `gates.passed=true`；fail-close 325.582 ms、fresh
  activation 456.102 ms、rewind 1,831.809 ms。运行前后 Docker volume 总数保持 913，
  `ql3-ha-*` container/volume/network 零残留，受保护 control-plane 未被操作。
- fixture 摘除旧 primary 的复制接口并终止唯一既有 walsender，保留客户端通道。Docker 拓扑确认复制网络只剩 standby，旧主 `pg_stat_replication` 为 0；test-only promotion guard 在旧主仍 writable 时明确拒绝。分区后的 `remote_apply` COMMIT 被确认卡在 `SyncRep`，最近一次证据在 1,510.482 ms 后模拟客户端超时并终止专用 backend；该行只存在旧主本地，promotion candidate 为 0，调用方从未得到成功。
- 门禁随后停止旧 primary 并确认容器为 exited，再等待两个 generation-1 control 子进程均 unavailable、`/readyz` 503 且 `/livez` 200；standby timeline 1→2 promotion 后，分区期未确认 marker 仍为 0。新 primary generation 重新应用同步配置并创建新物理 slot；测试以 `wal_keep_size=128MB` 保留分叉 WAL，`pg_rewind --write-recovery-conf` 退出 0，旧主使用专用 `ql3_replicator` 和新 slot 以 `inRecovery=true`、streaming、sync 重入。一次 post-rejoin `remote_apply` marker 在旧主可见，分叉 marker 为 0；稳定端点此后才切换。
- 两个 generation-2 control 子进程通过同一稳定地址重新完成包含可写主库与当前 role capability observation 的 readiness/recovery/lifecycle；2026-07-29 最近一次本机 arm64 PostgreSQL 18.4（repo digest `sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a`）证据为 fail-closed 263.784 ms、双 fresh activation 412.927 ms，旧主 `pg_rewind` 11,127.484 ms。完整报告的 35 个具体 gate 与总 `passed` 均为 true，其中包含晋升前后 Package manager/executor authority readiness、AI schema、Package quarantine/trust、Tool snapshot/artifact/result key 和全部既有 COMMIT-response-loss contract；切换前后 marker 各 1，领域 fixture 合计 5 Run、13 Event，credential delivery 为 4 条连续状态，unexpected domain side effect 为 0。
- scheduler claim-held 窗口已加入同一物理 promotion 门禁：primary 以数据库时间 `1785289093833` 取得 15 秒 claim，并在 standby 复验 owner/token/version/next-fire 的 WAL replay；旧主 fencing 前 claim 仍剩 14,589 ms 且 occurrence Run 数为 0。promotion 时间为 `1785289096600`，fresh control 在 claim expiry `1785289108833` 之后的 `1785289109305` 才完成 admission；claim version 1→2 后清空，同一 scheduled time 最终严格为 1 queued Run、1 claimed remote-worker Attempt、2 Event、0 duplicate。
- scheduler decision COMMIT-response-loss 已加入同一物理 promotion 门禁：真实 `ClusterSchedulerCoordinator` 经独立 runtime Pool 进入到期 decision transaction；driver 确认 `COMMIT` 后，fixture 终止该 backend 并让上层观察 `ECONNRESET`。standby 在 promotion 前已通过 WAL 看到完整 1 Run/1 Attempt/2 Event 与 claim 清空，promotion 后 fresh control 没有重放 occurrence，最终 0 duplicate。故障范围是“driver-confirmed COMMIT + backend self-termination + PostgresClient 边界失败”，不是 raw-wire packet-loss。
- Worker credential delivery v1/v2/v3/v4 COMMIT-response-loss 已加入同一物理 promotion 门禁，并使用独立最小权限 `ql3_admin` 与 `ql3_worker_ingress` Pool。standby 在 promotion 前依次看到 `[1]`、`[1,2]`、`[1,2,3]`、`[1,2,3,4]`；promotion 后仍只有 4 条连续 ledger、3 条 credential history、3 条 mutation/audit，stage/publish/entropy 各 1 次，旧 credential 为 `active → revoked`，恢复候选为 0，领域行不含原始 `ql3w` token。四个 fixture 均在 driver 确认 `COMMIT` 后终止 transaction backend 并让调用方观察失败，故障范围仍是 PostgresClient 边界，不是 raw-wire packet-loss 或生产 Secret provider 故障。
- Remote Worker completion COMMIT-response-loss 已加入同一物理 promotion 门禁：fixture 从 durable `starting` authority 在一个 runtime-role transaction 中完成 Lease、Attempt、Run 与双 Event，driver 确认 `COMMIT` 后终止 transaction backend，首次调用得到 `REMOTE_WORKER_COMPLETION_UNAVAILABLE`。健康连接以同一 fence/receipt/Event identity 重放得到 `already_completed`；standby 在 promotion 前已看到 `succeeded` Run/Attempt、`completed` Lease version 5 和 2 条不同 dedupe key 的 Event，timeline 1→2 promotion 后仍为 2 条，duplicate 为 0。
- 用户 cancellation intent 与 cancellation convergence 各自拥有独立 COMMIT-response-loss fixture。意图事务提交 Project/RoleBinding-fenced `run.cancel_requested` 后调用方收到 unavailable，同一 mutation 重放为 `already_requested`；收敛事务再原子提交 claimed Attempt 与 queued Run 的 `cancelled` 终态和两条 reconciler Event，调用方收到 convergence unavailable。健康重放扫描 0 条；standby 在 promotion 前及 promoted primary 上均严格保持 `run.cancel_requested → attempt.cancelled → run.cancelled`、Run version 4/event sequence 3、3 个不同 dedupe key，duplicate 为 0。
- 该场景同时暴露并修复 startup recovery 与 dispatcher authority 的冲突：正常 scheduler admission 会留下 queued Run + claimed `remote_worker` Attempt。recovery source 现在只排除仍为最新、未取消、未拥有 worker/lease/offer/callback/start/result/error 状态的精确 pristine dispatch candidate；任何漂移仍进入恢复候选并 fail closed。否则 fresh activation 会把正常待分发工作误判为人工恢复并拒绝启动。
- 通用事务窗口已加入同一物理 promotion 门禁：客户端先完成 `COMMIT`，再通过 backend 自终止让整个外层操作观察失败，promotion 后 marker 恰好为 1，证明必须读取耐久事实且禁止透明重放；另一个事务在写入后、COMMIT 前停止旧 primary，客户端 COMMIT 失败且 promotion 后 marker 为 0。这两者只证明 PostgreSQL 事务基线，不替代 completion 或 cancellation 各自的领域幂等/receipt/fence 矩阵。
- GitHub Actions 增加独立 PostgreSQL 18 x64/arm64 physical-promotion job；它不与单节点 PostgreSQL 16/18 四角色矩阵混算。
- 尚未证明生产 operator/proxy 的 TLS/健康路由、节点/存储级 STONITH、真实 Pod 网络分区与 split-brain fencing、raw-wire packet-loss。受控 Docker 复制链分区、fence-before-promote、同步 RPO 裁决、旧主 rewind/rejoin，以及 PostgresClient 边界的 scheduler decision、credential delivery v1/v2/v3/v4、completion、cancellation intent/convergence COMMIT-response-loss 已完成；这些不等价于生产 operator 认证或所有 mutation 的逐 statement fault matrix。

## 实施顺序

1. **已完成**：在 cluster-control 定义一次性 availability fence 与 admission disposer ownership，Pool callback 只提交 signal，生产配置绑定不暴露 callback 拼装缝隙；
2. **已完成**：用 fake Pool/HTTP 测试证明 ready→unavailable、body 前拒绝、早期/并发 signal 合并和 stop 幂等；
3. **已完成**：PostgreSQL 18 idle/active `pg_terminate_backend` 已证明真实 Pool/query error 摘流；runtime/admin/worker-ingress activation readiness 已在 schema 检查前拒绝 standby/read-only 目标；旧 activation 停止后 fresh production activation 已重新跑完整 gate 并以新 backend ready；通用写后 COMMIT 前回滚与 post-COMMIT 连接丢失后的耐久检查、scheduler claim-held promotion，以及 PostgresClient 边界的 decision、credential v1/v2/v3/v4、completion、cancellation intent/convergence COMMIT-response-loss 已验证；
4. **已完成（测试级）**：primary/standby fixture 已以两个真实 control 进程完成物理 streaming、`remote_apply`、专用复制链分区、未确认事务裁决、fence-before-promote、timeline promotion、新 generation 同步策略重放、新 slot、旧主 rewind/read-only sync rejoin、endpoint switch、双 fresh activation、scheduler expiry takeover，以及已提交 decision、credential ledger、completion 与 cancellation 的 exact convergence；
5. **未完成（生产级）**：使用真实 PostgreSQL operator/proxy、TLS endpoint、Pod/节点网络分区和基础设施 STONITH 重跑同一不变量，并增加 raw-wire PostgreSQL response-loss；
6. 记录恢复时间、重复率、未决事务裁决、连接池/RSS 和日志，达标后再把本 ADR 提升为 Accepted。
