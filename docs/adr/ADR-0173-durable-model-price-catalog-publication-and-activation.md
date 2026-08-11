# ADR-0173：耐久 Model Price Catalog 发布、激活与撤销

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-12、D-13、D-156、D-160、D-161、D-162、D-163；ADR-0167、ADR-0168、ADR-0170、ADR-0171、ADR-0172

## 背景

ADR-0172 已要求一次 Model invocation 在 provider I/O 前绑定 exact price revision，
但当时的 `StaticModelPriceCatalog` 只是运行时消费契约。它没有回答：

- 谁能发布价格，以及 publication 如何绑定 User、mutation 与数据库时间；
- Cluster 多副本如何原子决定当前 revision，SQLite 重启后如何保留同一事实；
- activation 响应丢失、并发切换和 stale writer 如何精确收敛；
- 错误价格如何永久撤销，避免稍后被另一副本重新激活；
- runtime 为什么只能读价格，而不能成为价格管理 authority；
- 如何在不增加低配路由器常驻进程、package 或依赖的情况下提供双方言能力。

## 决策

### 1. Publication 是不可变事实

`qinglong/model-price-catalog-publish-command@v1` 固定 provider、model、
price revision、USD 整数 micro-rate、mutation ID、publisher User 与 command digest。
Repository 使用数据库时钟创建
`qinglong/model-price-catalog-publication@v1`，并绑定 catalog、command 与 publication
digest。

同一 provider/model/revision 只能存在一条 publication。同一 mutation 与完全相同
command 可返回 `existing`；revision、mutation 或内容任一漂移都必须冲突，不能 update、
upsert 或 delete 历史价格。

### 2. 当前配置只由 append-only generation head 表达

`qinglong/model-price-catalog-transition-command@v1` 支持：

- `activate`：把一个已发布且未撤销的 revision 设为 current；
- `deactivate`：明确进入无 active revision；
- `revoke`：为目标 revision 追加永久 tombstone；若它正 active，同时清空 active。

每条 `qinglong/model-price-catalog-head@v1` 绑定 expected generation、previous head
digest、action、active/revoked 投影、User、mutation、数据库时间、command digest 与
head digest。写入只允许 `generation + 1`。同 command 精确重放返回 `existing`；stale
generation、detached digest、no-op、同 generation 竞争或 mutation 漂移都失败。

revoked revision 在该 provider/model 下永久不能再次 activate。撤销不是删除
publication；历史 Quote 和审计仍能证明当时使用的 exact catalog digest。

### 3. Resolver 只读取最新 head 精确激活的 revision

运行时 lookup 必须同时匹配 provider、model、price revision 与最新 head 的 active
projection；其它已发布但未激活、旧 active、deactivated 或 revoked revision 一律返回
unavailable。不得 fallback 到最高 revision、最近 publication 或静态默认价格。

SQLite 与 PostgreSQL resolver 都使用单条 publication/head join，避免先读 head、再读
publication 时遇到 activation 切换而产生撕裂。持久化 JSON 与结构列必须重新规范化并
核对 digest；损坏数据失败关闭。AbortSignal 的非法形状被拒绝，真实 cancellation reason
原样传播，不包装为存储故障。

### 4. 双方言使用各自最小并发原语

新增且只新增：

- SQLite `9005-ai-model-price-catalog`；
- PostgreSQL `pg-9005-ai-model-price-catalog`；
- publication/head 两张双方言表及 current/revoked 索引。

SQLite writer 复用同一进程的 shared operation authority，并在 `BEGIN IMMEDIATE` 短事务
中执行 publication 或 head CAS。PostgreSQL 使用 SERIALIZABLE transaction，并按
canonical provider/model identity 获取 transaction advisory lock；数据库 constraint、
serialization、deadlock 与 stale CAS 统一暴露为 catalog conflict。

9001–9004 的 migration identity 和 checksum 不变。9005 checksum 固定为：

- SQLite：
  `20d5c288dfab65ac7ea75a96b7302f9d59cd1bfdf06af28f3868261f6e2e3013`；
- PostgreSQL：
  `7db1a80fab1aa3dee3a4c4bcae5add53758418504f63f4b7d253b090506d7864`。

