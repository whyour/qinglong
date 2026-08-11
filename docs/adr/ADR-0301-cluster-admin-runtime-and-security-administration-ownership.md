# ADR-0301：Cluster Admin Runtime 与 Security Administration 实现归属

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-121、D-213、D-257、ADR-0123、ADR-0267、ADR-0276、ADR-0296、ADR-0300

## 上下文

schema v4 根行数棘轮显示 `@qinglong/cluster-admin` 有 3 个 root source、700 个审计行。60 行的
`modelInvocationMigrationCli.ts` 是 manifest 中 `ql3-ai-feature-migrate` 的真实 binary entry；128 行的 `index.ts` 实际负责
PostgreSQL readiness、Identity/API Credential/Worker Credential repository 与 administration service 的 Application Runtime
composition；509 行的 `administration.ts` 则持有 Identity 与 API Credential 的完整 Security Administration 领域实现。后两者不是
package root 职责，继续平铺会让真实领域边界被 `index` 和通用文件名掩盖。

两项能力已有稳定的根 package specifier 与 `/administration` 公开 subpath。物理 `src/index.ts`、`src/administration.ts` 和对应
`dist` 路径不是调用方契约。Runtime、Security Administration、Worker Credential 与 PostgreSQL adapter 共享同一个短生命周期
Cluster Admin 镜像、版本、权限和故障边界，因此没有成立新 workspace package 的依据。

移动前 GitNexus 显示根文件为 LOW（0 direct/0 total/0 process），`administration.ts` 为 LOW（1/1/0），
`bootstrapClusterAdmin` 为 LOW（0/0/0）。最宽的 `ClusterAdministrationConfigurationError` 为 MEDIUM
（6 direct/13 total/0 process）；其余 administration error/helper/service symbol 均为 LOW、0 process。没有 HIGH 或 CRITICAL
风险，因此本批只改变物理归属，不改变授权、审计、重放、熵、pepper、readiness、close 或 error identity 语义。

## 决策

1. 将根 Runtime composition 原样归入 `src/application-runtime/clusterAdminRuntime.ts`，将 Identity/API Credential
   administration 原样归入 `src/security-administration/clusterAdministration.ts`。
2. 不保留根 wrapper。`package.json` 的 `main`、`types`、根 export 与 `/administration` 直接映射嵌套编译产物；公开 package
   specifier、subpath、导出 symbol、类型和 error class identity 保持不变。
3. Cluster Admin 测试通过公开 package self-reference 验证根与 `/administration` 契约，不继续依赖私有 `../dist` 根路径。
4. `modelInvocationMigrationCli.ts` 留在根目录，因为它精确对应真实 manifest binary；不为目录数字移动 executable entry。
5. package ledger 将 Cluster Admin 的 `rootSourceFileHardCap` 从 3 降为 1、`rootSourceLineHardCap` 从 700 降为 61；boundary
   回归冻结 source/root/nested、binary role、两个 manifest target 与旧根源码不存在。
6. 不新增 workspace package、生产依赖、数据库对象、Pool、connection、timer、listener、watcher、进程、binary 或部署单元。

## 被拒绝的方案

- **保留根 facade/wrapper**：物理旧路径不是公开契约，wrapper 只会保留无职责 root cap，并重新引入包内根路径反向依赖。
- **拆成 Cluster Admin Runtime 与 Security Administration 新 package**：两者没有独立镜像、升级、权限或故障生命周期，会扩大
  lockfile、SBOM、Cluster Admin 镜像 importer 与低配部署的安装面。
- **同时拆分 509 行 administration service**：本批要证明路径之外零行为变化；同步重写授权、重放与审计逻辑会扩大安全审查面。
- **移动 migration CLI**：它是真实 executable root，移动不会改善权限或领域边界。

## 接受条件

1. Cluster Admin 保持 79 个 source，root 3→1、700→61 个审计行，nested 76→78；workspace 保持 19 package/768 source，
   root 40→38、nested 728→730。
2. 根 package export、`/administration` 与 `ql3-ai-feature-migrate` 契约保持；Cluster Admin 及完整 19-package clean build/test 通过。
3. 旧根源码与 clean build 旧根产物均不存在；根产物只保留真实 migration CLI。
4. backend、依赖/边界/Edge/本地镜像/Cluster 部署/Cluster 镜像发布与十档本机制品门 compatible。
5. 强制 GitNexus 不增加产品流程，移动后关键 symbol 调用半径不扩大，`detect_changes` 不出现额外受影响执行流。

## 接受证据

- package boundary schema v4 报告 Cluster Admin 为 79 source、1 root/61 root lines/78 nested；workspace 仍为 19 package、
  768 source、38 root、730 nested，`singleSourcePackages=[]`。
- Cluster Admin 258 项为 256 pass/2 条环境条件 skip/0 fail；完整 19-package clean build/test 退出 0。clean build 根只产生
  `modelInvocationMigrationCli.*`，Runtime 与 Security Administration 分别只在嵌套目录产生，不再生成 `index.*` 或
  `administration.*`。
- backend 1,112 项为 1,110 pass/2 skip/0 fail；dependency、package boundary、Edge import、Local image、Cluster deployment
  与 Cluster image release 审计全部 compatible。
- 十档本机制品门全部 compatible：基础 Edge 为 3,635,197 bytes/332 files/48 modules；最大 Standalone Application AI 为
  6,123,790 bytes/491 files/104 modules，各档 artifact/file/module/RSS 均未越界。
- 强制 GitNexus 刷新为 43,333 nodes/98,552 edges/1,703 clusters/269 flows。移动后 `bootstrapClusterAdmin` 仍为 LOW、
  0 direct/0 total/0 process，`createClusterAdministrationService` 仍为 LOW、1/1/0；
  `ClusterAdministrationConfigurationError` 保持 MEDIUM、6 direct/13 total/0 process，未减少或隐藏调用方。
  `detect_changes` all 为 12 files/31 symbols，compare `develop` 为 14/34，均 low/0 affected process。
- 本批只移动 TypeScript module 与 manifest target，不修改 SQL、migration、生产依赖或 Cluster 状态；PostgreSQL HA 物理门不因
  纯源码归位重复消费，紧邻增量已有 PostgreSQL 18.4 physical HA 与 Worker live contract 通过证据。
