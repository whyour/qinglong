# ADR-0351：MCP 单一消费者 Tool Projection 的包内归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-259、D-260、D-261、D-262、D-263
- 关联 ADR：ADR-0303、ADR-0345、ADR-0346、ADR-0347、ADR-0348、ADR-0349、ADR-0350
- 修正：ADR-0348、ADR-0349、ADR-0350 中关于 MCP 单一消费者 projection 位于 Runtime Core 的实现归属；不改变其 Tool 协议、安全约束或存储契约

## 背景

`qinglong.run.events.list`、`qinglong.run.list` 与 `qinglong.task.list` 的低敏展示 projection 最初位于
`@qinglong/runtime-core/tool-execution`，并通过三个公开 subpath 供 Local MCP 调用。复核消费者后，这三个
projection 均只有 `@qinglong/local-mcp-server` 一个产品消费者，却使所有包含 Runtime Core 的 Edge、Standalone、
Cluster 与 Worker 制品携带约 23 KiB TypeScript source 及对应 JavaScript/declaration 生成物。

文件多少不是 package 边界。上述 projection 没有独立部署、依赖、authority 或多消费者复用理由，既不应拆成新的
workspace package，也不应继续作为 Profile-neutral Core 公共 API。相反，`qinglong.run.get` projection 同时被
Runtime Core 的可信 in-process Tool Adapter 与 Local MCP 使用，是真实的共享协议实现，不能随前三者迁移。

## 决策

1. `run.events.list`、`run.list`、`task.list` 的 definition、输入校验、低敏 projection 与错误类型归入
   `@qinglong/local-mcp-server/src/tool-projection/`，作为 package-private domain module；不增加 package export。
2. Local MCP `application-runtime` 只通过包内相对依赖装配这三个 projection。其 authentication、Policy、durable
   audit、credential confirm 与 SQLite read authority 顺序不变。
3. Runtime Core 删除三个 MCP 单一消费者 subpath，只保留共享的 `builtin-run-read-projection`。为避免 Local MCP
   从 Runtime Core root 加载完整 barrel，新增轻量 `@qinglong/runtime-core/run` 合约 subpath，公开已有 Run
   constants/types，不新增实现 authority。
4. 单元测试跟随 owner 移入 Local MCP；能力测试总量不得减少。package boundary ledger 与 dependency firewall 必须
   断言 Local MCP 的 `tool-projection` 目录和精确 Core subpath。
5. 后续 projection 只有满足“Profile-neutral 且至少两个独立产品消费者”时才可进入 Runtime Core。单一 adapter 的
   协议展示、字段裁剪和 SDK glue 默认归 adapter package 内部；新建 workspace package仍须独立证明 deployable、
   authority、dependency isolation 或稳定多消费者 leaf contract。

## 被否决方案

1. 新建 `ql3-tool-projections` package：只有一个消费者，没有独立生命周期或依赖隔离，会重新制造微包。
2. 把四个 projection 全部移入 MCP：会复制或反向依赖 `run.get` 的可信 Tool Adapter，破坏 Runtime Core 内执行闭环。
3. 继续保留三个 Core 公共 subpath：协议能工作，但所有低配和非 MCP 部署持续承担无用文件与容量成本。
4. 从 `@qinglong/runtime-core` root 导入 Run constants：会把轻量 MCP projection 绑定到宽 barrel，扩大加载面。
5. 复制 Run status/actor 常量到 MCP：会形成协议漂移，失去单一领域事实来源。

## 验证

- Runtime Core 446/446；Local MCP 21/21。原 Core 中 12 个 projection 测试完整迁移，产品行为未减少。
- package boundary/dependency 59/59；workspace 仍为 17 package、993 source，其中 967 nested、26 root（97.4%）；
  Runtime Core 141→138 source，Local MCP 4→7 source，无单文件或浅层 package。
- 十二档 artifact 全部 compatible。Standalone Application AI 从 6,270,988 bytes/638 files 降至
  6,244,785 bytes/635 files，距 6 MiB 上限 46,671 bytes；Standalone MCP 为 9,808,996 bytes/942 files、
  194 loaded modules，RSS 增量 37,224,448 bytes。
- PostgreSQL 18.4 arm64 HA Docker gate `gates.passed=true`：`remote_apply`、复制链分区、旧主 fence、timeline
  1→2、`pg_rewind` 只读重入、双 control replica 与领域 COMMIT-response-loss 均通过；结束后临时容器、卷、网络为零。
- 未新增 production dependency、workspace package、migration、表、索引、数据库连接、timer、listener、缓存或写 authority。

## 后续约束

新增 MCP Tool 前必须先定义 owner：共享执行语义进入 Runtime Core，单一 MCP 展示语义进入
`local-mcp-server/tool-projection`。当第二个独立产品消费者出现时，应另立 ADR 评估提升为 Core contract；不得仅为
复用测试、缩短 import 或让目录“更整齐”而提前公开或拆包。
