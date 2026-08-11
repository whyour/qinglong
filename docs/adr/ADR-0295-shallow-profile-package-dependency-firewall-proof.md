# ADR-0295：浅层 Profile Package 的依赖防火墙证明

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-213、D-257、ADR-0063、ADR-0106、ADR-0267、ADR-0276、ADR-0294

## 上下文

QL3 当前 19 个 workspace package 中没有单 source package，但 `@qinglong/local-profile` 与
`@qinglong/local-adopted-profile` 都只有三个 `src/` 根文件、没有嵌套实现。仅凭“这些文件是公开入口”的文字解释还不够：
如果任何 artifact label 加几个 wrapper 都能取得浅层例外，package hard cap 只能限制总数，不能阻止边界逐步碎片化。

另一方面，这两个 package 不能按文件数机械合并。基础 `local-profile` 的 production closure 只允许 SQLite storage；
`local-adopted-profile` 才安装 `local-admin`、Local Secret 与 legacy source 写栅栏。继续向上合入
`local-application` 又会带入 `local-execution`、`local-process` 和 Croner。Edge/Standalone 的固定入口已经由
ADR-0106 从四个独立 wrapper package 收敛为 subpath，当前三个根文件分别对应 root、Edge 和 Standalone 公开入口，并非平铺
实现。

当前强制 GitNexus 中，package boundary audit 和 shallow-layout parser 均为 LOW，分别只有 1 个直接调用、0 条产品执行流；
两个 Profile 运行时 symbol 不需要修改。

## 决策

1. 保留 `@qinglong/local-profile` 与 `@qinglong/local-adopted-profile` 两个 package。它们隔离的是 production dependency、
   authority 和制品闭包，不是按文件数量划分的代码职责。
2. `docs/ql3-package-boundaries.json` 升级为 schema v3。所有无嵌套 source、无独立 binary、仅靠 artifact 证明 deployable 的
   package，必须在 `shallowSourceLayout` 中同时声明：
   - artifact 名到 package export specifier 的精确映射；
   - 一个真实直接 consumer 作为相邻更大闭包；
   - 至少一个存在于 consumer closure、但不存在于自身 closure 的 production dependency。
3. 审计必须从实际 package manifests 递归计算 production dependency closure，不接受账本自报；比较对象必须是该 package
   的真实直接 consumer，delta dependency 必须在 workspace 或外部 production closure 中可证明。
4. 对 shallow artifact package，manifest 的全部 export specifier、runtime `.js` target、根 source output 和 artifact entrypoint
   必须形成一一对应；隐藏 export、孤立根文件、重复 target、虚构 artifact 或未证明 dependency delta 均失败。
5. 有真实 `bin` 的 shallow deployable 继续以 executable manifest 作为独立部署证明，不强制使用 artifact dependency delta；
   one-source、consumer、authority、adapter 和 package hard-cap 的既有规则继续生效。
6. `local-profile` 必须证明相对直接 consumer `local-adopted-profile` 排除 `local-admin` 与 `local-secret`；
   `local-adopted-profile` 必须证明相对直接 consumer `local-application` 排除 `local-execution`、`local-process` 与 `croner`。
7. 不改两个 package 的 public API、运行实现、依赖树、artifact 集合或 Profile 行为；本批只加强结构准入，不以门禁改造伪装
   运行重构。

## 被拒绝的方案

- **合并两个 Profile package**：基础路由器闭包会取得 adoption 管理 authority，违反低配与最小权限边界。
- **把 adopted 组合并入 local-application**：storage-only adopted artifact 会被执行器、进程适配器和 Croner 污染。
- **只按 LOC/source 数设置自动合并阈值**：无法表达依赖、authority、部署和消费者责任，会误删安全边界并鼓励拆空 wrapper。
- **维持 schema v2 的文字 rationale**：能解释当前状态，但不能阻止下一批浅层微包复制相同说法。
- **为 Edge/Standalone 恢复独立 package**：ADR-0106 已证明固定配置值只需要 subpath，不构成依赖边界。

## 接受条件

1. 当前两个 shallow package 的入口、artifact 和 dependency firewall 由实际 manifest/closure 计算证明，审计
   `compatible:true`。
2. fixture 必须拒绝缺少 closure delta、比较非 consumer、依赖在两边都不存在、export/artifact 漂移和隐藏根入口。
3. 两个 Profile package 定向测试、完整 19-package 与 backend package-boundary 回归通过。
4. cluster dependency、package boundary、Edge import、local image 与十档 artifact/RSS 门通过；基础 Edge/Standalone 仍不安装
   local-admin/adoption authority。
5. 强制 GitNexus 和 `detect_changes` 证明没有产品执行流、运行 symbol 或 production dependency 变化。

## 接受证据

2026-08-09 已完成：

1. package boundary ledger 已升为 schema v3，审计从实际 manifest 递归计算 production dependency closure；当前
   `workspacePackageCount=19`、`singleSourcePackages=[]`，只有 `local-profile` 与 `local-adopted-profile` 被识别为 shallow，
   且 `compatible:true`。
2. 六项 package-boundary fixture 全部通过，明确拒绝缺少 artifact/delta 证据、虚构 delta dependency、以非 consumer
   比较、export/artifact 漂移和隐藏根入口；完整 backend 为 1,111（1,109 pass/2 skip）。
3. `local-profile` 5/5、`local-adopted-profile` 8/8，完整 19-package clean build/test 全绿。cluster dependency、package
   boundary、Edge import 与 local image 四项相关审计均 compatible。
4. 十档实际 pack/offline-install/import/RSS 门全部通过，字节/文件/module closure 与改造前完全相同：
   - Edge 3,635,004 bytes/332 files/48 modules；Standalone 3,635,052/332/48；
   - Edge Adopted 4,246,392/372/49；Standalone Adopted 4,246,476/372/49；
   - Edge Application 4,735,631/427/105；Standalone Application 4,735,775/427/105；
   - Edge AI 5,021,770/396/49；Standalone AI 5,021,830/396/49；
   - Edge Application AI 6,122,469/491/104；Standalone Application AI 6,122,625/491/104。
5. 基础 Edge/Standalone 的生产集合仍只有 `local-profile`、`local-sqlite`、`runtime-core`、`semver`；Adopted 才安装
   `local-admin`/`local-secret`，Application 才安装 `local-execution`/`local-process`/`croner`。强制 GitNexus 为
   43,278 nodes/98,485 edges/1,699 clusters/269 flows；`shallowSourceLayout` 与 `auditPackageBoundaries` 均为 LOW、0
   affected process，`detect_changes` all/compare `develop` 仍为 12 files/31 symbols 与 14/34，均 low/0 process。本批没有
   修改运行 symbol、public API、production dependency、migration 或部署单元，因此不重复制造 PostgreSQL HA 物理晋升证据。
