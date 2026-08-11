# ADR-0298：Local SQLite 根 Runtime 与 Adoption 实现归属

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-97、D-213、D-257、ADR-0063、ADR-0098、ADR-0276、ADR-0296、ADR-0297

## 上下文

schema v4 根行数棘轮显示 `@qinglong/local-sqlite` 仍有 3 个 root source、1,203 个审计行。`index.ts` 只有 31 个审计行，
是聚合公开导出的真实门面；`runtime.ts` 与 `adoption.ts` 分别有 432 与 738 个可见代码行，承载长期 Runtime Database
Composition 和短生命周期 Legacy Adoption Authority。两者有明确的权限、生命周期与领域归属，却继续以“公开入口”为由平铺在
package root，会让目录结构掩盖常驻与短生命周期 authority 的隔离关系。

这两个能力已经通过 `@qinglong/local-sqlite/runtime` 与 `@qinglong/local-sqlite/adoption` 两个稳定 subpath 暴露，物理 `dist`
路径并不是调用方契约。它们也不具备独立部署、依赖或版本生命周期，另拆 workspace package 会扩大路由设备的 importer、packlist、
SBOM 和构建拓扑。

移动前 GitNexus 显示 `LocalSqliteRuntimeDatabase` 为 MEDIUM（10 direct/24 total/0 process），
`openLocalSqliteRuntimeDatabase` 为 LOW（1/3/0）；`LocalSqliteLegacyAdoptionPublisher` 与
`openLocalSqliteAdoptionDatabase` 均为 LOW（2/6/0 与 1/1/0）。没有 HIGH 或 CRITICAL 风险。

## 决策

1. 保留根 `src/index.ts` 作为唯一聚合门面；Runtime composition 原样归入
   `src/runtime/runtimeDatabase.ts`，Legacy Adoption authority 原样归入
   `src/adoption/legacyAdoptionDatabase.ts`。
2. 不保留根 wrapper。`package.json#exports` 直接把公开 `/runtime` 与 `/adoption` subpath 映射到嵌套编译产物；公开
   specifier、导出 symbol、错误 class identity、lazy loading 和运行行为保持不变。
3. `src/storage/database.ts` 作为开发工具兼容入口直接导出新的 Runtime domain module。package tests 通过公开 self-reference
   验证 Runtime 入口；仓库根物理 Edge 脚本不是 workspace importer，显式绑定新嵌套产物。
4. package ledger 将 Local SQLite 的 `rootSourceFileHardCap` 从 3 降为 1、`rootSourceLineHardCap` 从 1,203 降为 31；
   回归测试同时冻结 source/root/nested 计数、manifest targets 与旧根文件不存在。
5. 不新增 workspace package、生产依赖、migration、数据库对象、connection、transaction、queue、timer、watcher、listener、进程或
   部署单元。

## 被拒绝的方案

- **保留两个根 facade**：会留下无独立语义的转发文件，使根文件数棘轮失去约束力。
- **按 Runtime 与 Adoption 各拆一个 package**：二者仍共享同一 SQLite adapter、operation authority 与发布节奏；拆包只增加低配设备成本。
- **本批同时拆分 738 行 Adoption publisher**：目录归位能证明路径之外零行为变化；同时重排事务、validation 和 row codec 会扩大授权与原子性审查面。
- **继续容忍 1,203 行 hard cap**：公开 subpath 不要求实现位于根目录，提高或冻结旧上限没有架构价值。

## 接受条件

1. Local SQLite 保持 156 个 source，root 仅有 `index.ts`/31 审计行，nested 153→155；workspace 保持 19 package、768 source，
   root 45→43、nested 723→725。
2. `/runtime`、`/adoption` 和根 export symbol 保持，Local SQLite 及完整生产消费者通过 clean build/test。
3. Runtime lazy import、migration exclusion、Adoption 单事务/围栏/重放行为继续由既有测试覆盖，旧根私有产物引用清零。
4. 完整 packages/backend、四项架构审计和十档 artifact/RSS compatible；基础 Edge 不获得 Adoption authority。
5. GitNexus 不出现新增产品流程，`detect_changes` 保持 low/0 affected process。

## 接受证据

- package boundary schema v4 报告 Local SQLite 为 156 source、1 root/31 root lines/155 nested；workspace 仍为 19 package、
  768 source、43 root、725 nested，`singleSourcePackages=[]`。边界 fixture 明确验证两个公开 target 与旧根文件不存在。
- Local SQLite 196/196，完整 19-package clean build/test 通过；backend 1,112 项为 1,110 pass/2 skip/0 fail。cluster
  dependency、package boundary、Edge import、local image 四项审计 compatible。
- 十档 artifact/RSS 全部 compatible。基础 Edge 为 3,635,197 bytes/332 files/48 loaded modules；最大 Standalone
  Application AI 为 6,123,790/491/104，均低于门限。clean build 后旧根 `dist/runtime*`、`dist/adoption*` 不进入 packlist。
- 强制 GitNexus 为 43,302 nodes/98,525 edges/1,696 clusters/269 flows。嵌套 manifest subpath 不被当前索引器反向解析为
  跨包 direct edge，因此移动后的四个关键符号均显示 LOW/0 process，不把降低后的 direct count 作为兼容证据；移动前 blast radius、
  完整 consumer 测试与制品门共同承担验证。`detect_changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，
  均 low/0 affected process。
- 本批没有修改 SQL、migration checksum、生产 dependency 或 Cluster 状态；按维护者额外授权，仍重跑 PostgreSQL 18.4 arm64
  physical HA Docker 门，`gates.passed=true`。证据覆盖 `remote_apply`、timeline 1→2、旧主 promotion 前 fencing、
  `pg_rewind` 后只读 synchronous rejoin 与两个新 control ready；结束后 `ql3-ha-*` container、volume、network 均为空。
