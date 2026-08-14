# ADR-0400：有界、受信的 Run 对比 Tool

- 状态：Accepted
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-308、Phase 2
- 关联 ADR：ADR-0133、ADR-0162、ADR-0163

## 问题

QingLong 3.0 首个稳定版本要求只读 Copilot 能比较最近成功与失败运行，但现有受信内建
Tool 只有 `qinglong.run.get@1.0.0`。让模型连续自由调用两次 `run.get` 会把选择、字段
裁剪、差值算法和一致性声明留给 Prompt；另建 Copilot 专用数据库查询又会绕过 Tool
Definition、Project Policy、durable start barrier、结果 Artifact 与 Trace/Audit 链。

对比能力还必须同时适用于低配路由设备和 Cluster。它不能引入新 package、连接池、
缓存、watcher 或后台采集器，也不能把 error、command、Artifact、PID、lease、Secret
或跨 Project 存在性送入模型上下文。

## 决策

1. 在既有 `@qinglong/runtime-core` 的
   `tool-execution/builtin-run-compare/` 领域目录内实现
   `qinglong.run.compare@1.0.0`，只从
   `/builtin-run-compare-tool` 与 `/builtin-run-compare-projection` 两个显式 subpath
   导出。它不进入 package 根入口，也不新增 workspace package。
2. Definition 固定为 `effect=read`、`risk=low`、权限 `run.read`、5 秒 deadline；
   executable binding 只允许 `database.read`，适用于 `edge|standalone|cluster-control`，
   recovery mode 为 `retry_safe_read`。Definition 必须先作为 `qinglong` Package 的普通
   contribution 进入当前 Project Tool snapshot；平台不会隐式授予任何 Project。
3. 输入只接受两个不同、各不超过 128 字符的 `baselineRunId` 与 `candidateRunId`。
   adapter 复用现有 `RunRepositoryReader.findRunById`，按 baseline → candidate 固定顺序
   串行执行两次有界点查；不新增 transaction 或并发读。任一点查损坏或不可用时，整个
   调用返回稳定 unavailable。
4. absent 与 cross-Project 对调用方统一为 `{found:false}`。可见 Run 只包含既有低敏
   projection：Run/Task revision identity、状态/version/event sequence/priority、执行来源/
   owner 与生命周期时间；request、trigger、input/output Artifact、executor handle、PID、
   lease、error 和 Secret 一律不输出。
5. 只有两侧都可见时才计算 `taskId|taskRevision|status|priority|executionOrigin|
   executionOwner` 的固定顺序 changed fields，以及可证明的 queue、execution、total
   duration delta。任一时间戳缺失、非安全整数或结束早于开始时，对应差值字段不出现，
   不以 `0` 冒充未知。
6. 输出永久携带 `consistency=ordered_independent_point_reads`。本协议不声称两次读取属于
   同一数据库 snapshot；每个 projection 的 version/eventSequence 供上层展示观察边界。
   若未来需要事务快照，必须由 repository 新契约独立评审，不能静默改变 v1 语义。
7. 该 Tool 复用既有 durable start → current binding → encrypted input Artifact → key →
   adapter → encrypted result Artifact → StepRun/RunEvent/Trace/Audit completion 链。本 ADR
   不开放新的 HTTP/MCP/Copilot route；产品组合仍必须显式装配 current snapshot、binding、
   repository 和 key authority。

## 低配与集群影响

- Edge/Standalone 空闲时零新增模块加载、timer、listener、数据库写入或后台唤醒；每次
  调用最多增加两次串行 Run 点查和一个调用期 deadline。
- Cluster 复用现有 PostgreSQL Run reader 与调用方 Pool；不新增表、migration、role、
  Pool、controller、Job 或缓存。
- package 数保持 18；新源码位于有稳定领域名的二级目录，不回到 `src` 根平铺，也不为
  两个文件制造微型 package。Runtime Core source 由 160 增至 162，新增量全部为 nested，
  根层仍精确为一个 160 行公开 export 文件。

## 被否决方案

1. **让 Prompt 自由组合两次 `run.get`**：不能冻结字段、顺序、差值和一致性声明。
2. **在 AI package 直连 Run repository**：会让模型路径绕过受信 Tool 和 durable evidence。
3. **一次并发读取两个 Run**：没有事务快照时并发不能提供更强一致性，却增加低配设备
   瞬时数据库并发。
4. **返回 error summary、日志或 Artifact**：它们需要独立授权、范围、脱敏和字节预算。
5. **找不到一侧时区分 absent/cross-Project**：会泄露跨租户 Run 存在性。
6. **新增 `ql3-run-compare` package**：没有独立部署、依赖或权限生命周期收益。

## 当前验证

- 定向 5/5：覆盖有界差值、固定读取顺序、跨 Project/absent 等价、时间戳缺失、别名与
  unknown input、损坏/不可用 repository、Definition/binding/authority 漂移、显式 subpath
  和根入口零导出。
- Runtime Core 全量 553/553 通过；TypeScript clean build 通过。
- 最终 18-package clean build/test 退出 0；backend 1,208 项为 1,206 pass、2 条平台条件
  skip、0 fail。package boundary 保持 18 个 package，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`；cluster dependency、Edge import 与 Cluster deployment 审计
  均无 finding。
- 基础 Edge、Edge AI、Edge MCP 最终制品分别为 2,589,812 / 3,121,108 /
  7,209,862 bytes，低于各自 4 / 5 / 16 MiB 上限；未装配的 compare subpath 由 Profile
  runtime export projection 裁掉，不产生默认常驻模块或发布闭包强依赖。
- GitNexus 对复用的 `executeBoundedRunReadProjection` 报告 LOW：1 个直接调用者、4 个
  总影响、0 条 execution flow。`RunRepositoryReader` 接口覆盖 11 个直接/33 个总依赖，
  为 MEDIUM，但本切片没有修改该接口，只消费既有 `findRunById`。
- 刷新索引后，新 `executeBuiltInRunCompareTool` 为 LOW：1 个直接调用者、6 个总影响、
  0 条 execution flow；adapter class 与 binding factory 均为 0 个产品调用者，精确反映
  “契约已提供、产品组合尚未默认装配”的状态。

## 后续门禁

1. 在 Local 与 Cluster 产品 composition 中装配 Definition/binding，并以真实 SQLite/
   PostgreSQL 完成 durable start→result completion 纵切面；
2. 增加受 Policy 保护的“按 Task 选择最近成功/失败 Run”，但不得把无界 search 交给模型；
3. 日志解释必须另设 range、redaction、Artifact 与 Prompt-injection 边界；
4. 固定物理 Edge 的单次对比延迟/RSS，以及 Cluster 多副本读取与 PostgreSQL failover 证据。
