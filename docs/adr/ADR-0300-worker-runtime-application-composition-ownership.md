# ADR-0300：Worker Runtime Application Composition 实现归属

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-121、D-213、D-257、ADR-0126、ADR-0127、ADR-0139、ADR-0276、ADR-0296、ADR-0299

## 上下文

schema v4 根行数棘轮显示 `@qinglong/worker-runtime` 有 3 个 root source、874 个审计行。8 个审计行的 `index.ts` 是只导出
Worker certificate identity/store/renewal 的真实 package 根聚合入口；705 行的 `productionHeadlessApplication.ts` 与 159 行的
`productionWorkerApplication.ts` 则分别承担完整 Remote Execution 生命周期 composition 和产品级 Session/Capacity/共享 HTTPS
client composition。它们已有稳定的 `/production`、`/product` 公开 subpath，也由 `process/workerProcessApplication.ts` 作为
同一 Worker 部署单元的内部 composition 使用，不是 package 根职责。

这两个实现与 credential、execution、remote-execution、session 和 process 目录共享同一 package、镜像、binary、版本及故障域；
把它们拆成新 workspace package 会制造新的依赖与制品边界，却不会获得独立部署或权限生命周期。

移动前 GitNexus 显示两个文件为 LOW（Headless 2 direct/3 total、Product 1/2，均 0 process），公开启动函数为 LOW/0 process。
`ProductionWorkerHeadlessApplicationError` 为 HIGH（8 direct/14 total/0 process），`inspectUnsettled` 为 HIGH（2/6/0）；高风险来自
同一 Worker startup/drain/error 收敛链的内部密集调用，而不是产品执行流扩散。因此本批不得修改 error identity、startup
reconciliation、Session registration、certificate maintenance、drain/stop 顺序、timer 或 client ownership 语义。

## 决策

1. 将两个生产 composition 原样归入 `src/application-runtime/productionHeadlessApplication.ts` 与
   `src/application-runtime/productionWorkerApplication.ts`；Product composition 继续直接依赖同目录 Headless seam。
2. 不保留根 wrapper。`package.json` 的 `/production` 与 `/product` 直接映射嵌套编译产物；公开 package specifier、导出 symbol、
   error class identity、类型、disabled path、start/tick/stop 语义保持不变。
3. `process/workerProcessApplication.ts` 直接引用新的领域模块，避免 package 内部反向依赖根路径。package 内测试改用公开 self-reference；
   仓库根 Worker↔PostgreSQL live contract 不是 workspace importer，因此显式绑定新的嵌套 `dist` 路径。
4. `index.ts` 留在根目录并继续作为轻量公开聚合入口；`ql3-worker` binary 仍由 `process/workerProcessCli.ts` 承担，不为根文件数字移动
   真实进程入口。
5. package ledger 将 Worker Runtime 的 `rootSourceFileHardCap` 从 3 降为 1、`rootSourceLineHardCap` 从 874 降为 8；boundary
   回归冻结 source/root/nested、manifest 两个 subpath target 与旧根文件不存在。
6. 不新增 workspace package、生产依赖、数据库对象、connection、Agent、timer、listener、watcher、进程、binary 或部署单元。

## 被拒绝的方案

- **保留两个根 facade**：物理旧路径不是公开契约；wrapper 只会保留无职责的 root cap 与包内反向依赖。
- **拆出 Worker Application package**：两个 composition 不具备独立镜像、升级、权限或故障边界，会扩大 lockfile、SBOM 和小设备依赖面。
- **同时拆分 705 行 Headless lifecycle**：本批需要证明路径之外零语义变化；改动 startup/drain/certificate/lease 顺序会扩大 HIGH 风险审查面。
- **移动 `index.ts` 或 process CLI**：前者是真实轻量 package 根入口，后者是真实 executable root；移动不会改善领域职责。

## 接受条件

1. Worker Runtime 保持 32 个 source，root 3→1、874→8 个审计行，nested 29→31；workspace 保持 19 package/768 source，
   root 42→40、nested 726→728。
2. `/production`、`/product` 与 `ql3-worker` 公开契约保持；Worker 及完整 19-package clean build/test 通过。
3. 旧根源码与 clean build 旧根产物均不存在；Worker Process 与仓库 live contract 只使用新领域路径或公开 package specifier。
4. backend、依赖/边界/Edge/镜像/Worker deployment、Worker resource、十档本机制品及 Worker↔PostgreSQL 实机门通过。
5. 强制 GitNexus 不增加产品流程；HIGH 项保持原调用半径和 0 process，`detect_changes` 不出现额外受影响执行流。

## 接受证据

- package boundary schema v4 报告 Worker Runtime 为 32 source、1 root/8 root lines/31 nested；workspace 仍为 19 package、
  768 source、40 root、728 nested，`singleSourcePackages=[]`。
- Worker 132/132、完整 19-package clean build/test 与 backend 1,112（1,110 pass/2 skip/0 fail）通过；clean build 根只产生
  `index.*`，不再产生两个旧 production composition 产物。
- dependency、package boundary、Edge import、Local image、Worker deployment 与 Cluster image release 审计全部 compatible。
  Worker Edge 资源基准为 active 70,533,120 bytes、peak 70,877,184 bytes、TLS 1.3 mTLS/1 socket/3 requests，门禁通过。
- 十档本机制品门全部 compatible：基础 Edge 为 3,635,197 bytes/332 files/48 modules；最大 Standalone Application AI 为
  6,123,790 bytes/491 files/104 modules，各档 artifact/file/module/RSS 均未越界。
- PostgreSQL 18.4 Worker live contract `gates.passed=true`：证书与 credential rotation 保持同一 Session，旧证书拒绝、新证书接受，
  Run/Attempt/Lease/Artifact 完成且 runtime/ingress authority 隔离成立；运行后临时 container/volume/network 均为空。
- 强制 GitNexus 刷新为 43,318 nodes/98,527 edges/1,698 clusters/269 flows。两个文件仍为 LOW、2/3 与 1/2、0 process；
  error class 保持 8 direct/14 total/0 process，`inspectUnsettled` 保持 2/6/0，正确归入 Application-runtime 后风险分类分别由
  HIGH 收敛为 MEDIUM/LOW，没有减少或隐藏调用方。`inspectUnsettled` 仍只由 startup seam 与 drain closure 直接调用。
  `detect_changes` all 为 12 files/31 symbols，compare `develop` 为 14/34，均 low/0 affected process。
