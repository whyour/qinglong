# ADR-0176：显式 Local AI Feature 启用与非破坏性停用

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-40、D-73、D-84、D-87、D-156、D-165、D-166；ADR-0087、ADR-0167、ADR-0175

## 背景

ADR-0175 要求 Model Price Catalog CLI 不得自动执行 AI DDL，但部署者当时没有受审的
产品启用入口，只能由测试或部署代码直接调用 `migrateLocalModelInvocationFeature()`。
这会产生三个问题：

1. “schema 已存在”和“部署者已明确启用”是同一个隐式状态，无法安全停用；
2. 迁移版本、备份确认、稳定 User、强认证和当前 Owner 没有绑定到耐久启用事实；
3. 只在 CLI 外层检查启用状态，无法阻止停用提交后的并发 invocation admission。

本机 feature migration 还可能跨多个 SQLite 事务。进程在某一步迁移后退出时，不能假装
整次启用原子完成；重试必须从受审 history/checksum 恢复，并且只有最后的 activation
transition 提交后，业务写入口才可到达。

## 决策

### 1. 复用现有包和短生命周期 authority

在现有 `@qinglong/local-owner-cli` 增加：

- 显式子路径 `@qinglong/local-owner-cli/ai-feature-command`；
- 二进制 `ql3-ai-feature`；
- `ai-feature.inspect|activate|deactivate` 三种 operation。

不新增 workspace package、第三方依赖、daemon、listener、timer、watcher 或缓存。CLI
仍只接受私有 exact-shape command file，完成后关闭唯一 SQLite authority。默认
edge/standalone runtime、通用 local-admin 和 Cluster image 不导入该入口。

现有 SQLite facade 的实现原本以 Plugin Package 命名，却已被多个本机管理域复用。
本 ADR 在同一个 `@qinglong/local-sqlite` 包内增加中性的
`/authenticated-management` 子路径，并保留 `/package-management` 兼容入口；不为
一个类型别名拆新包。

### 2. 9007 只属于本机 AI feature stream

本机 AI migration stream 在既有 9001–9006 后追加：

```text
9007-ai-feature-activation
```

9007 创建两张本机控制表：

- `ModelInvocationFeatureTransitions`：append-only generation、active/inactive、
  mutation/request、migration plan、data-safety、User/authentication 和 digest；
- `ModelInvocationFeatureHead`：只指向一个已存在的不可变 transition。

PostgreSQL Cluster 仍保持 pg-9001–pg-9006、11 张业务表和既有 ACL，不能把本机
Owner ceremony 复制成 Cluster authority。9007 checksum 为
`2454987c61a48dc5286a883d755c709000e6fd630025373cb276723001bdcc6c`；
包含 9001–9007 的 migration plan digest 为
`529cd8d3bce9ef124dd609044c4f704ea313926c9c8fc422c23871e110fed538`。

### 3. inspect、activate 与 migration plan fence

`inspect` 只有在 local-console 强认证和当前 `default` Project Owner 复验后，才返回：

- `absent | partial_or_drifted | ready` 三态 schema 摘要；
- 当前 active/inactive generation 的低敏摘要；
- 当前二进制的 migration plan digest。

`activate` command 必须回传 inspect 得到的 exact plan digest 和 CAS generation/state。
代码版本、迁移顺序或任一 checksum 改变都会形成新 plan digest，旧 command 不得执行
新 DDL。

首次启用必须选择一种 data-safety 证据：

- `fresh_database`：只允许没有 AI durable data 的 feature；不带备份 digest；
- `backup_verified`：带 64 位十六进制 backup evidence digest。

CLI 在 DDL 前和 transition 前均复验 credential、pepper、User 和 Owner。9001–9007
逐步使用既有 migration history/checksum 收敛；崩溃后可能留下 reviewed partial
schema，但不会留下 active head。重试完成全部 migration 并再次通过强认证后，才在
一个 `BEGIN IMMEDIATE` 中写 transition/head。相同 mutation 的响应丢失重试优先返回
首次 durable transition，即使启用后已经产生业务数据也不得重新执行“空库”裁决。

### 4. 停用不删除数据，并形成 admission fence

`deactivate` 只追加下一代 `inactive` transition 并更新 head：

- 不执行 `DROP`、`DELETE`、清表、回滚 migration 或修改历史；
- data-safety 必须固定为 `preserve_existing`；
- 有未完成 ModelInvocation 时拒绝停用；
- credential/User/pepper/Owner 与未完成调用检查在 transition 的同一
  `BEGIN IMMEDIATE` 中再次执行。

