# ADR-0290：Local SQLite Completion Receipt Journal 内部 Collaborator

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-85、D-87、D-213、D-257、ADR-0007、ADR-0069、ADR-0276、ADR-0280

## 上下文

`LocalSqliteRunRepository` 同时实现 Run Repository、startup recovery、local dispatch/control、Completion Receipt
Journal、Project Policy、Security Audit 与 Local Secret 等接口。它继续作为同一 Node SQLite connection 和
`LocalSqliteOperationAuthority` 的产品 Facade 是必要的：应用层需要在一个串行 authority 中共享事务和关闭语义。但把
所有持久化 SQL、结果映射与协议校验都留在同一个 2,755 行文件，会让独立能力的修改进入 CRITICAL Facade 的审查面，
也掩盖真正的事务耦合。

Completion Receipt Journal 已有独立 runtime-core port、独立表、四个完整操作与专用测试；其单次操作不与 Run aggregate
写事务合并，只需要在同一 connection authority 队列中执行，因此适合作为第一项内部职责抽取。Project Policy、
Security Audit 与 Local Secret 包含跨事实授权围栏和共同事务，不在本切片移动。

## 决策

1. 在既有 `@qinglong/local-sqlite/src/run/` domain 内新增私有
   `LocalSqliteCompletionReceiptJournalStore`。它只持有 Facade 已解析的同一个 `DatabaseSync`，负责 journal 四个操作的
   SQL、exact replay、候选映射与 corruption 检查。
2. `LocalSqliteRunRepository` 继续实现 `LocalCompletionReceiptJournal`，公开构造器、方法签名、root/subpath exports 和
   消费者全部不变。新 Store 不从 `package.json#exports`、`index.ts` 或 `runtime.ts` 导出，调用者不得直接构造。
3. 所有输入 validation、`LocalSqliteOperationAuthority.enqueue`、busy/closed 映射和 connection close 仍由 Facade
   控制。Store 不创建 connection、transaction、Promise queue、timer、watcher、cache 或后台工作。
4. Store 使用同步 Node SQLite 操作；Facade 只在原 authority 队列内调用它。不得为了“解耦”新建第二 connection，
   也不得把 Completion Receipt 注册并入另一个 transaction authority。
5. SQLite driver error 继续由 Facade 的既有 `mapSqliteError` 归一化；Store 只产生既有
   `RunRepositoryConstraintError` 和底层 SQLite error，不新增公开 error code。
6. 本增量不新增 workspace package、生产 dependency、migration、表、索引、公开 specifier、进程、listener、Pool、
   timer、资源预算或部署单元；package boundary root hard cap 与 19-package ledger 不变。

## 被拒绝的方案

- **拆成新的 workspace package**：没有独立部署、权限、依赖或消费者 closure，反而增加路由设备 importer 与 SBOM 表面积。
- **让应用直接组合多个 Repository**：会把同一 connection 的串行、关闭与事务 ownership 泄漏到产品层。
- **为 Store 新建 SQLite connection**：会改变 busy、WAL/DELETE、事务竞争和关闭语义，并破坏单 authority 不变量。
- **一次拆出 Policy/Audit/Secret/Run 所有职责**：CRITICAL Facade 有 30 个直接消费者，混合大规模移动无法归因回归。
- **只把代码移动到一个工具文件**：没有形成可测试的持久化职责，也不会降低 Facade 的实现耦合。

## 接受条件

1. Completion Receipt Journal 专用测试和 `@qinglong/local-sqlite` 全量测试通过，exact replay、非 Local Attempt 拒绝、
   quarantine/cursor/resolve 语义不变。
2. 完整 19-package clean build/test 与 backend 零回归；dependency/package boundary、Edge import、Cluster/CloudNativePG/
   local image 和十档 artifact/RSS 门 compatible。
3. package 仍为 19 个，`singleSourcePackages=[]`；Local SQLite root source 数、公开 export keys、生产依赖和 migration
   chain 不变。
4. 刷新 GitNexus 后重新检查 CRITICAL Facade 与四个 delegation 方法，并运行 `detect_changes` all/compare
   `develop`。如执行路径扩散或新 Store 变成公开消费者，ADR 不得进入 Accepted。

## 接受证据

- Completion Receipt Journal 专用测试 3/3、`@qinglong/local-sqlite` 192/192、完整 19-package clean build/test
  与 backend 1,110（1,108 pass/2 skip）通过；六项架构/部署审计和十档 artifact/RSS 均 compatible。
- package ledger 保持 19 个 package、`singleSourcePackages=[]`；Local SQLite 为 151 个 source、3 个受审根入口、
  148 个领域内嵌套实现。新 Store 未进入任何公开 export，生产依赖、migration chain、表和索引均未改变。
- 最小 Edge 产物为 3,617,583 bytes，RSS delta 为 12,025,856 bytes；最大 Standalone Application AI 为
  6,105,204 bytes，RSS delta 为 21,364,736 bytes，均低于硬上限。
- 刷新后的 GitNexus 为 43,155 nodes/98,225 edges/1,693 clusters/265 flows。Facade 保持 CRITICAL（30 direct/
  63 total/3 modules），四个 delegation 方法与构造器均为 LOW；内部 Store 为 MEDIUM（6 direct/31 total/
  0 process，仅 Run module）。`detect_changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，
  均为 low/0 affected process；由于 QL3 孵化树大部分仍 untracked，该统计只作为补充证据。

## 后续边界

- 下一候选应按共同事务事实选择，而不是按 LOC：dispatch definition、startup recovery reader 或 Security Audit 可以分别
 评审；Project Policy + authorized Secret mutation 必须先证明事务围栏不会被拆断。
- Facade 最终可以变成显式 capability aggregator，但在所有生产调用者迁移到窄 port 前，不能删除
  `LocalSqliteRunRepository` 或改变其构造方式。
