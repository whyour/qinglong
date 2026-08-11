# ADR-0155：Snapshot-bound Trusted Tool Handler 与执行准入

- 状态：Accepted（snapshot-specific handler binding、分层 action/preview/plan
  digest、Approval binding、执行前 Policy 复验和 StepRun/Trace/Audit evidence
  admission 纯契约已实现；耐久 plan/preview、StepRun/Trace/Audit repository、真实
  adapter 与生产 composition 尚未开放）
- 日期：2026-07-26
- 关联：ADR-0001、ADR-0031、ADR-0032、ADR-0133、ADR-0154、QL-RFC-0001
  D-03/D-29/D-131/D-148/D-149

## 背景

ADR-0133 已把 Tool Definition、输入规范化和 Project Policy 计划收敛为不可变纯契约，
ADR-0154 又把 active Package vector 投影为 Project-scoped immutable snapshot。但这
两层都刻意不包含 handler。若 composition 只按 Tool name 找函数，或者让 Package JSON
声明 module、URL、MCP server，就会出现以下旁路：

- 同名同版本 Definition 在 Package generation 切换后继续命中旧 handler；
- ADR-0133 的 invocation action digest 未绑定 snapshot、definition digest 或 handler，
  被误当成最终执行授权；
- preview 由 Agent 自报，审批后可以替换参数、adapter 或 Profile；
- Approved Action dispatcher 只按通用 action type 找 handler，无法证明 Tool 对应的
  StepRun、Trace 和 Audit 已经耐久化；
- edge 为了“动态插件”常驻目录 watcher/cache，cluster 则让普通 Package 获得控制面
  module/network authority。

因此 Tool execution 不能直接接到现有 dispatcher。必须先建立独立的可信 binding 和
执行前 admission contract。

## 决策

### 1. Binding 是 Project snapshot 的不可变受审描述符

`qinglong/trusted-tool-handler-binding@v1` 精确绑定：

- Project Tool snapshot digest；
- exact Tool name/version 与 definition digest；
- reviewed adapter identity 和 canonical SemVer；
- execution class；
- `edge | standalone | cluster-control | worker` Profile 集合；
- 最多 16 个显式外部 authority；
- 只能收紧、不能放宽 Definition 的 timeout；
- reviewed redaction contract 与 audit contract identity/version；
- domain-separated binding digest。

首版 execution class 固定为：

- `builtin_in_process`；
- `isolated_process`；
- `remote_worker`；
- `mcp_client`；
- `http_connector`。

authority 使用受限词表，例如 database/filesystem/artifact read/write、
network connect、process spawn、Secret、Model、MCP 和 Run control。词表只表达
composition 需要提供哪些 capability，不自动授予 capability。

一个 snapshot 最多 128 个 binding，同一 Tool identity 只能有一个。不存在于 current
snapshot、definition digest 不同、Profile 不匹配、timeout 扩大或 binding digest
漂移全部失败关闭。snapshot 中没有 binding 的 Definition 保持不可调用。

### 2. Binding registry 不保存 handler code

`TrustedToolHandlerBindingRegistry` 只保存冻结后的描述符，不提供 `register`，也不保存：

- function/`execute`；
- module path 或 dynamic import；
- command、URL、socket、credential；
- filesystem/process/network/database service；
- timer、watcher、LISTEN 或可变 current head。

真实 adapter 实例只能由受信产品 composition 按 binding identity 注入后续执行层；
Package materialized resource、Agent、MCP client 和 HTTP caller 均不能创建这个信任。
内置 Tool、MCP、HTTP 或未来隔离 Package runtime 也不能走特殊旁路：其 Definition 必须
先进入受审 Project snapshot，之后才能建立 binding。

### 3. 最终 Tool action 使用分层摘要

ADR-0133 的 `invocationActionDigest` 继续证明 canonical input 与 Policy-fenced
Definition 元数据，但不再被解释为执行授权。ADR-0155 生成：

1. `actionDigest`：绑定 invocation digest、action ref、Project/actor、Policy fence、
   snapshot、definition、binding、Profile 和有效 timeout；
2. `previewDigest`：绑定 action digest 与受限安全 preview；
3. `planDigest`：绑定完整 normalized input、action、preview 和全部摘要。

任何 snapshot、Package generation、adapter、redaction/audit contract、Profile、
authority、timeout、input 或 preview 变化都会产生不同最终摘要。

plan 只由显式调用构造，edge 空闲时没有 cache/timer。当前纯对象仍含 normalized input；
未来耐久 plan carrier 必须使用独立受授权 Artifact/plan repository，并根据 Secret
边界决定加密和 retention，不能把 input 写入 Approval/dispatch 行。

### 4. Preview 是有界安全投影，不是任意 JSON

preview 最多包含 16 个 field 和 8 个 warning code。field 只能为：

- `text`；
- `identifier`；
- `count`；
- `redacted`。

`redacted` 的 value 必须为 `null`，其余 value、title、summary 都有严格 UTF-8 byte
上限并拒绝控制字符。core 只能保证形状、大小和摘要绑定；具体哪些值必须被隐藏由
binding 中受审 redaction contract 决定。adapter 不得把 Prompt、token、Secret 或完整
credential 伪装成公开字段。

### 5. Approval 复用既有 durable state machine

只有 `approval_required` plan 可以生成 `ApprovedActionBinding`：

- permission 为原始 `tool.call:{name}`；
- action type 固定为 `tool.invoke`；
- action ref、final action digest 和 preview digest 与 plan 精确一致。

