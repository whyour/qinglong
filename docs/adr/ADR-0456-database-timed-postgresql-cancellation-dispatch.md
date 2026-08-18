# ADR-0456：数据库计时的 PostgreSQL CancellationDispatch

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-363、PR-5
- 关联 ADR：ADR-0001、ADR-0005、ADR-0041、ADR-0384
- Amends：ADR-0005 的 PostgreSQL adapter、时间 authority 与 token 持久化边界

## 上下文

ADR-0005 已在 Local Profile 建立 durable cancellation dispatch，但 Cluster Profile 不能直接复用 SQLite 的单写者事务或进程时钟。多个 cluster-control 副本可能同时扫描同一 Run；节点时钟漂移会让租约提前接管或永久延后；把 raw lease token 持久化又会扩大数据库快照、备份与只读诊断面的能力泄漏。

QingLong 3.0 还必须同时服务低配路由和集群节点。公共协议需要同构，部署依赖与运行 authority 必须按 Profile 隔离：Edge 不应因 Cluster 能力引入 `pg`、连接池或常驻协调器，Cluster 也不能用进程内锁冒充多副本共识。

## 决策

1. `CancellationDispatch` 的 canonical contract 位于 `@qinglong/runtime-core/cancellation-dispatch` 显式子路径，不从 runtime-core 根入口导出。它定义 exact-shape command/record/result、硬上限、状态不变量、结果分类和 domain-separated SHA-256 token digest；不拥有数据库连接、timer、worker 或部署 Profile。
2. claim command 只携带 Run/Attempt、已有的 `cancel_requested_at_ms`、owner、raw token 和有上限的 lease duration。result command只携带精确 fence、结果枚举、event ID，以及 retryable 结果所需的有上限 delay。调用方不得提交当前时间、lease expiry 或绝对 retry timestamp。
3. PostgreSQL Repository 在事务中以 `transaction_timestamp()` 取得唯一时间事实。lease expiry、`updated_at_ms`、`last_dispatched_at_ms` 和 retry due time均由数据库时间计算；Local adapter 保持注入/default clock，以便低成本确定性测试和单设备运行。
4. raw lease token 仅在成功 claim 的返回值中出现。durable record 与 PostgreSQL 表只保存 `sha256("qinglong.cancellation-dispatch-lease.v1\\0" || token)`；后续 result 在事务内重新计算 digest 比对。read/list、WAL、备份和诊断面不得恢复该 capability。
5. `pg-0066-cancellation-dispatch` 把 PostgreSQL capability 提升到 v65，创建 `ql3.run_cancellation_dispatches`。主键为 Run ID，Attempt 通过 `(attempt_id, run_id)` 复合外键固定绑定同一 Run；CHECK 约束状态、counter、lease/retry/terminal shape，索引只支持 bounded due 与 expired-lease recovery。
6. runtime role 对新表只有 SELECT、INSERT、UPDATE，没有 DELETE、TRUNCATE、REFERENCES、TRIGGER 或 schema create；migration owner 继续独占 DDL。readiness、Drizzle schema、reviewed SQL、migration checksum 与 catalog privilege 行必须保持锁步。
7. claim 的锁序固定为 Run→Attempt→CancellationDispatch。先验证 runtime-owned active Run、精确 cancel timestamp 与同 Run active Attempt，再创建或锁定 dispatch；跨 Attempt 重绑定失败关闭。正常 lease 未过期、不 due、terminal 和 blocked 都不会产生新 owner。
8. recordResult 使用同一锁序并精确验证 run/attempt/owner/token digest/expected version。在一个事务中更新 dispatch、对 Run version 做 CAS、分配 event sequence 并追加低敏 RunEvent；任一步失败全部回滚。stale fence 不能覆盖新 owner。
9. PostgreSQL adapter 只通过 `@qinglong/cluster-postgres/cancellation-dispatch` 和受审 runtime entrypoint 发布，不从 package 根入口扩张。它不自动创建连接池、扫描器、timer、listener 或 cluster-control 进程；生产启动/停止拓扑是后续独立决策。
10. Local legacy 表暂时保留既有列名与迁移兼容性，由 adapter 在 canonical record 边界投影 digest。D-363 不把这一点表述为 Local 数据库存量已经完成 raw-token 迁移；若要修改既有 SQLite durable layout，必须单独设计兼容迁移和回滚门。

## 被拒绝的替代方案

### 使用 cluster-control 进程时钟

拒绝。多副本时钟漂移会破坏 lease 与 retry 的单一到期语义，主库提升后也无法证明旧节点计算的绝对时间仍可信。

### 在表中保存 raw lease token

拒绝。token 是一次短期写能力，不是诊断事实。持久化 raw capability 会让只读快照、复制链和备份获得不必要的可重放材料。

### 只用唯一索引或进程锁去重

拒绝。它们不能同时表达过期接管、owner fencing、结果原子事件与多副本崩溃恢复。

### 把 adapter 从包根入口导出并自动启动

拒绝。根入口扩张会污染轻量依赖闭包，自动启动会在未决的生产拓扑之前引入常驻扫描与连接 authority。

## 资源、安全与部署影响

- Edge/Standalone 基础产物不新增 `pg` 或 cluster package；最小 Edge artifact 仍约 2.59 MiB。
- Cluster 新增一张当前状态表、两个恢复索引和短事务；无新 workspace package、生产依赖、Kubernetes 对象、端口、timer 或常驻进程。
- raw lease token 不进入 canonical record、PostgreSQL row、WAL 或事件；事件仍只含 Attempt、dispatch count 与固定结果枚举。
- 行锁顺序与 5 秒 statement timeout、1 秒 lock timeout、10 秒 idle-in-transaction timeout 共同限制锁等待；这不是无限并发压力证明，生产指标与容量门仍需完成。

## 验证

- runtime-core 契约 `5/5`，PostgreSQL schema/migration/readiness 聚焦 `75/75`；v65 checksum、CHECK/FK/index 与最小权限通过。
- 完整 backend：`1,487 pass / 0 fail / 2 conditional skip`；18-package 最新 clean/build 退出 0，随后 18-package 顺序测试单次退出 0。
- package boundary、Edge import、cluster dependency、cluster deployment、service-manager bridge 审计均零 finding；workspace package 精确为 18，新增实现位于明确子域而非 `src` 根平铺。
- `14/14` Local Profile artifact audit 通过；基础 Edge/Standalone 为 `2,589,998 / 2,590,076` bytes，没有 PostgreSQL 依赖泄漏。
- PostgreSQL 18.6 arm64 HA 门 `144/144`：双连接单 claim、数据库时钟、digest-only durable token、expired takeover、stale fence、retry due、事务回滚、WAL standby 可见和 promotion 后读取均通过；timeline `1→2`，报告 SHA-256 为 `b168b25023f7aad623153d22e41cccfe5f511a6985dc75c9e9e20073f980d5cb`。
- HA 临时 Docker 容器在门结束后全部清理。该证据不冒充 CloudNativePG、多节点网络分区或生产容量证明。

## 后续

下一阶段把 PostgreSQL CancellationDispatch Repository 接入 cluster-control 的明确生产 composition、单一 cadence、availability withdrawal、shutdown drain、指标与 blocked 处置面；随后补 CloudNativePG live failover、多副本压力、固定 x64/arm64 资源门。Local 侧如需消除 legacy raw-token 存量，另开兼容迁移 ADR，不与 Cluster rollout 混合。
