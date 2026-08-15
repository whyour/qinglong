# ADR-0408：Cluster Copilot Failure Diagnosis Tool Execution

- 状态：Accepted
- 日期：2026-08-15
- 关联 RFC：QL-RFC-0001 D-316、Phase 2
- 关联 ADR：ADR-0163、ADR-0226、ADR-0403、ADR-0405、ADR-0406、ADR-0407

## 问题

ADR-0407 只把故障诊断原子接纳为独立 Run、一个 `ready` Tool Step 和一个依赖它的
`pending` Model Step。系统仍不能执行该 Tool，也不能在崩溃、响应丢失或 PostgreSQL
主库切换后证明 Tool 是否已经产生副作用、结果是否已经加密持久化，以及 Model Step
是否可以安全解锁。

若 Copilot 绕过共享 Trusted Tool start/completion 协议直接读取日志，重放可能重复执行
adapter；若先解锁 Model 再写 completion，模型可能读取缺失、失败或未验证的结果；若复用
Prompt output key 或让 projected file 决定 Tool result active generation，又会合并本应独立的
密钥域和 durable authority。

## 决策

1. 新增 Copilot failure-diagnosis Tool execution coordinator。它只接受 ADR-0407 已持久化的
   `requestId`，重新读取并规范化 exact admission plan/receipt、当前 Project Tool snapshot 和
   invocation input/preview Artifact；任何 plan、Definition、binding、Artifact 或 source fence
   漂移均在日志读取前失败关闭。
2. coordinator 复用 Runtime Core 的通用 Trusted Tool execution evidence、start barrier、
   encrypted success/failure completion、result catalog 和 rekey 协议，并只装配内建
   `qinglong.run.log.excerpt@1.0.0` adapter。start/completion 使用从 plan 稳定派生的 identity；
   exact replay 首先打开 durable barrier/completion，不再次读取日志或执行 adapter。
3. invocation Artifact 使用独立的 Cluster projected keyring。它包含一个 active key 和最多
   16 个历史 key，提供 `active()` 与 `resolve(keyId)`，每次调用重新读取 canonical 32-byte
   material，不使用 cache、watcher 或 timer，并复用既有 projected-file 的 canonical path、
   symlink、权限、inode/size/mtime 和双 realpath fence。Tool result keyring 仍保持 resolve-only，
   PostgreSQL result catalog 继续独占 active/decryptable generation authority；两个密钥域不得互换。
4. 只有规范化且与 admission exact 绑定的 `succeeded` Tool completion 才能解锁 Model Step。
   `pg-9019-ai-copilot-failure-diagnosis-tool-unlocks` 新增 append-only unlock ledger；一个
   SERIALIZABLE 事务同时把 Model Step 从 `pending` 推进到 `ready`、递增 Run version/event
   sequence、写 RunEvent、StepRunMutation 和不可变 unlock receipt。Tool `failed|timed_out`
   completion 不解锁 Model，也不伪造最终 diagnosis 结论。
5. unlock transaction 重新锁定并验证 admission、success completion、当前 Model Step 和 running
   diagnosis Run；serialization/deadlock 只在事务提交前有界重试。response-loss replay 必须返回
  结构完全一致的 receipt；缺失关联事实、旧 fence、不同 digest 或部分写入全部视为冲突/损坏。
6. `ql3_runtime` 对 unlock ledger 只有 `SELECT, INSERT`，没有 `UPDATE, DELETE`；数据库外调用者
   不能直接把 Model Step 改为 ready。Tool execution 与 PostgreSQL storage 分别通过精确 AI
   subpath 发布，纯 execution 入口不隐式 re-export PostgreSQL repository。
7. 本 Gate 到 Model Step `ready` 为止，不调用模型、不持久化模型明文、不终态化 diagnosis Run。
   ADR-0405 prompt builder、Model Gateway、Copilot 专用 encrypted model completion、失败/取消/
   deadline terminalization 和产品 API 属于后续 Gate。
8. 能力内聚在既有 `@qinglong/ai` 与 `@qinglong/cluster-control` 的领域子目录，不新增 workspace
   package、依赖、进程、Pod、连接池、listener、daemon、timer、watcher 或 cache。默认 Edge/
   Standalone 不导入 Cluster execution；显式本地 AI 制品也不会取得 PostgreSQL/S3 authority。

## 被否决方案

1. **Copilot 自建一套 Tool completion**：会分叉 start barrier、加密 Artifact、rekey 与恢复语义。
2. **admission 后直接调用日志 reader**：响应丢失时无法区分“未执行”和“已执行但未返回”。
3. **Tool 一启动就解锁 Model**：允许模型消费未完成、失败或未认证的结果。
4. **把失败 Tool completion 当成可诊断输入**：当前没有经过审定的失败 Prompt/terminalization
   协议，会把基础设施错误伪装成业务诊断。
5. **共用 Prompt output/result/invocation keyring**：混淆密钥用途、active authority 与退役范围。
6. **为 keyring 或 coordinator 新建 package**：没有独立部署/ownership 边界，并会继续加剧包碎片化。

## 当前验证

1. admission/execution/unlock 与 migration/readiness 聚焦契约 21/21，projected invocation keyring
   2/2；AI package 最终为 229 pass、3 条件 skip、0 fail，类型检查通过。
2. 18 个 QL3 package 的 clean build/test 全部退出 0；backend 为 1,207 pass、2 条件 skip、
   0 fail。
3. package boundary、Cluster dependency、Edge import 和 Cluster deployment 四项审计均
   compatible 且零 finding。workspace 仍为 18 个 package，`singleSourcePackages=[]`、
   `shallowSourcePackages=[]`；AI 175 个源码中 174 个、Cluster Control 56 个中 54 个位于
   嵌套领域目录。
4. 14 档 Local Profile artifact 全部通过。默认 Edge/Standalone 为 2,589,890 / 2,589,968
   bytes；显式 Edge/Standalone AI 为 3,135,809 / 3,135,899 bytes；最大 Standalone MCP 为
   7,316,038 bytes，均在各自门内。
5. PostgreSQL 18.4 arm64 physical HA 为 130/130 Gate、timeline `1→2`。门证明首次 Tool 执行只
   读取两次日志、密文 JSON 不含敏感 fixture 文本、Model Step 原子进入 ready；主库提升后 exact
   replay 的日志读取为零。报告 SHA-256 为
   `d525a303696e178d777b021b376729bd2c5382fb5eb7bc98466a2b79d3940517`，独立审计零 finding，
   临时 Docker 资源已清理。

## 后续门禁

1. 从 durable Tool completion 解密受信投影，经 ADR-0405 builder 生成 prompt，并通过 Model
   Gateway 执行 provider credential、egress policy、quota、price 和 deadline fence。
2. 建立 Copilot 专用 encrypted model completion 和 response-loss recovery；模型输出不得进入
   普通 completion、数据库 JSON、审计或日志明文。
3. 原子终态化 Model Step 与 diagnosis Run，并覆盖 Tool/Model 失败、取消、超时、未知结果和
   主库切换后的恢复状态机。
4. 最后再开放默认关闭的 Cluster API/CLI/UI/MCP 产品入口，并补真实 S3、外部 Provider fault
   injection、多副本并发和 plaintext negative evidence。
