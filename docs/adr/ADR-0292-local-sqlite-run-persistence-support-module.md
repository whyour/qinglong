# ADR-0292：Local SQLite Run Persistence Support 内部模块

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-85、D-87、D-213、D-257、ADR-0007、ADR-0069、ADR-0280、ADR-0290、ADR-0291

## 上下文

ADR-0291 已把具名 `LocalSqliteRunReader` 移到独立文件，但 `runRepository.ts` 仍同时持有 Run/Attempt/Event/Retry
列声明、SELECT/INSERT/UPDATE SQL builder、row codec、SQLite driver error mapping、有界 query helper、Transaction、
Security/Secret 映射和产品 Facade。Reader 为避免复制，通过一个冻结 support 对象从 Facade 文件接收这些函数；这只是
安全的过渡边界，并没有消除反向依赖。

强制完整 GitNexus 索引表明五个 scalar/JSON codec 为 CRITICAL，最大 13 direct/88 total、2 processes/7 modules；
`mapSqliteError`、`queryRows`、`singleRow` 和 SQLite code/number 解码为 HIGH，最大 17 direct/46 total、1 process/
4 modules。Facade 仍为 CRITICAL（30 direct/63 total），Reader 为 HIGH（15/40），Transaction 为 HIGH（15/37）。
因此本批次必须是逐字语义保留的模块抽取，不能同时泛化不同领域的 SQLite codec。

## 决策

1. 在既有 `@qinglong/local-sqlite/src/run/` 下新增 package-private `runPersistence.ts`，集中：
   - Run/Attempt/Event/Retry column metadata 和 SELECT/INSERT/UPDATE SQL 常量；
   - write value normalization、row scalar/JSON/enum/blob/boolean codec 与 Run record 映射；
   - SQLite error code/number/message 分类、`mapSqliteError`、event payload 上限；
   - `queryRows` 和 duplicate-identity `singleRow`。
2. 所有被迁移函数体、错误类型、错误文本、NULL/undefined/empty-string 处理、JSON parsing、enum 集合、column 顺序、
   SQL 文本和 payload byte 计算逐字保持。不得借重构修改协议或“统一”错误。
3. `LocalSqliteRunReader` 直接导入 persistence support，不再接收函数对象；构造器恢复只接收同一 `DatabaseSync`。
   `LocalSqliteRunTransaction` 继续继承 Reader，Facade 继续通过唯一 `LocalSqliteOperationAuthority` 调度两者。
4. `LocalSqliteRunRepository`、Transaction 和现有 Security/Secret 映射只改为 import 同一 support。公开构造器、
   runtime-core ports、root/subpath exports、事务边界、close/error mapping 和消费者不变。
5. 新模块不得从 `package.json#exports`、`index.ts` 或 `runtime.ts` 导出，也不得创建 connection、transaction、queue、
   timer、watcher、cache、listener 或后台工作。
6. Completion Receipt、Task Definition、Owner、Tool 等模块的相似 helper 具有不同 empty/null/error 语义，本批次不合并；
   后续只有在先冻结共同 contract 后才可共享，不能按函数名相同机械去重。
7. 不新增 workspace package、生产 dependency、migration、表、索引、进程或部署单元；19-package ledger 与 Edge/
   Standalone 制品和 RSS 上限保持不变。

## 被拒绝的方案

- **建立 package-wide 万能 row codec**：不同领域对空字符串、NULL、错误类型和错误文本要求不同，会造成静默语义漂移。
- **继续由 Facade 向 Reader 注入函数对象**：可以运行，但让只读模块的基础依赖反向由产品 Facade 组装，长期难以演进。
- **复制 support 到 Reader/Transaction**：会复制列顺序、SQL projection 和 normalization，读写路径可能分叉。
- **把 support 拆成新 workspace package**：没有独立部署、权限、依赖或消费者 closure，只增加低配设备 importer/SBOM。
- **同时移动 Transaction 或 Security/Secret authority**：会把机械 support 抽取扩大为事务 ownership 重构，无法归因回归。