随后复用 ADR-0031 的 ApprovalRequest、human decision、一次性 consumption 和 immutable
dispatch。执行 admission 只接受 exact consumed dispatch；Project、requester、permission、
action type/ref/digest、preview digest 或时间顺序任一漂移都拒绝。

`ready` plan 不创建冗余 Approval。若执行前当前 Policy 已从 allow 变为
`require_approval`，旧 ready plan 必须停止并重新产生审批，不能带一个无关 dispatch
穿透。

### 6. 执行开始前重新验证当前 Policy

admission 以 active Principal 对 `tool.call:{name}` 和全部 required permission 再次
调用既有 `ToolPolicyAuthorizer`：

- 任一 deny 立即拒绝；
- unavailable、畸形 decision、空 fence 或 mixed fence 失败关闭；
- Principal subject 必须等于 plan requester；
- Profile 和 current binding digest 必须精确匹配。

审批完成不冻结未来权限；Role revoke、Project archive 或 binding/snapshot 切换都必须在
外部副作用开始前生效。

### 7. StepRun、Trace、Audit 是 admission 的强制前置证据

`qinglong/trusted-tool-execution-admission@v1` 必须绑定：

- 已耐久化 StepRun 的 id/version/digest；
- 已耐久化 Trace 的 trace/span/digest；
- 已耐久化 Audit event id/digest；
- current Policy fence；
- plan/action/binding/adapter/Profile/timeout；
- Approved Action dispatch id/digest（需要审批时）；
- admission time 与 domain-separated admission digest。

admission 不携带 input、handler 或 execute seam。当前 ADR 只冻结并验证 evidence receipt
形状；它不假装已有 StepRun/Trace/Audit repository。ADR-0001 的 `step_run_id` nullable
占位列和普通 RunEvent 不能冒充三种耐久事实。在这些 repository 与同事务 start barrier
完成前，生产 composition 不得构造 evidence，也不得调用 adapter。

### 8. Profile 与资源边界

- edge/standalone：按 Tool 调用构造 snapshot binding registry 和 plan；禁用或空闲时零
  timer、watcher、socket、数据库连接；
- cluster-control：只读取已通过 current-vector proof 的 snapshot，binding 来自受审
  control composition；不得取得 package-executor 的 snapshot 写权；
- worker：不建立 Project binding registry，只接受控制面已经绑定且由 Worker 能力再次
  验证的未来 execution spec；
- 任一 Profile 均不得通过 Package JSON、环境变量中的 module path 或运行期 register
  绕过 binding ceremony。

## 被否决方案

1. **按 Tool name 直接 Map 到函数**：没有 snapshot/definition/version fence，拒绝。
2. **把 handler/module/URL 放进 Package Tool JSON**：把内容安装升级为控制面 authority
   注入，拒绝。
3. **把 ADR-0133 action digest 直接写入 Approval**：没有绑定 snapshot 和 adapter，
   拒绝。
4. **保存任意 preview JSON**：无法证明大小、redaction 和 canonical identity，拒绝。
5. **审批后不复验 Policy**：Role revoke 和 Project archive 无法在副作用前生效，拒绝。
6. **用 RunEvent payload 代替 StepRun/Trace/Audit**：缺少独立状态、版本和 start
   transaction proof，拒绝。
7. **为了动态 registry 建 watcher/cache**：破坏 edge 空载预算且产生 stale head，拒绝。
8. **为 binding 新增 workspace package**：没有独立部署或发布生命周期，继续放在
   runtime-core 显式 subpath。

## 实现与验证

当前切片已实现：

- `@qinglong/runtime-core/trusted-tool-invocation` root/subpath；
- snapshot-specific immutable binding 与 exact registry；
- execution class/Profile/authority/timeout/redaction/audit 规范化；
- 分层 action/preview/plan digest；
- `tool.invoke` Approval binding 与 exact dispatch 复验；
- 执行前 current Policy 聚合与 mixed-fence fail-closed；
- StepRun/Trace/Audit evidence-bound admission；
- 无 filesystem/process/network/timer/execute authority 的源码门禁。

定向测试覆盖 12 项：

1. immutable binding 和无 executable code；
2. unknown Tool、timeout 扩大、重复 binding、stale snapshot；
3. Profile availability；
4. canonical layered digest 与 adapter 漂移；
5. preview redaction 和 digest tamper；
6. approval-only publisher；
7. exact consumed dispatch；
8. ready admission 与 fresh Policy；
9. approval admission；
10. deny、approval escalation、mixed fence、unavailable Policy；
11. StepRun/Trace/Audit/Profile drift；
12. root/subpath 与 authority import isolation。

## 后续门禁

1. ADR-0001 增量实现双方言 StepRun aggregate、状态机、索引和 Run/Attempt 外键；
2. 实现有界 Trace/Audit append-only repository 与 retention；
3. 实现受授权的 encrypted/opaque Tool plan 与 preview Artifact repository；
4. 把 plan/StepRun/Trace/Audit/Approved dispatch 在同一 start barrier 中提交或精确证明；
5. 为 built-in、isolated process、MCP、HTTP 和 Worker 分别建立 adapter composition 与
   recovery/idempotency evidence；
6. 接入本机/集群 application recovery/admission gate，并完成双方言、物理 edge、
   PostgreSQL HA 与生产依赖闭包门禁；
7. 上述全部完成前，Tool execution 保持 production unreachable。
