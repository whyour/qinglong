# ADR-0370：有界、Project-scoped 的 RunEvent 时间线 HTTP API

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-263、D-279、D-280、D-281、D-282，ADR-0348、ADR-0367、ADR-0368、ADR-0369

## 背景

D-280 已让 Local 与 Cluster 通过同构 HTTP API 发现和读取 Run，但排障仍只能看到 Run 当前快照。MCP 已有 `qinglong.run.events.list`，然而它的低敏投影仍由 MCP package 单独实现，HTTP 用户无法观察状态演进，并存在三份协议漂移的风险。D-281 已把最紧 Edge/Standalone Application+AI 的 6 MiB 余量恢复到 34,396/34,264 bytes，为一个受预算门约束的共享叶投影提供了空间。

## 决策

1. Local 与 Cluster 增加同构 `GET /api/v3/projects/{projectId}/runs/{runId}/events`，固定 operation `run.events.list`、permission `run.read`。不得接受 body；query 只允许 canonical 十进制 `after_sequence` 与 `limit`，默认 `after_sequence=0`、`limit=32`，最大 64。
2. Runtime Core 在既有 `run/projection/` 内拥有唯一 `boundedRunEventListProjection`。它先按 `runId` 读取 Run 并验证 Project 归属，再以 `afterSequence`、`limit+1` 调用既有 `RunRepositoryReader.listEvents`；不存在和跨 Project 返回同一 `found=false`，repository/shape/order 异常失败关闭。
3. HTTP 将 `found=false` 统一映射为 404 `run_not_found`；成功响应只包含 `events`、`hasMore`、`nextAfterSequence`。每个 event 只公开 `sequence`、`type`、`actorType`、`createdAtMs`，禁止 `id`、`actorId`、`dedupeKey`、`payload` 及其他内部事实越过投影。
4. event 必须严格按 sequence 升序且大于 cursor；请求 `limit+1` 只用于证明 `hasMore`，最多返回 64 条。`nextAfterSequence` 是最后一条已返回 sequence，空页保持请求 cursor。该 API 是 forward-only 当前视图，不宣称跨页数据库快照。
5. Local 复用现有 loopback listener、Edge 4/Standalone 32 并发、Bearer authentication、Project Policy、持久 Security Audit、credential/Pepper confirm 与唯一 SQLite authority。Cluster 复用受审 route registry、两阶段 admission、持久 Security Audit 与既有 PostgreSQL Pool。
6. MCP `qinglong.run.events.list` 改为共享投影的协议 adapter，保持 Tool 名称、输入输出和错误语义。普通 Local/Cluster HTTP 不得导入 MCP、Tool Registry 或 SemVer 闭包。
7. 不新增 workspace package、migration、index、repository method、数据库连接、listener、sidecar、timer、watcher、cache、authority 或默认启用面。实现落在既有 Runtime Core、Local API 与 Cluster Control 领域目录内。
8. D-281 的 6 MiB、文件数、module 与 RSS 门不得放宽。14 个 Local Profile artifact、默认 Local image、完整 backend/packages、dependency/package boundary 必须通过；Cluster production route 组合既有 PostgreSQL reader 后，必须重跑 PostgreSQL HA Docker 门。

## 实现与验收证据

- Runtime Core 已成为唯一投影所有者；MCP、Local API 与 Cluster Control 都只做协议/部署 adapter。Runtime 正向与负向 5/5、MCP adapter 4/4、Local route/admission/transport/真实 SQLite 以及 Cluster route/production composition 专项均通过。最大 64 条 RunEvent 的真实 HTTP JSON 为 13,754 bytes，低于固定 64 KiB response cap。
- 完整 18-package clean build/test 退出 0；backend 为 1,160 pass、2 skip、0 fail。workspace 为 18 package/1,022 source，其中 1,004 nested、18 个受审 root entry；无 single/shallow package，package boundary `findings=[]`，精确 dependency audit compatible。
- 14 个 Edge/Standalone artifact 全部 compatible。最紧 Application+AI 为 6,262,656/6,262,788 bytes、645 files、133 loaded modules，距 6 MiB 上限仍有 28,800/28,668 bytes；RSS 增量为 21,020,672/21,200,896 bytes，未放宽 24 MiB 门。Application+API 为 5,080,707/5,080,851 bytes、520 files、70 modules。
- AI-excluded Local image 为 arm64、UID/GID `65532:65532`，精确 10-package inventory 为 476 files/4,698,687 bytes。Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs 均在 read-only root、network none 下完成 active→graceful stop，SQLite integrity 为 `ok`。
- PostgreSQL 18.4 arm64 HA Docker 门 112/112，primary timeline 1→2；私有报告 SHA-256 为 `5951277a2578ebab521905329bbcbb45c781a08eadf19229a3b5344000f2319b`，离线 audit compatible、`findings=[]`。
- 没有新增 package、第三方依赖、lockfile 变化、migration、index、repository method、连接、listener、sidecar、timer、watcher、cache 或 authority；D-279/D-280 的固定物理路由器 API 证据仍由对应 ADR 跟踪，不阻塞这个共享时间线切片的接受。

## 不采用方案

- **直接复用 MCP 模块**：会把 Tool Registry/MCP 传输依赖带入普通 HTTP 制品。
- **在 Local/Cluster 各自复制投影**：三份低敏字段与分页语义会漂移。
- **返回完整 RunEvent payload**：payload 可能含 secret-adjacent、错误或插件数据，不属于低敏诊断面。
- **offset pagination 或无界时间线**：历史增长会直接转化为路由器内存和数据库扫描成本。
- **新增 timeline package/service**：单个纯共享叶不具备独立部署或 authority，增加 manifest、importer、SBOM 和低配成本。
- **新增索引或 schema**：双方言现有 `(run_id, sequence)` 唯一索引和 reader 足以支撑该 keyset，不应制造无关 migration。

## 完成门

- Runtime Core 正向覆盖默认/最大 page、`limit+1`、严格 sequence、低敏字段与 leaf import；负向覆盖输入、Project、row/order、oversize 和 repository failure；
- MCP 既有协议测试证明行为兼容且通过共享实现；
- Local route、transport、admission 与真实 SQLite HTTP 集成覆盖认证、授权、审计、凭据复验、404 遮蔽和 canonical query；
- Cluster route、registry、production composition 与 PostgreSQL 合同覆盖相同语义；
- 完整 backend/packages、14 artifact、Local image、dependency/package boundary 与 PostgreSQL HA Docker 门全绿，并记录实际 flash/file/module/RSS 与 HA 证据。
