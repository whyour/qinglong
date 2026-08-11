# ADR-0304：根 Public Export 纯转发证明与 Owner Command 实现归属

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-121、D-213、D-257、ADR-0106、ADR-0267、ADR-0276、ADR-0295、ADR-0303

## 上下文

schema v4 已冻结 19 个 workspace package 的根文件名、角色和行数，但 `public_export` 只证明文件被 manifest
指向，没有证明文件本身只是发布边界。复核 `@qinglong/cluster-postgres` 剩余 10 个根入口/520 审计行后，AST
显示十个文件都只含 TypeScript `ExportDeclaration`；它们分别是 runtime、admin、Package manager/executor、Worker
ingress、Automation 与 AI credential/maintenance 的最小权限公开面，不是隐藏实现。把它们机械移动到 `public-api/`
只会改变物理层级，不会改善 ownership。

同一轮全 workspace AST 复核发现两个反例：`@qinglong/local-owner-cli/src/index.ts` 的 413 行与
`@qinglong/local-owner-maintenance/src/command.ts` 的 317 行被登记为 `public_export`，但实际包含 command parsing、
validation、dependency assembly 与 execution。它们没有独立部署、版本、依赖或权限边界，不应拆成新 package；也不应
继续用发布角色隐藏实现。

移动前 GitNexus 将 `LocalOwnerCliConfigurationError` 与同文件 `exactKeys` 判为 HIGH，分别为 6 direct/
10 total/0 process 与 4/9/0；已在编辑前显式告警。Maintenance 配置错误最高为 MEDIUM 5/7/0。两个 runner
均为 LOW 1 direct/3 total/0 process。本批只改变物理路径、相对 import、manifest target 和审计证据，不改变 command
schema、validation、error identity、dependency custody、authority、执行顺序或 close 语义。

## 决策

1. package boundary ledger 升为 schema v5。非浅层 package 的每个 `public_export` 根文件必须可解析且非空，并且
   AST statement 全部是 `ExportDeclaration`；出现 function、class、variable、expression 或其他实现 statement 时以
   `PACKAGE_SOURCE_ROOT_PUBLIC_EXPORT_IMPLEMENTATION` 失败。
2. `local-profile` 与 `local-adopted-profile` 的三组根产品入口继续使用 `shallowSourceLayoutKind=public_entrypoints`。
   它们不是任意豁免：schema v3 已要求 manifest artifact 一一映射、真实 consumer 与递归 production closure 防火墙；
   证据消失时必须下沉或合并。
3. `@qinglong/cluster-postgres` 的十个根 facade 保持原位。它们是 manifest 可证明、AST 纯转发、按 authority 拆分的公开
   subpath；不以 `root=0` 为目标创建 `public-api/` 目录或 wrapper。
4. Owner CLI 实现迁至 `src/application-command/localOwnerCommand.ts`；Maintenance command 实现迁至
   `src/application-command/localOwnerMaintenanceCommand.ts`。CLI binary 和 manifest 直接依赖嵌套产物，不保留旧根 facade。
5. 公开 package specifier、`@qinglong/local-owner-maintenance/command` subpath、binary 名、exported symbol 与 error class
   identity 保持不变。测试改从公开 specifier 加载，clean build 必须证明旧 `dist/index.*`/`dist/command.*` 不存在。
6. 不新增 workspace package、生产依赖、数据库对象、connection、timer、listener、进程、binary 或部署单元。

## 被拒绝的方案

- **把 Cluster PostgreSQL facade 全部移到 `public-api/`**：十个文件已是纯转发 least-authority surface；移动不会产生
  新 ownership，只会增加 import 与 manifest 噪声。
- **只依赖根行数 hard cap**：实现可以在不新增文件的情况下继续藏进既有 `public_export`，schema v4 无法识别。
- **为两个旧根路径保留 wrapper**：物理路径不是公开契约，wrapper 会重新占用根 cap 并允许实现再次回流。
- **把两个 command 各拆成 workspace package**：它们分别只服务现有 CLI/maintenance deployable，没有独立 consumer、
  dependency closure 或权限域，拆包会增加低配设备的 importer、lockfile 与 SBOM 复杂度。
- **把浅层 Profile 一并强制为纯转发**：三组文件是独立 Edge/Standalone 产品组合入口，已有更强的 artifact/closure 证明；
  机械下沉不改变交付边界。

## 接受条件

1. schema v5 正向审计 19/19，无 finding；负向 fixture 能拒绝“以 public export 名义隐藏实现”，已有浅层 Profile 证据继续通过。
2. workspace 保持 19 package/768 source；root 34→32、nested 734→736。Owner CLI 为 48 source、root 2→1、
   463→50 行、nested 46→47；Maintenance 为 6 source、root 2→1、367→50 行、nested 4→5。
3. 两个包 check/test、完整 clean 19-package、backend、dependency/boundary 与 Edge/Local/Cluster 制品门通过；十档
   artifact 的 bytes/files/modules/RSS 不回退。
4. PostgreSQL HA 物理门通过，且门后 Docker 容器、volume、network 无残留。
5. 强制 GitNexus 不增加产品流程，公开 runner 的直接调用不扩大，`detect-changes` 保持 low/0 affected process。

## 接受证据

- package boundary schema v5 为 19 package/768 source、32 root、736 nested，`singleSourcePackages=[]`；边界 fixture
  8/8、dependency fixture 47/47，最终审计 `findings=[]`。
- Owner CLI 与 Maintenance 的 closure build/typecheck 通过；clean 19-package 从全空 `dist` 重建并完成测试。Owner CLI
  旧 `dist/index.*`、Maintenance 旧 `dist/command.*` 均不存在，两个新 `application-command` JS/declaration 同时存在。
- Worker Runtime 三项本地 TLS/mTLS 测试在受限沙箱内仅因 `listen EPERM 127.0.0.1` 失败；沙箱外重跑 132/132 通过。
  backend 为 1,113 项：1,111 pass/2 条件 skip/0 fail。
- Edge import、Local image、Cluster deployment 与 image release compatible；十档 artifact 全部 compatible 且与前批逐字节
  一致。基础 Edge 为 3,635,276 bytes/332 files/48 modules；最大 Standalone Application AI 为
  6,123,869 bytes/491 files/104 modules，Owner command 实现未进入路由设备 runtime closure。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：`remote_apply`、timeline 1→2、旧主先 fencing、`pg_rewind`
  后只读同步 rejoin 与两个 fresh control ready 均成立；门后 `ql3-ha-*` container、volume、network 精确为空。
- 强制 GitNexus 刷新为 43,358 nodes/98,573 edges/1,698 clusters/269 flows。两个 command runner 均为 LOW
  1 direct/3 total/0 process；Owner/Maintenance 配置错误分别为 MEDIUM 6/11/0 与 5/8/0，直接调用未扩大，
  聚类归位造成 total/risk 标签重算不解释为行为变化。`auditPackageBoundaries` 为 LOW 2/2/0，`auditSourceImports`
  为 LOW 1/1/0。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 process。
