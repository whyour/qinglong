# ADR-0368：有界、Project-scoped 的 Run Discovery HTTP API

- 状态：Proposed
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-45、D-46、D-49、D-52、D-269、D-278、D-279、D-280，ADR-0052、ADR-0349、ADR-0367

## 背景

Local 与 Cluster 已有同构的 `GET /api/v3/projects/{projectId}/runs/{runId}`，但调用方必须预先知道 `runId`。这使 HTTP API 无法从“最近运行”进入诊断闭环。MCP 已证明 Project-scoped keyset pagination、双方言 repository 和低敏字段白名单可用；HTTP 不应复制另一套排序、投影或存储协议。

该切片不得因增加第二条 route 再拆 package。Local 继续使用现有可选 `@qinglong/local-api` 单进程组合根；Cluster 继续使用现有 `@qinglong/cluster-control` route registry、admission pipeline 与 PostgreSQL Pool。

## 决策

1. Local 与 Cluster 同时增加 `GET /api/v3/projects/{projectId}/runs`，operation/permission 固定为 `run.list`/`run.read`。每页都必须经过 route/query validation → Authentication → Project Policy → durable security audit → credential fence（Local）→ bounded repository read。
2. query 只允许 `limit`、`after_created_at_ms`、`after_run_id`。`limit` 默认 32、最大 64；两个 cursor 参数必须同时出现，时间必须是 canonical 非负 safe integer，Run ID 必须满足现有 128 字符资源标识约束。重复、空值、未知、部分 cursor 或非 canonical decoded 数字在 Authentication 前失败关闭。Local loopback transport 额外拒绝 raw percent encoding；Cluster transport 先按 Node URL 语义解码，再对 decoded query 做 exact semantic validation，因此不宣称保留或拒绝原始编码形式。
3. Runtime Core 在现有 `src/run/projection/` 增加纯 `bounded-run-list-projection` subpath，统一输入、`limit + 1` storage fetch、排序复验、Project 遮蔽、低敏投影、`hasMore` 与 `next`。MCP `qinglong.run.list` 改为薄协议 adapter 并保持公开 Tool schema/错误不变；Local/Cluster HTTP 不依赖 MCP 或 Tool Registry/SemVer。
4. 返回固定 `{runs, hasMore, next?}`。Run item 只包含 id、taskId/revision、status/version/eventSequence、priority、execution origin/owner 和四个生命周期时间；不包含 Project、request/ref/trigger/attempt、executor、错误、Artifact、日志或 Secret 邻接字段。
5. 双方言复用现有 `(project_id, created_at_ms, id)` 索引与 `ProjectRunListReader`；不新增 migration、table、connection、transaction authority 或缓存。排序固定 `created_at_ms DESC, id DESC`，cursor 为上一页最后一个已返回项。
6. Local HTTP response 上限从只容纳 point read 的 4 KiB 调整为覆盖 64 条最坏字段长度低敏记录的固定 64 KiB；静态最坏 JSON envelope 为 61,516 bytes。Edge 并发仍为 4、Standalone 仍为 32，请求/URL/header/drain 上限不变。默认 headless Local artifact/image 仍不安装 `local-api`。
7. workspace 保持 18 package。新增代码只能进入 Runtime Core `run/projection`、Local API 既有 `run/admission/transport/application-runtime` 与 Cluster Control 既有 `run/application-runtime` 领域目录。不得以 route、projection、codec 或“一文件一目录”的形式制造新的 package/层级；单文件 capability 默认留在 owning domain，只有独立部署、authority、第三方运行闭包或被多生命周期复用的稳定安全叶子才允许形成 package 边界。

## 不采用方案

- **只给 Local 增加列表**：会让相同 `/api/v3` 在单机和集群具有不同的基础发现闭环。
- **HTTP 直接导入 MCP projection**：会把 MCP SDK/Tool Registry/SemVer 闭包带入普通 API 制品。
- **offset pagination**：深页成本随历史增长，且并发插入时容易重复或遗漏。
- **把 cursor 编成 opaque token**：首版没有签名/密钥 authority，编码并不增加可信度，反而扩大解析面。
- **返回数据库 Run row 或错误摘要**：`run.read` 不是调试、Artifact、日志或 Secret 权限。
- **新增 run-query package/service**：没有新的部署或权限边界，只增加 manifest、importer、SBOM 和低配安装成本。

## 完成门

- shared projection 覆盖默认/最大页、cursor、空页、排序、跨 Project/畸形 row、repository failure 与 module closure；
- Local 覆盖 canonical query、认证前拒绝、`run.list` audit、credential fence、真实 SQLite HTTP E2E、过载与 drain；
- Cluster 覆盖 reviewed route/operation allowlist、query、Policy/audit 顺序、真实 PostgreSQL repository contract；
- Runtime Core、MCP、Local API、Cluster Control/PostgreSQL 定向与完整 package/backend 通过；
- package/source/dependency boundary、默认 Local image、Local/Cluster artifact 与 PostgreSQL HA 不回归。

## 实现证据（2026-08-11）

- Runtime Core 466/466、Local MCP 38/38、Local API 19/19、Cluster Control 189 pass/2 条件 skip；18-package 完整门退出 0，backend 1,156 pass/2 条件 skip。
- workspace 仍为 18 package/1,018 source，其中 1,000 个位于 package 内部 domain/capability 目录，18 个 `src/` 根文件全部是受审 public/binary entry；无 single-source、shallow-source 或 package-boundary finding。
- dependency 回归 52/52，完整 dependency audit `findings=[]`；MCP 只新增 `@qinglong/runtime-core/bounded-run-list-projection` 这一条纯读 subpath allowlist，默认 Local image 继续不安装 `local-api`。
- 14 个 Local Profile artifact 全部 compatible。Edge/Standalone API 分别为 5,085,520/5,085,664 bytes、518 files、57 loaded modules，RSS 增量 12,681,216/13,041,664 bytes，低于 6 MiB/640 files/24 MiB；Edge/Standalone 并发仍为 4/32。
- 最紧的 Edge/Standalone Application+AI 分别为 6,281,356/6,281,488 bytes，距 6 MiB 上限仅 10,100/9,968 bytes；预算未放宽，后续闭包增长必须先裁剪，不能通过新增 wrapper/package 转移成本。
- PostgreSQL 18.4 arm64 HA Docker contract 112 gates 全部通过，timeline 1→2，report SHA-256 为 `a25e7226286f063d9b2e85a2a25c20834021627aa192e069f3bb4d40572c0447`；结束后临时容器、卷、网络均为零。

固定物理路由器上的 API Profile RSS/延迟报告仍未取得，因此 ADR 保持 Proposed；该缺口不影响本轮自动化实现完成结论。
