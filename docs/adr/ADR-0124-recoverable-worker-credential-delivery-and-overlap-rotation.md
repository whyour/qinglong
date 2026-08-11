# ADR-0124：可恢复的 Worker Credential 交付确认与重叠轮换

- 状态：Proposed（共享 contract、协调器、PostgreSQL v1/v2/v3/v4 delivery ledger、capability v15 discard tombstone、有界恢复、PostgreSQL 16/18 四角色、PostgreSQL 18 physical promotion 下 v1/v2/v3/v4 COMMIT-response-loss、受控复制链分区与旧主 rewind/rejoin、POSIX adapter 与 Kubernetes resourceVersion CAS adapter/单 API server RBAC 证据已实现；生产 operator/proxy TLS、基础设施 STONITH、真实 Pod/raw-wire 分区与管理产品入口尚未完成）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-23、D-59、D-60、D-121、D-122
- 关联 ADR：ADR-0050、ADR-0058、ADR-0060、ADR-0061、ADR-0122、ADR-0123

## 背景

Cluster Admin 已能在 PostgreSQL 中原子写入 Worker credential、mutation 与 security audit，并且只在新建
mutation 时返回一次 `ql3w` token。精确重放返回 `token: null`，数据库也只保存 HMAC digest。这个边界避免
服务端长期保存 bearer secret，但还不能直接成为生产部署 ceremony：

1. 数据库提交成功后、token 发布到 Worker Secret 前崩溃，会留下无法从数据库恢复的有效 credential；
2. 对同一 credential ID 执行 `rotate` 会立即令旧 version 失效，发布失败会同时失去旧、新两个可用 token；
3. “Secret 已写入部署系统”不等于 Worker 已实际使用新 credential 完成认证；
4. 401/403 后由 Worker 自助签发会绕过管理 Policy、强认证、audit 与 version fence。

因此，生产轮换必须把一次性 secret 的暂存、数据库事实、部署发布、Worker 观察确认和旧 credential 撤销组成
可恢复状态机。现有一次性签发 service 继续作为短生命周期低层 authority，但不得直接暴露为远程产品入口。

## 决策

### 1. 产品轮换使用新 credential ID 和重叠有效期

生产 issue/recovery 每次创建新的 credential ID；不得用同 ID 的新 version 原地替换正在工作的 token。
旧 credential 在以下两个事实都耐久成立前保持 active：

- deployment adapter 已确认 exact mutation/token generation 原子发布；
- Cluster ingress 已用新 credential ID/version 认证同一 Worker，并在 Session heartbeat/transition 事务中写入
  credential observation acknowledgement。

确认后才能以独立 mutation 撤销旧 credential。确认超时只告警和停止收敛，不得提前撤销旧 credential，
也不得让 Worker 自动创建新 Session。新 credential 可在受限 overlap 窗口内与旧 credential 并存；同一
Worker 可以持有多个 credential ID，但每个 ID 仍只有一个当前 version。

### 2. Secret 必须先耐久 stage，再提交 credential

`@qinglong/cluster-admin` 定义 delivery port，不新增 package。生产 coordinator 的顺序固定为：

1. 生成 token，并以 mutation ID、credential ID、Worker ID、token digest 和目标 generation 调用
   `stage`；adapter 必须 no-replace、私有/加密、有界并可在进程重启后按 mutation ID 恢复；
2. 在 PostgreSQL 中原子 append credential、mutation 与 allowed audit；
3. 调用 adapter 将 exact staged generation 原子发布到部署目标；
4. 写入 delivery-published acknowledgement；
5. 等待同一 Worker Session 事务写入 authenticated observation acknowledgement；
6. 两类 acknowledgement 都成立后，提交旧 credential revoke mutation。

token 只能在 stage/publish adapter 的受限 secret boundary 内出现；命令 JSON、HTTP response、Session wire、
日志、metric、audit 与 PostgreSQL 行都不得包含 token。adapter 必须复制需要保留的 bytes，调用方在 stage
返回后立即清零自己的 Buffer。

