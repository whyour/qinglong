# ADR-0380：Local lost Run retry 复用单一 execution-control cadence

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-292
- 前置决策：ADR-0021、ADR-0066、ADR-0067、ADR-0232、ADR-0366

## 上下文

Cluster 已消费 admission-time `RunRetryPolicy`，但 Edge/Standalone 的启动恢复只能把确定不再运行的本地 Attempt 与 Run 标记为 `lost`。此后没有生产 consumer 处理该状态：安全且显式启用的重试不会创建新 Attempt，禁用、unsafe 或耗尽的 Run 也不会终态关闭。

直接复制一套 Local retry policy、建立独立 lifecycle package，或为 retry 新增 timer/SQLite 连接都会形成不合理架构。纯 transition 本来就是 profile-neutral，只因最初由 Cluster 接入而使用 `Cluster*` 名称；本地运行时也已经拥有单 SQLite operation authority、`BEGIN IMMEDIATE` Run aggregate transaction 和唯一 execution-control timer。

## 决策

### 1. 通用契约留在现有 Runtime Core Run 域

不新增 workspace package，也不复制状态机。`runtime-core` 对既有纯 transition、page contract、coordinator 与错误发布 canonical `RunLostRetry*` 名称和 `run-lost-retry` subpath；早期 `ClusterRunLostRetry*` 名称继续兼容。新代码只能依赖 profile-neutral 名称。

该兼容层不创建第二份实现。后续在具备 call-graph-aware rename 工具和独立废弃周期后，才允许移动物理文件或删除旧名称；本切片不以文本替换破坏已有 Cluster consumer。

### 2. SQLite adapter 复用唯一 operation authority

`LocalSqliteRunLostRetryRepository` 位于 `ql3-local-sqlite/src/run`，不形成单文件微包。它：

- 只选择 runtime-owned、非 Workflow、无 cancellation intent、latest Attempt 为 `lost` 的 Run；
- `lost` 优先，`retry_wait` 仅在 durable `next_attempt_at_ms` 到期后进入候选；
- 候选发现是一次有界 authority 操作，每个候选在同一既有 `LocalSqliteRunRepository.transaction()` 中重读并原子 CAS Run、RetryPolicy，插入新 Attempt 与 Events；
- 已变化的候选返回 `raced`，响应丢失后的重放由当前 durable aggregate 自然收敛；
- 不拥有连接、cursor、timer、listener、watcher 或常驻内存队列。

没有 policy、未启用或 `maxAttempts<=1` 时以 `RUN_LOST_RETRY_DISABLED` 失败关闭；`safety=unknown` 以 `RUN_LOST_RETRY_UNSAFE` 失败关闭；耗尽以 `RUN_LOST_RETRY_EXHAUSTED` 失败关闭。只有 admission 时已证明 `idempotent|deduplicated` 的 policy 才能先进入 `retry_wait`，到期后创建一个全新、无执行 handle/lease 的 claimed Attempt。

### 3. Local application 复用现有控制周期

lost retry 注入 `LocalExecutionControlLifecycle`，每轮顺序固定为：

1. 消费内存中的 completion 通知；
2. 扫描 cancellation/deadline control；
3. 执行一页 lost retry；
4. 到慢周期时清理 completion receipt 与 Run log Artifact。

启动顺序仍为 startup recovery → 首次 execution-control cycle → scheduler。因而启动恢复刚写入的 `lost` 会在 Scheduler 首轮前进入安全 retry/终态。停机的 control drain 不再创建 retry work。

Edge 每轮最多 2 条，沿用 5 秒 control cadence；Standalone 每轮最多 16 条，沿用 1 秒 cadence。两者均复用已有 `unref` timer 和 SQLite authority，没有增加低配路由设备的空闲连接、常驻 sidecar 或独立唤醒源。

### 4. 明确不包含人工重试产品入口

本 ADR 只消费 admission 时冻结的自动 retry policy，不授予用户新的 mutation authority。`run.retry` Policy permission、人工 recovery API/CLI/UI、强认证、rate limit、审计与“对失败 Run 手工重跑”的产品语义仍需独立 ADR；不得把自动 lost retry 误报为人工恢复完成。

## 验收

- Runtime Core 验证通用名称与旧 Cluster 名称指向同一实现；
- SQLite 真库验证安全 lost → retry_wait → 新 Attempt 的原子闭环、禁用 policy 失败关闭、页上限、`hasMore` 与重放不重复；
- Local lifecycle 验证 control → lost retry → cleanup 顺序及重叠 `runOnce` 合并；
- Local application 真启动验证 startup recovery 后、Scheduler 前完成首次 lost retry；
- 受影响 package build/test、完整 QL3 package/backend 回归、dependency/package/Edge import audit 必须通过后才允许阶段性提交；
- package 数、migration 数、表/索引数、timer 数和 SQLite connection 数不得增加。

### 验收证据（2026-08-12）

- `pnpm run test:packages:ql3`：18 个 QL3 package 全量清理、构建与测试通过，退出码 0；
- backend 回归：1165 项中 1163 通过、2 项按环境条件跳过、0 失败；
- package boundary audit：18 个 package、1055 个 source file、1037 个 nested source file，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；
- cluster dependency audit：`findings=[]`；Edge import audit：121 个 imported module，root dependency 与 import 违规均为空；
- 本切片未新增 package、migration、表、索引、timer 或 SQLite connection。

## 被否决的替代方案

1. **新增 `ql3-local-retry` package**：只有一个 SQLite adapter，继续放大 package 碎片化，拒绝。
2. **复制 Cluster transition 为 Local 版本**：会让安全与终态规则漂移，拒绝。
3. **独立 retry timer**：增加路由设备唤醒、竞态和 shutdown 故障域，拒绝。
4. **启动时递归清空全部 lost backlog**：无法约束启动延迟与写放大，拒绝。
5. **`safety=unknown` 也自动重试**：可能复制不可逆外部副作用，拒绝。
6. **把人工 retry API 一并塞入本切片**：认证、Policy、审计与新 mutation 语义未冻结，拒绝。
