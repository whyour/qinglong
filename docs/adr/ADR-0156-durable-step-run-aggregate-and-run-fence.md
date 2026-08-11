# ADR-0156：耐久 StepRun Aggregate 与 Run Fence

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0001、ADR-0133、ADR-0154、ADR-0155；RFC D-03/D-131/D-148/D-149

## 背景

ADR-0155 已经要求任何 Tool adapter 在产生外部副作用前绑定独立的 StepRun、Trace 和
Audit evidence，但当时只有 evidence receipt 的纯契约。`RunEvent.step_run_id` 和
`RunAttempt.step_run_id` 仍是 nullable 占位列，不能证明：

- 工作流中的逻辑步骤具有独立、可恢复的状态；
- 同一次 mutation 没有在响应丢失后被重复应用；
- StepRun 变更和所属 Run 的 version/Event sequence 属于同一个提交；
- Attempt/Event 引用的 StepRun 确实属于同一个 Run。

直接为 StepRun 新建 workspace package 也没有独立部署、权限或版本生命周期依据，会让
低配路由器承担不必要的 importer 和依赖闭包。

## 决策

### 1. 领域契约留在 runtime-core 的显式 subpath

`@qinglong/runtime-core/step-run` 提供 profile-neutral 的 exact contract，不新增
workspace package 或第三方依赖：

- immutable `qinglong/step-run@v1` record；
- `task|tool|model|agent|condition|approval|subworkflow` 七种 kind；
- `pending → ready → waiting_approval/running → lost/terminal` 的封闭状态机；
- 每个 Run 最多 128 个 StepRun、每个 StepRun 最多 64 次 attempt；
- create/transition mutation 同时绑定预期 Run version/Event sequence、旧 StepRun
  version/digest/status 和 canonical RunEvent；
- repository 只公开 exact replay、按 identity 查询和稳定 keyset pagination。

StepRun 不保存 handler、input 明文、Secret、任意异常或 execute seam。`inputRef`、
`outputRef` 只能指向后续受控 Artifact 边界。

### 2. StepRun mutation 是 Run aggregate 的一部分

双方言 repository 必须在一个短事务中：

1. 串行化同一 Run；
2. 优先识别 exact mutation replay；
3. 校验 Run version/Event sequence 且拒绝 terminal Run；
4. create 或 compare-and-set StepRun；
5. 同时推进 Run version/Event sequence；
6. 插入 canonical RunEvent；
7. 插入 immutable StepRun mutation ledger；
8. 提交后才返回 applied。

历史 mutation 的 exact replay 必须返回当时的 StepRun、Run version 和 Event sequence，
即使当前 StepRun 已继续推进。相同 mutation identity 绑定不同内容必须失败关闭。

### 3. SQLite 与 PostgreSQL 保持语义对等

SQLite capability v26 使用 `0051-step-runs` 与 `0052-capability-v26`：

- `StepRuns` 保存完整镜像列和 canonical JSON，并用完整 CHECK 双向绑定；
- `StepRunMutations` 保存历史结果和 Event/Run fence；
- 四个 exact readiness-audited trigger 限制 RunAttempt/RunEvent 只能引用同 Run
  StepRun；
- repository 复用单个 `LocalSqliteOperationAuthority` 和 `BEGIN IMMEDIATE`。

PostgreSQL capability v27 使用 `pg-0028-step-runs`：

- `ql3.step_runs` 与 `ql3.step_run_mutations` 采用同一记录和 ledger 语义；
- 复合 foreign key 在数据库层绑定 `(run_id, step_run_id)`；
- repository 使用 `SERIALIZABLE`、固定 statement/lock/idle timeout 和最多三次
  serialization/deadlock retry；
- 只有 `ql3_runtime` 具有 StepRun 的 SELECT/INSERT/UPDATE 和 mutation ledger 的
  SELECT/INSERT，其他产品角色保持零表权限。

两种方言允许使用不同数据库机制，但状态机、digest、fence、重放和上限必须一致。

### 4. 继续保持 production execution 不可达

显式 `local-sqlite/step-run` 与 `cluster-postgres/step-run` subpath 只提供存储能力；
root、通用 runtime、admin、worker ingress 不重新导出该 authority。当前不把仓储接入
任何 Tool adapter，也不提供 execute API。

只有后续同一 Tool start-barrier transaction 能够精确证明 plan/dispatch、StepRun、
Trace 和 Audit 全部耐久化，才允许产品 composition 取得 adapter authority。

## 被否决方案

1. **每种 Step kind 一张表**：放大 migration、查询与恢复复杂度，拒绝。
2. **只写 RunEvent，不建 StepRun aggregate**：没有独立状态和 CAS fence，拒绝。
3. **StepRun 独立提交后再更新 Run/Event**：崩溃窗口会产生不可解释的半提交，拒绝。
4. **用 `(run_id, step_key)` 作为唯一 identity**：重命名和子工作流展开会混淆稳定
   identity，拒绝。
5. **为 StepRun 新增 workspace package**：没有独立部署/权限生命周期，拒绝。
6. **PG 只用应用层检查同 Run 引用**：旁路 SQL 可以制造跨 Run 引用，拒绝。
7. **旧 mutation 只返回当前 StepRun**：不能证明响应丢失前实际提交的结果，拒绝。

## 验证

- runtime-core StepRun 定向领域测试：10/10，完整 runtime-core：297/297；
- local-sqlite 完整测试：100/100；
- cluster-postgres package 测试：153 pass、1 条件 skip；
- PostgreSQL 18.4 arm64 六角色真实 integration：39 pass、1 条件 skip，覆盖 StepRun
  create、transition、历史 replay、查询和同 Run foreign key；
- PostgreSQL 18.4 arm64 physical HA：主备复制、fencing、promotion、`pg_rewind`、
  双 control replica 与总 gate `passed=true`；
- 未新增 workspace package、第三方依赖、timer、watcher、socket 或常驻进程。

## 后续门禁

1. 实现有界、append-only 的 Tool Trace span 与 Audit evidence receipt；
2. 实现 opaque/encrypted plan 和 redacted preview Artifact；
3. 把 plan/dispatch、StepRun、Trace、Audit 在同一 start barrier 中提交或精确重放；
4. 为 built-in、isolated process、MCP、HTTP 和 Worker adapter 分别定义启动后恢复证据；
5. 完成双方言故障注入、物理 edge 和 PostgreSQL HA 后，才解除 production
   unreachable。