### 5. Pricing authority 属于 Storage，不属于 Provider

AI Profile 的 Storage authority 必须同时提供 durable invocation repository 与
`ModelPriceCatalogResolver`。启用顺序保持：

1. load/validate Storage 与 pricing；
2. bounded recovery；
3. load provider credential/policy；
4. active。

缺少 pricing 时在 provider credential loader 前失败关闭，并回收已取得的无效 storage
authority；provider authority 不再携带价格。这样价格事实跟随 SQLite/PostgreSQL
durability 与 failover，而不是跟随短生命周期 credential adapter。

### 6. 数据库角色按读写职责分离

PostgreSQL：

- `ql3_runtime` 对两表只有 `SELECT`；
- `ql3_admin` 对两表只有 `SELECT, INSERT`；
- 两者都没有 `UPDATE, DELETE`；
- package-manager、package-executor、worker-ingress 与 PUBLIC 无目录权限；
- schema owner/migration role 保留受审迁移 authority。

管理 repository 只能由短生命周期 admin composition 注入；常驻 runtime 只构造 reader。

### 7. 不新增 package、依赖或后台服务

领域 contract 与 repository 留在现有 `@qinglong/ai`：

- `price-catalog`；
- `local-price-catalog-storage`；
- `postgres-price-catalog-storage`。

根入口只导出 profile-neutral catalog contract；存储 adapter 通过显式 subpath 到达。
没有新增 workspace package、第三方依赖、timer、watcher、轮询或独立价格服务。AI 禁用时
仍保持零 catalog loader、零迁移和零后台活动。

本 ADR 不开放 HTTP、MCP、UI 或默认 Cluster 管理进程。产品入口仍必须另行建立认证、
Project/Role Policy、rate limit、低敏 audit、发布预览与必要的双人/签名 ceremony。

## 被否决方案

1. 可变 current-price 单行：无法保存历史、精确重放或证明不确定提交的 winner。
2. 让 provider adapter 持有价格：把 credential 生命周期和计价权威错误合并。
3. 完成时读取最新价格：破坏 ADR-0172 的 exact Quote 绑定。
4. 先查 current head 再查 publication：并发切换时可能拼接两个 revision 的事实。
5. 撤销后允许重新激活：错误或泄露价格可被 stale writer 复活。
6. 用应用时钟：Cluster 副本时钟漂移会产生不同 publication/head 时间。
7. 给 runtime 写目录权限：外部调用面可改写计费配置，违反最小权限。
8. 新建 pricing package/service：没有独立部署收益，却增加 edge importer、制品和运维成本。

## 当前验证

- domain/SQLite/Profile 定向门覆盖 publication、activation/deactivation/revoke、exact
  replay、并发单赢家、永久撤销、损坏 JSON、AbortSignal 与无效 authority 回收；
- migration contract 证明 9001–9004 checksum 不变、9005 双方言 DDL/history/ACL 固定；
- 真实 PostgreSQL 18 以 migration/admin/runtime 三个连接验证正式主迁移与 feature
  migration、publication、activation race、active-only read、inactive/active revoke、
  永久 reactivation conflict、runtime read-only 与 admin append-only；
- PostgreSQL 18.4 arm64 physical HA 在 timeline 1→2 promotion 前后逐字段复验十张
  `ql3_ai` 表、9001–9005 history/checksum、runtime catalog read-only、admin append-only
  与其它业务角色 deny ACL；旧主 fencing、分区零确认丢失、`pg_rewind` 只读重入、双
  fresh control 与总 `gates.passed=true`；
- 没有新增 workspace package或第三方依赖。

## 后续门禁

1. 为 publish/transition 增加 COMMIT-response-loss 与 promotion 期间的数据行级 fault；
2. 建立认证、Policy、rate limit、低敏 audit、preview/confirm 的本机 CLI 与 Cluster 管理
   facade；
3. 决定高风险价格是否要求签名、双人复核或 break-glass ceremony；
4. 设计非 USD、汇率 revision、cached-input、batch 与 provider-specific 计价维度；
5. 在不可变 rollup/coverage receipt 前禁止删除 publication/head 历史。
