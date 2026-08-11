# ADR-0321：Plugin Package Install 领域归属与 Package/Module 粒度

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-257
- 关联 ADR：ADR-0087、ADR-0267、ADR-0276、ADR-0295、ADR-0303、ADR-0312、ADR-0316、ADR-0317

## 背景

QingLong 3.0 曾把 use case、authority 和 adapter 都默认表达成 workspace package，最多达到 32 个 importer。连续
收敛后当前只剩 16 个 package，并由 hard cap 禁止无决策地增长。当前 818 个 TypeScript source 中只有 25 个位于
`src/` 根层、793 个位于领域目录；`singleSourcePackages=[]`、`shallowSourcePackages=[]`。因此现阶段的主要问题
已经不是“每个文件一个 package”，而是少数 package 内的大文件仍混合多种 ownership。

`@qinglong/runtime-core` 的 `pluginPackageInstall.ts` 就是这类问题：原 2,586 行同时拥有公开 schema/repository port、
严格 codec、manifest/source/approval lock、install record/receipt、transition/event 和 repository command/pagination。
这些职责共享一个公开 subpath，但演进原因并不相同，继续平铺会迫使任一修改触碰整份安装协议。

编辑前 GitNexus impact 已逐 symbol 执行并告警：`InvalidPluginPackageInstallError`、
`PluginPackageInstallTransitionConflictError` 和 `PluginPackageInstallUnavailableError` 为 CRITICAL；
`InvalidPluginPackageLockError`、`PluginPackageInstallMutationConflictError`、`exactKeys`、`contentDigest` 和
`normalizePluginPackageLock` 为 HIGH。最高累计上游为 147，相关安全校验进入 3 条执行流程。因此本轮只移动
ownership，不重写 schema、digest、transition 或 repository 语义。

## 决策

### 1. Package 与内部 module 使用不同判据

workspace package 只表达至少一项真实边界：独立部署/发布或 binary、不同 authority、生产依赖隔离、可替换 adapter、
至少两个 production consumer 的稳定 contract，或独立供应链/版本责任。一个 use case、一个文件、一个 class 或一个
未来可能复用的猜测都不能单独创建 package。

package 内部的领域目录表达共同变化的 ownership。`src/` 根层只允许受审 public facade、public export 或 binary entry；
实现下沉并不意味着“一函数一文件”，共享同一状态机、事务或安全协议的代码必须保留在一起。文件数和 LOC 只触发
评审，不能代替 dependency、authority、consumer 和 artifact closure 证据。

### 2. Plugin Install 保持一个 package、一个 public subpath

不新增第 17 个 package，不新增公共 subpath。原入口收敛为 32 行纯 facade，内部按职责形成：

```text
plugin-package/installation/
├── pluginPackageInstall.ts                 # 稳定 public facade
└── plugin-package-install/
    ├── contracts.ts                        # schema、type、repository port、error identity
    ├── codec.ts                            # strict validator、canonical digest primitives
    ├── lock.ts                             # manifest/source/approval/plan/lock
    ├── record.ts                           # install record、failure、activation receipt
    ├── transition.ts                       # event、state transition、commit
    └── repository.ts                       # create command、pagination/cursor、recovery action
```

`pluginPackageInstallCreate` 与 create command/cursor 一起归 repository，避免 transition 反向依赖 repository；
transition 只拥有状态机与 commit。所有原公开 export 仍从同一 subpath 暴露，27 个公开 error/function export 与 owning
module 是同一个 runtime object，保持 `instanceof`、函数 identity 和调用路径不变。

### 3. 薄 package 不按文件数机械合并

当前较薄边界仍必须用真实拓扑解释。例如 `local-command-file` 只有 2 个 source，但被 Application、Owner CLI 和
Maintenance 三个生命周期闭包共同复用；`local-secret` 被 3 个 production package 复用并持有密文/keyring authority；
`local-owner-maintenance` 虽只有 6 个 source，却是不得进入常驻 Profile 的独立 destructive binary。若这些条件消失，
再新增 ADR 合并；不能仅为了减少 package 数破坏权限或制品防火墙。

