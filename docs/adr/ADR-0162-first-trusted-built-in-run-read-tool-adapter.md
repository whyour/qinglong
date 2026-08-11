# ADR-0162：首个 Trusted Built-in Run Read Tool Adapter

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0133、ADR-0154 至 ADR-0161；RFC D-131/D-149/D-150/D-151

## 背景

ADR-0158 已要求 Tool adapter 只能在 durable start barrier 提交后启动；ADR-0159 至
ADR-0161 又把 input/preview 变成不可变 Artifact，并把每个 start 与 exact Artifact
pair 以双方言关系事实绑定。但此前仍没有任何可执行 adapter：

- binding registry 只保存受审元数据，没有函数或 `execute` seam；
- Artifact 可以被领域函数解封，却没有一个 start-first 的产品无关执行门；
- current Project snapshot、binding、Artifact、key 和 output schema 还可能由调用方以
  多套对象分别注入；
- response-loss 后没有 adapter-specific 证据说明能否安全重试。

首个实现必须验证整条安全链，同时不能为了一个内置只读能力增加 workspace package、
数据库表、连接、timer 或低配设备常驻成本。

## 决策

### 1. 执行 authority 只从两个现有 package subpath 暴露

在 `@qinglong/runtime-core` 内新增：

- `/trusted-tool-execution`：durable-start 后的通用执行门和 executable adapter
  registry；
- `/builtin-run-read-tool`：首个 `qinglong.run.get@1.0.0` adapter。

它们不从 `@qinglong/runtime-core` root 聚合导出，不新增 workspace package、第三方
依赖、bin、进程、socket、连接池、timer、watcher 或缓存。Package 资源、Agent 输入、
HTTP/MCP caller 和 plan 均不能运行期注册 executable adapter。

`TrustedToolExecutionAdapterRegistry` 由受信 Profile composition 一次性构造。每个
adapter 必须携带 exact Project/snapshot-specific binding 和 Profile；registry 在构造
时复验 current binding、Definition effect、`builtin_in_process` execution class，并
冻结 binding/Profile/recovery mode 与已绑定的 execute seam。执行函数不再额外接受一套
Definition/binding registry，避免两个信任源。

### 2. 顺序固定为 barrier → current binding → Artifact → key → execute

`executeTrustedToolAfterStart(startId, dependencies)` 固定执行：

1. 从 `ToolExecutionStartBarrierRepository.findByStartId` 读取并规范化 durable
   barrier；缺失、损坏或 identity 漂移失败关闭；
2. 以 barrier 的 `bindingDigest` 在 executable registry 持有的 current Project
   binding registry 中反查 exact Tool，再复验 Project、snapshot、Definition、
   adapter/redaction/audit contract、Profile、execution class 与 timeout；
3. 读取 exact input Artifact，复验 reference、Project、action、requester、Tool、
   seal time 和由当前 Definition 重新计算的 invocation action digest；
4. 按 Artifact `keyId` 解析一次 owned 32-byte key，AES-256-GCM 解封，并再次通过同一
   current Tool Definition Registry；
5. 调用 frozen adapter seam，并使用同一 Registry 对 output 做 schema 与 256 KiB
   总上限规范化；
6. 返回 domain-separated output/result digest 绑定的低敏内存结果。

key provider 返回的 owned key 在成功和失败路径都会覆零；Artifact 解封函数继续覆零
内部 key、nonce、ciphertext、auth tag、AAD 和 plaintext byte buffer。JavaScript
已经解析出的字符串/对象无法提供物理内存擦除保证，因此 adapter 不得不必要地保留
input 引用，后续 Secret-bearing adapter 仍需独立内存与进程隔离评审。

deadline 在解封前检查，并用一次只在当前调用存续期间存在的 timer race 约束 caller；
adapter 返回后再复验时钟。race 超时不被宣传为已取消底层 I/O；首个 adapter
只有一次只读点查且无副作用，迟到结果会被丢弃。未来 process/MCP/HTTP/write adapter
必须提供真正的 cancellation/fencing contract，不能照搬本实现。

### 3. `qinglong.run.get` 是严格只读、Project-scoped 的首个 adapter

受审 Definition 固定：

- Tool：`qinglong.run.get@1.0.0`；
- effect/risk：`read/low`；
- required permission：`run.read`；
- input：仅 `{runId}`，最长 128；
- timeout：5 秒；
- adapter：`builtin.qinglong.run-get@1.0.0`；
- authority：仅 `database.read`；
- Profile：由 binding 显式选择，首版可用于 edge、standalone 和 cluster-control。

