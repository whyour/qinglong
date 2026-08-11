# ADR-0110：认证 Worker Offer 传输与耐久准入

- 状态：Accepted
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-85、D-89、D-107、D-108、D-109
- 关联 ADR：ADR-0012、ADR-0013、ADR-0021、ADR-0058、ADR-0061、ADR-0087、ADR-0090、ADR-0108、ADR-0109

## 背景

ADR-0108/0109 已完成 PostgreSQL 权威的 Pull claim 与 `starting|running|start-failure`，但此前只有控制面 HTTP response，没有 Worker 端可验证的 wire contract、丢响应后的 stable claim intent、真实 mTLS client 和“先落 inbox、后清 delivery”的装配。若 Worker 每次网络失败都生成新的 `offerId/token`，控制面已经提交的 Lease 将无法按原 authority 恢复；若收到 JSON 后直接调用 Executor，HTTP 成功又会被错误提升为执行事实。

该链路必须同时适配 NAT 后低配路由器和高并发节点：路由器不能增加数据库、sidecar、stream 或每任务 timer；集群也不能让服务端维护 per-Worker mailbox。代码必须留在现有 23 个 package，并保持 Worker 默认入口不加载网络与 offer 依赖。

## 决策

### 1. Wire response 是版本化、精确且 capability-free 的 contract

`@qinglong/runtime-core/remote-offer-delivery` 定义 `qinglong/remote-execution-offer@v1`。offered response 固定携带完整 candidate、Worker target、不可变 `executionRevision`、content digest、Placement score 和不含 capability 的 Lease 投影；idle response 只携带受限 reason、统计和 truncation。两者都拒绝未知字段，response 最大 128 KiB，页数、candidate、claim 与 race 统计受硬上限约束。

Worker 使用自己耐久保存的 lease token 重建完整 Lease，并重新校验：

- `offerId` 必须与本次 pending claim 相同；
- Worker ID、Session、generation 必须与本地当前目标相同；
- candidate、immutable revision、digest、Run/Attempt/Project/Task/revision 必须闭合；
- Lease generation/version/timestamp 必须合法，token SHA-256 必须匹配重建 authority。

response 永不包含 lease token 或 token digest。控制面的内部 malformed projection 映射为 503，不伪装成 Worker 400。

### 2. Worker 在发请求前耐久保存 stable claim intent

`@qinglong/worker-runtime/remote-offer-delivery` 每次只允许一个 in-flight Pull。首次请求前生成 UUID offer ID 和 32-byte CSPRNG lease token，并把 Session fence、capability、attempt count 与 next-attempt time 写入私有 `pending-claim.json`；网络错误、响应截断、认证失败或非法 JSON 后保留同一记录。

重试固定复用同一 `offerId + token + Session`。attempt 默认最多 16 次，full-jitter exponential backoff 最大 60 秒；协调器自身不创建 timer，Profile lifecycle 只在 `nextAttemptAtMs` 到期后显式再次调用。调用方 Abort 原样传播，不伪造 delivery failure。

idle response 证明本次 claim 没有取得工作，因而可以清 pending；offered response 必须先原子写入 inbox，随后才清 pending。若清理窗口失败，重放只会命中同一 offer，不会生成新的 authority。

### 3. 文件 journal 是本地 delivery crash barrier，不是执行 authority

首个 adapter 使用一个 `0700` root、一个 `pending-claim.json` 与每 offer 一个 `0600` 文件：

- 默认 64 条、硬上限 1024 条，单条最大 160 KiB；
- 首次发布使用 fsync 后的同文件系统 hard-link no-replace；更新使用 fsync + atomic rename；
- root 必须先取得单 owner lock，默认 stale 30 秒、范围 5 秒至 5 分钟，只有 lock 自己的刷新 timer；未持锁、双 owner、lock compromise、危险权限、容量满或 revision drift 全部 fail closed；
- 相同 offer 只允许相同 candidate/revision/digest/Session/lease generation/token，Lease version 可单调推进；冲突 payload 不得覆盖。

这批 `accepted` 记录是 ADR-0021 execution inbox 的 package 化准入阶段，不允许在生产再复制一份第二 journal。后续 Receiver 迁移必须在同一 authority 下扩展状态，或提供一次性、revision-fenced adapter；在此之前本能力保持 opt-in，不会调用 Executor 或 ACK starting。

### 4. 具体 HTTPS transport 同时要求 TLS 1.3 mTLS 与 `ql3w`

Worker transport 只接受无 userinfo/path/query/fragment 的 `https:` origin。每次请求从注入的 credential provider 取得：

