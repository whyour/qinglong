# ADR-0409：Cluster Copilot Failure Diagnosis Model Execution

- 状态：Accepted
- 日期：2026-08-15
- 关联 RFC：QL-RFC-0001 D-317、Phase 2
- 关联 ADR：ADR-0262、ADR-0405、ADR-0407、ADR-0408

## 问题

ADR-0408 只把成功的日志 Tool completion 原子解锁为 `ready` Model Step。若调用方直接把
Tool 返回值留在进程内再调用 Provider，进程重启后无法恢复 prompt；若 Model completion 先于
密文输出写入，COMMIT response loss 会留下“Step 已成功但结果不存在”的分裂状态；若把 Copilot
Artifact 继续塞进通用 Model coordinator，则每增加一个 AI 领域都会让核心层反向依赖一个新领域。

同时，diagnosis Run 不能在 Model Step 已终态后永久停留在 `running`。成功、Provider 失败和
deadline 必须由耐久 ModelInvocation completion 驱动 Run 终态，而不能由一次内存返回值决定。

## 决策

1. Model executor 只接受 ADR-0407/0408 的 exact admission、unlock receipt 和加密 Tool success。
   它通过 Runtime Core 的只读 `openTrustedToolSuccessCompletion` 重开 ciphertext，复验 barrier、
   result catalog/rekey、key material proof、Tool definition 与 completion digest；绝不重新执行 Tool。
2. 只有 `available`、`cluster-control` 且 Run/Attempt identity 与 source fence 完全一致的内建日志
   projection 才能进入 ADR-0405 builder。其余 Tool 输出不会被转成任意 Prompt，也不会调用 Provider。
3. executor 使用既有 `BoundedModelGateway`，因此 Provider/model allowlist、egress budget、并发、
   deadline、quota、price quote、usage settlement 和 content-free audit 继续由一个通用边界裁决。
   Gateway 必须显式安装当前 Copilot successful-completion sink，否则执行失败关闭。
4. Copilot 输出使用独立 `qinglong/copilot-failure-diagnosis-output-artifact@v1`，AES-256-GCM 密封
   完整 `GenerateResult`。AAD 与 digest 绑定 request/plan/Tool completion/Project/Run/Step/
   invocation/provider/model/egress evidence/key；公开 reference 不含 nonce、ciphertext、auth tag 或明文。
5. 通用 `DurableModelInvocationCoordinator` 不再导入 Plugin Package Prompt Artifact。新增领域无关的
   `ModelInvocationAtomicSuccess<TReference>` 端口，由领域负责 exact replay、冲突类型和方言事务；
   原有 Plugin Prompt 通过 adapter 保持行为兼容，Copilot 使用独立 adapter。PostgreSQL 的通用
   atomic-output helper 在同一 SERIALIZABLE 事务提交 StepRun/Event、Model completion、usage、
   pricing/quota settlement 和领域 ciphertext，任何一步失败均整体回滚。
6. `pg-9020-ai-copilot-failure-diagnosis-model-executions` 新增两个 append-only ledger：
   `copilot_failure_diagnosis_model_outputs` 保存密文 Artifact；
   `copilot_failure_diagnosis_finalizations` 保存 content-free Run terminal receipt。`ql3_runtime` 只有
   `SELECT, INSERT`，其他运行/管理角色不得读写，PUBLIC 无权限。
7. Model completion 提交后，独立可重放的 finalization 事务锁定 diagnosis Run 与 Model Step，复验
   plan、completion、成功 Artifact 和当前计数链，再把 Run 推进为 `succeeded|failed|timed_out`、
   写一个 `copilot.diagnosis.<outcome>` Event 和 receipt。两个事务之间崩溃时，恢复只执行
   finalization，不再调用 Provider；Run 的成功 `outputRef` 只指向密文 Artifact。
8. 已存在 completion 或 finalization 的 replay 永不调用 Provider；只有 start、没有 completion 的
   invocation 视为结果未知，禁止自动重试。`outcome_unknown` 仍必须先走既有显式 resolution，当前
   finalizer 不把未知结果伪装成失败。Tool failure、Tool 输出退役/缺失、Model admission 前 deadline
   和用户取消的无 Model-completion 终态化，留给下一状态机 Gate。
