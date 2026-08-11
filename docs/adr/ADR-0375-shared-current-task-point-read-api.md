# ADR-0375：共享的 current Task point-read API

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-239、D-253、D-257、D-262、D-279、D-280、D-285、D-286、D-287，ADR-0256、ADR-0272、ADR-0350、ADR-0373、ADR-0374

## 背景

D-286 已让 Local、Cluster 和 MCP 能以稳定 keyset 发现 Project 的 current Task，但客户端若持有一个 Task ID，仍必须扫描列表才能确认它当前是否存在、是否启用以及具体 revision。后续 Task start 又必须绑定明确的 current revision 与 immutable content digest，否则 discovery 与 mutation 之间的定义变化会被静默接受。

直接返回完整 TaskDefinition 不是可接受的捷径：command、public environment、SecretRef、working directory、placement、description 与 labels 都可能暴露执行细节或 secret-adjacent 内容，并会把内部 spec 格式冻结成公共 API。point read 应先提供精确 current-head identity/fence；完整 spec preview 与 Task start 继续分别评审。

## 决策

1. Runtime Core 在 `task-definition/projection` 拥有唯一 `executeBoundedTaskReadProjection`，输入为可信 Project ID 与一个 Task ID，只调用 `TaskDefinitionSource.findCurrentTaskDefinition(projectId, taskId)`。
2. 找到时只返回 `found=true`、`taskId`、current `revision`、`name`、`kind`、`specSchema`、`enabled`、`contentDigest`、`createdAtMs`、`updatedAtMs`。`contentDigest` 是后续 mutation 的 optimistic fence，不是执行授权。
3. 不得返回 Project、description、spec config/command/environment/placement、labels、mutationId、SecretRef 或数据库 row。合法的不存在、Task identity 不匹配与跨 Project 记录必须统一为 `found=false`；畸形 record、digest/time 不一致和 repository failure 必须失败关闭为 unavailable。
4. Local 与 Cluster 增加同构 `GET /api/v3/projects/{projectId}/tasks/{taskId}`，固定 operation `task.get`、permission `task.read`。不允许 query 或 body；Local 继续在 authentication 前拒绝非规范 path/query，Cluster 复用 route registry 的 exact path/query 编译。
5. HTTP 找不到统一返回 `404 task_not_found`；存储或投影不可用统一返回 `503 task_query_unavailable`。响应不把 Project ID 重复写入 body，Project authority 来自经过 admission 的 path binding。
6. 本机 MCP 增加 `qinglong.task.get@1.0.0`，输入只有 `taskId`，输出直接复用共享 projection。Tool 固定 `effect=read`、`risk=low`、`task.read` 与 5 秒上限，复用 authentication→Tool Policy→durable audit→credential confirm→同一 SQLite authority。
7. Local Application product surface 和 Local MCP database 只把既有 source 的 `findCurrentTaskDefinition` 加入窄 read authority；Cluster 复用 `ClusterControlAssemblyInput.taskDefinitions` 与现有 PostgreSQL Pool。
8. 不新增 workspace package、第三方依赖、migration、表、索引、数据库连接、listener、sidecar、timer、watcher、cache 或写 authority。历史 revision read、完整 spec preview、Task start、input payload 与 mutation 继续需要独立 ADR。
9. D-285/D-286 的 18-package、14 Profile artifact、真实 Local image、完整 backend/packages、dependency/package boundary 与 PostgreSQL HA 门不得放宽。

## 不采用方案

- **让客户端扫描 Task list**：深链接成本随 Task 数量增长，也不能获得明确的 current digest fence。
- **返回完整 TaskDefinition**：会泄露命令、环境、SecretRef 和部署细节，并提前冻结扩展 spec 协议。
- **只返回 revision、不返回 digest**：同一 revision 的损坏或错误 adapter 映射无法被客户端/后续 start 计划绑定。
- **把 `task.get` 合入 `task.list` query**：混合 collection 与 resource 语义，增加游标和 not-found 歧义。
- **只实现 HTTP 或只实现 MCP**：会让人类客户端与 AI 客户端拥有不同的 current-head/fence 语义。
- **新增 Task query package/service**：纯投影没有独立部署、authority 或重依赖隔离价值。

