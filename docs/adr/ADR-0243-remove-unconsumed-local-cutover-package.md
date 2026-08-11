# ADR-0243：删除无产品消费者的 Local Cutover 孵化包

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-64、D-85、D-175、D-207、D-227
- 取代实现：ADR-0065 中未接入产品的 `@qinglong/local-cutover` 孵化代码
- 延续：ADR-0217 的 beta 删除门

> 后续 ADR-0309 没有恢复被删除的 workspace package，而是在已有短生命周期
> `ql3-local-deploy` 产品内实现首个 Docker legacy-stop slice；本 ADR 的 package 删除决策
> 继续有效。

## 背景

QingLong 3.0 的 workspace package 只能表达可验证的制品、依赖、Profile 或 authority
边界，不能把尚未接入产品的概念源码永久保留为 importer。`local-cutover` 已连续多个
里程碑保持以下状态：

- 5 个 TypeScript 文件、约 1,479 行；
- 没有 production consumer、binary、image、deployment 或 Profile artifact entry；
- 没有 workspace 或第三方 production dependency；
- 只有自己的单元测试、dependency audit 登记和 RFC/ADR 文档引用；
- 缺少 ADR-0065 要求的 legacy controller、target controller、人工恢复 ceremony 与
  可安装 supervisor artifact。

这不是“包虽小但边界合理”，而是没有产品入口的孤立孵化实现。继续保留会增加
manifest、lock importer、拓扑构建、测试、SBOM/漏洞 inventory 和维护认知成本，同时
无法帮助任何 Edge、Standalone 或 Cluster 用户完成 2.x→3.0 cutover。

## 决策

### 1. 删除整个 `local-cutover` package

删除 package manifest、源码、测试、生成物和 pnpm lock importer，不把 1,479 行源码
机械并入 `runtime-core`、`local-admin` 或 `local-application`。这些包都没有产品调用该
Supervisor；把死代码移入现有 owner 只会隐藏而不会消除无效 authority。

Workspace importer 从 20 收敛为 19，hard cap 同步收紧为 19。新增第 20 个 importer
必须重新通过 D-85 的独立部署/依赖/Profile/authority/多消费者证明，而不能把本次删除
当作预留空位。

### 2. 保留删除墓碑

Dependency audit 继续识别 `@qinglong/local-cutover` 及其 subpath，并返回稳定的
`DELETED_LOCAL_CUTOVER_PACKAGE_IMPORT`。旧名称不允许被 root dependency、现有 package
或动态 import 重新引入。删除 package 本身的例外已经移除。

### 3. 保留安全需求，不保留未交付实现

RFC D-64 中“先证明 legacy writer/外部副作用静默、start barrier 后结果未知不得盲重试、
不得自动重启 2.x”的安全要求继续有效。ADR-0065 作为设计记录保留，但其 package 实现
由本 ADR 取代，不再作为当前可用能力或完成证据。

未来重新实现 cutover 前，必须同时提供至少一项真实产品边界：

- 可安装的短生命周期 CLI/image/service artifact；
- 至少一个受审 legacy controller 和一个 QL3 target controller；
- 明确的权限、签名、SBOM、人工恢复和多架构测试矩阵；
- 一个真实部署流程中的 production consumer。

若独立制品仍有必要，可以重新评审 package；否则默认作为既有 migration/admin owner 的
内部 subpath。无论哪种方式都不能在没有产品入口时先恢复 workspace importer。

## 影响分析

删除前对 package 内全部 39 个顶层函数/类执行 GitNexus upstream impact：

- 13 个 HIGH、3 个 MEDIUM、23 个 LOW；
- 最大 26 个受影响符号；
- 所有调用者都位于 `packages/ql3-local-cutover` 内；
- 外部文件 0、production process 0。

HIGH 来自 validation/helper 在 package 内的扇出，不代表跨 Profile 产品风险。整包原子
删除能同时消除这些内部边，因此不需要迁移 caller 或兼容 facade。

## 低配与集群影响

- Edge/Standalone/Cluster 运行时行为、RSS 和第三方依赖不变，因为该包从未进入制品；
- Workspace 构建、lockfile、漏洞扫描和维护面减少一个 importer；
- `local-command-file` 继续保留：它虽为单文件，却是零依赖且有三个 production consumer
  的共享安全叶子；
- Cluster PostgreSQL/Kubernetes/S3 三包和本机安全/Profile 边界不因追求包数量而合并。

## 验证

1. `packages/ql3-local-cutover` 目录不存在；
2. pnpm lockfile 不含 `packages/ql3-local-cutover` importer；
3. dependency audit 枚举正好 19 个 QL3 package；
4. 旧 package import 的负向 fixture 返回删除墓碑；
5. dependency audit 定向测试 39/39 通过；
6. Cluster dependency、Edge import、Cluster/Worker/CloudNativePG deployment、local image
   inventory 和全包 build/test 必须继续无 finding；
7. PostgreSQL HA Docker 门必须继续通过，且容器、网络与卷零残留；
8. GitNexus `detect_changes` 不得出现 cutover 之外的非预期产品执行流。

本次实际验证中，19 个 package 的完整 build/test、dependency/Edge/deployment/image
审计和 PostgreSQL 18.4 physical HA 均退出 0，HA `gates.passed=true`，`ql3-ha` Docker
容器、网络与卷均为零残留。完整门同时发现并修复两个与删除无调用关系的旧夹具漂移：
PostgreSQL runtime role fixture 缺少两个 Worker credential management 表，以及 Local
Compose 镜像仍声明旧 SQLite contract。镜像、preflight 成功夹具和审计已同步到 v42；
Compose collected-evidence 不再固定只接受 v40，而是在不扩大 storage authority 的前提下
由三个已授权调用方显式传入当前上限，接受历史 `40..42`、拒绝未知未来版本。

`audit:profiles:ql3` 本轮没有取得成功证据：受限环境无法获得 advisory，提升权限又因会
向外部 registry 发送生产依赖图和私有 package 元数据而被安全策略拒绝。未绕过该限制，
因此本文不宣称 vulnerability gate 已通过；它仍需在受信 CI/registry 环境执行。

删除不表示 2.x→3.0 cutover 已解决。它表示 3.0 不再把一个不可安装、不可调用的源码目录
误报为产品能力；正式 cutover 仍需新的、带真实部署证据的 RFC/ADR 切片。
