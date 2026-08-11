# ADR-0070：本机 Run 原子启动协调与耐久身份补偿

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-02、D-05、D-17、D-37、D-40、D-42、D-62、D-65、D-66、D-67、D-68、D-69
- 关联 ADR：ADR-0001、ADR-0003、ADR-0005、ADR-0007、ADR-0026、ADR-0040、ADR-0044、ADR-0063、ADR-0066、ADR-0068、ADR-0069

> ADR-0087 现行增量：本文 coordinator 已迁入 `@qinglong/local-execution/execution`；package 不提供聚合根入口，原子启动与 durable identity 补偿语义不变。

## 上下文

ADR-0069 已交付 pre-spawn journal、受审 launcher、completion receipt 与 exact Linux durable identity，但 launcher 只证明“怎样安全 spawn”，不能决定“哪个 Run/Attempt 有权 spawn”。若 scheduler、Workflow 或 application stack 直接取得 launcher，它可以在 `attempt.starting`、callback authority 或 deadline 尚未提交时创建进程；控制面此时崩溃会留下没有可解释数据库意图的外部副作用。

另一个窗口发生在 spawn 已成功、`executor_handle/pid` 尚未提交时。简单把 Attempt 标为 `lost` 会让仍在运行的原进程与后续重试并存；只按裸 PID stop 又可能杀死复用 PID。把这段策略塞回 legacy Primary orchestrator、Sequelize adapter 或 local-process，会分别重新引入 2.x 根依赖、数据库实现泄漏或基础设施反向依赖应用策略。

## 决策

### 1. 启动策略使用独立 local-execution package

新增 `@qinglong/local-execution`，生产只依赖 `@qinglong/runtime-core` port 与 `@qinglong/local-process`。固定依赖方向为：

```text
runtime-core
  <- local-process
  <- local-execution

runtime-core + local-process
  <- local-run-recovery

local-adopted-profile + local-execution + local-run-recovery
  <- local-application
```

local-execution 不导入 local-sqlite、Profile、legacy、cluster、ORM 或 HTTP。真实 `LocalSqliteRunRepository` 只在测试和组合根通过 runtime-core port 注入。local-process 不反向依赖 execution 或 recovery；execution 与 recovery 并列，前者拥有新启动协议，后者拥有崩溃后证据裁决。

launcher、coordinator 和 durable controller 均由组合根私有构造；ADR-0071 后 application 只暴露有界 dispatcher。上层不能绕过不可变执行定义、Artifact admission 或聚合事务取得裸 spawn capability。

### 2. spawn 前必须原子建立执行 authority

coordinator 只接受同时满足以下条件的 aggregate：

- Run 是 runtime-owned、`queued` 且没有 cancellation intent；
- Attempt 是该 Run 的 latest Attempt、状态为 `claimed`、executor type 为 `local_process`；
- callback sequence 为零，callback digest、Worker/Lease/Offer、handle/PID、deadline、日志、开始/结束和错误字段均未被旧 authority 占用。

它生成 256-bit callback capability，只把 SHA-256 digest 持久化。第一次 Repository transaction 依次 CAS：

1. Run `queued → dispatching` 并追加 `run.dispatching`；
2. Attempt `claimed → starting`，保存 callback digest、可选 deadline/log artifact，并追加 `attempt.starting`。

两个 event 各自消耗一个 Run version/event sequence，但整个 transaction 要么全部提交，要么全部回滚。事务失败时不得调用 launcher。callback 明文只在进程启动调用栈中传给 launcher，不进入数据库、Event、日志或 coordinator 返回值。

### 3. spawn 后必须原子保存耐久 ownership

launcher 仍按 ADR-0069 在用户代码前登记 receipt journal、验证同一 launcher fd 并捕获 exact Linux identity。返回后 coordinator 复核 handle/PID/timestamp，再在第二个 Repository transaction 内依次 CAS：

1. Attempt `starting → running`，保存完整 durable handle、PID 与 started time，追加 `attempt.running`；
2. Run `dispatching → running`，保存 started time，追加 `run.running`。

只有第二个 transaction 提交后调用方才能观察到成功启动。重复调用因 aggregate 已离开 `queued/claimed` 被拒绝，不通过内存 active map 决定唯一性。

### 4. 两类失败使用不同终态与补偿

