# ADR-0213：Owner 围栏化、有界的 Local Project 查询

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-200、D-201、D-202、D-203
- 关联 ADR：ADR-0028、ADR-0185、ADR-0208、ADR-0210、ADR-0211、
  ADR-0212

## 背景

ADR-0212 提供了 `policy.project.create|archive|restore`，但部署者仍无法通过受支持
产品入口取得 Project 当前版本或发现已有 Project。archive/restore 的 CAS 因而会迫使
operator 直接查询 SQLite；直接 SQL 又绕过强认证、实例 authority、Owner fence 和
security audit。

Project 数量虽然在 Edge/Standalone 分别被限制为 16/128，产品查询仍不能依赖该容量
事实返回无界数组。查询还必须允许实例 operator 看见 archived Project，否则无法取得
其恢复版本，但“可见”不能使 archived Project 重新获得业务权限。

## 决策

### 1. 继续扩展既有 `ql3-policy`，不新增 package 或 migration

在现有 project-policy-administration 四层 subpath 中新增：

- `policy.project.inspect`；
- `policy.project.list`。

查询只读取 v37 已有的 `QingLong3Projects` current head，并写已有 security audit 表，
因此 SQLite contract 保持 v37。workspace 保持 22 个 package，不新增第三方依赖、
daemon、timer、watcher、listener、缓存或端口。

### 2. 查询只属于实例 authority Project 的当前强认证 Owner

command 携带 `authorityProjectId`。local-admin 要求强认证 User 在该 Project 上通过
Owner-only `project.manage`。SQLite 在同一个 `BEGIN IMMEDIATE` 事务内再次复验：

1. authenticated credential、Identity、有效期和 pepper provenance；
2. ADR-0211 实例 authority anchor；
3. authority Project active/version；
4. actor 最新 active Owner RoleBinding/version。

复验成功后才读取 Project，并在同一事务写 allowed audit。secondary Project Owner
即使拥有自身 Project，也不能枚举实例 Project 拓扑。授权失败不读取目标对象。

### 3. inspect 返回精确 current head，不存在是低敏结果

`policy.project.inspect` 只接受目标 `projectId`、request ID 和单一 audit event ID。
成功结果只包含：

- `found`；
- Project ID、name、slug、status、version；
- created/updated timestamp。

不返回 RoleBinding、credential、Secret、数据库路径或内部 mutation ledger。
已授权但不存在返回 `found:false`；未授权调用不会以 found/not-found 形成存在性 oracle。

### 4. list 使用硬上限和稳定 keyset

`policy.project.list` 要求：

- `limit` 为 1–64；
- `status` 为 `active|archived|all`；
- 可选 cursor 精确包含 `{slug, projectId}`。

SQLite 按 `(slug ASC, projectId ASC)` 查询 `limit + 1`，最多返回 `limit` 条，并仅在确有
下一条时返回最后一条可见记录组成的 cursor。不支持 offset、任意排序、模糊搜索或
客户端 SQL 片段。slug 当前唯一且尚无 rename 产品操作，复合 cursor 仍保留确定性的
总排序。

每一页是一次独立授权、独立审计的 current-head snapshot，不是跨 command 的数据库
长事务。若翻页期间发生 create/archive/restore，operator 要求严格的同一时点清单时
必须从第一页重新执行；cursor 不得被描述成跨页 snapshot token。

archived Project 可被 inspect/list，但既有 Project Policy 仍对其业务操作默认拒绝；
查询不修改状态、不恢复 RoleBinding，也不释放容量。

### 5. 每次查询都是独立、可审计的短生命周期 ceremony

query command 使用单一 audit event ID，不携带 mutation ID、expected version 或
failure-audit ID。成功查询与 allowed audit 原子提交；credential/authority/Owner fence
在授权后漂移时，事务回滚，CLI 以同一 event ID 写低敏 denial audit。command file
仍必须是 deployment root 内当前 UID 所有的 `0600` 私有文件。

## 不采用方案

### 让 operator 直接查询 SQLite

拒绝。它绕过 authentication、authority、fence 和 audit，并把表结构变成产品 API。

### 因为 Edge 最多 16 个 Project 就返回无界数组

拒绝。Standalone 有 128 个，未来 Profile 也可能变化；无界接口会把存储容量策略泄漏
为内存和 wire 契约。

### 只提供 inspect，不提供 list

拒绝。部署者仍需预先知道 Project ID，无法发现遗留或 archived Project。

### 使用 offset pagination

拒绝。并发 create 会导致重复/遗漏，且大 offset 的成本随表增长。稳定 keyset 更适合
低配设备和未来 PostgreSQL 对齐。

### 新建 Project query package 或管理 daemon

拒绝。查询与 lifecycle 共用 authority、数据库、CLI 和交付闭包；拆包或常驻进程会
违反 ADR-0185 并增加路由设备空闲成本。

## 影响

正向影响：

- archive/restore CAS 不再要求直接 SQL；
- archived Project 可发现、可审计，但仍不具备业务权限；
- list 的 CPU、内存和输出大小由 64 条硬上限约束；
- secondary Project Owner 不能枚举实例拓扑；
- SQLite contract 保持 v37，workspace 保持 22 包。

代价与限制：

- 每次查询写一条 security audit，并短暂取得 SQLite write reservation；
- 当前只支持 status 过滤和 slug/ID 正序，不支持搜索、rename 或 authority transfer；
- Cluster 管理面仍使用独立 PostgreSQL/RBAC transport，不能复用本机 command file。

## 验证

- GitNexus：runtime repository interface 2 个上游、SQLite administration 类 1 个直接
  消费者、Owner CLI runner 3 个上游、共享 authority transaction helper 1 个直接调用，
  均为 LOW，未命中已索引执行流程；
- 真实 SQLite/Owner CLI 13/13：
  - archived Project inspect 与 missing `found:false`；
  - `all` 两页 keyset 无重复、无遗漏；
  - `archived` 精确过滤；
  - 只有确有下一页才返回 cursor；
  - limit 65 在打开数据库前被 exact command validation 拒绝；
  - secondary Project Owner 查询实例拓扑失败并写 denial audit；
  - credential 在服务授权后漂移时，最终 inspect 事务拒绝且不提交 allowed audit；
  - lifecycle、RoleBinding、防锁死、容量和 credential fence 回归；
- local-admin 与 local-owner-cli strict TypeScript 通过；
- 当时 runtime-core/local-sqlite 完整 TypeScript 受锁定的 `croner`、
  `@types/semver`、`drizzle-orm` 本地安装缺失影响，未出现本切片类型错误；
  ADR-0218 后 `croner` 已移出 runtime-core/storage，ADR-0219 又删除
  `@types/semver` builder dependency；当前本机第一物化阻塞为 `drizzle-orm`；
- 不新增 migration、package、生产依赖或部署 contract 版本。
