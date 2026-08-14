# ADR-0402：有界的 Task 最近成功/失败 Run 对比

- 状态：Accepted
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-310、Phase 2
- 关联 ADR：ADR-0347、ADR-0400、ADR-0401

## 问题

ADR-0400/0401 已提供按两个显式 Run ID 对比的共享受信 Tool 和可选本机 MCP 入口，但“选择
最近一次成功与失败运行”仍可能被留给模型。模型如果循环调用 `run.list`、翻页并自行过滤，
搜索次数、历史范围和停止条件都不可证明；在低配路由设备上会形成不可控 SQLite I/O，在
Cluster 上也会放大数据库读取和模型上下文，同时给 Prompt 注入制造更大的输入面。

直接把 Task/status 过滤继续塞入通用 Run Reader 也不合理。GitNexus 显示
`LocalSqliteRunReader` 为 CRITICAL（14 个直接、29 个总影响、1 条产品启动流程），
`PostgresRunReader` 为 HIGH（7 个直接、15 个总影响）。为了一个 AI 只读用例扩大这两个基础
Reader 的职责，会让本地恢复、API、Cluster recovery 和写事务继承树承担无关回归风险。

## 决策

1. 增加 `qinglong.task.runs.compare@1.0.0`。输入精确为一个不超过 255 字符的 `taskId`，
   没有 `limit`、cursor、status、SQL、排序或 Project 参数；Project 只来自受信 composition。
   Definition 固定为 `read/low`、`run.read`、5 秒 deadline。
2. Runtime Core 在 `run/outcome-comparison/` 定义窄
   `TaskRunOutcomeWindowReader`。repository 一次只返回按
   `(created_at_ms DESC, id DESC)` 排列的最小五字段记录：Run/Project/Task identity、status 和
   created time。Tool 固定请求 65 条，其中前 64 条是搜索窗口，第 65 条只证明还有更老记录；
   协议永远不返回 cursor，模型不能扩大窗口。
3. 前 64 条中第一个 `succeeded` 是 baseline，第一个 `failed` 是 candidate。两者都找到，
   或存储明确返回不超过 64 条时，`selection.complete=true`；如果窗口已满且缺少任一结果，
   输出 `complete=false`，不能把“窗口内未找到”伪装成历史上不存在。
4. 选择后按 succeeded → failed 固定顺序执行最多两个既有 Project-scoped Run 点查，并复用
   ADR-0400 的低敏 projection、changed fields 和时长差值算法。选择出的 Run 如果消失、变更
   Task/outcome、跨 Project 或损坏，整个调用稳定 unavailable；不回退到继续搜索。
5. 输出携带
   `consistency=bounded_task_window_then_ordered_point_reads`。它明确表示一次有界选择查询后跟
   两次独立点查，不声称数据库事务快照。baseline 永远代表 succeeded，candidate 永远代表
   failed，差值方向固定为 failed − succeeded。
6. SQLite 与 PostgreSQL 各自新增独立、二级目录内的窄 adapter，不修改现有通用 Run Reader
   或 Repository 继承树。SQLite 真实 `EXPLAIN QUERY PLAN` 必须命中既有
   `ql3_local_runs_task_created_idx`；PostgreSQL adapter 使用同样的 Project/Task/order/`LIMIT 65`
   查询。复用既有索引避免新增 migration、索引空间和每次 Run 写放大。
7. 可选 `ql3-mcp` 复用既有逐调用 Owner credential → Tool Policy → durable allowed audit →
   credential confirm 链，审计理由固定为 `tool_qinglong_task_runs_compare`。默认 Edge/Standalone
   仍不装载 MCP；Cluster 只获得显式 PostgreSQL adapter subpath，不开放 ambient MCP/HTTP
   endpoint，内部 Copilot 仍须走完整 Trusted Tool completion 链。

## 低配、集群与 package 布局

- 默认低配设备没有新增进程、连接、timer、listener、watcher、cache、migration 或索引；启用
  MCP 时每次调用固定为一个 65 行上限的最小列查询和最多两个串行点查。
