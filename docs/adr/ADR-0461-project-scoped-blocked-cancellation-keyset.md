# ADR-0461：Project-scoped Blocked Cancellation 固定键集分页

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-368、PR-5、PR-7
- 关联 ADR：ADR-0005、ADR-0458、ADR-0459、ADR-0460
- Amends：ADR-0460 的未知 blocked Run drill-down 边界

## 上下文

`ql3 run status` 已能低成本判断一个 Project 是否存在 blocked cancellation，但 operator 若事先不知道 Run ID，仍无法进入 inspect/rearm。把 Run 列表直接并入 summary 会让固定低基数状态卡变成分页协议，也会把调用次数、状态筛选和数据量控制权交给客户端。

QingLong 必须同时覆盖低配路由设备和集群节点。该能力只属于显式安装的 Cluster 管理面；不能为 Edge/Standalone 增加 PostgreSQL、管理凭据、后台扫描器或新的包。Cluster 侧则必须避免跨租户扫描，并在并发 rearm、failover 和翻页期间保持可解释的快照边界。

## 决策

1. 在既有 Run management 协议增加 `run.cancellation.blocked.list`，并在既有 `ql3 run` 增加一次性 `blocked --config=... --assertion=... --project=... [--cursor=...] [--format=text|json]`。不新增 package、binary、服务、端口、timer、queue、cache、连接池或 Kubernetes 对象。
2. 服务端页大小固定为 16，内部只读取 `limit + 1`。客户端不能提交 limit、状态、排序、时间窗口或任意路径，也不自动翻页；每次命令只发送一个请求并退出。继续读取必须由 operator 显式传回上一页的不透明 cursor。
3. 页面只返回 `{runId, blockedAtMs}`，按 `(blockedAtMs, runId)` 严格升序；不返回 Attempt、blocking result、dispatch version/count、lease owner/token/digest、PID、Worker、命令、环境、Secret、日志或错误原文。具体诊断继续走既有单 Run inspect，处置继续走 exact-CAS rearm。
4. 首页以 PostgreSQL `transaction_timestamp()` 固定 `snapshotAtMs`；后续 cursor 精确包含 `{snapshotAtMs, blockedAtMs, runId}`。所有页都要求 `updated_at_ms <= snapshotAtMs` 并从上一键之后继续，因此翻页不会吸收快照之后新 blocked 的记录。已被 rearm 的行可以从后续页消失；该列表是有界运维发现视图，不是历史审计账本。
5. cursor 在产品 CLI 中编码为版本化 canonical base64url token，大小和字段精确受限。服务端、transport、client 和 CLI 分别验证 exact shape、整数范围、Project/request 绑定、严格排序、快照上限、16 项上限、`truncated/nextCursor` 一致性；非法 token 在网络 I/O 前以 usage 64 失败关闭。
6. 读取要求强认证 User 与 `run.read`，复用 Run 专用 mTLS/OIDC 和固定 management route。Policy fence 确认、数据库时间、键集读取及 allowed audit 位于同一个最长 5 秒的 SERIALIZABLE 短事务；denied audit 保留既有事务外低敏失败路径。
7. `pg-0068-cancellation-dispatch-project-keyset` 把 capability 提升至 v67：为 dispatch 持久化 `project_id`，由既有 Run 关系一次性回填并设为非空；增加 `runs(project_id,id)` 唯一键、dispatch `(project_id,run_id)` 复合外键，以及仅覆盖 blocked 行的 `(project_id,updated_at_ms,run_id)` partial index。运行时 claim 从已锁定 Run 取得 Project，并与 dispatch 原子写入，禁止跨 Project 身份漂移。
8. migration 的一次性回填和索引建立属于 3.0 孵化期 schema 修正。升级前必须按现有 migration ceremony 评估表大小和锁窗口；运行时查询不得在缺少 v67 capability 时降级为跨租户扫描。
9. 实现继续内聚在现有 `cluster-postgres/run-management`、`cluster-postgres/run`、`cluster-admin/run-management` 子域。`src` 根只保留受审入口；不为一个分页查询拆单文件微包，也不把实现重新平铺到 package 根。
10. Edge/Standalone 及其 Application、AI、MCP 制品继续禁止依赖 `cluster-admin`、`cluster-postgres`、`pg` 或该命令。低配路由器默认零新增进程、连接、timer、磁盘 schema 和安装字节；只有 Cluster operator 的显式调用承担一次短事务和一次短 TLS 连接。

## 被拒绝的替代方案

### 在 summary 中附带前 N 个 Run

