# ADR-0303：Runtime Core 领域实现与基础设施端口归属

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-121、D-213、D-257、ADR-0143、ADR-0209、ADR-0267、ADR-0276、ADR-0296、ADR-0302

## 上下文

schema v4 根行数棘轮显示 `@qinglong/runtime-core` 剩余 4 个根 source、596 个审计行。其中 160 行 `index.ts` 是面向
15 个 production consumer 的真实公共聚合入口；384 行 `migrationStream.ts` 是完整 Migration 领域实现；21 行
`pinnedSemver.ts` 是统一版本约束 provider adapter；28 行 `postgresql.ts` 则定义 Cluster persistence port。后三者留在
`src/` 根目录会掩盖 ownership，但它们都没有独立部署、版本、权限或故障边界，不能据此拆成新的 workspace package。

移动前 GitNexus 将 SemVer provider 文件判为 MEDIUM（5 direct/38 total/0 process），其 `semver` factory 为 CRITICAL
（14/98/4，跨 6 个 module）；Migration 中 `InvalidMigrationStreamError`、`exactKeys`、`checksumIsValid` 分别为 HIGH
3/5/0、HIGH 3/5/0、HIGH 2/5/0。PostgreSQL port 的 `query`、`connect`、`release`、`close` 分别为 CRITICAL
14/43/2、78/140/12、77/139/12、18/36/2。已在移动前显式告警；本批只改变物理路径、相对 import 与 manifest target，
不改变函数、class、interface、migration checksum/order、SemVer 实例或 connection lifecycle。

## 决策

1. 将 Migration 实现归入 `src/migration/migrationStream.ts`，将版本 provider 归入
   `src/versioning/pinnedSemver.ts`，将 PostgreSQL port 归入 `src/persistence/postgresql.ts`。
2. 根 `index.ts` 继续作为真实公共聚合入口；不为清零根目录而移动它，也不为三个旧物理路径保留 wrapper/facade。
3. 公开 `@qinglong/runtime-core` 与 `/migration-stream` specifier、exported symbol 和 error identity 保持不变；manifest
   直接把 `/migration-stream` 映射到嵌套 `dist/migration/migrationStream.*`。SemVer 与 PostgreSQL 文件仍为 package-private。
4. package ledger 将 Runtime Core 根文件/根行 hard cap 从 4/596 降为 1/160，根角色只允许
   `index.ts: public_export`；新增回旧根路径或重新引入 facade 必须失败。
5. 单文件领域目录是 package 内语义 namespace，不是新的 workspace package。workspace package 仍只按独立部署、权限域、
   可选重依赖和真实裁剪收益划分，避免低配路由设备承担额外 importer、lockfile、SBOM 与初始化成本。
6. 不新增 package、生产依赖、数据库对象、connection、timer、listener、进程、binary 或部署单元。

## 被拒绝的方案

- **把三个文件各拆成 package**：它们由同一 Runtime Core 版本和 production closure 消费，没有独立 authority 或 deployable，
  会把源码整理成本转嫁给所有设备。
- **为旧路径保留 facade**：旧物理路径不是公开契约；wrapper 会重新占用根 cap，并制造包内反向依赖。
- **移动根 `index.ts`**：它是真实公共聚合入口，移走只为追求 root=0，没有 ownership 收益。
- **同时改写 migration、SemVer 或 Pool 语义**：CRITICAL/HIGH 调用半径要求把物理迁移与行为重构分批验证。

## 接受条件

1. Runtime Core 保持 113 source，root 4→1、596→160 审计行，nested 109→112；workspace 保持
   19 package/768 source，root 37→34、nested 731→734。
2. 根 package 与 `/migration-stream` 公开 specifier 保持，Runtime Core、完整 19-package clean build/test 和 backend 通过。
3. clean `dist` 根只保留 `index.*`，三个旧根产物不存在，新产物只在 `migration`、`versioning`、`persistence` 下生成。
4. dependency/boundary/Edge/Local/Cluster image 与十档本机制品门 compatible；低配 Profile package/module/file/RSS 预算不回退。
5. PostgreSQL HA 物理门通过，证明 persistence port 路径移动没有破坏真实 promote/fence/rejoin contract。
6. 强制 GitNexus 不增加产品流程，关键 symbol 调用半径不扩大，`detect_changes` 保持 low/0 affected process。

## 接受证据

- package boundary schema v4 报告 Runtime Core 为 113 source、1 root/160 root lines/112 nested；workspace 仍为
  19 package/768 source、34 root、734 nested，`singleSourcePackages=[]`。
- Runtime Core 445/445、完整 19-package clean build/test 与 backend 1,112（1,110 pass/2 skip/0 fail）通过；第一次 clean
  门发现测试仍引用旧 SemVer 私有产物，修正后从全空 `dist` 重跑通过，证明结果不依赖陈旧编译输出。
- dependency 47/47、package boundary 7/7、Edge import、Local image、Cluster deployment 与 Cluster image release 全部
  compatible；十档本机制品门全部 compatible。基础 Edge 为 3,635,276 bytes/332 files/48 modules；最大
  Standalone Application AI 为 6,123,869 bytes/491 files/104 modules，各档均在 artifact/file/module/RSS 硬上限内。
- clean `dist` 根只包含 `index.d.ts`、`index.js` 及 source map；Migration、SemVer、PostgreSQL 分别只在新的领域目录生成。
- PostgreSQL 18.4 arm64 physical HA 门 `gates.passed=true`：`remote_apply`、timeline 1→2、旧主先 fencing、
  `pg_rewind` 后只读 sync rejoin 与两个 fresh control replica ready 均成立；门后 `ql3-ha-*` container、volume、network
  精确过滤为空。
- 强制 GitNexus 刷新为 43,347 nodes/98,557 edges/1,700 clusters/269 flows。SemVer factory 保持 CRITICAL
  14 direct/98 total/4 process/6 module；PostgreSQL `query`、`connect`、`release`、`close` 保持 CRITICAL
  14/43/2、78/140/12、77/139/12、18/36/2。Migration 三个节点的 direct/total/process 保持 3/5/0、3/5/0、
  2/5/0，归入单一 Migration cluster 后风险标签从 HIGH 收敛为 LOW；调用没有删除。`runMigrationStream` 仍为 LOW
  0/0/0，dependency audit 的 `auditSourceImports` 为 LOW 2/3/0。`detect_changes` all 为 12 files/31 symbols，
  compare `develop` 为 14/34，均 low/0 affected process。
