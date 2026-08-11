# ADR-0294：Local SQLite 领域中立 Persistence Primitives

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-85、D-87、D-213、D-257、ADR-0276、ADR-0280、ADR-0292、ADR-0293

## 上下文

ADR-0293 已把 Project Policy、Security Audit 与 Local Secret 的状态和事务 authority 从 Run Facade 移到
`src/security/`，但 Security persistence 仍从 `run/runPersistence.ts` 导入 row scalar、query、single-row 和 SQLite
错误映射函数。该依赖不表示 Security 属于 Run，只是历史上这些无状态 SQLite primitive 首先在 Run 文件中出现；继续保留
会让源码目录重新形成 `security -> run` 的领域反向依赖，并使以后调整 Run corruption contract 时意外影响 Security。

当前 primitive 不能直接移动或改名。强制完整 GitNexus 基线为 43,207 nodes/98,365 edges/1,695 clusters/270 flows；
`requiredString`、`requiredInteger` 分别为 CRITICAL（17 direct/125 total、19/124），`queryRows`、
`mapSqliteError`、`singleRow` 也均为 CRITICAL（20/81、17/87、13/67），覆盖既有 Secret `put` 执行流及最多
9 个 module。现有调用方还依赖精确的 `RunRepository*Error` 类型、错误文本、NULL/empty/JSON/Blob 语义和 SQLite busy/
constraint 分类。

## 决策

1. 在既有 `@qinglong/local-sqlite/src/storage/` 下增加 package-private 的
   `sqlitePersistence.ts`。它只依赖 `node:sqlite`，提供 `SqliteQueryRow`、查询参数类型、SQLite driver 错误观察，以及由调用边界
   注入错误 contract 的 scalar/query/single-row primitive factory。
2. 中立层不得导入 Runtime Core 的 Run、Security、Secret 或 Policy 类型，不定义产品级错误，不包含表名、SQL、事务、queue、
   connection 生命周期或领域 normalization。
3. `run/runPersistence.ts` 保留既有导出函数名与签名，作为 Run corruption contract 的兼容适配层；它使用中立 primitive，
   仍逐字产生原有 `RunRepository*Error` 和错误文本。Run Reader/Repository 的调用点不迁移。
4. `security/securityPersistence.ts` 建立独立 Security-side 适配实例，并向 Security Authority Store 提供其所需的 package-private
   helper。为保持 ADR-0293 已冻结的可观察兼容性，本批仍映射成原有 `RunRepository*Error`；这是显式兼容边界，不再来自
   `src/run/`。未来如切换到 `ProjectPolicyUnavailableError`、`SecurityAuditUnavailableError` 或
   `LocalSecretUnavailableError`，必须另立错误迁移 ADR 和 consumer 证据。
5. Security source 不得再 import `../run/runPersistence`。Run 与 Security 可以共享中立实现，但各自拥有错误 contract、row
   mapper、SQL 和领域 normalization。
6. 不新增 workspace package、公开 export、生产 dependency、migration、表、索引、进程、timer、watcher、cache、queue 或
   connection；中立 factory 只创建冻结的函数集合，不持有可变状态。
7. 本批不顺带泛化 Local Owner、Completion Receipt、Plugin Package 或其他目录内同名 helper；是否共享必须按各自 corruption
   contract 单独证明，不能按函数名机械合并。

## 被拒绝的方案

- **把现有 Run helper 原样搬到 `storage/`**：文件路径变了，但中立目录仍泄漏 Run 错误与文本，隐藏而不是消除错误 ownership。
- **让 Security 永久继续 import Run 文件**：保持短期测试通过，却把错误演进和目录依赖绑定在错误领域。
- **复制 helper 到 Security**：会产生两套 SQLite driver 分类和 scalar 行为，后续漂移难以审计。
- **本批立即更换 Security 对外错误类型**：会把依赖方向修复与公开 corruption contract 迁移混在同一批，无法证明行为兼容。
- **新建 workspace storage-common package**：没有独立部署、权限、版本或消费者责任，只会扩大低配设备 importer、lockfile 和
  SBOM。

## 接受条件