## 完成门

- Runtime Core 覆盖 found/absent、字段脱敏、disabled Task、跨 Project、畸形 record、digest/time drift 与 repository failure；leaf import 不加载 Tool Registry/SemVer。
- Local route、transport、admission、product authority 与真实 SQLite HTTP 覆盖 `task.read`、pre-auth query rejection、credential confirm、durable `task.get` audit、404 masking 和同一 storage authority。
- Cluster route、registry 与 production composition 使用既有 `TaskDefinitionSource`/Pool，并覆盖 Policy、audit、404 masking、无 query/body 与响应上限。
- MCP 覆盖精确 Tool schema、`task.read` admission、durable audit、credential confirm、真实 stdio/SQLite current Task read，并证明只调用共享投影。
- Runtime Core、Local SQLite、Local API、Local Application、Local MCP、Cluster Control、双方言相关测试、完整 backend/18-package、14 Profile artifact、真实 Local image与 PostgreSQL HA 全绿。

## 验收证据

- Runtime Core 486/486、Local SQLite 213/213、Local API 39/39、Local MCP 45/45、Local Application
  45 pass/4 条件 skip、Cluster Control 204 pass/2 条件 skip；完整 18-package clean build/test 退出 0，完整
  backend 1,163 pass/2 条件 skip、0 fail。Local HTTP 使用真实 SQLite authority 持久化 `task.get` audit，MCP
  stdio 使用同一 SQLite current Task source；Cluster production composition 使用既有 PostgreSQL source/Pool。
- workspace 保持 18 package/1,035 source，其中 1,017 nested/18 个受审根入口，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`。package boundary 正反向门 62/62，dependency audit `findings=[]`；没有新增 package、
  第三方依赖、migration、表、索引、连接、listener、timer、watcher、cache 或写 authority。
- 14 个 Profile artifact 全部 `compatible=true`。默认 Edge/Standalone 仍为 2,385,220/2,385,298 bytes、288 files、
  50 loaded modules；Application、Adopted、AI 与 Application AI 档相对 D-286 精确不变。选择 Local API 的
  Edge/Standalone 为 3,538,918/3,539,062 bytes、416 files、80 modules，相对 D-286 增加 5,412/5,412 bytes、
  2 files、2 modules；选择 MCP 的 Edge/Standalone 为 7,161,579/7,161,687 bytes、776 files、213 modules，
  相对 D-286 增加 7,364/7,364 bytes、2 files、2 modules。未选择 API/MCP 的低配部署不承担该增量。
- 真实 arm64 Local Application image 为 10 package/380 files/3,284,889 bytes，默认不含 Local API、MCP、AI 或
  Cluster package；Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs 均以 UID/GID `65532:65532`、只读根、
  `network=none` 完成 active→graceful stop，SQLite integrity `ok`。临时 image 已删除。
- PostgreSQL 18.4 arm64 HA 通过 112 gates，timeline `1→2`，报告 SHA-256
  `d2f02a7cd67a712e5fe3e2152c8c3afdefe9680d51c6c0ab108c6882ac7c841c`；旧主 fence、promotion、`pg_rewind`/
  rejoin 与 fresh replica 收敛后 Docker 容器、网络、卷零残留。
- GitNexus 刷新为 47,031 nodes/106,513 edges/1,853 clusters/295 flows。四个新增生产符号均为 LOW：Local route
  1 direct/1 process，Cluster route 1 direct/2 total，MCP Tool 1 direct，共享投影 0 indexed upstream；跨 package
  export 未形成的调用边由三端定向测试、完整 package、真实 SQLite/MCP 与 artifact 门补强。无 HIGH/CRITICAL。
