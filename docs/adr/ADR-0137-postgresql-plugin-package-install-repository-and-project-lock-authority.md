# ADR-0137：PostgreSQL Plugin Package 安装仓库与 Project Lock Authority

- 状态：Accepted（PostgreSQL 三表、完整 lock、capability v17、admin-only repository、
  SECURITY DEFINER Project lock、跨 adapter 合同与物理 HA 门已完成；通用 activation
  coordinator、标准 OCI stage verifier、Kubernetes ConfigMap publisher、一次性 admin
  recovery process、exact-registry credential provider、独立镜像与最小权限
  Job/RBAC/真实 Kubernetes 专项门已可组合；Approved Action 产品 consumer
  与管理入口仍未开放）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-127、D-132、D-134、D-135
- 关联 ADR：ADR-0125、ADR-0129、ADR-0134、ADR-0135、ADR-0136

## 背景

ADR-0136 已让 edge/standalone 通过单 SQLite authority 持久化 Plugin Package
installation 历史、当前 head 与 mutation replay，但 cluster 节点仍没有同一
runtime-core contract 的 PostgreSQL adapter。若集群另造状态机，SQLite 与
PostgreSQL 会在 first-create、terminal replacement、旧 mutation replay 和恢复扫描
上逐渐产生不同安全语义。

实现过程中还出现一个 PostgreSQL 特有边界：创建 installation 前必须确认 Project
为 active，并把该事实锁到 transaction 结束。普通 `SELECT` 不能阻止并发归档；
`SELECT ... FOR SHARE` 又要求调用角色拥有目标表 UPDATE privilege。仅为了取得行锁就
授予 `ql3_admin` 通用 Project UPDATE，会扩大数据库权限而不是表达所需能力。

## 决策

### 1. Adapter 留在既有 `@qinglong/cluster-postgres`

Repository 只通过
`@qinglong/cluster-postgres/plugin-package-install` 显式 subpath 导出，不从 root、
runtime、admin 或 worker-ingress 入口导出，不新增 workspace package和第三方依赖。

它只接受 admin Pool；默认 cluster-control、worker 与 migration composition 都不
加载该 subpath。实现存在不代表产品已暴露安装入口。

### 2. `pg-0018` 冻结三类耐久事实

`pg-0018-plugin-package-installs` 创建：

- `plugin_package_installs`：每个 installation 的不可变 `lock_json`、当前 record 和全
  generation 历史；
- `plugin_package_install_heads`：每个 Project/Package 的唯一当前 authority；
- `plugin_package_install_mutations`：mutation ID/digest 与 resulting record digest。

CHECK、FK、partial recovery index、Project history index 与 mutation result index 同
typed Drizzle schema、SQL migration、migration manifest 和 readiness contract
lockstep。Repository `findLock` 每次重新规范化并重算 lock digest。PostgreSQL stream
由 exact `pg-0017` 前驱推进到 18 条 migration、
`control-core` capability v17、30 张受审表，并发布
`"plugin_package_install":1`。

runtime 与 worker-ingress 对三表没有任何 table privilege。`ql3_admin` 对 install/head
只有 SELECT/INSERT/UPDATE，对 mutation ledger 只有 SELECT/INSERT，所有角色均无
DELETE。

### 3. 用单用途 SECURITY DEFINER 表达 Project 锁能力

migration 创建
`ql3.lock_active_plugin_package_project(varchar) -> boolean`。函数：

1. owner 固定为 `ql3_migration`；
2. 使用 `SECURITY DEFINER` 和固定 `search_path=pg_catalog, ql3`；
3. 以 `FOR SHARE` 读取目标 Project，锁住 concurrent status update/delete；
4. 只返回 active 与否，不返回 Project 数据；
5. 撤销 PUBLIC 默认 EXECUTE，只授予 `ql3_admin`；
6. runtime、worker-ingress 均不得执行，admin 也不因此获得 Project UPDATE。

readiness 对函数 name/signature、owner、security-definer、volatility、search path、
PUBLIC ACL 及当前角色 EXECUTE 权限进行 exact 审计。未知 ql3 function、owner 漂移、
PUBLIC execute 或角色越权都使 activation 失败关闭。

### 4. Repository 复用完全相同的领域合同

create/commit 使用短 `SERIALIZABLE` transaction，依次验证：

