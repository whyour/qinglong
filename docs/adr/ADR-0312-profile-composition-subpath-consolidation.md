# ADR-0312：Local Profile Composition 的 Subpath 收敛

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-06、D-17、D-87、D-257
- 关联 ADR：ADR-0042、ADR-0063、ADR-0267、ADR-0276、ADR-0295、ADR-0311

## 背景

`@qinglong/local-profile` 与 `@qinglong/local-adopted-profile` 都只有 root、Edge、Standalone 三个文件。
ADR-0295 曾用 artifact closure delta 证明二者不是任意平铺实现，但后续 pack 实证又证明：基础 Profile 的
每个制品必然已经安装 `@qinglong/local-sqlite`，Adopted Profile 的每个制品必然已经安装
`@qinglong/local-admin`、`@qinglong/local-sqlite` 与 `@qinglong/local-secret`。两个 package 因而没有独立
制品、依赖隔离、authority owner 或版本收益，只留下 manifest/importer 开销。

编辑前 GitNexus 将六个公开 bootstrap、两个校验函数、审计映射与失败清理函数全部判为 LOW：两个主
bootstrap 各 2 个直接包装调用、0 条已识别跨模块执行流程。这个结果只允许物理归属迁移，不允许改变启动、
栅栏或清理语义。

## 决策

1. storage-only composition 进入 `@qinglong/local-sqlite/profile`，Edge/Standalone 固定入口分别为
   `/profile/edge` 与 `/profile/standalone`。
2. adopted composition 进入 `@qinglong/local-admin/adopted-profile`，固定入口分别为
   `/adopted-profile/edge` 与 `/adopted-profile/standalone`；activation authority 仍使用 dynamic import，
   disabled 分支不得加载可执行 adoption runtime。
3. 目录级审计替代微包防火墙：SQLite `profile/` 只能跨到 `runtime/runtimeDatabase`；Admin
   `adopted-profile/` 只能跨到 package 内 `runtime`，并且只能消费 SQLite 的 `/profile` 子路径。
4. 两个旧 package 名成为全局 tombstone。Application 只允许三个受审 composition owner 导入新 subpath。
5. Package ledger hard cap 18→16；任何未来新 package 仍须提供独立 deployable、authority、重依赖隔离、
   replaceable adapter 或多 production consumer 证据。

## 低配与集群影响

- Edge/Standalone closure 从 4 个 package 降为 3 个：3,623,093/3,623,129 bytes、331 files、49 modules。
- Adopted closure 从 7 个 package 降为 5 个：4,222,699/4,222,759 bytes、369 files、50 modules。
- Application closure 从 12 个 package 降为 10 个：4,720,548/4,720,668 bytes、428 files、110 modules。
- AI 基础档为 5,010,628/5,010,676 bytes、395 files；Application AI 最大档为
  6,108,149/6,108,281 bytes、492 files；十档均在原 byte/file/RSS 预算内。
- Cluster、Worker、PostgreSQL package 和 deployment 均未改变；没有新增常驻进程、timer、listener、连接、
  migration 或第三方依赖。

## 验收

- boundary ledger：16/16、`singleSourcePackages=[]`、`shallowSourcePackages=[]`、零 finding；workspace
  仍为 781 source，root 31→25、nested 750→756。
- local-sqlite 203/203、local-admin 91/91、dependency 50/50 与受影响 image/service 契约通过。
- 十档真实 pack/install/import/RSS 审计全部 compatible。旧 package 没有进入 lockfile、Docker build、SBOM
  或 runtime inventory。
- 本批不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不重复运行 PostgreSQL HA 门。

## 被否决方案

1. 继续把三文件 public entrypoint 当永久浅包：已有 artifact 闭包不能证明额外裁剪价值。
2. 把 adopted composition 合入基础 SQLite Profile：会让路由器基础档取得 local-admin/Secret authority，拒绝。
3. 为每个 Edge/Standalone 入口继续拆包：Profile 是参数化组合，不是两个独立 authority 或产品生命周期。
