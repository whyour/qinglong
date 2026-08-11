# ADR-0033：Approved Action 恢复证据与人工裁决

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0031、ADR-0032、ADR-0034、ADR-0035、ADR-0036、ADR-0007、ADR-0021

## 上下文

ADR-0032 用 durable start barrier 区分副作用前和副作用后故障：`leased` 过期可以安全接管，`executing` 过期只能得到有效状态 `recovery_required`。这阻止了 QingLong 因 lease timeout 自动重复一次已审批动作，但还没有回答如何把不确定执行收敛到可信终态。

单纯看到 handler 超时、进程退出、网络断开或本地 receipt 缺失，都不能证明外部副作用没有发生。反过来，一个未绑定 action digest、未经认证或来自旧执行 fence 的 receipt 也不能证明当前 dispatch 成功。edge 上不能为每个动作常驻 watcher/timer；cluster-control 的多副本 resolver 又必须避免重复探测风暴和互相覆盖裁决。

因此恢复必须把“证据观察”和“状态裁决”分开，并明确哪些动作能够自动恢复、哪些动作只能由人处理。

## 决策

### 1. `recovery_required` 是有效状态，不是可领取持久状态

数据库继续持久化 `executing`。当 `now >= lease_expires_at_ms` 时，读取层将其解释为 `recovery_required`：

- 普通 Approved Action due scan 永远不返回它；
- 普通 claim 不得把它变回 `leased` 或调用 `execute`；
- 只有 recovery resolver 或具备专门权限的人工裁决可以推进终态；
- 原执行者的迟到 completion 可以提交，但必须仍匹配未被替换的 owner/token/version fence。

这样不会出现两个可写状态互相漂移，也不会因为后台任务延迟而依赖一次额外的状态转换。

### 2. 恢复只能观察证据，不能重放副作用

每种真实 handler 在启用前必须声明一个 `RecoveryEvidenceProvider`。provider 只能执行 side-effect-free 的 receipt 读取、目标状态查询或 durable execution identity 探测，返回以下有限 finding：

- `verified_succeeded`：存在与当前 dispatch 完整绑定且可信的成功证据；
- `verified_failed`：存在与当前 dispatch 完整绑定且可信的失败证据；
- `still_running`：可验证的同一 durable execution identity 仍在运行；
- `missing`：当前没有证据，不等于未执行；
- `conflict`：证据身份、digest、fence 或认证不匹配；
- `unsupported`：该 action 类型没有可信恢复能力；
- `unavailable`：证据源暂时不可用。

resolver 不得调用 handler `execute`、重新发送 Tool call、重新安装 Package、重写 Secret、重新创建 Run 或根据日志文本猜测结果。即使下游声称幂等，首版恢复也只查询，不用“带相同 idempotency key 再发一次”替代证据。

### 3. 可信证据必须绑定 immutable action identity

可自动裁决的 receipt/query 结果至少绑定：

- schema version；
- `dispatchId`、`approvalRequestId`、`projectId`；
- `actionType` 与 canonical `actionDigest`；
- execution attempt、`startedAtMs` 与 dispatch idempotency key；
- outcome、低敏 result code、finished time；
- provider-specific receipt identity 的 digest；
- 可验证的完整性来源，例如受信数据库唯一约束、provider 认证响应、HMAC/签名或私有原子存储。

receipt 最大 4 KiB、exact-shape、版本化且禁止 Secret、Tool 参数、Shell、prompt、任意 provider 响应或无界错误文本。数据库只持久化低敏 finding code、receipt/evidence digest 和必要时间，不保存 capability 或原始凭据。

本地文件 receipt 只适用于 edge/standalone 的本机 action，并使用私有目录、原子不可覆盖发布和数据库 journal 定位；cluster-control 的唯一恢复证据必须位于 PostgreSQL、共享对象存储或可认证的外部 provider，不能依赖某个控制面副本的本地文件。

### 4. 自动恢复能力按 action 类型显式分级