## 接受条件

1. 原 support 函数和常量只存在于 `runPersistence.ts`，Reader/Fascade/Transaction 没有复制；源码与错误文本保持等价。
2. Reader 恢复单参数构造，Transaction 写方法与 Facade BEGIN/COMMIT/ROLLBACK、enqueue/close 完全不变。
3. Run、startup recovery、dispatch/control、Security Audit、Project Policy、Local Secret 和 corruption/error 定向测试通过；
   Local SQLite 全量零回归。
4. 完整 19-package clean build/test、backend、六项架构/部署审计及十档 artifact/RSS 门通过；package 仍为 19 个、
   `singleSourcePackages=[]`，公开 exports、依赖与 migration chain 不变。
5. 强制完整 GitNexus 索引后重查全部 CRITICAL/HIGH helper、Facade/Reader/Transaction 和执行流，再运行
   `detect_changes` all/compare `develop`。如果 support 丢失可索引性、生产流程扩散或风险上升，ADR 不得 Accepted。

## 接受证据

- `runPersistence.ts` 为 551 行，成为 Run 子域唯一的 column/SQL/codec/error/query support；`runRepository.ts`
  从 1,990 行降至 1,457 行，`runReader.ts` 从 762 行降至 667 行。Reader 恢复只接收同一 `DatabaseSync`，旧
  `LocalSqliteRunReaderSupport` 注入对象已删除；Transaction 写方法、BEGIN/COMMIT/ROLLBACK、Facade enqueue/close、
  runtime-core port 和 package exports 均未改变。
- 跨 Run/Startup/Dispatch/Control/Execution Revision/Security Audit/Policy/Secret 的定向回归 74/74、Local SQLite
  192/192、完整 19-package clean build/test 与 backend 1,110（1,108 pass/2 skip）通过；cluster dependency、package
  boundary、Edge import、cluster deployment、CloudNativePG 与 local image 六项审计均 `compatible:true`。
- workspace 保持 19 个 package、765 个 source、49 个受审根入口和 716 个领域内嵌套实现，
  `singleSourcePackages=[]`；Local SQLite 为 153/3/150。没有新增生产 dependency、migration、表、索引、进程、
  部署单元或公开 specifier。
- 十档制品/RSS 门全部 compatible。最小 Edge 为 3,623,406 bytes/329 files/45 loaded modules，RSS delta
  11,599,872 bytes；最大 Standalone Application AI 为 6,111,027 bytes/488 files/101 loaded modules，RSS delta
  21,250,048 bytes，均低于硬上限。
- 强制完整索引为 43,173 nodes/98,227 edges/1,693 clusters/265 flows。五个既有 scalar/JSON helper 仍为 CRITICAL，
  最大 `requiredString` 17 direct/108 total、`requiredInteger` 19/107；`mapSqliteError`、`queryRows` 和 SQLite
  code/number decoder 仍为 HIGH，最大 20/70，`singleRow` 为 MEDIUM（13/42）。直接调用数比 support-object 基线更
  完整，是删除间接注入后图谱恢复可见性，不是新消费者或执行流；其风险等级没有升级。Facade 为 CRITICAL（30/64）、
  Reader 为 HIGH（15/40）、Transaction 为 HIGH（15/38），全部仍为 0 affected process；其余 persistence helper
  最高 MEDIUM。
- 本批次只改变 Local SQLite package 内源码组织，未触及 PostgreSQL、Cluster、migration 或 HA 状态，因此不重复执行
  与变更无关的物理 PostgreSQL HA；对应结构、依赖和部署审计已覆盖其不变性。
- `detect_changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均为 low/0 affected process；QL3
  孵化树大部分仍 untracked，因此该结果只作为逐符号 impact、完整测试、审计与制品门的补充证据。

## 后续边界

- Security/Secret authority 仍在 Run Facade 内是下一项真实职责问题，但必须先按共同授权事实和事务围栏建模。
- 其他领域的重复 scalar helper 只能按明确 contract 分组迁移，不能把本 ADR 当成全 package 泛化授权。
