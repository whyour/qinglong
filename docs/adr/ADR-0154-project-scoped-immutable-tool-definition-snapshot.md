# ADR-0154：Project-scoped 不可变 Tool Definition Snapshot

- 状态：Accepted（架构边界、纯 planner、canonical digest、轻量 contribution、
  8 MiB snapshot 上限、双方言 append-only repository、current-vector proof、
  分页双观察 production coordinator、本机 application gate、Cluster
  package-executor Job、executor-only PostgreSQL ACL 与 physical HA snapshot
  durability 已实现；Tool consumer admission 与 trusted handler binding 尚未实现）
- 日期：2026-07-26
- 关联：ADR-0133、ADR-0149 至 ADR-0153、QL-RFC-0001 D-131/D-144/D-148

## 背景

ADR-0150 允许 active Plugin Package 提供经 Package name 和已审批 permission 围栏的
`ToolDefinition`，ADR-0133 提供 immutable `ToolDefinitionRegistry` 与 Policy-fenced
invocation plan。但目前仍不能把多个 active Package 的 Definition 组成可供产品读取的
一致 registry。

这里必须避免两个看似直接但错误的推论：

- Package 提供 Definition 不等于 Package 可以注入 handler；
- 一个进程级全局 registry 不能代表所有 Project，因为不同 Project 可以安装不同
  Package generation。

如果 registry 没有绑定完整 active Package 集合，移除 Package、升级 generation 或
无 Tool 的 Package 发生变化时，旧 registry 可能继续被误认为当前。

## 决策

### 1. Snapshot 必须以 Project 为边界

`qinglong/project-tool-definition-snapshot@v1` 至少绑定：

- `projectId`；
- 完整、唯一排序的 active Package vector；
- 每个 Package 的 name、installation、generation、generation digest、lock digest 和
  materialized revision digest；
- 完整、唯一排序的 Tool Definition 与来源 Package/generation；
- active vector digest、definition digest 和 snapshot digest；
- 数据库提交时间。

active vector 必须包含没有 Tool 的 active Package。否则“Package 从无 Tool 升级为有
Tool”或“有 Tool 降级为无 Tool”不能可靠改变 snapshot identity。

一个 Project 最多 128 个 active Package、128 个 Tool Definition；任何重复
`name + version`、跨 Package namespace、来源 revision 漂移或超限都失败关闭。
完整 canonical snapshot JSON 另受 8 MiB 硬上限。

### 2. Builder 使用双观察，不建立第二个 Package pointer

caller-driven builder 固定执行：

1. 从耐久 install heads 分页读取一个 Project 的完整 active vector；
2. 对每个 Package 读取 active generation，必须与 install vector 精确一致；
3. 按 generation digest 逐项读取 immutable materialized revision，立即提取只含
   generation、revision digest 和 Tool Definition 的轻量 contribution，然后释放完整
   revision；
4. 从 contributions 构造确定性 snapshot；
5. 再次读取完整 install vector 和每个 active generation；
6. 全部未变才允许提交 snapshot。

planner 不得要求同时持有全部 24 MiB materialized revision；否则 128 个 active
Package 会在低配设备上制造不可接受的理论峰值。snapshot 不是第二个 active pointer。
source of truth 仍是 durable active install 与
ADR-0149 generation；snapshot 只是这一完整集合的不可变、可审计投影。

### 3. 双方言使用 append-only snapshot + source item

SQLite/PostgreSQL 使用既有 storage package 的显式 subpath，不新增 workspace package：

- snapshot 主表按 `Project + activeVectorDigest` 唯一；
- source item 表保存该 snapshot 的完整 Package vector；
- Definition 保存在规范化 snapshot JSON 中，并由索引列/CHECK 绑定 identity；
- create 只允许首次插入或完整 exact replay；
- update/delete 禁止。

`findCurrent(Project)` 必须在一次数据库观察中证明 snapshot source item 与当前 active
install heads 双向完全相等。安装刚提交而 snapshot 尚未发布、Package 被移除或任一
generation 改变时返回 unavailable/absent，禁止回退到旧 snapshot。这样不需要 timer、
watcher、LISTEN 或可变内存 head。