1. `src/security/` 对 `src/run/` 的生产 import 为零；中立 primitive 对 Runtime Core 领域 import 为零。
2. Run helper 的导出名、签名、错误类型、错误文本、NULL/empty/JSON/Blob 和 SQLite busy/constraint/operation 行为不变；
   Security 的既有可观察行为也不变。
3. Project Policy、Security Audit、Local Secret、Run Reader/Repository 的定向 corruption/replay/transaction 测试通过，
   Local SQLite 全量、完整 package 与 backend 回归通过。
4. package-boundary、cluster dependency、Edge import、cluster deployment、CloudNativePG 与 local-image 审计通过；19-package
   ledger、公开 exports、生产依赖和部署 closure 不变。
5. 十档 artifact/RSS 门通过；不得为共享 primitive 引入常驻资源或超过 Edge/Standalone 预算。
6. 强制完整 GitNexus 后重查新中立 factory、Run 兼容 adapter、Security adapter 及既有高风险 mapper，并运行
   `detect_changes` all/compare `develop`；出现新产品执行流或影响扩大时不得 Accepted。

## 接受证据

- 新增 169 行 package-private `storage/sqlitePersistence.ts`，只导入 `node:sqlite`；它定义领域中立 row/query value、
  driver error observation 和注入错误 contract 的冻结 primitive 集合。`src/security/` 到 `src/run/` 的生产 import 为零，
  中立文件到 Runtime Core 的 import 为零。
- `runPersistence.ts` 从 551 行收敛到 529 行并保留全部既有导出函数；`securityPersistence.ts` 为 350 行，通过显式薄函数
  暴露 Security-side adapter，使调用图可追踪而不以函数对象 alias 隐藏消费者。新增 4 项 contract 测试逐字验证
  Run/Security 的 scalar、NULL/empty、JSON、Blob copy、duplicate identity、busy/constraint/operation 类型和错误文本。
- Local SQLite 196/196、Local Admin 83/83、Local Owner CLI 104/104、完整 19-package clean build/test 与 backend
  1,110（1,108 pass/2 skip）通过。第一次受限运行中的 loopback `EPERM` 只来自沙箱网络限制；在允许本机 loopback 的同一
  最终源码上完整重跑已全绿。
- cluster dependency、package boundary、Edge import、cluster deployment、CloudNativePG 与 local image 六项审计均
  `compatible:true`。workspace 仍为 19 个 package、768 个 production source、49 个受审根入口和 719 个领域内嵌套实现，
  `singleSourcePackages=[]`；Local SQLite 为 156/3/153。公开 exports、生产依赖、migration、表、索引、进程和部署单元
  均未改变。
- 十档制品/RSS 门全部 compatible。最小 Edge 为 3,635,004 bytes/332 files/48 loaded modules，RSS delta
  12,206,080 bytes；最大 Standalone Application AI 为 6,122,625 bytes/491 files/104 loaded modules，RSS delta
  21,299,200 bytes，均低于各自硬上限。
- 强制完整索引为 43,262 nodes/98,457 edges/1,695 clusters/269 flows。中立 factory 为 LOW（2 direct/19 total，
  0 process）；Run `requiredString`/`requiredInteger` 从混合领域 CRITICAL 降为 MEDIUM（10/24，0 process），Security
  adapter 分别为 CRITICAL（5/99、8/99），风险归属清晰。Run/Security `queryRows` 合计仍为 20 direct/81 total，
  `singleRow` 合计仍为 13/67，没有扩大原基线；全局 flow 从 270 收敛到 269，没有新增产品入口、状态机或运行资源。
- `detect_changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均为 low/0 affected process；QL3
  孵化树大部分仍 untracked，因此以逐符号 impact、完整测试、审计和制品证据为主。
- 按额外授权重新运行 PostgreSQL 18.4 arm64 physical HA Docker 门，`gates.passed=true`：`remote_apply`、timeline
  1→2、旧主先 fencing、双新 control ready、`pg_rewind` 回归同步及完整 Cluster/AI/Workflow gates 全绿；运行后
  `ql3-ha-*` container、volume、network 均为空。该结果是跨部署基线复验，不改变本批 Local SQLite ownership 范围。
