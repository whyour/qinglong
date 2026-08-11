# ADR-0117：流式 Remote Worker Artifact 与原子 Completion

- 状态：Accepted（S3-compatible 共享对象存储已由 ADR-0120 实现，生产执行面装配已由 ADR-0121 实现；retention 与完整 Worker 产品生命周期仍默认关闭）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-14、D-17、D-24、D-26、D-68、D-85、D-108、D-111、D-114、D-115、D-116
- 关联 ADR：ADR-0024、ADR-0058、ADR-0109、ADR-0112、ADR-0115、ADR-0116

## 背景

ADR-0116 固定了 Worker 的 upload-before-completion 顺序，但中央侧仍只有抽象 port。若通过普通
JSON/base64 发送 64 MiB 日志，Worker 和 controller 都会产生大对象复制；低配路由设备无法承受，
高并发节点也会放大 GC。若 controller 先把日志写入本地盘，多副本 completion 可能看不到上传
结果；若只信任 Worker 上报的 digest，终态可引用不存在或已漂移的内容。

completion 还必须关闭两个崩溃窗口：running ACK 已完成后的正常终结，以及进程已经完成、但
Worker 在 running ACK 前崩溃后从 durable `starting` 证据恢复。网络 upload 不得跨 PostgreSQL
事务持锁，终态又必须一次完成 Lease、Attempt、Run 和 Event，不能由多个 API 逐步拼接。

## 决策

### 1. 不新增 package，使用两个 exact versioned contract

wire contract 放入 `@qinglong/runtime-core/remote-worker-completion`；Worker adapter 放入现有
`@qinglong/worker-runtime/completion-transport`；Cluster service 与 PostgreSQL repository 分别
留在现有 cluster-control、cluster-postgres。它们与既有部署、依赖、权限和版本责任相同，不满足
D-85 的拆包条件。

Artifact schema 为 `qinglong/remote-worker-artifact-upload@v1`。request 使用 4-byte big-endian
JSON header length，header 最多 4 KiB，随后是最多 64 MiB 原始内容。header 只携带 execution
fence、Artifact identity、内容长度和 truncation；Worker/Session identity 由 path 绑定，不在 body
重复。media type 固定为 `application/vnd.qinglong.worker-artifact`，必须 identity encoding 和精确
Content-Length，不允许 chunked、压缩或 multipart 产生第二套解析语义。

completion schema 为 `qinglong/remote-worker-completion@v1`，request/response 分别最多 16/4 KiB，
字段 exact，未知字段拒绝。普通 Worker ingress JSON 的 4 KiB 默认与 64 KiB hard cap 不因 Artifact
stream 放宽；只有 Artifact route 使用独立 64 MiB + 4 KiB + 4 bytes hard cap。

### 2. 复用单一 mTLS client 和有界 backpressure

Worker Artifact uploader 与 completion client 复用 ADR-0112 的 `WorkerIngressHttpsClient`、TLS 1.3
mTLS credential provider、canonical `ql3w` authorization 和单 keep-alive Agent。stream writer 按
已知长度逐 chunk 写入，Node socket 返回 backpressure 时等待 `drain`；短读、超读、错误类型、
错误 route、响应越界或 authority 漂移全部 fail closed。

Artifact preamble、TLS credential material、JSON request/response 临时 buffer 在消费后尽力清零。
完成协调器继续只从 durable inbox 装配 lease capability；通用 Artifact source/store 不接收 Worker
credential，也不记录 capability。

### 3. 认证和授权先于内容，store 必须跨副本共享

Cluster HTTP surface 必须先完成 route、mTLS/credential、Worker/Session 和 admission prepare，再读取
stream body。Artifact service 读取有界 header 后，在共享 Attempt advisory fence 下通过 PostgreSQL
repository 精确复验 Worker generation、offer、Lease generation/token digest/version/expiry、Run、
Attempt 和状态；授权成功后才把原始内容交给 store。

`ClusterRemoteWorkerArtifactStore` 是 immutable put-if-absent port：key 至少绑定 Project、Run、
Attempt、log Artifact ID，返回实际消费的 length、SHA-256 和 truncation。实现必须跨所有
cluster-control replica 可见，并对相同 identity + digest 提供 exact replay；同 identity 不同内容
拒绝。controller 本地目录、Pod ephemeral volume 或仅 process-local Map 只能用于测试，不能声明为
生产 cluster store。

store 不接收 Worker/Session identity、raw lease token 或 callback capability。上传事务不跨 store
I/O 持有数据库锁；因此 completion 必须重新调用 `inspect`，精确匹配 immutable Artifact 的 ID、
length、SHA-256、truncation 和 Project/Run/Attempt authority 后才能进入终态事务。

### 4. completion 是一个 PostgreSQL 权威事务

