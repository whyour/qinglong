# ADR-0237：面向能力的依赖边界对账

- 状态：Accepted
- 日期：2026-07-31
- 关联 RFC：QL-RFC-0001 D-175、D-207、D-210、D-211、D-213、D-221
- 关联 ADR：ADR-0217、ADR-0220—0222、ADR-0229、ADR-0230、ADR-0236

## 背景

QingLong 3.0 的 Package 生命周期、自动化发布和 Workflow Task 纵切面完成后，仓库级
依赖审计报告 27 条 finding。它们混合了两类不同问题：

1. `cluster-admin` 的安装清单查询直接实例化
   `PostgresPluginPackageInstallRepository`。该 concrete adapter 同时实现 inventory、
   admission 和 install mutation port；即使调用方只使用两个查询方法，composition 已经
   取得 executor authority，违反 ADR-0220 的 package-manager 只读边界；
2. 新增的 lifecycle/publication 文件与 Local Workflow 内部依赖已经由 ADR 定义，但
   依赖审计的具体文件/subpath 清单仍停留在旧切片。

如果把两类 finding 都简单加入白名单，会掩盖真实权限泄漏；如果按每个共享 port 再拆
workspace package，则会重回“一文件一包”，增加路由设备的安装、构建、SBOM 和供应链
成本。

## 决策

### 1. 先区分 capability 泄漏与审计规则滞后

依赖审计 finding 不能直接以“代码已经存在”为理由放行。每条新边必须满足：

- 对应已有 RFC/ADR 的部署和 authority 方向；
- 只开放到具体 owner 文件和具体 package subpath；
- 不让只读进程取得 mutation concrete adapter；
- 不增加 Profile 无关的重依赖或常驻资源；
- 仍有负向测试证明相邻的宽入口和反向依赖被拒绝。

### 2. Package manager 使用独立只读 inventory reader

`cluster-postgres` 增加
`PostgresPluginPackageInstallInventoryReader`，只实现
`PluginPackageInstallInventoryRepository` 的 `findCurrent` 和
`listCurrentPage`。它只从 `@qinglong/cluster-postgres/package-manager` 导出；该入口
不得导出 `PostgresPluginPackageInstallRepository`，reader prototype 也不得出现
admit/create/commit/recovery 方法。

`cluster-admin/pluginPackageManagement` 改为只装配该 reader。原 mutation repository
继续留在显式 `plugin-package-install`/package-executor 权限边界，既有安装与恢复语义不
修改。

### 3. Workflow Task repository port 上提为 package 内共享契约

`LocalWorkflowTaskExecutionRepository` 同时被 execution、control 和 recovery 使用，
因此不属于 `execution/` 实现区。它上提到 `local-execution/src` 的共享契约文件；
`./execution` 继续 re-export，保持公开 subpath 兼容。

审计只允许各区域导入这一条精确共享 port，不开放任意 root 文件。Scheduler 依赖
dispatch 是 ADR-0229 单 cadence 的最后一步，明确登记为
`scheduler → dispatch → execution` 的单向 DAG；反向 `execution → dispatch`、
`control → recovery` 等继续拒绝。

### 4. 新纵切面使用具体文件 + 具体 subpath 清单

以下边只对对应 owner 文件开放：

- Owner CLI lifecycle command → local-admin lifecycle、SQLite install inventory 与
  runtime lifecycle contract；
- local-admin lifecycle service → SQLite approval/operation/lifecycle/policy authority 与
  runtime approval/lifecycle/policy/security/audit contract；
- local-application activation/contract → runtime automation publication contract；
- Cluster lifecycle management → manager/approval/policy，lifecycle executor →
  executor/approval/policy；
- management transport → capability-free lifecycle plan DTO；
- Cluster installation management → package-manager 只读入口。

未知文件、根入口、driver、executor repository 或相邻 authority 不因这些决策获得通配
权限。

### 5. 不新增 workspace package

workspace 保持 20 个 package。共享 port、只读 adapter 和审计契约都进入已有职责
owner；它们没有独立部署、发布、重依赖、凭据、故障域或 Profile 替换价值。文件数量
继续不作为拆包理由。

## 不采用方案

### 把 27 条 finding 全部加入宽白名单

拒绝。会把 manager→executor concrete adapter 泄漏永久合法化，并让后续同 package
文件获得未审 authority。

### 让只读 reader 包装或继承 mutation repository

拒绝。包装仍在 composition 内构造 mutation authority，继承则直接把 mutation 方法
暴露在 reader 对象上，都不满足 capability 最小化。

### 新建 inventory、workflow-contract 或 lifecycle workspace package

拒绝。这些能力都由既有 package/进程 owner 使用，没有独立交付价值；拆包只会增加
低配设备闭包和维护成本。

### 直接允许 control/recovery 依赖 execution 实现区

拒绝。共享 port 应属于中性契约层；允许反向实现依赖会使内部 DAG 失去约束。

## 影响

- workspace、生产依赖、migration、表、角色、进程、端口、Pool、timer、watcher、
  listener 和常驻内存均不增加；
- `@qinglong/local-execution/execution` 公共导出保持兼容；
- PostgreSQL mutation repository 的已有方法和三个生产调用者不修改；
- package-manager 只增加可审计的只读 capability，不获得 install mutation authority；
- 依赖审计从 27 条 finding 收敛为 0。

## 验证

1. GitNexus impact：`PostgresPluginPackageInstallRepository` 为 CRITICAL（3 direct、
   7 upstream），因此不修改其既有方法；
   `createClusterPluginPackageManagementService` 为 LOW（1 direct、3 upstream）；
   `LocalWorkflowTaskExecutionRepository` 为 MEDIUM（5 direct、20 upstream）；
   `auditSourceImports` 为 LOW（1 direct）；
2. cluster-postgres、cluster-admin 与 local-execution strict TypeScript closure check
   通过；
3. 依赖审计报告 `findings=[]`、`compatible=true`，20 个 importer 不变；
4. 依赖边界 38/38，通过精确 lifecycle/publication 正向边、共享 port、scheduler DAG，
   并继续拒绝 manager→executor concrete adapter 和内部反向依赖；
5. package-manager entrypoint 证明只读 reader 可达、mutation repository 不可达，
   reader prototype 仅有 constructor/findCurrent/listCurrentPage；另以无 connect、无
   mutation 的 query-only pool 实际验证 exact/list 和 `limit + 1` 参数；
6. 受影响包全量测试：cluster-postgres 249 pass/1 条真库条件 skip、cluster-admin
   133 pass/1 条真实 Kubernetes 条件 skip、local-execution 30/30；Cluster Admin 两个
   过期 role fixture 同步拒绝三个 runtime-only function，生产 readiness 未放宽；
7. PostgreSQL `18.4 (Debian 18.4-1.pgdg13+1)` arm64 physical HA 通过
   `remote_apply`、timeline 1→2、旧主先 fencing、`pg_rewind` 只读同步重入和两个 fresh
   control replicas；inventory 提升前为 quarantined、list 有结果、提升后存活，全部具体
   gate 与 `gates.passed=true`；
8. HA 临时容器、网络和卷已清理；已有且与本门无关的
   `ql3-cnpg-evidence-control-plane` 未修改。