| Action 类型 | 可接受的自动恢复证据 | 缺少证据时 |
| --- | --- | --- |
| QingLong 内部数据库 mutation | 同事务保存的唯一 `dispatchId`/mutation ID 与结果事实 | 保持 recovery-required |
| Run 创建或控制 | RunRepository 中绑定 dispatch 的唯一 origin/request 与状态事实 | 保持 recovery-required |
| Package 安装 | 安装事务记录、目标版本/content digest 与原子 commit marker 同时匹配 | 人工核验，不从目录存在推断成功 |
| 外部 Tool/API | provider 接受 idempotency key，并可认证查询同一 request/receipt | 人工核验，不重新发送请求 |
| 任意 Shell 或无查询能力 Tool | 无 | 只能人工裁决 |

真实 handler 注册时必须声明 `automatic | manual_only` recovery capability。没有 provider 或 contract 测试的 handler 默认为 `manual_only`，不得用通用进程退出码或日志关键字升级为 automatic。

### 5. Recovery control 使用独立 lease，裁决写入保持原子

`0022-approved-action-recovery` 已为跨越 start barrier 的 dispatch 建立一对一 `ApprovedActionRecoveryControls`，并以唯一 `ApprovedActionRecoveryResolutions` 保存由恢复流程产生的终结裁决：

- control 在 `leased -> executing` 的同一事务中 armed；升级时为已有 executing 行回填；
- `next_scan_at_ms` 使用有界索引，不扫描 immutable dispatch 全表；
- recovery owner/token/version/expiry 只协调证据探测，不授予执行副作用的能力；
- edge/standalone 用短 SQLite `BEGIN IMMEDIATE` claim，cluster-control 用 PostgreSQL row lock/`SKIP LOCKED`；
- `still_running/missing/unavailable` 只更新有界 finding、计数与下一次扫描时间；
- `verified_succeeded/verified_failed` 在同一事务写唯一 resolution、推进 execution 终态并关闭 recovery control；
- `conflict/unsupported` 保持 recovery-required 并触发人工队列，不自动 blocked 掩盖未知结果。

normal completion 不伪造 recovery resolution，但必须在同一事务把 control 关闭为 resolved，并以 completion mutation ID 绑定 execution/control。executing renew 会增加 execution/control version、撤销陈旧 recovery lease 并把下一次扫描推迟到新的 execution lease expiry；陈旧 resolver 随后只能得到 fence rejection。

resolver 每次只处理一页，默认不超过 16、硬上限 64；没有内部 timer、递归翻页或 watcher。Profile lifecycle 决定 cadence、单周期页数、退避和 shutdown。edge 空闲时不会写 heartbeat；cluster 多副本由 recovery lease 防止探测风暴。

### 6. 迟到 completion 与 recovery resolution 使用同一 version 裁决

原执行者 completion 和 recovery resolution 都只能从同一 persistent `executing@version` 推进终态：

- completion 先赢：resolver 读取终态，不再写 resolution；
- resolution 先赢：迟到 completion 只能精确重放同一 outcome/evidence，否则 fence conflict；
- 两者并发：数据库条件更新只允许一个 winner；
- repository/storage 不可用：保持 recovery-required，不推导成功或失败；
- mutation ID 只有在所有语义字段完全一致时幂等。

wall clock 只决定何时允许进入 recovery scan，不决定哪一个结果更可信。

### 7. 人工裁决是显式终结，不是隐藏重试

人工裁决要求稳定 User、当前 `approval.recover` 权限、Project/RoleBinding version fence，以及 authentication 层提供的近期强认证。允许的决定只有：

- `confirm_succeeded` -> `succeeded`；
- `confirm_failed` -> `failed`；
- `abandon_unknown` -> `blocked`。

裁决记录包含唯一 mutation ID、expected execution version、User actor、bounded reason code、可选 evidence digest 与时间，并与 execution 终态在同一事务提交。禁止 `retry`、`reset_to_pending`、`clear_start_barrier` 或编辑 immutable dispatch。

如果操作者确实要重复动作，必须创建新的 action plan、ApprovalRequest 和 dispatch，并显式引用前一个 unknown dispatch；Policy/UI 必须展示可能重复副作用的风险。这让第二次执行成为新的、可审计的授权，而不是偷偷复用旧审批。

### 8. 当前阶段仍不接生产路径