本地 invocation 的 `admit`、`admitWithQuota`、`admitWithPricing` 在各自
`BEGIN IMMEDIATE` 内、写任何新 start 前读取 active head。价格目录 mutation 也在其
事务 hook 内复验 active。由此：

- admission 先提交时，停用随后看到未完成调用并拒绝；
- 停用先提交时，后续 admission/价格 mutation 看到 inactive 并拒绝；
- 已经存在的 admission replay 和 completion/recovery 仍可完成，不因停用破坏耐久
  收敛。

这是一条数据库串行化写围栏，不依赖进程内布尔值、文件锁或 watcher。

### 5. 鉴权、审计和输出

三种 operation 都要求稳定 User、`local_console` assurance、credential-version pepper
provenance 和当前平台 Owner。命令不得提供 principal、authentication ID、assurance、
Owner、Policy 或数据库时间。

成功由 append-only transition/head 证明；失败写现有低敏 SecurityAudit，固定原因包括：

- `credential_rejected` / `credential_fence_rejected`；
- `platform_owner_required`；
- `data_safety_rejected`；
- `in_flight_invocation`；
- `transition_conflict` / `transition_unavailable`；
- `migration_unavailable`。

输出不包含 credential、secret、principal、subject ID、authentication ID、备份路径或
DDL 细节。

## 拒绝方案

1. **新增 `ql3-ai-feature-cli` package**：没有新的部署边界，只会制造小包，拒绝。
2. **让 `ql3-model-price` 顺便迁移**：把日常业务管理升级为 DDL authority，拒绝。
3. **以 schema presence 代表 enabled**：无法表达显式停用和 operator intent，拒绝。
4. **停用时 DROP AI 表**：破坏账本、重放、恢复和备份语义，拒绝。
5. **只在启动配置读取一个布尔值**：无法和 durable admission transaction 串行化，
   拒绝。
6. **只在停用前事务外检查未完成调用**：检查后仍可并发创建 start，拒绝。
7. **把 9007 同步加入 PostgreSQL**：本机 Owner ceremony 不具备 Cluster TLS、平台
   Policy、耐久 quota 和职责分离 authority，拒绝。

## 当前证据

- AI suite 96 项：94 pass、2 条真实 PostgreSQL 条件 skip；覆盖 9007 schema/history、
  append-only transition/head、CAS/plan/identity drift、事务 hook/replay、inactive
  admission fence 和既有 crash matrix；
- local-owner-cli 22/22，覆盖真实 `ql3-ai-feature` binary、inspect/activate/replay/
  deactivate、无敏感输出、widened body、plan drift、pre-migrated backup evidence、
  credential revoke、in-flight deactivation rejection 和 inactive price gate；
- local-sqlite 127/127；22-importer dependency audit `findings=[]`，AI 21 个、Owner
  CLI 10 个源码文件；edge 121-module import gate 无 AI 越界；
- clean build 后 workspace 仍为 22 个 QL3 package，没有新增生产依赖或常驻资源；
  base edge/standalone 均为 478 files，AI opt-in 制品均为 522 files，disabled loader
  的 storage/provider/management authority load 保持为 0；
- 2026-07-27 重新执行 PostgreSQL 18.4 arm64 physical HA 门，timeline 1→2、
  old-primary fence、双 control replica 重建、`pg_rewind` 只读 sync rejoin 与总
  `gates.passed=true`。AI 专项在 promotion 前后均精确保持 pg-9001–pg-9006、
  11 张表和同一最小权限矩阵；本机 9007 未进入 PostgreSQL history，因而该证据不
  冒充 Cluster activation ceremony。

## 后续门禁

1. 产品启动 composition、active-head dynamic import、restart/drain/operator UX 已由
   ADR-0177 完成；真实产品 executable 仍需选择该显式入口；
2. 私有命令模板、备份/恢复演练和真实低配 Linux 设备断电/ENOSPC 证据；
3. activation transition 与 Model Price mutation 专属 SQLite
   COMMIT-response-loss/SIGKILL 矩阵；
4. Cluster TLS identity、平台 Policy/quota、双人 activation 和独立 transport；
5. 只有 Cluster 入口变更 PostgreSQL schema/ACL 后才重跑对应三角色与 physical HA 门。