### 3. PostgreSQL ledger 只保存低敏恢复事实

新增 append-only delivery ledger，至少绑定：

- mutation ID、new/previous credential ID、new credential version、Worker ID；
- staged token digest、deployment target digest 和 generation；
- `staged`、`credential_committed`、`published`、`observed`、`previous_revoked` 各阶段的时间与 fence；
- 发布 acknowledgement、认证 observation 的主体/Session/version 摘要；
- recovery attempt 的低基数结果和 security audit event ID。

ledger 不保存 token、私钥、证书、Authorization header、Session lease token 或 deployment provider
credential。阶段推进使用 expected-state/version CAS；同 mutation 的 exact replay 返回已有低敏状态，语义漂移
或同 generation 不同 digest 一律 fail closed。

### 4. Recovery 是显式、无 timer、可分页的短生命周期操作

恢复器由受审管理 CLI/API、部署 controller reconcile 或运维命令显式驱动，不在 Worker/Cluster control
常驻进程新增 timer。每次只处理有界页，并按事实执行：

- 只有 staged、数据库无 mutation：先提交数据库 cleanup authorization，再清除 staged secret；
- credential 已提交但未发布：从 exact staged record 重试发布；
- 已发布但未 observed：保留新旧 credential，等待 Session cadence 或发出告警；
- 已 observed 但旧 credential active：提交独立、可重放的 revoke；
- digest、target、Worker、Session 或 version 漂移：进入人工审查，不自动覆盖 Secret 或撤销旧 credential。

数据库结果不确定时不得删除 staged secret；部署发布结果不确定时必须 inspect exact generation 后再裁决，
不得盲目重写。所有清理都要求 ledger 终态和最小保留期。

#### 4.1 全局 orphan 清理采用数据库 tombstone，不以单次 absence 作为删除证明

部署目录的有界扫描只能发现候选 stage，不能直接授予删除权限。`resolveDelivered(deliveryId) = null`
与一个尚未提交完成的 issuer 可以同时成立；扫描器若据此删除，会让随后成功的 credential commit 永久失去
对应 token。因此 capability v15 新增 append-only cleanup ledger，并遵守同一 `deliveryId` 上的
单赢家协议：

1. cleanup coordinator 读取并规范化低敏 stage intent；
2. PostgreSQL 事务获取 `ql3-worker-credential-delivery:<deliveryId>` advisory transaction lock；
3. 在同一事务内重新检查 mutation、delivery 与既有 cleanup 记录；只有前两者均不存在时，才插入绑定
   delivery ID、Worker、credential、token digest、target digest、generation 与数据库时间的 v1
   `discard_authorized` tombstone；
4. `commitDelivered` 在插入 credential/mutation/delivery 之前获取同一把 delivery lock，并在 tombstone
   已存在时 fail closed；由此数据库 commit 与 orphan cleanup 只能有一个赢家；
5. coordinator 只有拿到 exact committed authorization 后，才调用 adapter 的 exact `discard`；删除成功或
   已证明文件不存在后，再以 expected-version CAS 追加 v2 `discarded`；
6. authorization 响应丢失时从 ledger 精确恢复，discard 响应丢失时用 adapter `inspect` 重放；任何 intent
   语义漂移、数据库不可用、锁结果不确定或未知目录项都进入人工审查。

tombstone 一旦写入不得撤销或复用该 delivery ID。全局恢复分别分页读取 deployment stage inventory 与未完成
cleanup ledger，不引入常驻 timer。POSIX adapter 仍只承担受控单写者文件语义；Kubernetes 多 Pod 由独立
resourceVersion CAS adapter 提供部署侧并发协议，并必须再通过真实 API server/RBAC 故障矩阵才能成为生产证明。

### 5. 认证观察复用现有 Session，不增加 Worker authority

Cluster authenticator 已产生 `credentialId`、`credentialVersion` 和 `authenticationId`。Session heartbeat 或
transition 在验证 Worker/Session/version fence 后，将这一低敏 principal identity 与 delivery ledger 关联；
不增加新的 Worker 写路由，也不接受 Worker 自报 credential ID/version。新 token 被部署后，现有
`WorkerProductionCredentialProvider` 在下一次请求读取它，coordinator 在同一 Session 上恢复 heartbeat。