当前已实现 recovery domain/port、`0022` control/resolution migration、SQLite repository、evidence-only bounded reconciler 和 contract tests。测试覆盖 start/control 原子回滚、升级 backfill、稳定 keyset、双 SQLite resolver claim/takeover、finding 精确重放、normal completion 关闭、executing renew 重新 armed、自动/人工 resolution，以及迟到 completion 与 resolver 的单一终态 winner。ADR-0034/`0023` 又增加了第一个 `run.create` 原子 receipt 和 SQLite automatic evidence provider，覆盖 missing、collision、tamper、renew 与终态 fence。ADR-0035/`0024` 已增加 `approval.recover` Policy、稳定 User + 五分钟内强认证门禁，以及与 human resolution 同事务提交的 version-fenced authorization fact。ADR-0036 又增加 recovery-first、单 timer、分 Profile 硬预算与跨周期 cursor 的本机 lifecycle core。

这些核心仍没有 production lifecycle，`run.create` provider 也没有生产 plan source 或注册入口。以下内容完成前，ADR-0032 的 dispatcher 与本 ADR resolver 都继续 production unreachable：

- `run.create` immutable plan 的生产 resolver、preview builder 与 API/审计入口；
- profile lifecycle 的 production registry/startup/shutdown 装配、指标、告警和积压/最长年龄门禁；
- 真实 MFA/hardware/local-console authentication adapter，以及人工恢复 API/UI、rate limit 和对外错误屏蔽；
- PostgreSQL adapter 与 cluster 多副本竞争测试；
- 原子 receipt 的断电、磁盘满、损坏、认证和 retention 测试。

## 影响

正面影响：

- post-start crash 不会被普通重试放大为重复副作用；
- 可查询的内部/外部动作能够基于证据自动收敛；
- 无恢复能力的 Shell/Tool 会诚实暴露为人工队列；
- edge 使用有界索引和按需 lifecycle，cluster 使用独立 recovery fencing；
- 所有人工“再做一次”都需要新的审批和审计身份。

代价与风险：

- 每个真实 handler 必须额外实现并测试恢复证据 contract；
- recovery control、resolution 和 receipt/journal 增加存储与运维面；
- provider 不支持幂等查询时不能自动恢复，可能长期积压；
- 强认证和人工处置 UI/API 会成为生产启用前的硬依赖；
- 即使证据协议完整，也只能在具体下游 contract 范围内声明幂等收敛，不能泛化为跨系统 exactly-once。

## 未选择的方案

1. **lease 过期后使用同一 idempotency key 重发**：不是所有 provider 都正确实现幂等，且请求可能包含不可重复语义，拒绝。
2. **receipt 缺失视为失败**：缺失不能证明副作用没有发生，拒绝。
3. **进程退出或日志出现 success 视为成功**：身份和完整性不足，拒绝。
4. **把 `recovery_required` 写成普通 due 状态**：容易被通用 dispatcher 领取并重放，拒绝。
5. **允许管理员重置为 pending**：绕过新审批并隐藏重复副作用风险，拒绝。
6. **每个 action 一个 watcher/timer**：不满足 edge 资源预算，拒绝。
7. **cluster-control 读取本地 receipt**：多副本不可见且故障转移丢失唯一证据，拒绝。

## 验证要求

- expired executing 只进入 recovery scan，永不进入普通 due/claim/execute；
- recovery evidence provider 的 contract 证明 inspect side-effect-free，并覆盖 missing/conflict/unavailable；
- receipt exact-shape、大小、identity/digest/fence/authentication 任一不匹配均 fail closed；
- recovery control claim/renew/result 具备 owner/token/version fencing 与有界 keyset；
- 自动 resolution 与 execution 终态同事务提交，失败不留下“已解决但仍 executing”或相反状态；
- 迟到 completion 与 resolver 并发只有一个 winner，精确重放幂等、字段漂移冲突；
- manual resolution 在提交时复验 User、`approval.recover`、Project/RoleBinding version 和 expected execution version；
- manual path 没有 retry/reset，重复动作必须获得新 approval/dispatch；
- edge lifecycle 无 watcher、无每动作 timer、页/退避/单周期工作量有硬上限；
- cluster adapter 不依赖本地文件，并通过多副本 recovery claim contract；
- production wiring 搜索证明 `run.create` handler/provider、resolver 和 recovery API 均未被旧路径导入。
