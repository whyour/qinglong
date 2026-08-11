# ADR-0067：SQLite 事实驱动的本机 Run 启动恢复预检

- 状态：Superseded（由 ADR-0068 细化）
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-02、D-17、D-37、D-42、D-52、D-55、D-62、D-65、D-66
- 关联 ADR：ADR-0001、ADR-0007、ADR-0040、ADR-0044、ADR-0053、ADR-0056、ADR-0063、ADR-0066、ADR-0068

## 上下文

ADR-0066 已建立 `adopted storage → assembly → recovery → lifecycle → admission` 激活门，但由注入 stack 返回的 recovery summary 仍是进程内声明。如果具体 stack 尚未装入真正的 Run Reconciler，一个恒真的 `safe: true` 就可能让 SQLite 中已有 `dispatching/running` Run 的 target 开放 admission。这违反数据库事实源原则，也会把“组合边界已成立”误报成“历史执行副作用已收敛”。

本机 Profile 还必须覆盖低性能路由设备。启动检查不能扫描全表、创建第二个 SQLite 连接、安装 timer/watcher，或为零候选启动完整 recovery supervisor；但 standalone 也不能因为数据更多而静默截断后继续启动。

## 决策

### 1. 在 runtime-core 定义 Profile-neutral 只读候选端口

新增 `LocalRunStartupRecoverySource`，只暴露 `inspectCandidates({ limit })`。返回页只有严格字段：

- `candidates`：`runId`、`runStatus` 和 `activeAttemptCount`；
- `truncated`：查询结果是否超过本页硬上限。

候选状态只允许 runtime-owned Run 的 `dispatching/running`。`queued`、等待、retry、terminal 和 legacy-owned Run 不属于这次启动遗留预检。端口只发现事实，不 claim、不推进状态、不调用 Executor，也不决定是否重放。

### 2. SQLite adapter 复用唯一 Repository authority

`@qinglong/local-sqlite` 在现有 `LocalSqliteRunRepository` 上实现该端口，复用同一个 `DatabaseSync`、串行 operation queue、256 pending-operation 上限和 close fence。禁止为预检创建第二连接、后台 worker、timer 或 watcher。

查询按 Run ID 确定性排序，使用 `limit + 1` 判定截断；单次 limit 必须在 1–256 内。每个候选同时计算 `claimed/starting/running` Attempt 数量，但候选身份由 Run durable status 决定。任何 row、计数或页契约畸形都由上层 fail closed。

### 3. Application 在 stack recovery 前强制数据库候选门

enabled 激活顺序细化为：

```text
adopted storage ready
  -> assemble side-effect-free application stack
  -> receipt-first local Run reconciliation
  -> domain recovery summary safe
  -> lifecycles started
  -> admission installed
  -> active
```

组合根固定以 256 为 limit。最初切片只允许 `candidates=[] && truncated=false` 进入 stack recovery；ADR-0068 已将该只读门细化为 receipt-first Reconciler：候选可被原子终态化，或在双重 verifier 中被证明为同一个仍存活进程。截断、存储错误、畸形或证据不足仍抛出 `LocalApplicationStartupRecoveryRequiredError`，不得启动 lifecycle 或 admission，并按 ADR-0066 关闭 stack 与 storage、释放 source fence。

错误只暴露候选计数和截断标志，不携带 Run ID、命令、路径或用户输出。stack factory 只允许装配资源，不得在构造期启动 listener、timer、Executor 或 admission；需要副作用的初始化必须进入受 gate 约束的 recovery/lifecycle。

### 4. 本 ADR 的只读切片不冒充 Reconciler

本 ADR 当时交付的是 read-only fail-closed gate，不会把 Run/Attempt 标记为 `lost`，不会检查 completion receipt 或 durable process identity，不会消费取消意图，也不会创建新 Attempt 或重放任务。

ADR-0068 已交付首个真正的本机 Run Reconciler：逐候选先复核 receipt、再检查进程身份，并以 Repository transaction 原子推进 Run/Attempt/event；最终 verifier 允许精确稳定的活进程继续存在。它仍不自动 replay、创建新 Attempt 或替代人工 recovery 产品流程。

## 被否决的替代方案

1. **只信任 stack 的 `safe: true`**：注入契约可在实现缺失时误报，拒绝。
2. **扫描全部非终态 Run**：正常 queued/等待工作会阻止启动且查询无界，拒绝。
3. **发现 `running` 后直接标记 lost**：数据库状态不能证明外部进程或副作用已经停止，拒绝。
4. **截断后检查前 256 条并继续**：会把未观察事实当作不存在，拒绝。
5. **另开 SQLite 连接或后台定时扫描**：制造双 authority、锁竞争和路由设备隐性资源成本，拒绝。
6. **复用 cluster PostgreSQL recovery supervisor**：会把 claim、多副本与 cluster driver 职责带入本机产物，拒绝。

## 影响与未完成项

正向影响：

- application admission 首次直接受真实 SQLite Run 事实约束；
- edge 零候选只支付一次有界只读查询，不增加常驻 timer、连接或内存表；
- standalone 数据超过上限时显式转入恢复要求，而非静默漏检；
- local 与 cluster 共享“独立事实 verifier”原则，但保持不同 adapter 与 recovery authority。

仍未完成：

- 3.0 launcher 生成 completion receipt 与 durable process handle 的纵向装配；
- cancellation/retry、人工 recovery 与 receipt cleanup journal；
- 恢复进度、候选详情和人工裁决 API/UI；
- 断电、强杀、真实 Linux x64/arm64 与固定路由设备资源基线。

因此本 ADR 的历史结论仍只证明“存在 durable Run 遗留时不会错误继续激活”；当前自动安全恢复能力与更精确的继续条件以 ADR-0068 为准。

## 验证

1. SQLite 只返回 runtime-owned `dispatching/running`，排除 terminal、等待和 legacy Run，并正确统计 active Attempt。
2. 查询按 Run ID 稳定分页，超过 256 条显式 `truncated=true`；非法 limit 和 close 后访问 fail closed。
3. local-profile 与 adopted-profile 向上提供同一 `startupRecovery` authority，不新建数据库连接。
4. 真实 target SQLite 中存在一个不可判定候选时，local-application 在 stack recovery/lifecycle/admission 前拒绝并释放 source fence；可信回执或 exact 活进程按 ADR-0068 收敛。
5. 257 个候选时只观察 256 个并因截断拒绝，不能以部分扫描宣称安全。
6. package、导入闭包、production 产物与 RSS 门禁继续证明 edge/standalone 不携带 cluster、legacy ORM 或额外 SQLite native addon。
