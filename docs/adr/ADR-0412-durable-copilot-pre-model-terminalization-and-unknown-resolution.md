# ADR-0412：耐久 Copilot Pre-Model 终态化与 Model Unknown Resolution

- 状态：Accepted
- 日期：2026-08-15
- 关联 RFC：QL-RFC-0001 D-320、Phase 2
- 关联 ADR：ADR-0087、ADR-0407、ADR-0408、ADR-0409、ADR-0411

## 问题

ADR-0411 已把 Cluster Copilot failure diagnosis 组合到既有、默认关闭的 Cluster AI 进程，但成功链之外仍有两类不收敛窗口：

1. Tool `failed|timed_out`、日志 `not_found|pending|missing|retired`、执行 Tool 所需的固定预算不足、数据库观察到 deadline 或 cancellation 时，Model 尚未开始，diagnosis Run 可能永久停留在 `running`；
2. Provider 已开始但结果不可确认时，通用 ModelInvocation 会耐久记录 `outcome_unknown` 和 `lost` Step。人工 `fail|cancel` resolution 会产生一个新的 resolved Step digest，原 Copilot finalizer 却仍只接受 unknown completion 时的 `lost` digest，因此正确 resolution 也无法终态化父 Run。

不能由调用者直接提交 outcome/reason，也不能用进程内异常或定时器伪造耐久终态。路由器和低配设备部署还要求该补强不能增加 package、进程、连接、队列、watcher、timer 或默认 Profile 闭包。

## 决策

1. 在 `@qinglong/ai` 的既有 `copilot/failure-diagnosis/terminalization` 领域目录建立一个 pre-Model terminalization capability，并仅通过 `failure-diagnosis-pre-model-terminalization` 精确 subpath 发布。它不是新 package，也不从 package `src` 根平铺实现文件。
2. terminalizer 只接受三种受信触发：耐久 Tool failure completion、耐久 Tool success 加受审日志 projection、或无调用者事实的 boundary observation。repository 再从数据库读取 exact admission、Run、Tool/Model Step、Model start existence 和数据库时间；调用者不能指定 reason、outcome、Step mutation、Run version 或时间。
3. reason 与结果采用封闭映射：
   - `tool_failed` → Run `failed`，取消尚未运行的 Model Step；
   - `tool_timed_out` → Run `timed_out`，取消 Model Step；
   - `log_not_found|log_pending|log_missing|log_retired` → Run/Model Step `failed`；
   - `tool_budget_exhausted|deadline_exceeded` → Run `timed_out`，按 Step 当前状态写 `timed_out|cancelled`；
   - `cancellation_requested` → Run `cancelled`，取消未开始的两个 Step。
4. 任何 Model start 已存在时都拒绝 pre-Model terminalization。Model 已经跨过外部副作用边界后，只能使用 Model completion/recovery/resolution 语义，不能把“不知道”改写为“没有执行”。
5. `pg-9021-ai-copilot-failure-diagnosis-pre-model-terminalizations` 增加一个 append-only content-free receipt ledger。`ql3_runtime` 只有 `SELECT, INSERT`，PUBLIC 和其他角色没有权限。一个 `SERIALIZABLE` 事务锁定 Run/Step，复验 admission、reason evidence、version/digest 和 Model-start absence，原子提交 StepRun mutations、RunEvents、父 Run 终态和 receipt；COMMIT response loss 通过 receipt exact replay 收敛，不重复 Tool、日志读取或 Model 调用。
6. application service 在 Tool 执行前先检查 boundary terminalization；Tool failure 和非 available 日志 projection 直接进入 terminalizer；只有 available projection 才继续 unlock/Model。Tool 的固定五秒预算必须完整落在 plan deadline 内，否则在 start barrier 前终态化。并发调用继续由既有 request coalescing 收敛。
7. `outcome_unknown` 不自动重试、不自动假定失败。强认证 User 仍须通过通用 `DurableModelInvocationResolutionCoordinator` 显式选择 `fail|cancel|retry`。Copilot finalizer 对普通 completion 校验 completion 后 Step digest；对 unknown 的 `fail|cancel` 校验 resolution completion binding 和 resolution mutation 的 resolved Step digest，再终态化父 Run。`retry` 保持 in-progress，且确定性 invocation identity 不允许偷偷再调用 Provider。
8. 该 capability 继续 caller-driven，并复用既有 PostgreSQL AI Pool、Run/Step ledger、Tool completion、ModelInvocation resolution 与 Cluster composition；不新增 daemon、scan、timer、watcher、队列、cache、HTTP/CLI/UI/MCP route、Pod 或 Kubernetes API 权限。默认 Edge/Standalone 及其 AI 制品不导入 Cluster-only composition，低配部署没有新增常驻工作。