- Cluster adapter 复用调用方现有 queryable/Pool，不创建第二连接池；driver 错误收敛为稳定
  repository operation error，畸形 bigint/status 收敛为 constraint error。
- package 数保持 18。能力落入 Runtime Core 既有 `run/outcome-comparison/` 与
  `tool-execution/builtin-run-compare/`，持久化实现落入两端既有
  `run/outcome-comparison/`；不为一两个文件创建微型 package，也不回到 package `src` 根平铺。
- Runtime Core、Local SQLite、Cluster PostgreSQL 只提供显式 subpath，package 根入口不扩大；
  Local MCP dependency firewall 只放行两个新 Runtime Core 精确 subpath。

## 被否决方案

1. **让模型分页 `run.list`**：查询次数、停止条件和上下文大小不可证明。
2. **把 task/status/cursor 加入通用 Run list**：会把 AI 用例扩散到 HTTP/API 和基础 Reader，
   且仍允许模型无界翻页。
3. **分别查询所有成功和失败历史**：即使只返回一条，缺少固定窗口时存储扫描和语义仍无界。
4. **为两种 outcome 新增索引**：会增加所有设备的磁盘与 Run 写放大；固定 64 条窗口可复用
   已有 Task 时间索引，当前收益不足以支付 migration 和低配常驻成本。
5. **修改 `LocalSqliteRunReader`/`PostgresRunReader`**：GitNexus 已证明 HIGH/CRITICAL blast
   radius，独立 reader 能用更小权限和故障域完成目标。
6. **只返回两个 Run ID**：仍迫使调用方再次自由组合字段和差值；本 Tool 应交付完整的有界
   低敏对比结果。

## 当前验证

1. Runtime Core 定向 10/10：覆盖成功/失败选择顺序、差值、固定 64+1 窗口、无 cursor、
   incomplete 语义、跨 Project/乱序/畸形/消失/存储失败、Definition/binding 漂移、显式
   subpath 和根入口零导出。
2. Local SQLite 1/1：fresh production migration 后写入多 Project/Task/状态 Run，经 MCP 的
   单 authority 读取精确窗口，并用真实 `EXPLAIN QUERY PLAN` 证明命中既有 Task 时间索引。
   PostgreSQL adapter 2/2：精确 SQL/参数/顺序/上限、bigint 映射、畸形状态和 driver 错误
   收敛全部通过。
3. Local MCP 47/47：新增 Tool discovery、固定 read-only annotations、双 permission、durable
   audit reason、credential confirm、真实 stdio + fresh SQLite 的选择和两次点查均通过。
4. dependency firewall 53/53，完整 dependency audit 与 package boundary audit 零 finding；
   package 保持 18 个，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。
5. 最终 18-package clean build/test 退出 0；backend 1,208 项为 1,206 pass、2 条平台条件
   skip、0 fail。Edge import 与 Cluster deployment 审计零 finding。Runtime Core 为 165/164
   nested、Local SQLite 为 197/196 nested、Cluster PostgreSQL 为 168/167 nested，三者 package
   根入口均未增长。
6. 默认 Edge artifact 保持 2,589,812 bytes/315 files/56 modules，证明未装配能力被完全裁掉；
   RSS 增量 11,173,888 bytes，低于 16 MiB 门。Edge-MCP 为 7,237,187 bytes/795 files/
   220 modules/RSS 38,699,008 bytes，Standalone-MCP 为 7,237,295 bytes/795 files/
   220 modules/RSS 38,600,704 bytes，均低于 16 MiB/1,536 files/48 MiB 门。
7. PostgreSQL 18.4 arm64 HA 125/125 Gate 通过，timeline `1→2`，报告 SHA-256 为
   `229c7cac328ee960f667f92868374264a10cb75090ef93d644da1326385d8774`；容器、网络与卷零残留。

## 后续门禁

1. Cluster 产品 composition 装配 Definition/binding，并以真实 PostgreSQL 完成加密结果和
   StepRun/Trace completion；
2. 日志解释另建 Artifact range、redaction、prompt-injection 和字节预算协议；
3. 固定物理 Edge MCP 单次选择/点查延迟与 RSS，并验证撤权竞态。
