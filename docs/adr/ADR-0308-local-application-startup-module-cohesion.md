# ADR-0308：Local Application 启动模块内聚与 Profile 制品防火墙

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-257、D-259
- 关联 ADR：ADR-0063、ADR-0106、ADR-0178、ADR-0217、ADR-0267、ADR-0276、ADR-0295、ADR-0296

## 背景

QL3 当前 19 个 workspace package 中，`@qinglong/local-profile` 与
`@qinglong/local-adopted-profile` 都只有三个根源码文件，容易被误判为按文件名拆出的微型包；与此同时，
`@qinglong/local-application` 的 `application-runtime/activation.ts` 已增长到 835 行，同时承担 storage
选择、Plugin Package 四阶段恢复、Secret readiness、execution/scheduler 装配、startup recovery、生命周期
启动和反向停止。

两类问题不能使用同一个“合包”动作解决。ADR-0295 已由真实 production closure 证明：基础 Profile 相对
Adopted 排除 `local-admin`/`local-secret`，Adopted 相对 Application 排除
`local-execution`/`local-process`/`croner`。前者服务低配路由器的最小安装与权限，后者保留 storage-only
接管制品；合并会改变部署能力，而不是单纯整理目录。真正需要收敛的是 Application package 内部已经形成的
启动 capability。

编辑前 GitNexus upstream impact 显示：两个 Profile bootstrap 均为 LOW、各 2 个直接 wrapper、0 条产品
执行流；`bootstrapLocalApplication` 为 LOW，1 个直接调用者、1 个模块和 9 条 AI 启动流。五个启动错误 class
均为 LOW，直接影响 Application/AI composition 与现有 public export，不允许改变 identity 或错误字段。

## 决策

1. 保留 19 个 workspace package，并保留 `local-profile`、`local-adopted-profile` 两个 shallow artifact
   package。它们继续由 schema v5 package ledger、artifact/export 一一映射和实际 dependency closure delta
   证明，不因 LOC 或目录深度合并。
2. `local-application` 仍是一个 deployable composition package，不为 storage、Plugin recovery、Secret、
   scheduler 或 execution lifecycle 新增 workspace package。
3. 将 Application 启动代码按现有 owning capability 分为：
   - `storageActivation.ts`：只选择并验证 fresh/adopted storage readiness；
   - `pluginPackageStartup.ts`：只完成 install、Task、Workflow/Prompt 与 Tool snapshot 四阶段恢复和审计；
   - `startupErrors.ts`：保存稳定的 fail-closed 错误类型；
   - `activation.ts`：继续作为唯一生命周期组合根，拥有 Secret、execution、scheduler、startup recovery、
     start/stop 顺序和失败清理。
4. `bootstrapLocalApplication`、根 `package.json#exports`、`src/index.ts` 公共符号、Profile 依赖树与
   application audit 状态顺序保持不变。新模块是 package-private implementation，不增加公开 subpath。
5. Profile/Application 的生产制品继续由实际 pack/offline-install/import/RSS 门裁决。源码文件数增长本身不
   等于运行制品不可接受，但不得借拆分放宽 4–6 MiB、文件数、加载模块或 RSS 预算。
6. 后续处理巨型 schema/repository 文件时沿用相同规则：先找事务 authority 和 owning capability，再拆内部
   collaborator；不得按固定 LOC 建“一文件一包”，也不得用 `common`/`utils` 或空目录隐藏耦合。

## 被否决的方案

- **合并两个 Profile package**：基础 Edge/Standalone 会取得接管管理依赖，破坏最小闭包。
- **把 Adopted 直接并入 Application**：storage-only 接管制品会安装执行器、进程控制和 Croner。
- **每个启动阶段新建 package**：这些阶段只有一个 Application owner，既无独立部署、版本、权限，也无多个
  production consumer，只会扩大 importer、lock、SBOM 与构建成本。
- **仅设置统一 LOC 合并阈值**：无法表达 deployment、authority、transaction 和可选依赖边界。
- **只移动文件、不保留唯一组合根**：会让启动顺序、失败清理与反向 shutdown 分散到多个隐式 owner。

## 验收证据

- `activation.ts` 从 835 行降至 578 行；Application 为 12 个 source、2 个根入口、10 个嵌套实现，根文件
  hard cap 与 98 行 line ratchet 不变。
- `@qinglong/local-application` 严格 TypeScript 检查通过；完整 package test 为 42 项、39 pass/3 条件 skip。
- public root/export、workspace package 数、production dependency 与两个 Profile package 实现均未改变。
- dependency 的精确路径门首次拒绝了迁移后的新 module，随后只把既有许可从旧 `activation.ts` 精确迁到
  `pluginPackageStartup.ts`、`startupErrors.ts` 和 `storageActivation.ts`；没有目录通配或新增 specifier，
  48/48 负向门通过。package boundary、dependency、Edge import、Local image、Cluster deployment 与 image
  release 六项审计最终全部 compatible。
- 完整 19-package clean build/test 通过；沙箱外 Backend 为 1,114 项、1,112 pass/2 条件 skip/0 fail。
  workspace 为 773 source/32 root/741 nested；只有两个经过制品闭包证明的 shallow Profile package。
- 四个受影响的实际 pack/offline-install/import/RSS 制品均 compatible：Edge/Standalone Application 分别为
  4,737,805/4,737,949 bytes、431 files、109 modules；Edge/Standalone Application AI 分别为
  6,125,418/6,125,574 bytes、495 files、108 modules。最大实测 RSS delta 为 21,364,736 bytes，低于
  24 MiB Application 门。
- 刷新后 GitNexus 为 43,415 nodes/98,627 edges/1,702 clusters/272 flows；bootstrap、storage 与 Plugin
  startup helper 均为 LOW，唯一直接运行调用链仍是 Application→AI Application。`detect_changes` all/compare
  `develop` 仍为 12 files/31 symbols 与 14/34、low/0 affected process；QL3 孵化树整体尚未进入 Git baseline，
  因此该 diff 结果只作补充证据，不替代上述逐符号 impact、运行测试与制品门。
- 本批未改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，不重复生成 PostgreSQL HA 物理晋升证据。

## 后续

本批只处理 Application 内部启动内聚，不关闭 2.x adopted cutover：`application active` 仍不能证明 Legacy
writer、scheduler、executor 与外部副作用已经静默。该安全门必须由真实 deployment controller 与可验证
cutover evidence 单独完成，不能塞回 Profile bootstrap 或用同机锁冒充。
