# ADR-0349：有界、Project-scoped 的本机 MCP Run 发现

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-259、D-260、D-261
- 关联 ADR：ADR-0041、ADR-0052、ADR-0063、ADR-0087、ADR-0088、ADR-0345、ADR-0346、ADR-0347、ADR-0348

## 背景

`qinglong.run.get` 与 `qinglong.run.events.list` 已能读取一个已知 Run 的低敏快照和事件，但调用方必须先知道 `runId`。这使桌面 Agent 和本机 AI Client 不能从“最近运行”开始诊断，只能依赖用户复制内部标识，尚未形成可用的只读发现闭环。

发现能力必须保持 Project 隔离和固定资源上限，不能通过 offset 扫描放大历史成本，也不能返回输入、输出、命令、错误、触发者、请求、幂等键或 Artifact reference。SQLite 与 PostgreSQL 已有 `(project_id, created_at_ms, id)` 索引，因此本批不需要 migration。

这也是对 workspace 结构的再次校验：协议、投影和双方言 adapter 具有不同领域 owner，但都属于既有 Runtime Core、Local SQLite 和 Cluster PostgreSQL package；为它们新建微包会增加 importer、构建、SBOM 与低配设备闭包成本。相反，把实现继续堆在 `src/` 根层也会混淆 public entrypoint 与领域实现。

## 决策

在既有本机 MCP sidecar 增加第三个只读 Tool：`qinglong.run.list@1.0.0`。输入固定为 `{after?, limit?}`；`limit` 默认 32、最大 64。`after` 是服务端返回的 `{createdAtMs, runId}`，查询按 `createdAtMs DESC, id DESC` 执行严格 keyset 分页，并最多读取 `limit+1` 条。

输出固定为 `{runs, hasMore, next?}`。每个 Run 只包含：

- `id`、`taskId`、`taskRevision`；
- `status`、`version`、`eventSequence`、`priority`；
- `executionOrigin`、`executionOwner`；
- `createdAtMs` 以及存在时的 `queuedAtMs`、`startedAtMs`、`finishedAtMs`。

输出不得包含 `projectId`、Task name/snapshot、trigger、actor、request/idempotency、parent/retry identity、input/output reference、cancel/error detail、Attempt、Event payload、Artifact/Log、Secret、Policy 或数据库 row。adapter 返回跨 Project、乱序、重复位置、越过 cursor 或超量结果时，projection 统一失败关闭。

每次 Tool call 继续复用同一个 admission 顺序：authentication → exact `tool.call:qinglong.run.list` + `run.read` Policy → durable audit → credential `confirm()` → Project-scoped bounded read。MCP 不缓存结果，不增加连接、timer、watcher、listener 或 background service。

Runtime Core 在 `run/` 领域目录新增 profile-neutral `ProjectRunListReader`/cursor/query，在 `tool-execution/` 新增低敏 Tool projection；Local SQLite 与 Cluster PostgreSQL 在各自 `run/` adapter 增加同契约查询。公开能力使用精确 subpath，不扩大 Runtime Core root facade。

## Package 与目录规则

Package 以独立部署、authority、依赖隔离、可替换 adapter 或多消费者 shared leaf 为边界，不以文件数为边界。包内源码遵循：

1. `src/` 根层只允许受审 binary entry、public export 或确有跨领域意义的 shared infrastructure；
2. 领域实现进入 `src/<domain-or-capability>/`，公开 subpath 直接映射 owning module；
3. 单文件/全根层 package 必须提供独立边界证据，否则结构门失败；
4. 不为“目录整齐”新建微包，也不把纯 facade 移入虚构的 `public-api/` 目录；
5. root file/line hard cap 只允许 ratchet，不允许随新增功能自动增长。

本批新增代码全部进入 `run/` 与 `tool-execution/`。当前 17 个 package、992 个 source 中 966 个 nested、26 个 root（97.4% nested），`singleSourcePackages=[]`、`shallowSourcePackages=[]`；新增 Runtime Core root export 曾使 160 行 hard cap 超出 1 行并被 gate 拒绝，随后改为精确 subpath，证明门禁能实际阻止根层继续膨胀。

## 被否决方案

1. 客户端传 Project ID：会把租户范围从可信 MCP 配置退化为调用参数。
2. offset/page-number 分页：历史增长后成本不稳定，并在并发插入时产生漂移。
3. 返回完整 Run record：会泄露命令关联、actor、错误与 Artifact reference，并让未来字段自动进入公共面。
4. 复用 Package Workflow 管理列表：其 Package/Workflow authority、审计事务和输出模型不适合通用 Run discovery。
5. 新建 `run-list` package：没有独立部署或依赖边界，只会形成微包。
6. 把新协议直接放到 `runtime-core/src/`：会扩大根 facade 和领域混杂，结构 hard cap 已明确禁止。

## 验收证据

- Runtime Core 453/453：Definition、默认/最大页、exact cursor、低敏字段、严格降序、跨 Project/乱序/超量故障关闭。
- Local SQLite 204/204：真实 migration/runtime repository、同时间 ID tie-break、跨 Project 排除、连续两页。
- Cluster PostgreSQL 286 pass/1 条件 skip：参数化 SQL、严格降序 keyset、limit 与 row normalization。
- Local MCP 8/8：三 Tool 静态发布、逐调用 permission/admission/audit 顺序、真实 stdio/API Credential/SQLite discovery E2E。
- package boundary 与 dependency audit compatible；17 package、无单文件/浅层 package、992 source 中 966 nested。
- 十二档 artifact 全部 compatible。最紧 Standalone Application AI 为 6,262,567 bytes/637 files，距离 6 MiB 上限 28,889 bytes；MCP Edge/Standalone 为 9,800,548/9,800,656 bytes、941 files、187 loaded modules，RSS 增量 43,008,000/43,171,840 bytes。
- 未新增 workspace package、production dependency、migration、表、索引、数据库连接或后台资源。

## 后续约束

Run filter/search、跨 Project 聚合、事件订阅、日志/Artifact 内容和任何写 Tool 必须另立 ADR，并证明索引、租户隔离、字段脱敏、限流、授权、审计及设备预算。新领域优先进入既有 owning package 的能力目录；只有 package ledger 的边界证据成立时才允许增加 package。
