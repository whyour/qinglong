# ADR-0407：Cluster Copilot Failure Diagnosis Run Admission

- 状态：Accepted
- 日期：2026-08-15
- 关联 RFC：QL-RFC-0001 D-315、Phase 2
- 关联 ADR：ADR-0163、ADR-0226、ADR-0403、ADR-0404、ADR-0405、ADR-0406

## 问题

ADR-0403~0406 已经给出有界日志摘录 Tool、显式模型出口策略和 Cluster result-key material
authority，但仍缺少把一次故障诊断变成 durable execution 的入口。源 Run 已经处于 `failed` 或
`timed_out` 终态，不能向它追加 Tool/Model Step，也不能复用 Plugin Package Prompt admission
冒充 Copilot 工作流。

若仅在 API 内顺序调用 Tool 和模型，进程崩溃、响应丢失或 PostgreSQL failover 会让系统无法证明
已经接受了什么、下一步应该执行什么；若 admission 直接启动模型，模型又可能在 Tool 结果尚未形成
可信 encrypted completion 时读取未经 fencing 的数据。通用 Task recovery 也不能把这种以 StepRun
编排、没有顶层 RunAttempt 的聚合 Run 当成普通孤儿任务。

## 决策

1. 故障诊断创建独立 `copilot_failure_diagnosis` Run，并以源 Run 作为 `parentRunId`。源 fence 必须精确
   固定 Project、Run ID/version、`failed|timed_out` 状态、最新且已结束的 Attempt、兼容的 Attempt
   状态和非空日志 Artifact；admission 不修改或重新打开源 Run。
2. 计划只接受 `cluster-control` Profile 中经过 snapshot、Policy、subject 与 binding fencing 的
   `qinglong.run.log.excerpt@1.0.0` 内建只读 Tool。`approval_required`、不同 Tool/version、不同
   adapter/redaction/audit contract、输入 Artifact 未绑定源 Attempt 或权限漂移全部在数据库写入前
   失败关闭。
3. 模型 intent 固定 provider/model、`on_device|external` 边界、响应语言、输出 token 上限和 ADR-0405
   egress policy digest。计划与 receipt 均有 domain-separated digest 和字节上限；它们声明最终模型
   completion 必须加密、审计不得保存明文且 `actionAuthority=none`，本阶段不授予命令或写 Tool 权限。
4. 一个 SERIALIZABLE PostgreSQL 事务原子创建 diagnosis Run、admission event、`collect-log` Tool
   StepRun、`diagnose` Model StepRun 和 admission receipt。Tool Step 初始为 `ready`；Model Step 以 Tool
   Step 为父节点且初始为 `pending`。本阶段只 admission，不执行 Tool/模型；后续只有可信 Tool
   completion 成功后才能解锁 Model Step。
5. `ql3_ai.copilot_failure_diagnosis_admissions` 保存有界 plan/receipt JSONB 及关键列镜像。
   `SECURITY DEFINER` source snapshot 函数只授予 `ql3_runtime`，并在同一事务内重新确认 active Project、
   最新 active subject binding、源 Run/Attempt 状态与日志 Artifact。request identity 支持 response-loss
   replay；同 request 不同事实、任何 durable 镜像漂移或部分证据缺失均冲突或失败关闭。
6. PostgreSQL JSONB 的对象键序不具有语义；replay 采用严格的结构深比较，而不是比较
   `JSON.stringify` 文本。数组顺序、值类型、缺失/新增字段仍保持 exact，不能借键序修复放宽证据。
7. `copilot_failure_diagnosis` 与 `plugin_package_workflow` 都是 StepRun 编排的聚合 ownership domain，
   从通用 Task orphan recovery 查询中排除。它们必须由各自 StepRun 状态机恢复，不能伪造顶层
   RunAttempt，也不能因不存在 Attempt 而被自动终态化。Cluster activation 在 recovery 未收敛时输出
   remaining/failed 计数，便于 failover 诊断。
8. 能力只通过 `@qinglong/ai` 精确 subpath 和既有 Cluster PostgreSQL migration stream 提供；不新增
   workspace package、进程、连接池、listener、timer、watcher 或 cache。默认 Edge/Standalone 及其
   AI/MCP 制品不导入 PostgreSQL admission，因此低配路由设备没有新增常驻成本。

## 被否决方案

1. **把 Step 追加到源失败 Run**：破坏终态 Run 不可变和 event/version 单调性。
2. **复用 Plugin Package Prompt admission**：两者的 authority、Artifact 密文域、恢复与产品语义不同。
3. **admission 后立即调用 Tool/模型**：无法在 response loss 与主库切换后证明执行边界，也会绕过
   Tool completion 对 Model Step 的依赖。
4. **为 diagnosis Run 伪造顶层 Attempt**：把 StepRun 聚合误装成 Task 执行，并让两套恢复状态机争夺
   ownership。
5. **用序列化字符串比较 JSONB**：PostgreSQL 会重排对象键，合法重放会被错误判为证据损坏。
6. **为 admission 新建 package 或进入 Local Profile**：没有独立进程/制品边界，并向低配设备引入
   无用的 Cluster/PostgreSQL 闭包。

## 当前验证

1. admission 定向测试 6/6，覆盖 exact Tool/subject/policy/source fencing、approval 拒绝、模型出口策略、
   原子创建、response-loss replay、冲突/损坏证据和 JSONB 键序等价。
2. recovery SQL 4/4、Cluster activation 6/6；HA 门额外断言 diagnosis 聚合不会进入通用 recovery
   candidate。
3. 18 个 QL3 package 的 clean build/test 全部通过；完整 backend 为 1,207 pass、2 条条件 skip、
   0 fail。package boundary、Cluster dependency、Edge import 与 Cluster deployment 四项审计均为
   compatible 且零 finding；workspace 仍为 18 个 package，`singleSourcePackages=[]`、
   `shallowSourcePackages=[]`。
4. 14 档 Local Profile artifact 全部通过，证明 Cluster-only admission 未进入默认 Edge/Standalone、
   AI 或 MCP 的本地部署闭包。
5. PostgreSQL 18.4 arm64 physical HA 为 128/128 Gate、timeline `1→2`；报告 SHA-256 为
   `a4ed1edec783e3f5b42507c0f8e11b94c59dbe44a57e691017d1445ec9d115e2`，独立证据审计零 finding，
   Docker 容器、网络与卷零残留。

## 后续门禁

1. 以 admission 中的 exact plan 启动 Tool Step，并复用 invocation Artifact、S3 reader、catalog 与
   ADR-0406 result-key provider 完成加密 Tool completion；response loss 不得重复执行 adapter。
2. 只有受信 Tool Step 成功后才原子解锁 Model Step；用 ADR-0405 builder 生成 prompt，并由 Model
   Gateway 执行 provider credential/配额/价格 fence。
3. 建立 Copilot 专用 encrypted model completion、Run/Step terminalization、取消、deadline 和恢复协议，
   证明明文不进入数据库、审计、日志或普通 model completion。
4. 最后开放默认关闭的 Cluster API/CLI/UI/MCP 产品入口，并补多副本并发、真实 S3、外部 Provider
   fault injection 与 plaintext negative evidence。