## 被否决方案

1. **由 application catch 后直接返回失败**：没有耐久 Run/Step/Event 事实，崩溃和 replay 会漂移。
2. **调用者提交 reason/outcome**：会把数据库时间、取消事实和 Tool completion authority 暴露给不可信边界。
3. **后台轮询扫描所有 diagnosis Run**：增加每副本 timer/数据库负载，并与 caller-driven 组合重复竞争。
4. **Model start 后仍走 pre-Model terminalizer**：可能把已经产生费用或外部结果的调用伪装为未执行。
5. **将 unknown completion 直接映射为 failed**：抹掉真实歧义并绕过显式人工 resolution。
6. **新增 terminalization package**：没有独立部署、依赖、权限或多 consumer 边界，只会制造薄 package。

## 验证标准

1. 单元测试覆盖 Tool failure/timed-out、四种日志状态、deadline、Tool budget、cancellation、exact replay、并发 coalescing、过早触发和 Model-start 后拒绝。
2. PostgreSQL migration 测试固定 migration ID、顺序、表约束和 `SELECT, INSERT` 最小权限；package/dependency/import/deployment 审计必须保持零 finding。
3. PostgreSQL 18 physical HA 以三个独立 diagnosis Run 证明：成功基线、日志不可用 pre-Model terminalization、unknown completion→人工 fail resolution→finalization；晋升后全部 exact replay，不重复日志读取、Tool 或 Model 外部执行。
4. 18-package clean build/test、完整 backend、14 档 Local artifact、GitNexus staged/change detection 全通过后才允许阶段性提交。

## 当前验证

1. `@qinglong/ai` 完整测试 244 pass/3 条件 skip/0 fail；新增 9 条 pre-Model 场景覆盖 Tool failure、四种日志状态、deadline、固定 Tool budget、cancellation 和 Model-start fence。
2. 18 个 QL3 package 从清空全部 `dist` 开始完成拓扑构建和全包测试，非沙箱 TLS loopback 回归全绿；backend 1,207 pass/2 条件 skip/0 fail。
3. workspace 保持 18 个 package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。AI 192 个源码中 191 个位于嵌套领域目录；新增五个源码全部位于既有 failure-diagnosis 领域目录，package 根仍只有一个 16 行 public entrypoint。`local-command-file` 虽小但保留多 consumer 的独立 POSIX 文件安全边界，两个 migration 密集目录继续作为有顺序上限的 ledger 接受审计。
4. Edge import、Cluster dependency、package boundary 与 Cluster deployment 审计兼容且零 finding；14 档 Local artifact 通过，说明 Cluster-only terminalizer 未进入默认路由设备闭包。
5. PostgreSQL 18.6 arm64 physical HA 137/137、timeline `1→2`；21 条 AI migration、新 append-only ledger、最小权限、两条新增恢复链和晋升后 exact replay 全部通过。私有报告 SHA-256 为 `6eaeb20615a62d153c5a69687344f41f31351c6ecf111cfb9cbafad115538c83`，独立离线审计 `compatible=true`、零 finding。

## 后续门禁

下一 Gate 才能增加认证、Policy、audit、request identity 与 source fence 保护的 Cluster 产品 API；CLI/UI/MCP 必须复用同一 capability，不得建立旁路执行器。产品入口还需补多副本并发、真实外部 Provider、费用/取消可观测性和明文负证据后再评估默认策略。