launcher 在取得可返回 durable ownership 前失败时，它已保证任何可能 spawn 的进程组被停止。coordinator 将 `starting/dispatching` 在一个 transaction 内收敛为 Attempt/Run `failed`，错误码为 `EXECUTOR_START_FAILED`。

若 launcher 已返回 durable handle，但 running ownership transaction 失败，coordinator 必须先通过 `LocalProcessController` 停止 exact identity：

1. 解析 handle 并复验 boot ID、PID、process group 与 start ticks；
2. 只对匹配进程组发送 TERM，并在有界 grace 内复验；
3. 升级 KILL 前再次复验完整身份，PID 已退出或复用时不得 signal；
4. 只有 `stopped`/`already_exited` 才把 aggregate 原子标为 `lost`；
5. `unknown`、provider unavailable、signal failure 或 timeout 时保留 `dispatching/starting`，由 ADR-0068 startup recovery 继续 fail-closed 裁决。

补偿终态自身写失败时也保留 durable starting fact；不能为了返回一个整洁错误而伪造进程已停止。

### 5. 本切片不增加常驻资源

coordinator 是一次性调用对象，没有 timer、watcher、队列、active handle map、第二数据库连接或目录扫描。edge 与 standalone 执行相同安全语义；Profile 差异仍只存在于 recovery/cleanup cadence 和后续 admission/并发预算。cluster-control/Worker 使用 Session/Lease/attestation authority，不复用本机 PID 协议。

## 被否决的替代方案

1. **把 launcher 直接交给 scheduler/stack**：允许未提交 start intent 的 spawn，拒绝。
2. **继续复用 legacy PrimaryRunOrchestrator**：重新依赖 legacy domain、Sequelize、全局 lifecycle，拒绝。
3. **把协调逻辑放进 local-process**：基础设施开始持有 Run 状态与 Repository 策略，形成错误依赖方向，拒绝。
4. **spawn 后写失败直接 lost**：无法证明原进程已停止，会制造双执行，拒绝。
5. **用裸 PID 或只检查一次 identity 后 TERM/KILL**：PID 可复用，TERM 与 KILL 之间身份也可能变化，拒绝。
6. **用 process-local active map 防重**：跨 worker/重启无效，且绕过数据库 aggregate CAS，拒绝。

## 影响与未完成项

已完成：

- 独立 local-execution importer 与 production dependency/source/lock 审计；
- `queued/claimed → dispatching/starting → spawn → running/running` 两段原子协议；
- callback plaintext 隔离、digest 持久化和 sequence fence；
- pre-ownership failed 与 post-spawn exact stop + lost/starting 补偿；
- TERM/KILL 前 exact durable identity 复验；
- local-application 私有装配 coordinator，不再向 stack 暴露 coordinator 或 launcher；
- ADR-0071 的有界 dispatcher、不可变 execution revision/context recipe、Secret-first materializer、Artifact admission 与输出 hard quota；
- 真实 Node 24 SQLite 的成功、启动失败、持久化失败、补偿不确定和重放拒绝测试。

仍未完成：

- 具体加密本机 Secret provider、Task definition 管理权限/审计与 Artifact retention/read stack；
- ADR-0072 已闭环 live completion receipt、cancellation、timeout 与 shutdown drain；仍缺 retry 的安全产品入口与协调；
- 对 controller 的 Linux x64/arm64、PID namespace、权限拒绝、断电与固定物理路由器门禁；
- target executable、systemd/Docker/s6 controller 和 API/UI 状态。

因此本 ADR 交付的是可安全调用的 3.0 本机启动内核，不表示已有 scheduler 生产入口，也不授权插件、AI Agent 或旧 Cron 直接执行命令。

## 验证

1. launcher 观察到数据库已是 `dispatching/starting`，callback digest、deadline 与前两条 Event 已提交。
2. 成功启动后 Run/Attempt 为 `running/running`，version/event sequence 连续为四次推进，callback plaintext 不在返回值中。
3. launcher failure 收敛为双 `failed`，不会调用 durable controller。
4. running transaction 注入失败时，exact controller 先被调用；stop 成功后双 `lost`。
5. stop unavailable 时 aggregate 保持 `dispatching/starting`，重启恢复候选仍可发现。
6. controller 在 TERM 与 KILL 前都复验 full identity；invalid handle 不发 signal。
7. 第二次启动同一 Attempt 被 durable aggregate 拒绝。