PostgreSQL 只允许 `ql3_package_executor` 创建 snapshot；未来 Tool invocation consumer
只取得经过 current-vector 复验的 SELECT，不取得 Package install、materialization 或
snapshot 写权。

### 4. Definition snapshot 不包含 handler

snapshot 和现有 `ToolDefinitionRegistry` 均不得包含函数、module path、dynamic import、
command、URL、MCP credential、数据库 service 或网络 client。Package 安装不能创建或
替换 handler binding。

后续受信 handler binding 必须由产品 composition 独立提供，并精确绑定：

- Project Tool snapshot digest；
- Tool name、version 和 definition digest；
- reviewed handler adapter identity/version；
- execution class、timeout/redaction/audit contract；
- 可用 Profile 与所需外部 authority。

没有 exact binding 的 Definition 必须保持不可调用。built-in、MCP、HTTP 和未来隔离
Package runtime 可以使用不同 binding ceremony，但均不能由 Package resource JSON
自行声明为已信任代码。

### 5. Profile 保持请求驱动

- edge/standalone：Task publication gate 后按 Project 构造 snapshot；空 Package 集合
  产生合法空 snapshot。读取与提交使用单 SQLite authority，无常驻 cache/timer。
- cluster：既有 package-executor Job 在 Task publication 后构造并提交 snapshot；
  多 Job 通过 active vector exact replay 收敛。
- worker：不构造 snapshot；只接受未来 execution plan 中已绑定的 handler identity。

## 被否决方案

1. **一个进程级全局 registry**：会混淆不同 Project 的安装集合和 Policy authority。
2. **只收集有 Tool 的 Package**：无 Tool→有 Tool 的升级不能被完整 source vector
   围栏。
3. **把 handler/module/URL 写进 Package Tool JSON**：把 Definition 安装升级为控制面
   代码或网络 authority 注入。
4. **以 registry cache 作为 current head**：进程重启、多副本和 Package 更新会产生
   stale truth；current 必须由数据库 active vector 复验。
5. **每次 Tool call 重读 staging/OCI**：绕过 immutable revision，并把调用可用性绑定
   到 Registry。
6. **为 snapshot 新建 package**：没有独立部署或版本生命周期，显式 subpath 足够。

## 实现门

1. runtime-core pure planner、canonical digest、轻量 contribution、8 MiB、
   128/128 bounds，以及 active-source/pending-Project keyset、双观察 publication、
   有界 recovery/final probe 和 drift tests（已完成，runtime-core 275/275）；
2. 双方言 append-only snapshot/source-item schema、exact replay、active-vector
   current proof 与显式 storage subpath（已完成：SQLite capability v25；
   PostgreSQL `pg-0027` / capability v26）；
3. install vector 在 queued/staged/activating 窗口保持旧 active generation、active
   commit 后旧 snapshot 立即失效，以及 stale publish conflict 的双方言共享契约
   （已完成；source page 精确绑定 active install 与 immutable revision，publication
   在提交前完成第二次完整观察）；
4. local application 在未来 Tool consumer admission 前按 Project 请求驱动发布
   current snapshot（已完成；位于 Task publication 后、Secret/Run/lifecycle/admission
   前；只分页处理缺 current snapshot 的 active Project，空 Project 生成合法空
   snapshot，无 timer/watcher/全历史扫描）；
5. PostgreSQL `ql3_package_executor` 的 snapshot `SELECT/INSERT`、其余常驻角色
   default deny、真实六角色 PostgreSQL 18 integration 与 physical HA readiness
   （已完成；package-executor recovery Job 在 Task publication 后运行同一有界
   coordinator。PG18.4 arm64 六角色真库 38 pass/1 条件 skip；25 个 physical HA
   具体 gate 与总 `passed` 全绿，snapshot 在旧主由 executor 发布、晋升前完成
   `remote_apply` 复制并在 timeline 2 以相同三层 digest 读取）；
6. 独立 ADR 冻结 trusted handler binding、preview/approval、StepRun/Trace/Audit 后，
   才能开放 Tool execution（待实现）。
