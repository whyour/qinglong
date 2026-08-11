# ADR-0299：Cluster Control 根 Composition 实现归属

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-121、D-213、D-257、ADR-0106、ADR-0123、ADR-0276、ADR-0296、ADR-0298

## 上下文

schema v4 根行数棘轮显示 `@qinglong/cluster-control` 有 3 个 root source、1,032 个审计行。`cli.ts` 与 `aiCli.ts` 分别是
`ql3-cluster-control` 和 `ql3-cluster-control-ai` 的真实 binary entry；836 行的 `index.ts` 则不是薄聚合入口，而是完整的
PostgreSQL readiness、Recovery、Scheduler、Cancellation convergence、Worker port、Policy/Audit 与 Plugin Package Workflow
composition root。继续把它命名为 `index` 并放在 package root，会掩盖其 Application Runtime 领域归属，也会冻结无治理价值的
1,032 行 root cap。

该能力已通过 package 根 specifier 暴露，物理 `dist/index.js` 不是调用方契约。它与既有 `application-runtime/application.ts`、
`productionApplication.ts` 共享同一部署和版本生命周期，没有成立新 workspace package 的依据。

移动前 GitNexus 显示根文件、`ClusterControlAssemblyInput` 与 `ClusterControlBootstrapOptions` 均为 LOW（2 direct/6 total/0
process），`bootstrapClusterControlRuntime` 为 LOW（2/3/0）；没有 HIGH 或 CRITICAL 风险。

## 决策

1. 将 `src/index.ts` 原样归入 `src/application-runtime/clusterControlRuntime.ts`；同领域的 `application.ts` 与
   `productionApplication.ts` 直接引用该 module，不再反向依赖 package root。
2. 不保留根 wrapper。`package.json` 的 `main`、`types` 与根 export 直接映射嵌套编译产物；公开 package specifier、导出 symbol、
   error class identity、bootstrap 顺序和 stop/close 语义保持不变。
3. 两个 binary entry 保留在根目录，因为它们精确对应 manifest 的两个 `bin`，并承担 process signal、低敏输出和 exit code 语义；
   不为目录数字搬运真实入口。
4. 仓库根 benchmark 不是 workspace importer，显式绑定新的嵌套 `dist` 路径。dependency audit 将五个 PostgreSQL runtime-only
   subpath 的唯一允许 owner 从旧 `src/index.ts` 改为新的 composition module，并用同路径 fixture 证明。
5. package ledger 将 Cluster Control 的 `rootSourceFileHardCap` 从 3 降为 2、`rootSourceLineHardCap` 从 1,032 降为 195；
   boundary 回归冻结 source/root/nested、两个 binary role、manifest root target 与旧根文件不存在。
6. 不新增 workspace package、生产依赖、数据库对象、Pool、connection、timer、listener、watcher、进程、binary 或部署单元。

## 被拒绝的方案

- **保留根 `index.ts` facade**：没有兼容、组合或权限语义，只会让旧路径继续成为包内反向依赖并保留虚假入口。
- **把 composition 拆成新 package**：没有独立部署或依赖生命周期，只会扩大 Cluster 镜像 importer、lockfile 和 SBOM。
- **同时拆开 356 行 bootstrap 函数**：目录归位可以证明路径之外零行为变化；本批再改 readiness/recovery/stop 顺序会扩大故障恢复审查面。
- **把两个 CLI 也移入装饰性目录**：它们是真实 executable roots，不是被入口名称掩盖的领域实现；移动不会改善职责边界。

## 接受条件

1. Cluster Control 保持 43 个 source，root 仅有两个 binary entry/195 审计行，nested 40→41；workspace 保持 19 package、
   768 source，root 43→42、nested 725→726。
2. 根 package export 与两个 bin 名称/路径保持；Cluster Control 及完整生产 consumer 通过 clean build/test。
3. PostgreSQL authority allowlist 只承认新的 composition module；旧根源码和 clean build 旧根产物均不存在。
4. 完整 packages/backend、架构/部署审计和十档本机制品门 compatible。
5. 强制 GitNexus 不增加产品流程，`detect_changes` 保持 low/0 affected process。

## 接受证据

- package boundary schema v4 报告 Cluster Control 为 43 source、2 root/195 root lines/41 nested；workspace 仍为 19 package、
  768 source、42 root、726 nested，`singleSourcePackages=[]`。
- Cluster Control 188 项为 186 pass/2 条环境条件 skip；dependency 与 boundary 定向回归 54/54。
- 完整 19-package clean build/test 退出 0；backend 1,112 项为 1,110 pass/2 skip/0 fail。clean build 的
  `@qinglong/cluster-control/dist` 根只保留 `cli`/`aiCli` 产物，不再产生 `index.*`。
- dependency、package boundary、Edge import、Local image、Cluster deployment 与 Cluster image release 审计全部
  compatible；需要真实 OCI layout 参数的布局校验由 backend fixture 覆盖，不把无 layout 的 CLI 调用伪报为失败。Cluster
  Control benchmark 通过，module load 78.524 ms/30,638,080 bytes RSS delta，disabled activation 0.154 ms 且未打开数据库或
  assembly。
- 十档本机制品门全部 compatible：基础 Edge 为 3,635,197 bytes/332 files/48 modules；最大 Standalone Application AI 为
  6,123,790 bytes/491 files/104 modules，各档 artifact/file/module/RSS 均未越界。
- 强制 GitNexus 刷新为 43,308 nodes/98,518 edges/1,696 clusters/269 flows。新 composition file、两个 interface 与
  `bootstrapClusterControlRuntime` 均为 LOW，2 direct/0 process；bootstrap 仍只有 `inactiveBootstrap` 与
  `startClusterControlApplication` 两个直接 caller。`detect_changes` all 为 12 files/31 symbols，compare `develop` 为
  14/34，均 low/0 affected process。
- 本批未修改 SQL、生产依赖或 Cluster 状态，不重复消费 PostgreSQL HA 物理门；紧邻 ADR-0298 已按授权完成 PostgreSQL 18.4
  arm64 physical HA、fencing、timeline 1→2、`pg_rewind` sync rejoin，并确认测试资源清空。
