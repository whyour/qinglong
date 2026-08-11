# ADR-0372：两阶段认证的 Local Run Cancellation API

- 状态：Proposed
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-18、D-19、D-44、D-279、D-280、D-282、D-283、D-284，ADR-0118、ADR-0119、ADR-0367、ADR-0371

## 背景

D-283 后，Local `/api/v3` 已能按 Project 读取 Run、列表、RunEvent 与 StepRun，但仍不能停止一个正在执行的通用 Run。Cluster 已有 `run.cancel`，Local 只有内部 execution control 与 Package Workflow 专用管理入口；用户因此能看见阻塞点，却必须退回旧控制面或专用命令才能取消。直接把 HTTP 请求转给 execution lifecycle 会绕过 durable intent、Project/RoleBinding fence 与重启恢复；直接复用 Package Workflow administration 又会错误绑定 Package/Workflow identity。

现有 Local HTTP transport 还假定全部 operation 都是无 body GET，并在 admission 前拒绝 body。取消需要一个极小 JSON body，但不能因此退化为“先缓冲匿名 body，再鉴权”的单阶段 Controller；低配路由器与安全边界都要求 route、Bearer、Policy 和持久 Audit 成功后才读取 body。

## 决策

1. Local 增加 `POST /api/v3/projects/{projectId}/runs/{runId}/cancellation`，固定 operation `run.cancel`、permission `run.stop`，不得接受 query。成功与 Cluster 同构：首次 durable intent 返回 202，exact replay/已请求/已终态返回 200；不存在和跨 Project 统一 404 `run_not_found`，授权 fence 漂移返回 409，存储不可用返回 503。
2. 通用 wire schema 改为 `qinglong/run-cancellation@v1`，body 只允许 exact `{schema,mutationId}`。Runtime Core 新增 profile-neutral `run-cancellation` export；现有 `cluster-run-cancellation` export 作为 3.0 Alpha 源码兼容别名保留，但不再定义 Cluster 专属 wire identity。
3. Local admission 升级为两阶段：canonical route resolution、Bearer authentication、Project Policy、持久 security audit、credential/Pepper confirm 全部完成后，transport 才读取 body。取消 body 固定最多 512 bytes、只接受单个 `application/json`、拒绝 transfer-encoding、重复/畸形 content-length、空 body、尾随 JSON、非 UTF-8 与超量；GET 继续不接受 body且不支付 JSON parser 成本。
4. Local SQLite 增加通用 Run cancellation repository，并复用 Runtime Database 已打开的唯一 `LocalSqliteOperationAuthority`。单个 `BEGIN IMMEDIATE` 内重新验证 Project active/version、调用主体最新 RoleBinding active/version/role（owner/admin/operator），验证 Run 的 Project 归属，再原子更新 `cancel_requested_at_ms='now'`、`cancel_reason='user'`、Run version/event sequence 并追加低敏 `run.cancel_requested` Event。
5. `mutationId` 进入每 Run 唯一的 `user-cancel:{mutationId}` dedupe key；事件 id 与时间由服务端产生。响应丢失后的同 mutation 重放不得追加 Event 或再次递增版本；Run 已存在任何合法 cancellation intent 时只返回 `already_requested`，不得覆盖 reason/time；终态只返回 `already_terminal`。
6. repository 只在启用 Local API product surface 时惰性构造，并与 Run/StepRun reader 共用同一 SQLite connection、queue 与 close fence。不得把 mutation method 放入只读 Run reader 或 MCP database，也不得让 HTTP route取得 execution controller/PID/signal authority；后续有界 execution-control lifecycle 从 durable intent 收敛实际进程。
7. MCP 继续保持只读，不增加 `qinglong.run.cancel`。AI 写操作仍必须等待独立 preview/Approval/Audit 产品契约，不能因 HTTP 已有 User cancellation 就取得等价 authority。
8. 不新增 workspace package、第三方依赖、migration、index、数据库连接、listener、sidecar、timer、watcher 或 cache。D-281 的 flash/module/RSS 门不得放宽；完整 backend/packages、14 artifact、默认 Local image、真实 Edge/Standalone Local contract 与 PostgreSQL HA 门必须继续通过。

## 不采用方案

- **复用 Local execution controller**：signal 是 intent 之后的收敛副作用，不是认证后的 durable command 边界。
- **复用 Plugin Package Workflow cancellation**：通用 Run 不一定来自 Package Workflow，额外 identity 会把合法目标错误遮蔽。
- **在鉴权前读取 JSON**：匿名请求可消耗 body 内存和 parser CPU，也破坏 Local/Cluster 的安全时序一致性。
- **用 query/header 传 mutationId**：规避 body 只会制造第二套 wire contract，且难以扩展显式 schema version。
- **开放 MCP cancellation**：当前 MCP 是低风险只读诊断面，没有 preview/Approval 消费与写操作强认证闭环。
- **新增 cancellation package 或 SQLite 表**：能力属于既有 Run domain，当前 Runs/RunEvents、Project/RoleBinding 和索引已足够。

## 完成门

- Runtime Core 覆盖 profile-neutral canonical schema、严格 body/result、compat export 与非法状态；
- Local admission/transport 覆盖认证与持久审计早于 body、512-byte hard cap、content-type/content-length/UTF-8/JSON 严格性、GET 零 body parser；
- SQLite repository 覆盖 accepted、response-loss replay、already-requested、already-terminal、跨 Project、Role revoke/version drift、counter overflow、Event collision、rollback 与 bounded authority queue；
- 真实 SQLite HTTP 覆盖 Owner/Operator allow、Viewer deny、credential confirm、durable Run/Event、取消 lifecycle 收敛与重启后可观察状态；
- Cluster canonical schema、完整源码、制品、Local image 与 PostgreSQL HA 门全绿，且 MCP Tool 清单和默认 Edge/Standalone import closure 不获得写 authority。

## 当前验证证据

- Runtime Core 476/476、Local SQLite 213/213、Local API 32/32、Local MCP 41/41、Local Application 45 pass/4 skip、Cluster Control 196 pass/2 skip；完整 18-package clean build/test 退出 0，backend 1,160 pass/2 skip。
- workspace 保持 18 package；1,028 个 source 中 1,010 个位于包内领域子目录，18 个根文件均为 public/binary entry，`singleSourcePackages=[]`、`shallowSourcePackages=[]`，package/dependency boundary 无 finding。
- 14 个 Profile artifact 全部 compatible。默认 Edge/Standalone 仅包含 SQLite/Runtime Core/SemVer，为 3,694,042/3,694,096 bytes、375 files、50 loaded modules；API 组合为 5,113,425/5,113,569 bytes。最紧 Application+AI 为 6,281,428/6,281,560 bytes，距 6 MiB 只余 10,028/9,896 bytes，后续增量必须先恢复包内可达文件裁剪余量，不得提高 cap。
- AI/API-excluded arm64 Local image 为 478 files/4,717,459 bytes；Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs 均在只读根、无网络、非 root 条件下 active→graceful stop，SQLite integrity 为 `ok`。
- PostgreSQL 18.4 arm64 HA 112/112 gates、timeline 1→2；私有报告 SHA-256 为 `8416a26aa6220210961a40e22aec897215a55e59423ad48638ca203a8cb488e6`，离线审计 `compatible=true/findings=[]`，Docker 资源零残留。
- HTTP→SQLite durable intent/exact replay、重启前 cancellation intent 收敛，以及 Linux `/proc` 真实进程 stop 已由相邻集成门分别证明；固定型号低配路由器上的同一 API→进程 stop 链尚无物理报告，因此本 ADR 保持 Proposed。
