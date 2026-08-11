# ADR-0350：有界、低敏的本机 MCP Task 发现

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-259、D-260、D-261、D-262
- 关联 ADR：ADR-0052、ADR-0087、ADR-0090、ADR-0272、ADR-0345、ADR-0346、ADR-0347、ADR-0348、ADR-0349

## 背景

本机 MCP 已能发现 Run、读取 Run 快照并分页诊断事件，但 Agent 仍必须由用户提供 `taskId`，无法先回答“当前 Project 有哪些 Task 可以运行”。现有 TaskDefinition 双方言 source 已提供 Project-scoped、按 `taskId` 严格递增的 keyset 分页和 `limit+1` 截断判断，不需要增加 migration、表或索引。

TaskDefinition 完整记录包含命令/spec config、description、labels、mutation 和 digest。这些字段既可能含敏感执行细节，也会把未来定义格式直接冻结成 MCP 公共协议，因此不能透传。

## 决策

在既有可选 stdio sidecar 增加第四个只读 Tool：`qinglong.task.list@1.0.0`。输入固定为 `{after?, limit?}`；`limit` 默认 32、最大 64，`after` 只能使用服务端返回的 `{taskId}`。Project 继续来自私有 MCP 配置，不接受客户端选择。

输出固定为 `{tasks, hasMore, next?}`，每项只包含：

- `taskId`、当前 `revision` 与显示 `name`；
- `kind`、`specSchema`、`enabled`；
- `updatedAtMs`。

不得返回 `projectId`、description、spec config/command、labels、mutationId、contentDigest、Secret reference 或数据库 row。当前页只表示 current Task heads；disabled Task 保留在结果中并显式标记 `enabled=false`，避免通过过滤造成无界扫描或游标歧义。projection 必须拒绝跨 Project、乱序、越过 cursor、超量或 continuation 不一致的 adapter 结果。

调用顺序固定为 authentication → exact `tool.call:qinglong.task.list` + `task.read` Policy → durable audit → credential `confirm()` → Project-scoped bounded TaskDefinition read。MCP 仍使用单 SQLite authority，不缓存 Task，不增加连接、timer、watcher、listener、后台服务或写 authority。

实现放入既有 `@qinglong/runtime-core/tool-execution`、`@qinglong/local-sqlite/task-definition` 与 `@qinglong/local-mcp-server/application-runtime` owner。只增加精确 Runtime Core subpath，不增加 root export 或 workspace package。PostgreSQL `TaskDefinitionSource` 契约保持可复用，但本批 MCP 只装配本机 SQLite sidecar，不修改 Cluster runtime。

## 被否决方案

1. 返回完整 TaskDefinition：会泄露命令和配置，并把内部 schema 固化为外部协议。
2. 只返回 enabled Task：存储按 `taskId` 分页，投影层过滤会导致页大小不确定、潜在无界补读和游标跳跃。
3. 客户端传 Project：会把租户边界从可信部署配置移到不可信参数。
4. 新建 Task discovery package：没有独立部署、authority 或依赖边界，只会增加 importer、SBOM 和低配制品成本。
5. 把 MCP SDK 合入默认 application：会让未启用 AI Client 的路由设备承担约 9.81 MB/194 modules 的可选闭包。

## 验证

- Runtime Core 458/458：exact Tool、默认/最大页、cursor、字段脱敏、跨 Project/乱序/超量/continuation fail-closed。
- Local SQLite 204/204：复用 current TaskDefinition head、Project keyset 与单 authority close fence。
- Local MCP 9/9：四 Tool 静态发布、`task.read` admission/audit 顺序、真实 stdio/API Credential/SQLite Task discovery E2E。
- package boundary/dependency/edge import compatible；17 package、993 source 中 967 nested、26 root（97.4%），无单文件或浅层 package。
- 十二档 artifact compatible。最紧 Standalone Application AI 为 6,270,988 bytes/638 files，距 6 MiB 上限 20,468 bytes；MCP Edge/Standalone 为 9,809,892/9,810,000 bytes、942 files、194 loaded modules，RSS 增量 36,405,248/37,011,456 bytes。
- 未新增 production dependency、migration、表、索引、数据库连接或后台资源。

## 后续约束

Task point read、按 kind/label 搜索、Task spec/command 展示、Task start 和任何写 Tool 必须另立 ADR。尤其 Task start 必须绑定当前 revision、输入 schema、approval、Run admission、幂等与 durable audit，不能把本只读 discovery cursor 或 content-free projection 当作执行授权。
