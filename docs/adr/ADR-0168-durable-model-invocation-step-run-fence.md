# ADR-0168：Durable ModelInvocation 与唯一 StepRun Fence

- 状态：Accepted
- 日期：2026-07-26
- 关联：RFC D-12、D-13、D-156、D-157；ADR-0156、ADR-0167、ADR-0170

## 背景

Model Gateway 已经能执行受预算约束的远程调用，但进程内 audit 不能回答崩溃、
COMMIT 响应丢失、集群 promotion 或用户取消后的 durable outcome。另建一套
Invocation `pending/running/succeeded` 状态会与既有 Run/StepRun 产生双写；自动重试
结果未知的远程模型调用又可能重复计费，并产生不同输出。

同时，禁用 AI 的路由设备不应因为 workspace 中存在 AI 包就创建 AI 表、加载 adapter
或增加默认 Profile 产物。持久化能力需要复用现有 SQLite/PostgreSQL 部署边界，但
不能再拆一个只有 repository 的 package。

## 决策

### 1. ModelInvocation 是 model StepRun 的 receipt，不是第二状态机

每次 invocation 必须绑定一个 `StepRun.kind=model`：

- admission 原子提交 `ready → running`、Run version/event、RunEvent、
  StepRunMutation 和 ModelInvocationStart；
- completion 原子提交 usage/cost/byte receipt 与
  `running → succeeded|failed|timed_out|lost`；
- `succeeded` 的 StepRun 只保存 `outputRef=model-invocation:<id>`，正文默认不进入
  Start、Completion、RunEvent 或 mutation；
- deadline 映射为 `timed_out`；
- provider 调用后的 caller abort、consumer stream cancel 或其它结果未知映射为
  `lost/outcome_unknown`，只允许人工裁决，不自动 replay。

Start/Completion/Command 使用独立 v1 schema 和 domain-separated SHA-256 digest，
单 record/command JSON 最大 24 KiB。完整绑定 Project、Run、StepRun、Trace、provider、
model、policy revision、request digest、deadline、输入/输出字节、token 与可选费用。

### 2. mutation identity 必须由摘要派生

requestId 最长 128 字符，不能用 `requestId + ':started'` 生成事件 ID。
`createModelInvocationMutationIdentity` 以 invocationId、phase 和独立 domain 派生完整
SHA-256，并产生均不超过 128 字符的 mutation/event/dedupe identity。Start 与
Completion normalizer 同时复验 identity、StepRun digest/version、Run event sequence
和 command digest；身份或内容复用漂移一律 conflict。

### 3. durable admission 不得被 Abort race 脱离

Policy 解析和 provider Promise 可以被 deadline 从调用方视角中止；durable admission
不可以。Gateway 必须等待 audit/start sink 自身的受限数据库操作结束：

- admission 未成功时 provider I/O 为零；
- deadline 在 admission 中到达且 start 最终提交时，随后写入 `timed_out` completion；
- admission sink 失败时返回 `MODEL_AUDIT_UNAVAILABLE`；
- terminal sink 失败时不把 provider 结果交给上层。

这会让一个超时的 admission 在 repository timeout 内继续占用一个有界并发槽，但避免
后台出现无法解释的 running StepRun。repository 必须有 statement/busy timeout，不能
用 Gateway Promise race 替代数据库取消和事务收敛。

### 4. migration、repository 与 coordinator 留在可选 AI 能力族

SQLite 和 PostgreSQL feature migration、原子 repository、durable coordinator 与
recovery 都进入既有 `@qinglong/ai` 的显式 subpath，不新增 workspace package。
双方言实现只依赖 `node:sqlite` 或 runtime-core 的 structural PostgreSQL
Pool/Client port，不导入 Drizzle、`pg`、local-sqlite 或 cluster-postgres，也不增加
optional peer。具体 Profile 只在启用 AI 时注入已有数据库 authority。

AI schema 使用独立 feature migration stream：

- AI 未启用时不运行 feature migration、不创建表；
- feature history 使用独立表、stream identity 和 checksum，绝不向双方言 main
  migration history 插入 feature row；
- PostgreSQL feature tables/history 位于独立 `ql3_ai` schema，避免被核心 `ql3`
  exact readiness 误判为未知表；SQLite readiness 保留精确 owned-table 校验并允许
  同库显式 feature table；
- 启用 composition 必须先显式 migrate/readiness，再构造 repository；
- PostgreSQL runtime role 对不可变 invocation 表只取得 `SELECT/INSERT`，不得为了
  `FOR UPDATE` 扩大 `UPDATE/DELETE`；
- repository subpath 只取得数据库 authority，不取得 provider credential 或外部网络。

Gateway admission sink 返回 `created|existing`。只有 `created` 可开始 provider I/O；
`existing` 包括正常重放和 COMMIT 响应丢失后的耐久回查，必须返回
`MODEL_INVOCATION_REPLAY_BLOCKED`，禁止再次调用 provider。bounded recovery 只扫描
已过数据库 deadline 且没有 completion 的 start，并收敛为
`lost/outcome_unknown`，不自动重放模型。

### 5. unknown outcome 只能以不可变人工 Resolution 推进

`lost/outcome_unknown` 不再是永久死点，也不能被自动 retry。唯一出口是受信 User
提交一个 `qinglong/model-invocation-resolution@v1` receipt，决策严格限定为：

