# ADR-0411：默认关闭的 Cluster Copilot Failure Diagnosis Composition

- 状态：Accepted
- 日期：2026-08-15
- 关联 RFC：QL-RFC-0001 D-319、Phase 2
- 关联 ADR：ADR-0407、ADR-0408、ADR-0409、ADR-0410

## 问题

ADR-0407 至 ADR-0410 已分别建立 diagnosis admission、Trusted Tool execution、Model execution
和独立 output key authority，但它们仍只在测试与 HA ceremony 中手工组装。若直接再启动一套 Model
Gateway，会为每个 replica 复制 PostgreSQL Pool、Provider client、恢复扫描和并发预算；这对小型集群
不合理，也会让 Prompt 与 Copilot 绕过同一模型出口限额。若直接开放 HTTP route，则 Tool failure、日志
missing/retired、Model admission 前取消以及 outcome-unknown 尚未终态化，产品会暴露无法收敛的 Run。

## 决策

1. Copilot 只在既有显式 `ql3-cluster-control-ai` 进程中装配，并由独立
   `QL3_CLUSTER_AI_COPILOT_ENABLED=true` 开关启用。默认 Cluster、Edge、Standalone 和仅 Prompt 的
   Cluster AI 均不读取 Copilot 配置、keyring 或 Artifact authority。
2. Prompt 与 Copilot 共享一个 PostgreSQL runtime Pool、一个 Model Gateway、同一 Provider authority、
   recovery pass、pricing/quota ledger 和 `maxConcurrent` 预算。新增有界 successful-completion router，
   只把一次已开始的 invocation 交给声明该 invocation 的 durable sink；不得复制 Gateway 或隐藏队列。
3. Copilot Model execution 依赖 `generate()` 与 `supportsSuccessfulCompletionSink()` 的窄结构端口，不依赖
   `BoundedModelGateway` 具体类，使 production Profile 的 drain/active-operation capability 可以直接注入，
   同时保留 exact sink identity 检查。
4. Cluster Copilot application service 从当前 PostgreSQL Run、latest Attempt、Project Tool snapshot 和
   Policy 派生计划；调用者不能提供 Attempt、Artifact、Tool binding、Policy fence、key ID、nonce、
   `plannedAtMs` 或内部 Run/Step/ModelInvocation identity。模型与 egress policy 来自部署者的 canonical
   read-only配置，而不是请求体。
5. diagnosis admission 先持久化 exact plan/Run/Step ledger，再物化可重建的加密 Tool invocation Artifact。
   replay 使用 durable plan、historical invocation key 和域分离确定性 nonce 修复 admission→Artifact
   crash window；只有 Artifact exact replay 成功后才允许 Tool execution。密钥副本使用后必须清零。
6. Tool execution 复用同一 PostgreSQL repository、current snapshot、Project Policy 与 Worker Artifact
   range reader；Model execution复用同一 Gateway，并由 ADR-0410 output keyring 原子落盘 ciphertext。
   invocation、Tool result 与 Model output keyring 继续是三个不可互换的域。
7. composition 能力在进程内保持 caller-driven、无 timer、watcher、队列或后台扫描。当前 Gate 不注册
   HTTP/CLI/UI/MCP route；只有下一 Gate 完成所有非成功路径的 durable terminalization/recovery 后，
   才能把该能力接入认证产品面。
8. Kubernetes 以独立可选 component 投影 canonical Copilot 配置和三个 read-only keyring；它必须与
   `cluster-ai` 以及可读 Worker Artifact storage 一起使用，不新增 Pod、ServiceAccount 权限或 sidecar。

## 被否决方案

1. **为 Copilot 再启动 Gateway/Pool**：资源翻倍并拆散全局并发、quota 和 Provider 出口约束。
2. **让 Gateway 依赖具体业务 sink**：把通用模型边界反向耦合到 Prompt/Copilot 产品域。
3. **由请求提交完整执行计划**：把 source fence、Tool binding、egress policy 和内部 identity 交给不可信边界。
4. **先开放 route、以后补失败收敛**：会产生用户可见但永久 running/pending 的 diagnosis Run。
5. **把三个 keyring 合并**：轮换、退役与泄漏半径跨越 Tool 输入、Tool 输出和模型输出域。
6. **新增 workspace package**：composition 没有独立进程或依赖闭包，薄包会恶化已有 package 粒度。

## 验证标准

1. completion router 证明 Prompt/Copilot 精确分发、未知 invocation 不落盘、重复/扩展 sink 拒绝。
2. 默认关闭时不读取 Copilot config、keyring、Worker Artifact 或新增 PostgreSQL authority。
3. composition 测试覆盖 server-derived source/snapshot/Policy、admission→Artifact crash repair、Tool→Model
   成功链、exact replay、key rotation、配置/authority 缺失和有序 drain。
4. AI、Cluster Control、18-package clean build/test、backend、四项架构审计和 14 档 Local artifact 全通过。
5. PostgreSQL 组合证据覆盖真实 repository 上的 admission、Tool completion、Model ciphertext、finalization
   与 exact replay；本 Gate 不新增 migration、schema、role 或 SQL privilege。

## 当前验证

1. successful-completion router 与 Cluster Copilot application/composition 定向测试全部通过；AI 完整测试
   238 pass/3 条件 skip，Cluster Control 完整测试 240 pass/2 条件 skip。
2. 18-package clean build/test 全部通过；backend 1,207 pass/2 条件 skip/0 fail。package boundary、
   dependency、Edge import 与 Cluster deployment 四项审计均为 compatible、零 finding。
3. workspace 仍为 18 个 package，无 single-source 或 shallow-source package；AI 187 个源码中 186 个、
   Cluster Control 59 个源码中 57 个位于嵌套领域目录。新增 composition 没有制造薄 package 或根层平铺。
4. 14 档 Local Profile artifact 全部通过。默认 Edge/Standalone 保持
   2,589,890/2,589,968 bytes；Edge/Standalone AI 为 3,064,454/3,064,544 bytes，均未引入 Cluster-only
   composition，且分别保有 1,604,414/1,604,336 与 2,178,426/2,178,336 bytes 体积余量。
5. PostgreSQL 18.6 arm64 HA 130/130、timeline `1→2`，报告 SHA-256 为
   `981299b454dce5541e9596450b85816dc40559cba8dc42adf3d5fea571c3d3a6`。本 Gate 不新增
   migration、schema、role、SQL privilege 或 HA 拓扑；真实 repository 的 admission、Tool completion、
   Model ciphertext、finalization 与 exact replay 沿用同一受审 authority，Docker 门禁与清理均通过。

## 后续门禁

1. 为 Tool `failed|timed_out`、日志 `missing|retired|pending`、deadline/cancel 和 Model
   `outcome_unknown` 建立有界 durable terminalization/recovery。
2. 完成后再增加经 authentication、Policy、audit、request identity 和 source fence 保护的 Cluster API，
   随后复用该 capability 提供 CLI/UI/MCP，而不是建立旁路执行器。