拒绝。summary 的固定计数契约会被分页状态污染，告警调用也会无条件读取 identity；N 之外仍无法处置，而且无法表达稳定 continuation。

### 允许客户端选择 limit、排序或 blocking result

拒绝。它扩大查询形态、索引组合和响应预算，并可能被用作高基数枚举。固定 16 项足以驱动人工 drill-down，规模化消费应另行设计受控导出。

### 只在 dispatch 上按 status/updated_at 建全局索引

拒绝。Project 查询必须先跨租户读取候选再 join/filter，既浪费资源也削弱租户边界的数据库证明。Project identity 必须进入 dispatch durable row、外键和 partial index。

### offset 分页或客户端自动翻到结束

拒绝。offset 在并发 rearm 下会跳项/重复且成本随页数增长；自动翻页会把一次性产品命令变成隐藏的无界循环。快照键集和显式逐页调用保持成本可见且有上限。

### 为列表新增 scanner、缓存或常驻 Console authority

拒绝。durable dispatch 已是数据库事实源；第二份缓存会在重启/failover 后漂移。常驻高权限 authority 与后台扫描也不符合小型 Cluster 和可选 Console 的资源/安全边界。

## 资源、安全与部署影响

- 每次调用最多读取 17 个 partial-index entry、返回 16 个低敏 identity，并写一个安全审计事件；没有 N+1、后台 cadence 或隐藏重试。
- v67 migration 会对已有 dispatch 行做一次 Project 回填并建立新索引；这是明确的升级维护窗口成本，不是运行时常驻成本。
- rearm 可使同一快照中的尚未读取项消失，因此 cursor 保证“不会读入快照后新增项”和“顺序单调”，不承诺历史集合冻结。需要历史证明时使用 Security Audit/RunEvent，而不是列表页面。
- 文本与 JSON 共用已验证 projection；cursor 不含凭据或 capability，但仍按不透明 continuation 处理，不写入 operator context。
- workspace 维持 18 个职责包；新增源文件全部位于已有领域目录，package boundary 审计继续禁止不合理单文件包、浅层实现和 `src` 根实现增长。

## 验证

- migration/schema lockstep、repository、service、transport、client、产品 cursor/card 与真实 TLS CLI 测试覆盖 v67 checksum、Project 复合外键、partial index、固定 16+1、snapshot continuation、原子 audit、viewer `run.read`、低敏页面和网络前 cursor 拒绝。
- Cluster Admin 全量 `413 total / 410 pass / 3 conditional skip / 0 fail`；Cluster PostgreSQL 全量 `347 total / 344 pass / 3 conditional skip / 0 fail`；package layout 聚焦审计 `10/10`。
- 完整 backend `1,489 total / 1,487 pass / 2 conditional skip / 0 fail`；18-package clean build/顺序测试单次退出 0。依赖审计曾发现 Admin client 为页大小常量导入 PostgreSQL run-manager authority，最终把 `16` 收敛为 runtime-core profile-neutral protocol constant，不放宽审计；修复后相关三包重建与 26 项聚焦门通过。
- package boundary、Cluster dependency、Edge import、Cluster deployment 四项审计全部 compatible；workspace 维持 18 包且 `singleSourcePackages=[]`、`shallowSourcePackages=[]`，Cluster Admin 为 `124 source / 123 nested`，Cluster PostgreSQL 为 `173 source / 172 nested`。
- `14/14` Local artifact audit 全部 compatible；基础 Edge/Standalone 为 `2,589,998 / 2,590,076` bytes，Application+AI 为 `4,493,151 / 4,493,283` bytes，MCP 为 `7,315,930 / 7,316,038` bytes，证明 Cluster-only 分页和 v67 schema 未进入低配设备闭包。
- PostgreSQL 18.6 arm64 HA `146/146`、timeline `1→2`；真实 migration、blocked list、Project partial-index plan、同事务 allowed audit、rearm、production delivery、WAL replay 和 promotion 后读取全部通过。私有报告 SHA-256 为 `1fbd58c5bb32bbf83b6c1970a594f7879c33d63057a3b9c34f13ec9917ff5c44`，独立 evidence audit compatible 且零 finding。

## 后续

D-369 可设计 Copilot Console 的显式可选 Run management authority 与用户触发式 status→blocked→inspect 导航，但不能默认持有管理凭据、后台轮询、自动翻页或把 rearm 变成只读 Console 能力。CloudNativePG live failover、固定 Linux x64/arm64 容量和物理 Edge 资源证据仍是独立发布门。