- `retry`：原子执行 `lost → ready`，清除旧结果字段；后续 `ready → running` 必须
  使用新的 invocationId，StepRun attemptCount 在新 start 时增加；
- `fail`：原子执行 `lost → failed`，固定
  `resultCode=model_outcome_rejected`；
- `cancel`：原子执行 `lost → cancelled`，固定
  `resultCode=model_outcome_cancelled`。

Resolution/Command 绑定原 Completion digest、Project/Run/StepRun/Trace、User ID、
StepRun version/digest、mutation/event/dedupe identity 与时间。repository 必须在同一
SQLite/PostgreSQL 事务内复验原 completion 仍是 `outcome_unknown`、当前 StepRun 仍
精确等于该 completion 的 `lost` winner，然后提交 StepRun/Run/RunEvent/
StepRunMutation/Resolution。每个 invocation 只能有一个 Resolution；相同命令 exact
replay，不同 User/decision conflict。

一个 StepRun 可以有多个 attempt，因此 Start/Completion 表不能再对
`(run_id, step_run_id)` 建唯一索引。它们改用包含时间和 invocationId 的普通历史索引，
invocation、mutation、RunEvent 和 digest 继续保持唯一。旧 Start/Completion/
Resolution 永不覆盖，新 attempt 形成新的 invocation 链。

## 被否决方案

1. 把 adapter 放入双方言 storage package 并反向 optional peer AI：会污染默认 packlist，
   且真实 Edge artifact 已证明即使 AI 不安装也会增加文件。
2. 在 AI 包引入 `pg`/Drizzle：会扩大可选 Edge AI 的依赖和供应链闭包。
3. 把 durable contract 放入 runtime-core root：禁用 AI 的基础 artifact 也会增长。
4. 把 AI 表加入双方言 main migration：禁用功能仍产生 schema、备份和写放大。
5. start audit 使用 `Promise.race`：调用返回后事务仍可能提交 running 状态。
6. 对 unknown outcome 自动 retry：可能重复计费且输出非确定。
7. 保存 Prompt/输出便于调试：默认扩大 Secret、个人数据和备份泄露面。

## 当前验证

- `@qinglong/ai` 默认门：50 pass、1 条 PostgreSQL 条件 skip；真库门另 1 pass；
- 最大长度 requestId 的 mutation/event/dedupe identity 均不超过 128 字符；
- admission deadline 期间 provider 调用为零，start sink 不脱离，随后写入明确的
  deadline failure；
- success、deadline 与 caller-abort 分别收敛为
  `succeeded`、`timed_out`、`lost/outcome_unknown`；
- SQLite 与 PostgreSQL feature history 使用独立表；主迁移与 AI 迁移交错重启通过；
- SQLite 原子 admission/completion、provider replay block 和 expired recovery 通过；
- SQLite Edge `DELETE/FULL` 与 Standalone `WAL/FULL` 共 14 个真实文件
  `SIGKILL` 窗口通过：10 个 COMMIT 前窗口零部分事实并重放 `created`，4 个 COMMIT
  后窗口重启为 durable winner 并重放 `existing`，全部 `integrity_check=ok`；
- PostgreSQL 18 真库以 migration/runtime 分角色验证原子事务、exact replay、rollback、
  bounded recovery source，以及 invocation 表仅 `SELECT/INSERT`；
- PostgreSQL ModelInvocation `COMMIT` 已提交但响应丢失时，provider 调用为 0，
  coordinator durable recheck 返回 existing，recovery 收敛为
  `lost/outcome_unknown`；
- SQLite 与 PostgreSQL 都覆盖 User `retry/fail/cancel` 原子 Resolution；`retry`
  后同一 StepRun 可用新 invocationId 进入第二次 running，attemptCount 从 1 增至 2，
  原 unknown completion 保持不变；不同 decision replay 被拒绝；
- dependency audit `findings=[]`，AI 只有 runtime-core workspace dependency；
- Edge 基线仍为 3,902,728 bytes/478 files/40 modules；edge-ai 为
  4,212,508 bytes/508 files/41 modules，standalone-ai 为
  4,212,580 bytes/508 files/41 modules；
- ADR-0170 已把非空 usage 从 Completion 原子投影为独立不可变 ledger；失败 outcome
  也保留已知 usage，无 usage 不伪造零成本，exact replay 同时复验 Completion 与
  ledger；
- PostgreSQL 18.4 arm64 完整 HA 门通过 physical streaming、timeline 1→2、fencing、
  双 control replica、`pg_rewind` 与总 `passed=true`；`ql3_ai` 独立 history 和
  Start/Completion/Resolution/UsageLedger 四表在 promotion 前后 9001/9002
  checksum、表集与 runtime append-only ACL 完全一致，
  `optionalAiFeatureSchemaSurvivesPromotion=true`。

## 后续门禁

1. credential binding audit 的双方言持久化，以及 binding digest 与 invocation
   查询的关联；Project-bound SecretRef 和可清零 material lease 已由 ADR-0169
   完成；
2. ADR-0170 ledger 之上的原子 Project quota、计价 catalog/revision、不可变 rollup
   与 retention coverage receipt；
3. AI invocation 数据行级 promotion/partition fault，而不只 schema promotion；
4. 正式产品 importer、配置 ceremony、read-only usage/Copilot/MCP authority；
5. 在这些门禁完成前保持 HTTP/MCP/UI 产品 route 和费用配额关闭。