repository 使用既有 Attempt advisory fence，并按 Worker Session、Run/Attempt、Run Lease 的固定
顺序 `FOR UPDATE`，随后读取一次数据库时间。它复验 path principal、Session/generation、offer、
Lease generation、raw token 的 SHA-256、expected version、callback sequence/digest 和 Artifact
receipt。raw token 只在应用内比较摘要，不进入 SQL、Event 或错误。

允许的 live 起点只有：

- `starting + dispatching`：覆盖 spawn 后/running ACK 前的 authenticated receipt 恢复；
- `running + running`：正常 completion。

Worker finished time 不能晚于数据库时间加五分钟。最终状态首先服从 durable cancellation/timeout
intent，再解释 exit code；不得让迟到成功覆盖取消或 timeout。单一 transaction 必须：完成 Lease
并把 version 加一、终结 Attempt、终结 Run、写 Attempt 与 Run 两个 Event。Event ID 由服务端生成，
terminal timestamp 取数据库 observation、Worker evidence 和既有 start/create facts 的安全上界。

### 5. exact replay 由终态和 Event 共同认证

只有 Lease 已 `completed`、Lease/Attempt version 精确为 request expected version + 1、Run/Attempt
终态和 callback/Artifact/exit/error facts 完全一致，并且已有 Attempt completion Event 具有 exact key
set 与 exact payload，才返回 `already_completed`。Event 的 `from_status` 只允许 `starting|running`。
任何字段漂移为 `replay_mismatch`；其他已终态 aggregate 返回 `already_terminal`，不能被当前 Worker
改写，也不能重复追加 Event。

### 6. 生产默认关闭条件

ADR-0120 已选择一个 S3-compatible 共享 immutable adapter；任何 production composition 都必须显式
注入它，缺失时 Artifact/completion routes 不注册或 admission fail closed。不得用 controller-local
fallback 自动降级。ADR-0121 已提供默认关闭的 Worker execution composition，但 transport 类存在仍
不得自动启动 timer、Pull 或 completion loop；完整 Session/credential 产品生命周期继续由外层门禁。

本 ADR 不完成 Artifact range read/retention、spool deletion、对象存储 credential/临时前缀 lifecycle
的产品配置，也不声明多 Pod/failover 实机支持。durable timeout/cancellation/lease-loss stop 已由
ADR-0118 完成；S3 SSE/KMS adapter 与单节点 MinIO 真实验证由 ADR-0120 完成；默认关闭的生产执行面
装配与 drain-before-release 由 ADR-0121 完成。

## 被否决的替代方案

1. **JSON/base64 Artifact**：峰值内存和复制与日志大小成正比，拒绝。
2. **multipart/form-data**：引入第二套复杂边界解析且没有当前单 Artifact 请求的收益，拒绝。
3. **controller 本地文件作为 cluster store**：多副本不可见、Pod 重建丢失，拒绝。
4. **先写 store、后信任 Worker 自报 digest**：不能证明中央内容与终态一致，拒绝。
5. **跨 upload 网络调用持 PostgreSQL transaction**：长锁和连接占用放大 store 尾延迟，拒绝。
6. **completion 分别更新 Lease、Attempt、Run**：中途崩溃产生不可解释部分终态，拒绝。
7. **只按终态行做幂等**：无法证明历史 completion payload，拒绝。
8. **为 upload/client/repository 各建 package**：没有独立依赖/权限/发布责任，违反 D-85，拒绝。

## 验收证据

1. runtime contract 拒绝未知字段、越界 header/content、错误 authority 和结果不一致。
2. HTTP surface 在读取 stream 前完成 admission，拒绝错误 media type、encoding、Content-Length 和
   未完整消费；普通 JSON cap 保持不变。
3. Worker client 使用 fixed length、backpressure 和共享 Agent；短读、超读、route confusion 拒绝。
4. 真实 TLS 1.3 mTLS 测试完成分帧 Artifact upload 与 completion，并验证 path/body identity 分离。
5. Artifact service 先授权再 store，验证实际消费 length/digest，completion 前重新 inspect。
6. PostgreSQL repository 从 `starting` 与 `running` 收敛，在单 transaction 完成 Lease/Attempt/Run/
   双 Event，cancellation/timeout 优先。
7. exact replay 同时验证终态、version 和 Event payload；非法 `from_status`、digest 漂移拒绝。
8. raw lease token 不进入 SQL/Event；Event identity 由服务端生成。
9. Worker、runtime-core、cluster-control、cluster-postgres 完整测试通过，未新增 workspace package、
   migration、schema、timer、queue 或常驻连接。
10. ADR-0125 的本机 arm64 PostgreSQL 18.4 physical-promotion 门在 runtime-role completion
    transaction 的 driver-confirmed `COMMIT` 后终止 backend，使首次调用得到 unavailable；同一
    fence/receipt/Event identity 重放为 `already_completed`。standby 在 promotion 前、promoted
    primary 在 timeline 2 上均保持 succeeded Run/Attempt、completed Lease version 5、2 条 Event、
    2 个 dedupe key 和 0 duplicate；故障范围是 PostgresClient 边界，不是 raw-wire packet-loss。
