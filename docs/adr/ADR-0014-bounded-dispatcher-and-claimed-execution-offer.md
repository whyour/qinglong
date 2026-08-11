# ADR-0014：有界 Dispatcher 与 Claimed Execution Offer

- 状态：Proposed
- 日期：2026-07-18
- 关联：QL-RFC-0001、ADR-0012、ADR-0013

## 上下文

Run candidate、Worker 列表、Placement 结果、Run Lease 和 `ExecutionSpec` 已分别建立边界，但如果由 transport、定时器或 API 临时拼接，仍可能产生以下错误：

- 在 claim 前把命令、工作目录或资源策略暴露给未获授权的 Worker；
- 把 Placement 命中误认为执行权，导致多个 Dispatcher 重复下发同一 Attempt；
- 在路由设备上无界读取 Run、Worker 或构造大量 `ExecutionSpec`；
- 使用请求体中的 Worker 身份，而不是 Registry 中刚参与 Placement 的 session/generation；
- candidate 的 executor type、Placement 和 `ExecutionSpec` 身份不一致；
- claim 与消息发送之间的崩溃窗口没有被明确建模。

因此需要一个与 transport 无关、单次运行且有硬预算的应用层 Dispatcher，先稳定控制面授权顺序，再选择 HTTP、gRPC 或消息协议。

## 决策

### 1. Dispatcher 每次只执行一个有界周期

`RunDispatcher.dispatchOnce()` 不创建 timer，也不拥有后台生命周期。调用方负责调度下一周期。默认预算面向 edge：

- active lease recovery：每页 8 条，最多 2 页；
- candidate：每页 8 条，最多 2 页；
- Worker：每页 8 条，最多 2 页；
- claim：全周期最多尝试 8 次。

实现硬上限为 recovery/candidate/Worker 每页 64 条、页数 16、单周期参与 Placement 的 Worker 总数 64、claim 尝试 64。配置若使 Worker 页乘积超过 64，启动前直接拒绝。standalone 或未来 cluster-control 可以调高默认值，但不能绕过硬上限；扩展吞吐应通过更多短周期和数据库级公平性完成，而不是扩大单周期内存。

### 2. 授权顺序固定

每个周期严格执行：

1. 用同一个 `observedAtMs` 优先读取 active lease recovery；只有 Run 仍为 `dispatching`、Attempt 仍为 `claimed`、未取消、lease 未过期且 Worker session/generation 仍为当前 online/draining Session 时才可恢复；
2. recovery 没有可交付项后才读取第一页 candidate；没有 candidate 时不查询 Worker；
3. 有 candidate 后才按稳定 cursor 读取有界 Worker 快照；
4. 每次只调用 `RunDispatchPlanSource.prepare(candidate)` 构造一个 plan；
5. 对 `ExecutionSpec` 做共享领域校验、显式深拷贝和未知字段剥离，并验证 `runId/attemptId/projectId/taskId/taskRevision` 与持久化 candidate 完全一致；
6. 新 claim 的 Placement 必须包含 candidate 的 executor type；未声明时由 Dispatcher 加为 required，冲突时拒绝；
7. 按 Placement score、可用槽位和 Worker ID 确定性排序；
8. 使用所选 Registry record 的 Worker ID、session ID 和 generation 原子 claim；
9. 只有 lease recovery、`claimed` 或同一 capability 的 `idempotent` 结果才能生成 `ClaimedExecutionOffer`。

plan 可以在可信控制面内存中于 claim 前构造，但不得作为返回值、日志、Event、Trace attribute 或 transport 消息暴露。claim 失败、竞争丢失、无匹配节点或预算耗尽时只返回低基数状态和计数，不返回 `ExecutionSpec`。

### 3. Offer 是受 Lease 约束的内部 capability

`ClaimedExecutionOffer` 只包含：

- candidate 的有界身份和排序事实；
- 由 Attempt ID、lease generation 和 Worker session authority 派生的稳定 `offerId`、规范化 `ExecutionSpec` SHA-256，以及 `new_claim/lease_recovery` 来源；
- 目标 Worker 的 ID、session ID、generation；
- 已提交的 Run Lease，包括不透明 token；
- 清洗并深拷贝后的 `ExecutionSpec`；
- 新 claim 的 Placement score；恢复不依赖重新计算 score。

原始 lease token 和命令内容不得进入普通日志。offer 的消费者必须把它发送给完全相同的认证 Worker principal；不能改派给另一个 session，也不能以消息系统的 delivery ACK 代替 ADR-0013 的 starting/running ACK。

### 4. 分页与竞争 fail closed

- candidate 重复 Attempt、cursor 不前进或端口返回超页数据时拒绝本周期；
- recovery 重复 Attempt、过期 lease、非前进 cursor 或超页数据时拒绝本周期；
- Worker 重复、顺序倒退、truncated 页缺失前进 cursor 或总数超限时拒绝；
- Worker 在快照后失联或容量耗尽时，可以在全局 claim 预算内尝试下一个已匹配 Worker；
- Attempt 已被租用、变为不可领取或 claim CAS version 冲突时停止处理该 candidate，不对同一 Attempt 继续改派；
- 扫描或 claim 预算耗尽必须显式返回 `truncated` 和对应 reason，不能伪报为“没有任务”。

### 5. Run Lease 是恢复 authority，但不是 transport outbox

