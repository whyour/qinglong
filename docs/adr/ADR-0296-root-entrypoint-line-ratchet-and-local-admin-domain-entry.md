# ADR-0296：根入口行数棘轮与 Local Admin 领域入口

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-213、D-257、ADR-0064、ADR-0069、ADR-0087、ADR-0267、ADR-0276、ADR-0295

## 上下文

ADR-0295 已能拒绝没有 artifact/closure 证明的浅层 package，但现有 package boundary ledger 只限制根 source 文件数量和角色。
一个标记为 `public_export` 的根文件仍可继续承载大量实现而不触发门禁。`@qinglong/local-admin/src/index.ts` 就是实际反例：它有
1,940 行，完整实现 Legacy SQLite inspection、review、stage、verify、activation 和 source write fence；与同 package 已有的
`src/legacy-adoption/` 领域模块并列，却被 package root 名称掩盖为入口。

机械增加两行 `index.ts` facade 虽能把实现移入目录，却会新增一个无独立语义的微型 wrapper，重现本轮刚拒绝的文件碎片化。
package manifest 本身已经能够把 `.` 直接映射到嵌套领域输出，不需要源码 wrapper。

强制 GitNexus 中 `LocalSqliteAdoptionError` 为 CRITICAL（35 direct/40 total/0 process），`inspectLegacySqlitePath` 为 MEDIUM
（8 direct/13 total/0 process），其余公开 adoption/activation entry 多为 LOW；高风险来自共享错误契约和同文件内部调用，
不是产品流程扩张。package boundary `sourceMetrics`/`auditPackageBoundaries` 均为 LOW，各 1 direct/0 process。

## 决策

1. 将原 `local-admin/src/index.ts` 的 Legacy Adoption 实现原样移至
   `src/legacy-adoption/localSqliteAdoption.ts`，与 decision、publisher、keyring 等同领域模块共置。
2. 删除源码 `index.ts` wrapper。package manifest 的 `main`、`types` 与 `exports["."]` 直接指向领域输出；公开 package
   specifier `@qinglong/local-admin`、全部导出名称、类型、错误 class identity 和运行行为保持不变。
3. `runtime.ts` 与 `legacyCrontabDecisionIssuer.ts` 直接依赖领域模块，不再通过 package root 形成内部反向依赖。
4. package boundary ledger 升级为 schema v4。每个 workspace package 必须声明不可增长的 `rootSourceLineHardCap`；审计从实际
   根 TypeScript source 计算总行数，缺失、负值或超限均失败。文件数量和行数是两个独立棘轮。
5. 为当前 19 个 package 建立真实基线。Local Admin 从 2 个根文件/1,949 行收敛为 1 个根文件/9 行，nested 24→25，source
   总数仍为 26；workspace package/source 总数、生产依赖和公开 export 集合不变。
6. 高基线只表示“禁止继续恶化”，不表示架构债务已经合理。后续优先复审 AI migration/profile、Local SQLite adoption/runtime、
   Cluster Control root 和 Worker production assembly，并在每次下沉后只能降低对应 hard cap。
7. 不新增 package、wrapper、第三方依赖、数据库对象、connection、timer、watcher、listener、进程或部署单元。

## 被拒绝的方案

- **保留两行 package-root facade**：新增没有独立职责的 source/compiled wrapper，违背减少微型文件的目标。
- **只移动文件、不增加行数门禁**：同类 god module 可以在任一 `public_export` 根文件重新出现。
- **一次拆分 1,940 行内部状态机**：本批目标是修正 ownership；同时重写高风险 adoption/activation 事务会把可验证的移动变成语义重构。
- **新增 `local-adoption` workspace package**：没有新的依赖、权限、部署或版本生命周期，只会扩大 importer 拓扑。
- **统一设置很小的全局阈值**：会把 migration、binary assembly 与固定 Profile composition 混为同一种入口；逐 package 棘轮更适合
  按风险持续下降，同时不允许任何现状反弹。

## 接受条件

1. Local Admin root source 只有 `runtime.ts`，9 行；Legacy Adoption 实现位于领域目录，source 总数仍为 26。
2. root package specifier 与 runtime/decision-issuer subpath 的导出和错误 class identity 保持；83 项 Local Admin 测试通过。
3. schema v4 fixture 必须拒绝在不增加根文件的情况下向入口塞入实现；当前 19-package boundary 为 compatible。
4. 完整 19-package、backend、依赖/Edge/local-image 审计与十档 artifact/RSS 门通过；基础 Edge 不安装 Local Admin。
5. GitNexus/detect_changes 不出现新产品流程或生产依赖变化。

## 接受证据

- `@qinglong/local-admin` 保持 26 个 source；root 仅 `runtime.ts` 1 个/9 行，nested 为 25。package root 的
  `main`/`types`/`exports["."]` 直接映射 `dist/legacy-adoption/localSqliteAdoption.*`，不存在两行 wrapper。
- Local Admin 83/83、完整 19-package build/test、backend 1,112（1,110 pass/2 skip）通过；schema v4 的 7 项 boundary
  fixture 覆盖“根文件数不变但行数增长”并全部通过。cluster dependency、package boundary、Edge import、local image 四项审计
  均为 compatible，workspace 仍为 19 package/768 source/48 root/720 nested，`singleSourcePackages=[]`。
- 十档 Profile artifact/RSS 全部 compatible。基础 Edge 为 3,635,004 bytes/332 files/48 loaded modules，不含 Local Admin；
  最大 Standalone Application AI 为 6,122,822 bytes/491 files/104 loaded modules，仍低于 6 MiB/768 files 门限。
- 强制 GitNexus 为 43,284 nodes/98,493 edges/1,698 clusters/269 flows。移动后的 `LocalSqliteAdoptionError` 仍为
  CRITICAL（35 direct/40 total），`inspectLegacySqlitePath` 为 MEDIUM（8/13），但两者均为 0 affected process；
  `sourceMetrics`/`auditPackageBoundaries` 为 LOW，分别 1 direct/2 total 与 1/1。`detect_changes` all/compare
  `develop` 为 12 files/31 symbols 与 14/34，均 low/0 process。
- 本批没有修改 production dependency、migration、数据库/Cluster 状态或运行资源，因此不重复制造无关 PostgreSQL HA
  物理故障证据；此前门禁结论不被本批扩大或替代。