该 Definition 仍必须作为 `qinglong` Package namespace 的普通 Definition 进入 current
Project snapshot；平台代码不会把它秘密插入 registry。binding factory 只接受与受审
Definition 完全一致的 snapshot entry。

adapter 只取得 `RunRepositoryReader.findRunById`，不取得 transaction、mutation、
filesystem、network、process、Secret 或 Artifact authority。返回值只包含：

- found；
- Run/Task revision identity；
- status/version/event sequence/priority；
- execution origin/owner；
- create/queue/start/finish 时间。

request ID、trigger identity、input/output ref、executor handle、PID、lease、error 和
其他敏感或可扩权字段不得进入 output。missing 与 cross-Project Run 都返回相同的
`{found:false}`。

### 4. 首个 post-start recovery 只证明“只读可安全重试”

`inspectTrustedToolExecutionRecovery` 只读取 durable barrier 并复验 exact executable
binding。对 `retry_safe_read` adapter 返回
`qinglong/trusted-tool-execution-recovery-evidence@v1`，其中 disposition 为
`retry_safe`、reason 为 `read_only_no_side_effects`，并绑定 barrier/adapter digest
与 inspection time。

inspection 不读取 input Artifact、不解析 key、不解密、不调用 adapter，也不声称已有
exact output。重试可能观察到更新后的 Run 状态，但不会重复外部副作用。结果
Artifact/receipt 的持久化、exact response replay 和 StepRun completion 同事务仍是后续
门禁。

## 低配与集群影响

- workspace importer 仍为 21，不新增依赖；
- Edge/Standalone 空闲时零新增资源；每次调用只多一次 barrier 点查、一次 Artifact
  点查、一次 key resolve、一次 Run 点查、一个调用期 deadline timer 和有界 AES/JSON
  工作；
- Cluster 复用现有 PostgreSQL repositories，不增加表、role、Pool、队列或服务；
- adapter registry 是请求/组合根显式构造的最多 128 项小集合，不是跨 Project 全局
  cache，也不建立 watcher；
- recovery inspection 不触碰密文和 Run repository。

## 被否决方案

1. **在 plan/admission 中保存函数或 module path**：绕过受信 composition 和供应链
   审查。
2. **执行函数同时接受 binding registry 与 executable registry**：形成可漂移的双信任
   源。
3. **没有 barrier 时直接读取 Artifact 执行**：允许越过同事务 start gate。
4. **只比 Artifact ID**：不能证明 digest、Project、action、requester、Tool 和当前
   Definition。
5. **把内置 Definition 隐式插入每个 Project registry**：破坏 Project snapshot 的
   完整 source vector。
6. **为首个 adapter 新建 package**：没有独立部署、依赖或权限生命周期。
7. **用 Promise race 宣称可取消任意 adapter**：底层 I/O 仍可能继续，不能作为副作用
   fence。
8. **把只读 recovery evidence 当完成 receipt**：无法重放 exact output。

## 验证

- runtime-core type/build gate 通过；
- runtime-core 全量 319/319，新增 6 项覆盖：
  1. durable start 后才解封并执行真实 Run repository 点读；
  2. missing barrier 和错误 key 在 adapter 前失败关闭，owned key 覆零；
  3. stalled read 对 caller 有 deadline 上限且 owned key 仍覆零；
  4. missing/cross-Project 输出不可区分且不泄露低敏投影外字段；
  5. recovery inspection 不读取 Artifact/key、不调用 adapter；
  6. Definition/binding 漂移拒绝，root 不导出 execution authority；
- source gate 证明通用执行门不导入 filesystem、process、network、worker thread；
- package 数和依赖树不变。

## 后续门禁

1. 在 edge/standalone 与 cluster-control 产品 composition 中请求驱动装配
   `qinglong` built-in Definition、binding、repository、key provider 和 start→execute
   调用链；
2. 新增 immutable result Artifact/receipt，并与 StepRun terminal transition、
   RunEvent、Trace/Audit completion 在双方言中原子绑定；
3. 为 key lost、Artifact/关系损坏和 result ambiguity 提供 inspect/manual recovery；
4. 增加 crash/response-loss 的 SQLite、PostgreSQL 真库和 physical HA 故障注入；
5. 完成物理 Edge idle/fault/scale 证据后，才允许产品 execution admission 开放。