不新增与 Run Lease 并列的 `DispatchOffers` authority 表。已提交的 active Run Lease 已原子绑定 Attempt、Worker session/generation、lease generation/token 和 expiry；Dispatcher 重启后先从该事实有界恢复，并按 Run 中固定的 Project/Task/revision 重新 materialize plan。相同 lease generation 始终得到相同 `offerId`，因此 claim 提交后、首次发送前崩溃不必等待 lease 过期。

恢复只覆盖 Attempt 尚为 `claimed` 的窗口。Worker 已 ACK `starting` 后不再重发 `ExecutionSpec`；Worker 应重试 ADR-0013 的后续 ACK。取消、lease expiry 或 Session replacement 都立即取消恢复资格。plan 无法按原 revision 重建或 `ExecutionSpec` identity 漂移时 fail closed。

当前仍没有持久化 delivery attempt、网络发送或 delivery ACK。控制面可能在 starting ACK 前重复返回相同 offer。ADR-0021 已增加默认不可达的 Worker 本地持久化 inbox：按 `offerId` 幂等去重、拒绝同 ID 异 `ExecutionSpec` digest，并在 spawn 前写入 crash barrier。delivery ACK 仍只表示收包，不能代替 starting/running 事实。

ADR-0108 已为 PostgreSQL cluster 增加一个更窄的认证 Worker Pull 适配：Worker 自带稳定 `offerId` 与高熵 lease token，服务端用数据库时钟有界读取 candidate，只对该认证 Session 执行 Placement 和原子 claim；数据库仅保存 token digest，同一请求可从 durable Lease 重建丢失响应。该适配复用本 ADR 的授权顺序和预算，但不把 SQLite Dispatcher 的进程内 Worker 全表选择、控制面派生 token 或 transport 生命周期搬入 cluster。

生产 transport 必须另行决定：

- delivery attempt、退避、重连和可观测状态；
- 认证 transport 如何调用 ADR-0021 inbox，以及 journal 单 owner、retention 和恢复扫描；
- offer 未送达时主动 release 还是等待 lease expiry；
- Artifact 是否能按 pinned Task revision 确定性重建；
- token 的加密传输、内存生命周期和脱敏审计。

ADR-0109 已完成 PostgreSQL starting/running/start-failure ACK；在认证 ExecutionSpec transport、runtime 内部 port 和 Worker inbox 网络装配完成前，当前 Dispatcher/Pull port 必须保持默认生产不可达。

## 影响

正面影响：

- candidate discovery、Placement、claim 和 offer 的权限边界可独立测试；
- edge 无新增常驻 timer、连接或无界集合；
- Worker session fencing 来自持久化快照，不信任 transport 请求体；
- `ExecutionSpec` 的共享校验同时服务 LocalProcess 和未来 Remote Worker，避免两套规则漂移；
- cluster-control 可以复用同一应用语义，只替换 PostgreSQL Repository 和 transport。

代价与风险：

- plan 在 claim 前构造，昂贵的 Artifact 解析必须保持惰性和有界；后续可以拆成 claim 前 metadata plan 与 claim 后 payload materialization；
- 单周期公平性依赖 candidate keyset 顺序及外部 cadence，仍需多 Project/Quota 调度策略；
- starting ACK 前可能重复投递，transport 和 Worker 必须实现稳定 ID 去重与退避；
- SQLite 只能验证单控制面行为，不能证明多副本 claim 正确性。

## 未选择的方案

1. **先发送 ExecutionSpec，再由 Worker claim**：未授权节点能看到任务内容，并可能先执行后 claim。
2. **Placement 命中即更新为 running**：没有 Run Lease、starting ACK 或稳定 executor handle。
3. **一次加载全部 Worker 和 candidate**：在 edge 上失去内存上限，也放大集群热点。
4. **把 Dispatcher 直接写进 HTTP handler**：网络重试和身份字段会污染领域授权顺序。
5. **claim 成功后立即接入生产 headless runtime**：delivery、Artifact 和 ACK 恢复协议尚未完成。
6. **新建与 Lease 并列的 durable offer authority 表**：会复制 Attempt/Worker/lease 状态并引入双重真相；delivery telemetry 后续可以单独持久化，但不能取代 Lease authority。

## 验证要求

- 第一页无 candidate 时 Worker、plan 和 claim 调用次数均为 0；
- required/preferred Placement 选择正确 Worker，并用该 record 的 session/generation claim；
- candidate/Worker 跨页查找受预算限制，重复或不前进 cursor fail closed；
- 容量竞争可尝试下一 Worker，Attempt 所有权竞争停止当前 candidate；
- claim/扫描预算耗尽返回准确 reason 与 `truncated`；
- 无效或身份不一致的 `ExecutionSpec` 在 claim 前拒绝；
- 未 claim 的结果不包含 offer，序列化结果不能泄漏命令；
- `ExecutionSpec` 深拷贝，plan source 后续修改不能改变 offer；
- active lease 在新 candidate 前恢复，重启前后 `offerId` 相同；
- recovery 只接受 pinned Task identity、当前 Worker Session 和未过期 lease；取消或 Session replacement 后不再投递；
- recovery plan 缺失、revision 漂移、重复 cursor 和页数耗尽均显式 fail closed；
- Node 22、Node 24 全量回归通过；未来 PostgreSQL contract suite 覆盖多 Dispatcher 竞争。
