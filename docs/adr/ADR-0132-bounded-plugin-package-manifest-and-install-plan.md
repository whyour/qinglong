# ADR-0132：有界 Plugin Package Manifest 与安装计划

- 状态：Accepted（profile-neutral Manifest normalization、环境兼容性、
  资源预算、权限差异和安装/升级/回滚计划已实现；ADR-0134 已补齐内容寻址
  PackageLock 与纯领域 durable 状态机，ADR-0135 已补签名 bundle 检查和私有本地
  staging；ADR-0136 至 ADR-0149 已补持久化、恢复、原子 generation，ADR-0150 已补
  有界语义物化，ADR-0151 已补 durable semantic revision；执行接入仍未开放）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-130

## 背景

QingLong 2.x 的订阅主要交付脚本和定时任务。它没有一个稳定边界提前说明：

- Package 支持哪些架构和部署 Profile；
- 需要哪些 runtime、内存和磁盘；
- 会访问哪些网络 host、使用哪些 Secret、请求哪些 Tool 权限；
- 会创建多少 Task、Workflow、Prompt 和 Tool；
- 升级是否新增权限，是否必须重新审批。

直接从脚本内容猜测这些事实既不可靠，也会让插件安装器拥有静默扩权空间。
另一方面，为 Manifest 再拆一个 workspace package 会让低配设备和开发依赖图为尚未
激活的插件系统支付额外成本。

## 决策

### 1. 契约留在 `@qinglong/runtime-core`

新增 `plugin-package` subpath，不新增 workspace package、数据库、migration、
timer、socket、文件或网络 authority。YAML/JSON 读取、来源下载、签名验证和
staging 都属于未来 adapter；核心只接收已经解析的普通对象。

禁用插件时不会加载该 subpath，现有 edge、standalone、cluster-control 和 worker
组合根均不改变。

### 2. Manifest 必须 exact-shape 且有硬上限

首版只接受：

- `apiVersion: qinglong.io/v1alpha1`；
- `kind: Package`；
- lowercase DNS-label Package name 与 canonical SemVer version；
- `amd64 | arm64 | arm/v7 | ppc64le | s390x`；其中 `arm/v7` 仍受 RFC
  Tier 2 实验运行时门禁约束，声明兼容不等于 ql-core 已正式支持；
- `edge | standalone | cluster-control | worker`；
- 最多 8 个 runtime、32 个 network host、64 个 Secret、64 个 Tool 权限；
- Task、Workflow、Prompt、Tool 合计最多 256 个相对路径；
- canonical JSON 不超过 64 KiB；
- 内存和磁盘只接受有界 `Ki | Mi | Gi` quantity。

未知字段、重复值、通配 host、反斜杠、绝对路径、空 path segment、`.`、`..`、
未受审架构/Profile/权限和 Package migration 均失败关闭。内容路径必须位于各自
的 `tasks/`、`workflows/`、`prompts/`、`tools/` 目录。

### 3. 安装计划不执行任何副作用

`planPluginPackageInstall` 只生成不可变计划：

- install、reinstall、upgrade 或 rollback；
- QingLong version、架构、Profile、runtime 和磁盘兼容性；
- 推荐内存不足 warning；
- install/working disk 和内容数量；
- network、Secret 与 Tool 权限的 added/removed Diff；
- `low | medium | high` 风险；
- 是否需要权限重新审批。

所有安装计划都保持 `approvalRequired: true`。磁盘不足、runtime 缺失或版本不匹配、
架构/Profile/QingLong 不兼容时 `compatible: false`。推荐内存不足只产生 warning，
因为 Manifest 当前声明的是 recommendation，不得偷偷把它解释成硬 minimum。

新安装必须审批；升级新增任一 network host、Secret 或 Tool 权限必须重新审批。
回滚删除权限可以生成计划，但仍不能绕过安装审批和后续原子激活状态机。

### 4. 风险分级不能由 Package 自报

风险由核心根据受审权限计算：

- `system.command`、`dependency.install`、`background.service` 为 high；
- network、Secret、filesystem write、模型/MCP 调用、Run mutation 和 Task update
  至少为 medium；
- 无上述 authority 的声明式只读内容可以是 low。

Package 不得在 Manifest 中自报较低风险覆盖该计算。

### 5. 本切片保持 production unreachable

本 ADR 不实现：

- PackageSource 下载、本地 bundle file capability 或目录扫描；
- 签名、publisher trust 或 archive 解包；
- staging/current symlink、durable repository adapter；
- Task/Workflow/Prompt/Tool 注册；
- Trigger 暂停、health check、激活或回滚副作用；
- Runtime Extension、UI Extension 或控制面动态 import。

ADR-0134 至 ADR-0151 已继续定义并实现 exact source、Approved Action、持久化、
恢复、active generation、纯语义 revision 与双方言 immutable revision repository，
但 Task/Tool/Workflow/Prompt 的 durable 原子发布仍未闭环。后续 ADR 必须继续把跨资源
发布事务和历史 Run 的 PackageLock 绑定闭环，不能因物化值已耐久保存就开放执行。

## 影响

- 插件安装预览首次拥有可执行、profile-neutral、低资源的安全边界。
- `packages/` 数量不增加；runtime-core 只增加一个按需 subpath。
- edge 没有新增常驻开销，Manifest 解析和规划只在显式安装请求中发生。
- 现有无 Manifest 订阅继续走 legacy adapter，且不能获得 Tool、MCP、后台服务或
  高风险权限。

## 验证

单元测试必须覆盖：

1. canonical normalization 与深冻结；
2. 未知字段、错误 kind/version；
3. traversal、通配网络、重复 Secret/runtime；
4. 未受审架构、Profile、权限和资源单位；
5. 兼容安装计划及精确资源/权限 Diff；
6. 版本、runtime、Profile、架构和磁盘不兼容；
7. upgrade 权限扩张和 rollback 权限收缩；
8. install environment exact-shape 与跨 Package upgrade 拒绝；
9. 核心实现没有 filesystem、process、network 或 timer authority。
10. 根入口与 `plugin-package` subpath 导出同一 contract；
11. Node 24 候选架构词表包含 `ppc64le` 且不接纳 legacy-only `386`。
