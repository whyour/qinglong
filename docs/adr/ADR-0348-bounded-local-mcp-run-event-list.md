# ADR-0348：有界、低敏的本机 MCP Run 事件诊断

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-260、D-261
- 关联 ADR：ADR-0028、ADR-0049、ADR-0052、ADR-0087、ADR-0155、ADR-0195、ADR-0276、ADR-0345、ADR-0346、ADR-0347

## 背景

ADR-0347 建立的 `qinglong.run.get` 能回答 Run 的当前低敏快照，但不能解释状态如何演进。桌面 Agent 和本机 AI Client 在诊断排队、重试、取消与终态收敛时需要有序事件元数据；RunEvent payload、Actor identity、Artifact/Log reference 等字段可能包含命令、错误或租户信息，不能因为增加诊断能力而进入 MCP 公共输出。

新增能力也不能让可选 MCP sidecar 获得写、调度、迁移或管理 authority，不能增加 SQLite connection、后台任务或默认 Edge/Standalone 闭包。一个新的只读 projection 没有独立部署、生命周期或消费者边界，因此不构成新增 workspace package 的理由。

## 决策

在既有 `@qinglong/local-mcp-server` 中增加第二个只读 Tool：`qinglong.run.events.list@1.0.0`。当前本机 MCP 只发布 `qinglong.run.get` 与 `qinglong.run.events.list` 两个 Tool，不开放动态注册。

输入固定为 `{runId, afterSequence?, limit?}`：`limit` 默认 32、最大 64，repository 最多读取 `limit+1` 条以计算下一页；输出固定为 `{found, events, hasMore, nextAfterSequence}`，其中每个 event 只含 `sequence`、`type`、`actorType` 与 `createdAtMs`。事件必须严格按 sequence 递增，分页游标只来自已返回的最后一条事件。

输出不得包含 RunEvent payload、event ID、dedupeKey、actorId、attemptId、stepRunId、Artifact/Log reference、命令、错误详情或数据库 row。Run 不存在与跨 Project 必须同样返回 `found=false`、空 events，且不得继续查询事件。存储故障或损坏顺序统一映射为低敏 unavailable error。

每次调用继续执行 ADR-0347 的逐调用 admission：

1. API Credential authentication；
2. Tool Registry 解析 exact Definition，并依次检查 `tool.call:qinglong.run.events.list` 与 `run.read`；
3. durable Security Audit 记录 `operationId=mcp.tool.call` 以及精确 Tool reason；
4. credential `confirm()` 关闭撤权窗口；
5. Project-scoped Run point read 确认所有权，再执行有界事件读取。

两个 Tool 通过 package-private descriptor registry 复用同一 admission 编排，避免各自复制认证、Policy、Audit 与 fence。`@qinglong/local-sqlite/mcp-read-database` 在同一 SQLite connection、operation authority、queue 与 close fence 上增加窄 `listEvents` reader；不取得 migration、management、repair、Run mutation、Shell、Secret、listener、timer、watcher 或 scheduler authority，也不增加 connection、cache、service、package 或第三方依赖。

Runtime Core 在既有 `tool-execution/` owning domain 增加 `builtin-run-event-list-projection` 公共子路径。它只承载稳定 Definition、严格输入验证、低敏投影和有界分页，不复用 Trusted Tool 的 executable authority，也不为单个 Tool 新拆 package。

## Package 与资源边界

本增量没有新增 workspace package 或 production dependency。MCP source import gate 只增加精确 runtime-core projection subpath；默认十档 Profile 仍不加载 MCP SDK。

当前 Edge/Standalone MCP 制品分别为 9,785,975/9,786,083 bytes、939 files、185 loaded modules，完整 import RSS 增量为 43,008,000/42,565,632 bytes，继续低于独立 16 MiB/1,536 files/48 MiB 门。最紧默认 Standalone Application AI 制品为 6,248,558 bytes，距离 6 MiB 门仅余 42,898 bytes；因此后续不得把 MCP SDK、事件 repository 或诊断缓存引入默认 application。

## 被否决方案

1. 返回完整 RunEvent payload：会把未来新增字段自动变成公共泄露面，也无法为 Secret、命令和错误内容提供稳定低敏保证。
2. 一次返回完整历史或提供无限 limit：设备成本随历史增长，恶意 Client 可放大 SQLite 延迟和内存。
3. 直接按 runId 查询事件：会泄露跨 Project Run 的存在性，并绕过当前 Policy 对象范围。
4. 复用 Workflow/Owner 管理 repository：会让 stdio session 持有无关 mutation、migration 或 destructive authority。
5. 同批开放 start、cancel、Shell 或事件写入：副作用 Tool 需要独立批准、幂等、限流和未知结果恢复设计。
6. 为 event projection、reader 或 registry 新增 package/service：没有独立部署或资源边界，只会增加 importer、SBOM 和低配设备成本。

## 验收证据

- Runtime Core 450/450：Definition、输入上限、严格有序分页、payload-free projection、跨 Project 屏蔽和故障关闭。
- Local SQLite 203/203：事件读取复用同一 operation authority、queue、connection 与 close fence。
- Local MCP 7/7：双 Tool 列表、逐调用 permission/admission 顺序、精确 durable audit reason 与真实 stdio JSON-RPC/SQLite 分页 E2E。
- package-boundary/dependency 定向 59/59；17-package ledger compatible，970 个 QL3 source 中 944 个 nested、26 个 root，未新增浅包。
- 默认十档与两个 MCP artifact 共十二档 compatible；默认 Profile loaded-module 数不变，MCP 制品只增加约 10 KiB 与 1 file。
- 本批未修改 SQL、migration、PostgreSQL 或 Cluster runtime，因此 PostgreSQL HA 不属于该变更的相关门，不能宣称由本批重新验证。

## 后续约束

事件 payload、Artifact/Log content、subscription/streaming、远程 transport 以及任何写 Tool 都必须另立 ADR，并证明字段级脱敏、租户隔离、限流、取消/幂等、durable audit 与资源预算。新增只读 Tool 也必须进入同一静态 descriptor registry，并逐调用经过认证、exact Tool permission、业务 permission、durable audit 与 credential fence；不得用 wrapper 绕过 admission。