- active Project lock；
- exact current head 或空 head；
- runtime-core 重新计算的 create/commit command；
- installation version、record digest、mutation ID/digest CAS；
- history、head 与 mutation ledger 原子提交。

只对 PostgreSQL `40001`、`40P01`、`55P03` 做最多三次 transaction retry。
连接错误、COMMIT response loss 和其他 outcome-unknown 不透明重放，必须由调用方读取
durable mutation/head 事实后裁决。exact replay 返回当前已前进 record，不倒写旧状态。

恢复只扫描当前 head 中 `queued | staged | activating`，使用稳定
Package/installation cursor，每页最多 64 条；旧 generation 不能重新取得 authority。

### 5. 两个 adapter 共享一份可执行语义合同

根级 `pluginPackageInstallRepositoryContract.cjs` 同时驱动 SQLite 与真实 PostgreSQL，
覆盖 create/find、exact replay、mutation drift、CAS/stale state、旧 mutation replay、
terminal head replacement 和 current-head recovery pagination。adapter-specific
测试只保留 catalog、corruption、role/entrypoint 与数据库故障行为。

### 6. 产品安装入口继续失败关闭

后续 ADR 已补齐标准 OCI source/stage verifier、一次性 recovery process、独立
cluster-admin image 与 namespaced ConfigMap-only Job/RBAC；这些恢复能力不等于面向
用户开放安装入口。当前仍不实现：

- 具体 Approved Action 产品 consumer 与管理入口；
- Task/Workflow/Prompt/Tool/Trigger 的原子 generation publisher；
- operator repair、旧 generation GC；
- publisher revoke/index、管理 API/CLI/UI 或自动更新；
- Runtime Extension 或动态代码加载。

因此 production cluster 可以在已存在耐久 installation 的前提下运行受限恢复门，但仍
不能通过产品入口创建安装、激活新的资源 generation 或启用动态代码。

## 拒绝的方案

- 新增 `plugin-package-postgres` workspace package：拒绝；单一 adapter 文件和迁移属于
  现有 cluster-postgres，拆包只会增加 importer/build/发布成本。
- 直接授予 admin Project UPDATE 以便行锁：拒绝；技术性锁需求不应变成通用数据修改
  authority。
- 普通 SELECT 后写 installation：拒绝；Project 可在检查后并发归档。
- 在 repository 内复制 SQLite 状态机：拒绝；领域语义必须由 runtime-core 和共享合同
  单点定义。
- 将 repository 加入 admin/root 默认导出：拒绝；会让短生命周期安装 authority
  在无产品闭环时变成易达能力。

## 影响

- 集群节点获得与本机完全对等的 crash-safe installation/head/mutation authority。
- 低配 edge/standalone 制品不安装或加载 cluster-postgres，本切片不改变其常驻资源。
- workspace importer 仍为 21 个，没有新增 package 或依赖。
- PostgreSQL readiness 多审计一个单用途函数，但常驻进程不增加 timer、watcher、
  sidecar 或数据库连接。

## 验证

- migration checksum、SQL/Drizzle/schema/function contract、三角色 readiness 与显式
  subpath 隔离：21/21；
- local-sqlite 全量及共享合同：68/68；
- cluster-postgres 非数据库全量：124 pass、1 个条件 skip、0 fail；
- PostgreSQL 18 单角色真实集成：26 pass、3 个角色条件 skip、0 fail；
- PostgreSQL 18 四角色真实集成：28 pass、1 个同角色 backend termination 条件
  skip、0 fail；
- `pnpm test:postgres-ha:ql3`：21 个 HA 子门和总 `passed` 全为 true；2026-07-25
  最近一次本机 arm64 证据为 fail-closed 312.866 ms、fresh activation
  364.602 ms、旧主 `pg_rewind` 1,744.481 ms，0 unexpected domain side effect。

21 个 importer 的 clean build 与全量 package 聚合测试均退出 0；dependency/source
boundary、edge import 和六种 Profile artifact 门禁均通过且 `findings=[]`。六种制品
顺序复验的最大值为 2,849,582 bytes/439 files/78 loaded modules，最大 RSS delta
13,221,888 bytes，低于 4 MiB/512 files/16 MiB 硬门禁。production composition 与
真实 operator 安装恢复仍是后续独立 Gate。
