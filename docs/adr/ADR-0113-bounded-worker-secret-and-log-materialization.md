# ADR-0113：有界 Worker Secret 与 Log Materialization

- 状态：Accepted
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-24、D-72、D-85、D-110、D-111、D-112
- 关联 ADR：ADR-0024、ADR-0025、ADR-0073、ADR-0092、ADR-0111、ADR-0112

## 背景

Worker Processor 已能在单一 inbox 上执行 ACK/spawn barrier，但此前只接受任意
materializer port。具体组合若把完整 Offer 交给 Secret/Artifact provider，会连同 lease
token capability 扩散；若先分配日志再发现 Secret 不可用，会在重试中制造无主 Artifact。
另一个实际缺口是 materializer 返回的 `logArtifactId` 只用于 running ACK，没有交给
Executor，导致本地输出与控制面记录无法绑定同一 identity。

## 决策

### 1. 只向 provider 发送最小身份投影

`BoundedWorkerRemoteExecutionContextMaterializer` 必须先重新规范化完整 offer，但向 Secret
provider 只发送 Project、Task、Task revision、Run、Attempt、capability-free 的 offer ID、
execution digest 与去重后的 secret refs；向
Artifact allocator 只发送 Project、Run、Attempt 与 offer ID。两类请求都不得携带 lease
token/digest、callback token/digest、Worker credential、command 或完整环境。

Secret provider 返回以 `secretRef` 显式配对的 exact entries，不使用位置隐式关联：

- 最多 64 个去重 reference；
- 每值最多 16 KiB，禁止 NUL；
- public 与解析后的 Secret 环境总量最多 64 KiB；
- 数量、引用集合、唯一性、字段或预算不匹配全部 fail closed；
- 可选 dispose 在任何后续失败与正常 handoff 后最多调用一次。

### 2. Secret 成功后才能分配 Artifact

只有所有环境值闭合后才调用 Artifact allocator。allocator 返回 exact
`logArtifactId + takeOutput + release`，ID 最多 36 字节并符合 Run dispatch ID 约束。
`takeOutput` 只能在 spawn barrier 后调用一次；`release` 只释放未交接的 preparation
资源，不得关闭或删除已交给 Executor 的日志；无效/不可用 Artifact 必须同时释放 Secret
resolution。

materialized context 的 dispose 幂等并同时尝试 Secret dispose 与 Artifact release，一个
清理失败不得跳过另一个。Processor 已在所有 launch 结果的 finally 中调用它。

### 3. Executor 与 running ACK 使用同一个日志身份

`WorkerRemoteExecutionLaunch` 必须同时携带 `logArtifactId + output`。Processor 在写入
durable `launching` barrier 后才取得 output capability，并复验 sink 与 materialized ID
一致后交给 Executor；Executor 返回 handle 后，该 ID 与 handle 一起持久化，并随
`acknowledgeRunning` 提交控制面。禁止 Executor 自行生成另一个未回报的日志身份。

调用 `Executor.start` 即转移 output ownership。tagged `rejected` 证明未 spawn，Processor
执行一次防御性幂等 close；异常或非法返回表示 spawn outcome unknown，不得由 Processor
误关可能正在写入的 output。

### 4. 保持 provider 与 Profile 默认关闭

本 ADR 只定义并实现 worker-runtime 内的组合原语；Secret 网络协议随后由 ADR-0114 在
不把 lease capability 暴露给通用 provider 的前提下闭合。本 ADR 不实现 Artifact
上传或本地文件 provider，不新增 package、数据库、timer、watcher或第三方依赖。生产
Profile 只有在受审 provider、具体 Executor、completion 与 lease-loss lifecycle 都闭合后
才能启用。

## 被否决的替代方案

1. **把完整 Offer 交给 provider**：不必要地扩散 lease capability、command 与 Worker
   target。
2. **按数组位置返回 Secret**：provider 顺序漂移会静默把 Secret 注入错误变量。
3. **先分配 Artifact 再解析 Secret**：Secret 不可用会制造无意义写入和 orphan。
4. **Executor 自己生成日志 ID**：running ACK、Artifact 路由与实际输出无法闭合。
5. **把 Secret 明文写入 inbox**：把瞬时 capability 变成跨重启持久泄露面。
6. **另拆 materializer package**：没有独立部署或供应链责任，只增加 package 碎片。

## 影响与剩余门禁

已完成：去重 Secret 请求、exact response、每值与总量预算、Secret-before-Artifact、最小
identity projection、失败清理、幂等 dispose，以及 log ID 从 materializer 到 Executor、
journal 和 running ACK 的单一链路。

ADR-0114 已完成 Secret provider 的认证传输和完整 Session/Lease/revision 围栏；仍未完成：
具体 KMS/Vault/本地加密存储策略、Artifact upload 与
retention、具体进程 Executor、completion transport、lease-loss/cancellation/recovery
组合和物理 Edge 故障证据。默认 Worker 执行保持关闭。

## 验收证据

1. 相同 Secret ref 只解析一次，两个环境变量得到同一受限值。
2. Secret 不可用或超过 64 KiB 时 Artifact 调用数为零。
3. duplicate/unknown/malformed provider response 被拒绝，并执行所有可用 cleanup。
4. provider 请求的序列化内容不包含 lease token。
5. Executor launch 观察到与 running ACK 相同的 `logArtifactId`。
6. output 只在 durable launching barrier 后交接；unknown spawn 不被 Processor 关闭。
7. package 数、依赖树与默认入口闭包不增加。