401/403 只暂停 Pull 并触发外部运维信号；Worker 不能调用 issue/recover/revoke。409 继续按 Session fencing
处理，不能被 credential recovery 掩盖。

## 被否决的替代方案

1. **数据库提交后再直接写 Secret**：保留不可恢复的 commit-to-publish 崩溃窗口。
2. **同 credential ID 原地 rotate**：交付确认前旧 token 已失效，容易把 Worker 永久锁出。
3. **数据库保存可解密 token**：扩大 cluster 数据库泄露面，并混合 credential authority 与 delivery authority。
4. **只以 Secret provider 的写成功作为完成**：无法证明 Worker 实际读取并通过新 credential 认证。
5. **Worker 收到 401 后自动签发**：绕过管理权限、强认证、审计、审批与撤销策略。
6. **为每个 Worker 增加续期 timer/watcher**：放大路由设备常驻成本，并与 D-121 单 cadence 冲突。

## 实现 Gate

1. 定义 exact delivery port、低敏 ledger contract、错误分类和 crash matrix；实现进程内 fake adapter 测试。
2. 增加 PostgreSQL migration/repository，验证双连接 CAS、事务重试、commit response loss 和有界 recovery page。
3. 在 Session heartbeat/transition 同事务写 authenticated observation，验证 credential/Worker/Session/version 漂移。
4. 至少实现一个真实部署 adapter，并证明 no-replace、inspect-before-retry、原子发布、权限与容量上限。
5. 覆盖 stage 前后、DB commit 前后、publish 前后、observation 前后和 revoke 前后的进程终止矩阵。
6. 验证低配 Edge 不新增 timer/socket/数据库，Cluster Worker 只复用现有 Session cadence 与 mTLS Agent。
7. 完成 Gate 前保持 `Proposed`，不得把低层一次性 token 返回接口暴露为常驻远程管理 API。

## 当前实现证据

1. `@qinglong/runtime-core/worker-credential-delivery` 已定义 exact `DeliveryIntent`、append-only
   `DeliveryRecord`、credential commit/publication command、错误分类与 repository port。intent 不携带
   `credential_committed` 假事实；record 强制 v1 committed → v2 published → v3 observed → v4
   previous-revoked 的连续证据和时间单调性；discard contract 另以 exact stage intent 绑定 v1
   `discard_authorized` → v2 `discarded`，不把单次文件 absence 当作删除权限。
2. `@qinglong/cluster-admin/worker-credential-delivery` 已实现无 timer 的 stage-before-commit coordinator：
   复用既有强 Principal、HMAC、credential mutation/audit service，禁止构造一次性返回 token；token Buffer
   在 adapter 返回后清零。覆盖正常发布、publish failure、publication ledger 响应丢失、孤儿 stage 清理、
   raw mutation/missing stage/语义漂移 fail-closed 与同 ID rotation 拒绝。
3. `pg-0015-worker-credential-delivery-ledger` 将 `control-core` 推进到 capability v14，新增一张 append-only
   `worker_credential_deliveries` 表；admin 与 worker-ingress 仅获 select/insert，runtime 零权限。Drizzle、
   schema contract、冻结 checksum、readiness 和四角色权限保持一致。
4. `PostgresWorkerCredentialAdministrationRepository.commitDelivered()` 在同一 SERIALIZABLE transaction 中
   写 audit、credential、mutation 与 delivery v1；`markPublished()` 只 append v2。读取会验证完整 v1→vN
   连续历史、不可变字段和累计证据，覆盖 COMMIT response loss、publication replay、gap 与历史改写。