## 小设备与集群影响

最小 Edge/Standalone 仍只加载 49 个模块，AI 基础档仍为 50，说明包内拆分不会使路由设备加载未 import 的能力。
Application 档真实使用 Plugin Install public subpath，因此从 ADR-0320 的 110/109 增至 116/115 个 loaded modules；
这是 6 个职责模块的可观测成本，不隐藏为零。最大实测 RSS delta 仍低于 24 MiB Application 门限，所有 pack/file/RSS
预算 compatible。

Cluster 仍通过同一个 Runtime Core contract 使用 PostgreSQL adapter；没有新增 dependency、数据库连接、进程、timer、
listener、部署单元或角色。此次不改 SQL、migration、PostgreSQL/Cluster runtime 和部署资源，因此不重复 PostgreSQL
HA Docker 门。

## 被否决方案

1. **六个职责各建一个 workspace package**：没有独立部署、依赖或 consumer closure，拒绝。
2. **只保留 2,586 行单文件**：公开 contract、codec、状态机与 repository 继续共同变化，拒绝。
3. **每个 schema/function 一个文件**：制造导航噪声并拆断状态机协议，拒绝。
4. **按 LOC 自动合并所有薄 package**：会把 destructive、secret 或 adapter authority 带入错误制品，拒绝。
5. **用动态 import 隐藏 Application module 增量**：会改变同步 contract 与失败面，且当前资源预算没有要求，拒绝。

## 验收证据

- facade 2,586→32 行；contract 361、codec 202、lock 930、record 560、transition 397、repository 295 行。
- 27 个公开 error/function export 的 facade/owner runtime identity 全部相同；Runtime Core 445/445。
- 完整 16-package clean topology build/test 在允许 loopback TLS 与 crash 子进程的门环境最终退出 0；AI 为
  209 pass/3 skip，Owner CLI 134/134，Application 40 pass/3 skip。沙箱内 Worker 的 3 个 `listen EPERM` 明确归因于
  环境禁止 `127.0.0.1`，不是产品失败。
- package boundary 为 16 package、818 source、25 root、793 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Runtime Core 为 119 source、1 root/118 nested。Edge import、Cluster
  dependency 和 Cluster deployment 均 compatible。
- Edge/Standalone 为 3,636,968/3,637,004 bytes、337 files、49 modules；Adopted 为
  4,247,060/4,247,120 bytes、382 files、50 modules；Application 为 4,744,909/4,745,029 bytes、441 files、
  116 modules。AI 基础档为 5,032,279/5,032,327 bytes、416 files、50 modules；Application AI 为
  6,140,286/6,140,418 bytes、520 files、115 modules。十档全部 compatible。
- 强制重建后的 GitNexus 为 43,999 nodes/100,193 edges/1,726 clusters/274 flows。post-impact 中公开 install error
  为 CRITICAL（82 direct/146 total），`normalizePluginPackageLock` 为 CRITICAL（15/41、2 flows），`exactKeys`
  为 HIGH（20/70、3 flows），record normalizer 为 HIGH（13/24），transition 为 MEDIUM（5/7），repository create
  为 LOW（1/1）；高风险关系没有因换文件消失。`detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy
  baseline 的 12/31 与 14/34、low/0 process，未跟踪 QL3 孵化树不能用该结果代替上述完整索引和测试证据。

## 后续约束

后续不以“package 少”或“文件短”作为完成标准。每轮优先审计仍同时混合 contract、codec、持久化和 coordinator 的实现，
保持 public facade 与 package 数稳定；纯 schema declaration 和共享同一事务/状态机的协议不机械拆分。若新增 package，
必须给出 deployment/authority/dependency/consumer/supply-chain 证据，并同步收紧或明确调整 16-package hard cap。
