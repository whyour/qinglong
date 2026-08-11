# ADR-0133：不可变 Tool Registry 与 Policy-fenced Invocation Plan

- 状态：Accepted（profile-neutral ToolDefinition registry、受限 JSON Schema、
  Project Policy 聚合、Agent Approval 判定和 digest-bound invocation plan 已实现；
  handler、StepRun、preview、ApprovalRequest publisher、MCP/HTTP adapter 与生产组合仍
  未开放）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-131

## 背景

AI Agent、MCP、Package 和内置功能都需要调用 Tool。如果每个入口各自：

- 解析一份 Tool schema；
- 猜测权限和审批要求；
- 直接持有 handler；
- 在运行期注册或扫描 Tool；

就会出现权限旁路、不同输入语义、插件移除后的行为漂移和低配设备常驻开销。
现有 `ProjectPolicyEngine` 已经提供稳定 Principal、Project permission 和
Project/RoleBinding version fence；Tool 层必须复用它，不能建立第二套 RBAC。

## 决策

### 1. Tool Registry 留在 `@qinglong/runtime-core`

新增 `tool-registry` subpath，不新增 workspace package或第三方依赖。Registry 在受信
composition root 中一次性接收 0–128 个 definition，构造后冻结，不提供 `register`、
目录扫描、watcher、timer、socket、数据库或 handler 注入。

同一 `(name, version)` 只能出现一次。Tool name 必须是小写分段标识，version 必须
是 canonical SemVer。调用必须精确指定 version，不提供 latest、wildcard 或运行期
fallback。

### 2. 首版只实现有界 JSON Schema 子集

QL3 不在核心中接受任意 JSON Schema draft。首版只允许：

- `null`、`boolean`；
- 有显式 `maxLength` 的 `string`，可选 `minLength` 和有界 enum；
- 有显式安全上下界的 `number`、`integer`；
- 有显式 `maxItems` 的 array，可选 `minItems`、`uniqueItems`；
- `additionalProperties: false` 的 object，显式 properties 和 required。

拒绝 `$ref`、`oneOf`、`anyOf`、任意 regex、默认值、coercion、未知 keyword 和
开放 additional properties。Schema 深度最多 8、节点最多 256、object properties
最多 64、enum 最多 64、array 最多 256 项。

Tool input 根必须是 object。canonical input 最大 64 KiB，output 最大 256 KiB。
没有 `outputSchema` 的 Tool 只能返回 `null`，不能把“未声明 output”解释为任意输出。

### 3. Registry 不拥有执行能力

Definition 只包含：

- name、version、description；
- input/output schema；
- `read | write | execute | external` effect；
- `low | medium | high | critical` risk；
- 最多 16 个 Project permission；
- 1–3600 秒 timeout。

Registry 只规范化 definition/input/output 和生成 invocation plan。Definition、
Registry 和 plan 均不包含 `execute`、handler、数据库 service 或网络 client。
Package、MCP 或 Agent 不能通过注册 Definition 把代码注入控制面。

### 4. 每次调用先 Policy，后解析输入

`prepareToolInvocation` 固定执行：

1. 精确解析 request envelope 和 Tool identity；
2. 验证当前 Principal；
3. 对 `tool.call:{name}` 和 Definition 的每项 required permission 调用既有
   `ProjectPolicyEngine.authorize` 端口；
4. 任一 deny 立即停止，且不解析 Tool input；
5. 所有非 deny decision 必须包含完全相同的 Project/RoleBinding fence；
6. 任一 decision 为 `require_approval` 时生成 `approval_required` plan；
7. 只有之后才按 schema 规范化 input，并生成 input/action SHA-256。

Policy 存储异常、畸形 decision、空 fence 或不同 fence 混用全部失败关闭。这样多
permission Tool 不能把不同 Project 版本或 revoke 前后的授权拼成一个调用。

### 5. Action digest 是 Approval/Dispatch 的稳定输入，不是执行授权

action digest 绑定：

- `qinglong/tool-invocation@v1`；
- Project、稳定 actor subject；
- exact Tool name/version；
- `tool.call:{name}` 和 required permissions；
- effect、risk、timeout；
- canonical input digest。

它不保存 input、Prompt、Secret 或 handler，也不等于已审批。`approval_required`
仍必须由后续 preview builder 产生 preview digest，再进入既有
ApprovalRequest/immutable dispatch/start barrier。`ready` plan 也必须由受审 handler
registry、StepRun/Trace/Audit 组合消费；本 ADR 不提供直接 execute seam。

## 影响

- AI Agent 通过真实 Project Policy 调用任意 Tool 时，`tool.call:*` 继续返回
  `require_approval`。
- MCP、Package 和内置 Tool 共用同一 schema、permission 和 fence 语义。
- edge 只在显式 Tool 调用时支付 schema/input 规范化成本；禁用 Tool 时零 timer、
  socket、数据库和后台进程。
- `packages/` 数量不增加，runtime-core 只增加一个源码文件和 subpath。

## 未完成边界

以下内容仍需独立闭环：

- built-in/package Tool handler registry；
- ADR-0150 已完成 Package Tool JSON 到 ToolDefinition 的来源/PackageLock/
  generation 绑定；全部 active generation 的全局 immutable snapshot 仍未完成；
- preview/dry-run 和 ApprovalRequest publisher；
- Approved Action handler、receipt/evidence provider；
- StepRun、Trace、redaction 和 durable audit；
- MCP Server、MCP Client、HTTP/API 与 Agent adapter；
- Tool version retirement 与历史 Run/PackageLock 解析。

在这些能力完成前，Tool Registry 保持 production unreachable。

## 验证

测试必须覆盖：

1. immutable registry、exact version 和无 runtime register；
2. root/subpath 导出一致；
3. JSON Schema exact subset；
4. schema depth/node/property 上限；
5. canonical input/output、未知字段与 unique array；
6. 无 output schema 时只允许 null；
7. 同一 Policy fence 的 digest-bound ready plan；
8. 真实 Project Policy 下 Agent Tool call 需要审批；
9. deny 在 input 解析前短路；
10. Policy unavailable、畸形 decision 和 mixed fence；
11. 过期 Principal 与扩展 request 拒绝；
12. canonical envelope byte budget；
13. 无 filesystem/process/network/timer/execute authority。