5. Worker Ingress pipeline 只把 authenticator 产生的 Worker/credential identity 交给
   `AuthenticatedWorkerSessionRepository`，不接受 Worker body 自报 delivery 或 credential。PostgreSQL
   heartbeat/transition 在更新 Session 的同一 transaction 中读取并验证 append-only credential delivery 历史：v2 published
   才 append v3 observed；v1 未发布会回滚 Session 更新，v3/v4 精确重放不重复写，非 delivery legacy
   credential 保持兼容。按 credential lookup 的 partial unique/indexed path 已纳入同一 reviewed migration。
6. `listRecoveryPage()` 使用 PostgreSQL statement observation、delivery ID keyset cursor、64 条硬上限，
   只返回 v1 committed、v2 published 与携带 previous credential 的 v3 observed；v4 和无需撤销的 v3 不再
   占用恢复页。`WorkerCredentialDeliveryRecoveryService` 是显式、无 timer 的短生命周期协调器：v1 复核
   exact stage 后发布并 append v2，v2 等待认证观察，v3 用 delivery ID 派生的 domain-separated mutation
   原子提交旧 credential v2 revoke、audit、mutation 与 delivery v4。所有时间取自恢复页的 PostgreSQL
   observation，不使用管理节点本地时钟；响应丢失通过确定性 mutation 与终态移出恢复页收敛。
7. PostgreSQL 16 临时真库已用独立最小权限 `ql3_admin` 与 `ql3_worker_ingress` Pool 贯通 v1 commit、v2
   publication、Session heartbeat 同事务 v3 observation、恢复页与 v4 revoke，并在 v4 的 COMMIT 已成功但响应
   丢失后精确收敛；21 项 integration 中 20 pass，只有未配置独立 runtime URL 的既有测试 skip。该测试同时
   揭示并修复了 worker-ingress 对 append-only delivery ledger 使用 `FOR UPDATE`、与既定 `SELECT+INSERT`
   权限冲突的问题；现由既有 Worker Session 行锁串行化 observation，不扩大 ingress 权限。
8. `@qinglong/cluster-admin/worker-credential-file-delivery` 在既有 package 内提供首个真实 POSIX adapter，未新增
   package、依赖、timer、socket 或数据库。adapter 绑定 stage/target 目录 owner、mode、device 与 inode；stage
   采用单一 bounded 私有文件、`O_NOFOLLOW`、fsync 与 hard-link no-replace，target 使用 previous credential ID
   fence、durable operation lock、`0600` 临时文件、rename 原子替换、目录 fsync 与发布后重读。publication digest
   绑定 delivery、credential、generation、target 与 token digest，响应丢失可由目标文件精确重放。stage root
   最多 128 项，keyset page 最多 64 项且只返回低敏 intent；不确定临时文件、未知条目、权限/目录身份漂移、
   非预期目标代际与锁竞争均 fail closed。该 adapter 已与 stage-before-commit issuer 贯通，Worker token 文件
   与现有请求时惰性 credential provider 格式兼容。
9. `pg-0016-worker-credential-stage-discard-ledger` 将 `control-core` 推进到 capability v15，新增无 delivery FK
   的 append-only `worker_credential_stage_discards`：admin 只有 `SELECT+INSERT`，runtime 与 worker-ingress
   零权限。authorization 与 credential commit 对同一 delivery ID 复用 advisory transaction lock；前者在
   同一 SERIALIZABLE transaction 内重查 mutation/delivery 并追加数据库计时 tombstone，后者在写入前重查
   tombstone，因此只能有一个赢家。短生命周期 cleanup service 分别有界分页扫描 deployment inventory 与
   未完成授权，只有 exact authorization 才 discard，随后追加 v2；响应丢失通过 ledger/inspect 收敛，语义
   漂移 fail closed。PostgreSQL 16 两个独立 admin Pool 的真实竞态已证明 commit/discard 恰有一个赢家，并
   验证赢家重放和永久 fence。
