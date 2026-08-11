# ADR-0306：Local SQLite Run Runtime 最小能力投影

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-85、D-87、D-213、D-257
- 关联 ADR：ADR-0087、ADR-0185、ADR-0276、ADR-0293、ADR-0294、ADR-0305

## 背景

ADR-0305 已从 `LocalSqliteRunRepository` 删除 Policy、Audit 与 Secret 的历史兼容面，但该对象仍同时实现
`RunRepository`、`LocalDispatchStore`、`LocalExecutionControlSource`、`LocalRunStartupRecoverySource` 与
`LocalCompletionReceiptJournal`。生产组合虽然把同一实例赋给多个窄类型字段，运行时对象本身仍携带全部方法；拿到
`runs` 的 Launcher、Cleanup 或 Recovery collaborator 可以越过 TypeScript 类型访问不属于它的能力。

这不是 workspace package 数量问题。现有 19 个 package 的机器可读 ledger 已逐一证明 deployable、authority、
dependency isolation、replaceable adapter 或 shared leaf 边界；`local-command-file` 等薄包也有三个真实生产消费者。
继续合并 package 会破坏路由设备 Profile 裁剪。真正需要收敛的是同一 package 内的 object-capability 暴露。

## 决策

1. `LocalSqliteRunRepository` 只实现 `RunRepository`，并保留同 authority 的 `close()`；它不再实现 Dispatch、Execution
   Control、Startup Recovery 或 Completion Receipt contract。
2. 新增 package-private `createLocalSqliteRunRuntimeCapabilities()`，基于同一个 `LocalSqliteOperationAuthority` 投影四个
   `Object.freeze()` 的窄对象：`dispatch`、`executionControl`、`startupRecovery`、`completionReceipts`。
3. 四个对象的方法集合互不重叠，也不等于 `runRepository`。`LocalSqliteRuntimeDatabase`、基础/Adopted Profile 与完整
   Application 显式传递对应能力；Launcher、Receipt Processor、Cleanup 与 Recovery 不再接收宽 `runs` 对象作为 Journal。
4. 保持一个 SQLite connection、一个 operation queue 和一个 close fence。不得新增 connection、worker、timer、watcher、
   listener、binary、进程、workspace package、生产依赖或部署单元。
5. QL3 仍为 private alpha，本次删除 `LocalSqliteRunRepository` 上 12 个错误能力方法，不保留 deprecated wrapper。
6. 负向门同时检查 prototype 与干净构建的 `.d.ts`；运行时门检查四个对象精确键集、冻结状态、互异 identity 和统一关闭后
   `RunRepositoryOperationError`。

## 被否决的方案

- **继续只依赖 TypeScript 窄类型**：运行时仍是同一宽对象，无法形成真实 object-capability 边界。
- **为四类能力新增 workspace package**：它们共享同一数据库 authority、事务事实与部署闭包，没有独立发布或依赖责任。
- **为每种 capability 打开独立 SQLite connection**：会破坏单 queue/close fence，并扩大低配设备 FD、内存与锁竞争。
- **仅把 567 行文件机械拆开**：目录更整齐但不改变消费者可获得的权限，不能解决责任耦合。
- **保留兼容委托**：会让生产组合或新消费者继续把 Run facade 当作全能数据库对象。

## 验收证据

- 编辑前 GitNexus：`LocalSqliteRunRepository` 为 LOW，3 direct/4 total/0 process；12 个待退役方法均 LOW/0；四个
  Runtime/Profile/Application bootstrap 均 LOW，应用 bootstrap 只关联一条既有启动流程，没有 HIGH/CRITICAL。
- `runRepository.ts` 567→337 行；新增 package-private capability module 252 行，两者合计 589 行，净增 22 行用于显式能力
  投影和关闭边界。Local SQLite 为 157 source/1 root/31 root lines/156 nested/48,269 source lines；workspace 为
  19 package/769 source/32 root/737 nested，两个浅层 Profile 入口保持原 226/323 行 hard cap，没有提高棘轮。
- Local SQLite 198/198；从空 `dist` 重建并测试全部 19 个 package 退出 0；backend 1,113 项为 1,111 pass/2 条件 skip/
  0 fail。dependency、package boundary、Edge import、Local image、Cluster deployment 与 image release 审计全部通过。
- 十档 artifact/RSS 全部 compatible。相对 ADR-0305，每档增加 1 file/1 loaded module；基础/AI-only 增加 2,023 bytes，
  Adopted 增加 2,088 bytes，Application/Application+AI 增加 2,144 bytes。基础 Edge 为 3,635,156 bytes/333 files/
  49 modules，最大 Standalone Application AI 为 6,123,870 bytes/492 files/105 modules；没有新增常驻资源。
- 最终 GitNexus 为 43,375 nodes/98,545 edges/1,697 clusters/271 flows。Run class 与新 factory 均为 LOW，
  factory 只有 `openLocalSqliteRuntimeDatabase` 一个直接调用方；`detect_changes` all/compare `develop` 仍为 12/31、
  14/34，均 low/0 affected process。

## 后续边界

`LocalSqliteRunRepository` 现在只剩 Run aggregate read/write transaction 与 close。下一步应审计其内部
`LocalSqliteRunTransaction` 是否需要成为独立 package-private aggregate writer，或转入 RFC 尚未完成的生产可达性、固定
Edge/多架构磁盘压力和操作回滚门；任何继续拆分都必须证明消费者、事务或 authority 收益，不能只以 LOC 为依据。