- canonical `Worker ql3w_<credential>_<secret>` authorization；
- client certificate chain 与 private key；
- 1–8 个 trust anchors。

Node HTTPS request 固定 `minVersion=TLSv1.3`、`rejectUnauthorized=true`、JSON POST、15 秒默认/60 秒硬上限、4 KiB request 和调用方给定的 response hard limit。默认 Agent 只允许一个 socket 与一个空闲 keep-alive socket，并可显式 `close()`；证书和 key 每项最大 1 MiB，局部副本在请求结束后清零。拒绝 plaintext、重定向、压缩响应、非 JSON、非 200、错误 Content-Length 和流式越界。

credential enrollment/recovery、certificate renewal cadence 与连接热重载仍由外层 Profile lifecycle 负责；transport 不扫描文件、不读取数据库、不注册 watcher/signal。

### 5. 包与权限边界保持不变

不新增 workspace package：wire contract 使用 runtime-core subpath；delivery coordinator、文件 adapter 和 HTTPS client 使用 worker-runtime subpath。Worker 主入口继续只加载 steady-state certificate store/renewal，不 eager-load PKI enrollment、runtime-core、proper-lockfile 或网络 client。

Worker runtime 新增对 runtime-core 和既有 `proper-lockfile` 的精确依赖，但继续禁止 cluster-control、cluster-postgres、pg、Drizzle、Express、SQLite 与 legacy root。控制面仍通过注入的 offer service 工作；`ql3_worker_ingress` 权限不变，HTTPS handler 也不取得 runtime Pool。

## 被否决的替代方案

1. **每次失败生成新 offer/token**：claim 已提交但响应丢失时无法恢复原 Lease。
2. **只在内存保存 pending claim**：Worker 重启后仍会丢失幂等键。
3. **收到 HTTP 200 就 ACK delivery 或 starting**：无法证明本地 inbox 已耐久提交。
4. **把 token/digest 回显给 Worker**：token 本来由 Worker 持有，回显会扩大 capability 暴露面。
5. **服务端为每个 Worker 建 mailbox/stream/timer**：把节点规模转换成控制面常驻资源和新故障域。
6. **为 transport/inbox 再建 package**：没有新的部署、权限或供应链责任，只会重新突破 23 importer 门禁。
7. **让 worker-runtime 依赖 cluster-control/PG adapter**：把 transport 与数据库 authority 倒置，并扩大路由设备闭包。

## 影响与剩余门禁

正向影响：

- claim-before-response、response-before-inbox、inbox-before-clear 三个窗口都可用相同 authority 收敛；
- HTTPS/mTLS/Worker credential、response schema、digest 与 Session fence 形成完整认证链；
- edge 只增加一个 pending 文件、每 offer 一个文件、一个 owner lock timer和最多一个 socket；cluster Worker 可以实例级水平扩展，不改变服务端协议；
- 总包数保持 23，默认入口和 edge/standalone 产物不加载新能力。

仍未完成：

- 把 package 化 `accepted` record 接入 ADR-0021 的 `starting_acknowledged → launching → started → running_acknowledged` Receiver，而不是并存两份 journal；
- ADR-0112 已实现共用 TLS authority 的 activation client 与默认关闭的显式 headless lifecycle seam；heartbeat/renewal/offer cadence 与 Profile graceful drain 的统一组合仍未完成；
- Artifact 下载、Secret materialization、日志上传、completion transport；
- PostgreSQL completion/expiry/cancellation/retry 全生命周期；
- credential recovery、证书到期告警、断网/断电/ENOSPC/suspend 与 Linux x64/arm64 固定资源证据；activation 的真实 TLS 1.3 mTLS integration 已由 ADR-0112 覆盖。

因此本 ADR 完成“认证 ExecutionSpec delivery + durable admission”，但没有开放 Remote Worker 默认执行。

## 验收证据

1. runtime contract round-trip 不序列化 token/digest，并拒绝 target drift、未知字段和超限 response。
2. Worker 文件 journal 验证 `0700/0600`、stable claim、跨重启 retry、full-jitter backoff、accept-before-clear、exact replay 与单 owner。
3. HTTPS transport 验证 TLS 1.3、mTLS material、canonical `ql3w`、request/response hard limit、plaintext/credential/oversize/Abort/close 失败关闭。
4. cluster ingress 返回 versioned schema、完整 immutable revision 与 `updatedAtMs`，不返回 capability；内部坏 projection 返回 503。
5. 依赖审计仍为 23 importer，worker-runtime 不取得任何 cluster/database authority；全包、backend、制品与 Linux resource evidence 需在该 Gate 关闭前重新运行。