10. `@qinglong/cluster-admin/worker-credential-kubernetes-delivery` 在既有 package 内实现多写者部署 adapter；
   ADR-0239 又把 target digest v2 扩展为绑定 cluster identity、namespace、Secret name/data key 与 exact
   Recreate Deployment。每个 delivery 使用 deterministic name 的 immutable Secret；目标 Secret create/replace
   必须回传 GET 的 opaque `resourceVersion`，随后 Deployment 也以独立 GET `resourceVersion` 推进 PodTemplate。
   409 只在
   重读结果与 delivery/generation/token digest 完全一致时视为响应丢失重放，否则 conflict；discard 使用
   UID + resourceVersion delete precondition，并在 404 后重读 absence。inventory 单次最多读取 129 条、超过
   128 或出现 Kubernetes continue token 即 fail closed，再转换为领域 delivery ID keyset/64 条页；无 watcher、
   timer、cache 或新 package。fake API 双 rotation 竞态先证明同一 resourceVersion 只有一个赢家；随后固定
   `rancher/k3s:v1.34.3-k3s1`（arm64，digest `sha256:71abd3a56f57884c62732e0e0d87606052cb5f8555b7db7e8e33c04570b8175c`）
   的真实 API server 使用 10 分钟专用 ServiceAccount 重跑通过。RBAC 仅允许 Secret get/list/create/update/delete，
   明确拒绝 watch/patch 与 ConfigMap get；官方 client 实际完成双 rotation 单赢家与带 UID/resourceVersion 的
   orphan delete。HA control-plane failover、list compaction 与多 namespace 隔离仍待验证。client 精确固定 1.4.0，其历史依赖通过根
   override 收敛到 `form-data@4.0.6` 与 `js-yaml@4.3.0`，QL3 production vulnerability audit 为零 high/critical。
11. 当前验证：runtime-core 161/161、Cluster Admin 默认 37 tests 中 36 pass/1 real-API skip，且上述 real-API
   integration 显式启用后 1/1 pass；ADR-0239 后 fake adapter 定向 8/8，并在真实 K3s CoreV1/AppsV1 API
   完成双 Secret/Deployment CAS 与 Recreate/PVC Gate。Cluster PostgreSQL 105 tests 中 104 pass/1 external
   skip、Cluster Control 131 tests 中 129 pass/2 external skip；全量 23-package build/test、cluster dependency、
   Edge import 与六种 Profile artifact audit 均通过。当前 workspace 为 21 importer；最大常驻 application 为 2502983 bytes、413 files、
   72 loaded modules、12435456 bytes 单次 RSS delta，仍低于 4 MiB/512 files/16 MiB 门禁。本机 arm64 PostgreSQL 18 四角色 integration 23/23、cluster-control 6/6 已通过，并修正 CI 中随 v15 漂移的 admin/worker-ingress 最小 GRANT；前者补充 active query 连接失效的精确 availability 分类，后者以真实 idle backend terminate 验证 active admission 摘流；真实多 Pod credential/Session replacement 并发矩阵、stale lock/temp 显式修复、Kubernetes HA
   control-plane/failover、管理产品入口和固定物理设备证据仍是 Gate；不能把单 k3s API server 的
   resourceVersion 竞态或 PostgreSQL 单赢家结论扩大为生产多控制面发布证明。
12. `pnpm test:postgres-ha:ql3` 已在 `postgres:18`（18.4、arm64）两个独立数据卷和物理 replication slot
    上完成 credential delivery 的 v1 credential commit、v2 publication ledger、v3 authenticated Session
    observation 与 v4 previous credential revoke 四个独立 COMMIT-response-loss 窗口。每次都在 driver
    确认 `COMMIT` 后终止该 transaction backend，使调用方看到 unavailable/`ECONNRESET`，并在 promotion
    前从 standby 依次复验 `[1]`、`[1,2]`、`[1,2,3]`、`[1,2,3,4]`。timeline 1→2 promotion 后仍只有
    4 条连续 ledger、3 条 credential history、3 条 mutation/audit；stage、publish 与 entropy 各只发生
    1 次，旧 credential 精确为 `active → revoked`，恢复页为空，PostgreSQL 相关领域行不含 `ql3w` token。
    该故障注入位于 PostgresClient 边界，不代表 raw-wire packet-loss、网络分区或生产 Secret provider
    的响应丢失证明。