9. 本能力继续内聚于 `@qinglong/ai` 的嵌套领域目录，不新增 workspace package、Node 进程、Pod、
   连接池、队列、timer、watcher 或 cache。Edge/Standalone 默认制品不导入 PostgreSQL executor；
   Cluster 的 Copilot output key material 必须由显式 `active()/resolve()` provider 注入，不能复用
   Provider credential、Tool invocation/result 或 Plugin Prompt output 的密钥用途。

## 被否决方案

1. **Model 成功后再单独写 Artifact**：留下成功 Step 与缺失输出的不可恢复窗口。
2. **把 Tool 明文保存在 executor registry**：崩溃后无法恢复，也扩大路由设备常驻内存与泄漏面。
3. **把第二个领域 Artifact 导入通用 coordinator**：继续形成 Model core → product domain 的反向依赖。
4. **自动重试只有 start 的 Model invocation**：外部 Provider 可能已完成，重试会产生重复费用和结论。
5. **将 `outcome_unknown` 直接标为 failed**：丢失真实不确定性，破坏人工 resolution 语义。
6. **为 Copilot Model execution 新建 package**：没有新的独立部署边界，只会再次制造单文件薄包。

## 验证标准

1. 单元/契约测试覆盖密文 round-trip、metadata/ciphertext/key tamper、content-free reference、
   finalization receipt、显式 subpath、一次 Provider 调用、completion/finalization replay 零 Provider 调用。
2. 既有 Plugin Prompt exact replay、Artifact 与 settlement crash window 全部通过，证明通用原子端口
   重构没有改变旧领域语义。
3. PostgreSQL 18.4 physical HA 必须应用 20 条 AI migration，证明两张新表 append-only 角色隔离、
   timeline `1→2` 提升后 history/schema/ACL 一致，并由独立证据审计复核。
4. 18-package clean build/test、backend、四项架构审计、14 档 Artifact 和 GitNexus staged/change
   detection 全部通过后才允许阶段性提交；不得把 focused test 当完整性证明。

## 当前验证

1. `@qinglong/ai` 全量测试 233 pass、3 条 PostgreSQL 条件测试 skip、0 fail；新增覆盖密文
   round-trip、tamper、content-free reference、一次 Provider 调用及 completion/finalization replay。
2. 18 个 QL3 package 从清空 `dist` 开始全部构建并通过各自全量测试；backend 1,207 pass、
   2 条条件测试 skip、0 fail。
3. package boundary、cluster dependency、Edge import、Cluster deployment 四项审计均为
   `compatible: true` 且零 finding。workspace 仍为 18 个 package，`singleSourcePackages=[]`、
   `shallowSourcePackages=[]`；AI 的 183 个源码中 182 个位于嵌套领域目录。
4. 14 档 Local Profile Artifact 全部通过；默认 Edge/Standalone 分别为
   2,589,890/2,589,968 bytes，Edge/Standalone AI 为 3,061,009/3,061,099 bytes，均在预算内。
5. PostgreSQL 18.6 arm64 physical HA 130/130、timeline `1→2`，20 条 AI migration、schema、
   append-only ACL 与提升后一致性全部通过；报告 SHA-256 为
   `8401634f30635b45bfb583b02e94ac41f023bf8a0bdbcfd9744ebf459ab0d8f8`，独立证据审计零 finding，
   Docker 容器、网络和卷零残留。

## 后续门禁

1. 为 Copilot output 建立 Cluster 专用 projected keyring manifest、active rotation、retirement、
   external custody 与 lost-key recovery；在产品 composition 完成前 Model executor 保持不可达。
2. 终态化 Tool failure、日志 missing/retired、Model admission 前 deadline、用户 cancellation 与
   `outcome_unknown` resolution，并加入跨主库提升的 crash-window execution matrix。
3. 最后开放默认关闭的 Cluster API/CLI/UI/MCP 入口，补真实外部 Provider、KMS/Secret projection、
   plaintext negative evidence、多副本并发和费用/取消可观测性。
