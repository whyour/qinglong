# ADR-0291：Local SQLite Run Reader 内部模块

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-85、D-87、D-213、D-257、ADR-0007、ADR-0069、ADR-0280、ADR-0290

## 上下文

ADR-0290 已证明 QingLong 3.0 可以在不新增 workspace package、不拆分 SQLite authority 的前提下，把独立持久化职责
下沉到 `@qinglong/local-sqlite` 的领域目录。但 `LocalSqliteRunRepository` 仍把约 600 行只读 Run/Attempt/Event、
startup recovery、local dispatch/control 和 execution revision 查询与 Facade、事务写入及 Security/Secret authority
放在同一个文件。

现有 `LocalSqliteRunReader` 已经实现 `RunRepositoryReader`，并由 `LocalSqliteRunTransaction` 继承；问题不是缺少领域
对象，而是这个内部对象仍嵌在 Facade 文件。GitNexus 显示 Facade 为 CRITICAL（30 direct/63 total），Reader 为 HIGH
（28 direct/51 total），Transaction 为 HIGH（15 direct/37 total）。Reader 各方法和 Facade `transaction()` 均为
LOW，但共享 row codec helper 中有五项为 CRITICAL 并进入两条执行流，因此不能在同一批次同时移动 Reader 和 codec。

## 决策

1. 把既有 `LocalSqliteRunReader` 原样移动到 `src/run/runReader.ts`，继续作为 package-private implementation；不得从
   package root、subpath、`index.ts` 或 `runtime.ts` 导出。
2. 新模块定义最小 `LocalSqliteRunReaderSupport` contract。Facade 文件把现有 SELECT projection、
   `queryRows`/`singleRow`、row codec 和标量校验函数组成冻结对象并注入具名 Reader；SQL 文本、排序、limit、cursor、
   normalization 与错误类型不变。Reader 只增加 package-private support 参数，产品 Facade 构造器不变。
3. `LocalSqliteRunRepository` 继续持有 Reader，所有公开读方法继续通过同一个
   `LocalSqliteOperationAuthority.enqueue` 委托。公开构造器、方法签名和实现的 runtime-core ports 不变。
4. `LocalSqliteRunTransaction` 保留在 Facade 文件，不移动任何 BEGIN/COMMIT/ROLLBACK 或写操作，只继承移动后的具名
   Reader，并由 Facade 注入同一个冻结 support。
5. Reader 仍只持有 Facade 的同一个 `DatabaseSync`；support 只包含纯函数和字符串 projection，不创建 connection、
   queue、transaction、timer、watcher、cache、listener 或后台工作。
6. 本批次不移动 CRITICAL row codec helper。后续若要抽取 codec，必须另立 ADR、逐符号 impact，并同时覆盖 Run、
   Security/Secret 两条执行流，不能把本次结构调整当作其安全证据。
7. 不新增 workspace package、生产 dependency、migration、表、索引、公开 specifier、进程或部署单元；19-package
   ledger 和低配设备制品/RSS 上限保持不变。

## 被拒绝的方案

- **把 Reader 拆成新 workspace package**：它没有独立部署、权限、依赖或消费者 closure，只会增加 importer/SBOM 成本。
- **同时移动全部 row codec**：五个 helper 为 CRITICAL 且进入两条执行流，会把机械布局调整扩大成难以归因的跨域重构。
- **复制 row codec 到 Reader**：会让 Run 读取与事务写入产生两套列定义和 normalization，长期形成 silent drift。
- **为 Reader 新建只读 SQLite connection**：改变 WAL/DELETE、busy、snapshot 与 close 语义，破坏单 connection authority。
- **同时移动 Transaction**：会把只读结构调整与写事务边界混在同一批次，扩大 HIGH 风险面。

## 接受条件

1. Reader 查询源码从 Facade 文件移除且没有复制；公开 exports、方法签名、SQL/排序/cursor/limit 和错误语义不变。
2. Reader、Transaction 与 Facade 共享同一 client 和冻结 support；不得出现第二 connection、独立 queue 或新资源 owner。
3. Run Repository、startup recovery、local dispatch/control、execution revision 定向测试和 Local SQLite 全量测试通过。
4. 完整 19-package clean build/test、backend、六项架构/部署审计及十档 artifact/RSS 门通过；package ledger 仍为
   19 个、`singleSourcePackages=[]`，公开 export keys、生产依赖与 migration chain 不变。
5. 刷新 GitNexus 后重查 Facade/Reader/Transaction 与委托方法，并运行 `detect_changes` all/compare `develop`；如出现
   新生产执行流、跨模块公开消费者或风险扩大，ADR 不得进入 Accepted。

## 接受证据

- Reader/Startup Recovery/Dispatch/Control/Execution Revision 定向测试 26/26、Local SQLite 192/192、完整
  19-package clean build/test 与 backend 1,110（1,108 pass/2 skip）通过；六项架构/部署审计和十档 artifact/RSS
  均 compatible。
- `runRepository.ts` 从 ADR-0290 后的 2,581 行降到 1,990 行；具名 `runReader.ts` 为 762 行。Reader 源码没有复制，
  Transaction 写入与 BEGIN/COMMIT/ROLLBACK 仍在原 Facade 文件，产品公开 API/exports 不变。
- workspace 保持 19 个 package、764 个 source、49 个受审根入口和 715 个领域内嵌套实现，
  `singleSourcePackages=[]`；Local SQLite 为 152/3/149。生产依赖、migration chain、表、索引和部署单元均未改变。
- 最小 Edge 产物为 3,619,760 bytes/328 files/44 loaded modules，RSS delta 为 11,698,176 bytes；最大
  Standalone Application AI 为 6,107,381 bytes/487 files/100 loaded modules，RSS delta 为 21,266,432 bytes，
  均低于硬上限。相对 ADR-0290，Edge 只增加 2,177 bytes、1 file 和 1 loaded module。
- 更正：ADR-0292 前的强制完整索引基线确认 Facade 仍为 CRITICAL（30 direct/63 total），不是本 ADR 验收时增量图谱
  报告的 HIGH（25/47）；后者遗漏了部分 package-private function edge，现已废止，不再作为风险下降证据。Reader 为
  HIGH（15/40），Transaction 为 HIGH（15/37），三者均为 0 affected process；Reader 十二个方法、Reader/Facade
  构造器和 Facade `transaction()` 均为 LOW。该更正不改变本 ADR 的行为、测试、制品或 package 边界验收结论。
- `detect_changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均为 low/0 affected process；QL3
  孵化树大部分仍 untracked，因此该统计只作为逐符号 impact、完整测试和制品门的补充证据。

## 后续边界

- 下一批可独立评审 Run record codec，但必须把其 Run 与 Security/Secret 调用者作为同一回归范围。
- Facade 中 Project Policy、Security Audit 与 authorized Secret mutation 共享授权事实和事务围栏，不能只按 LOC 拆散。
