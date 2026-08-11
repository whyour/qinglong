# ADR-0150：有界 Plugin Package 语义物化

- 状态：Accepted（纯领域物化、POSIX staging reader 与 Cluster OCI reader 已实现；
  ADR-0151 已实现 SQLite/PostgreSQL immutable revision repository；Task 批量发布与
  全局 Tool snapshot 尚未实现）
- 日期：2026-07-25
- 关联：ADR-0091、ADR-0132 至 ADR-0135、ADR-0149、QL-RFC-0001
  D-90/D-130/D-131/D-133/D-144

## 背景

ADR-0149 已经让本地 pointer rename 与 Kubernetes ConfigMap CAS 原子发布一份
`PluginPackageResourceGeneration`。它能回答“哪个 Package 的哪一代、哪些路径当前
生效”，但不能回答：

- 每个路径采用什么格式；
- Task、Workflow、Prompt、Tool 如何规范化；
- Package 内引用和已审批权限如何复验；
- staging/OCI 的实际字节怎样与 generation content tree 对账；
- 路由设备如何避免扫描、watcher 和一次读入 64 MiB bundle；
- Cluster 多副本怎样得到相同的不可变语义，而不是各自动态注册。

若 consumer 直接把 JSON/YAML 交给 Task repository 或 Tool registry，它会在资源之间
产生部分发布；若由 pointer publisher 顺便解析，又会把字节发布、业务语义和执行
authority 合并。

## 决策

### 1. 语义契约继续留在 runtime-core subpath

新增
`@qinglong/runtime-core/plugin-package-resource-materialization`，不新增 workspace
package、第三方依赖、数据库、timer、watcher、socket 或动态 import。它只接收：

- ADR-0149 的 active generation；
- 与 generation 精确匹配的完整 `PluginPackageLock@v2`；
- lock 摘要绑定的 canonical `package.json`；
- 一次 caller-owned byte session 顺序读取的 exact resource bytes；
- 受信 composition root 提供的不可变 TaskSpec semantic registry。

物化前后各观察一次 active generation；中途发生 upgrade、disable 或 pointer 漂移时
失败关闭。读取 session 必须显式 `open → read → close`，实现不得在 close 后保留
authoritative cache、watcher 或 timer。

### 2. v1 资源只接受严格 UTF-8 JSON

四类文件必须位于 Manifest/generation 已锁定的路径，文件名以 `.json` 结尾，每个最大
1 MiB，全部业务资源合计最大 8 MiB：

- `qinglong/plugin-package-task-resource@v1`；
- `qinglong/plugin-package-workflow-resource@v1`；
- `qinglong/plugin-package-prompt-resource@v1`；
- `qinglong/plugin-package-tool-resource@v1`。

JSON 只负责作者输入；物化结果按核心规范化，不要求作者手工排序 object key。输入必须
是严格 UTF-8、exact shape、无未知字段。每项保存实际 source bytes 和 SHA-256，全部
entry 再按 path 重算 ADR-0135 content tree，必须与 generation/lock 一致。

### 3. Task v1 只开放既有 command 语义

Task 资源提供 package-local id、name、description、labels、enabled、kind 与 spec。
核心生成稳定 `pkg:{packageName}:{id}` Task identity，并通过 ADR-0091 的同一
`TaskSpecSemanticRegistry` 规范化。

首版只接受 `kind=command` 与 `qinglong/command@v1`，且 Manifest 必须已审批
`system.command`。Package Secret requirement 目前只有声明，没有 Project SecretRef
绑定 ceremony；因此含 secret environment 的 Package Task 必须失败关闭，不能把
bundle 中写死的 SecretRef 当作已审批绑定。

物化层只输出 `PluginPackageTaskDefinitionDraft`。它不逐项调用
`appendTaskDefinitionRevision`，因为当前单项 Repository 无法证明一代 Package 的
多 Task 原子可见。

### 4. Workflow 与 Prompt 是可审计定义，不冒充执行引擎

Workflow v1 最多 128 个 step。step id 唯一，`needs` 必须引用同 Workflow step，
图必须无环；`task` 只能引用同一 Package generation 中存在的 Task id。首版不允许
跨 Package、current/latest、任意 Tool/Prompt 动态引用。

Prompt v1 只提供 text template 和最多 64 个参数；template 最大 512 KiB，声明参数
与 `{{name}}` placeholder 必须 exact 一致。它不选择模型、不读取 Secret、不调用
Tool，也不声称已经存在 Prompt executor。

### 5. Tool 只形成 Definition，不注入 handler

Tool 文件包裹 ADR-0133 的 exact `ToolDefinition`：

- name 必须以 `{packageName}.` 命名空间开头；
- Package 内 identity 不得重复；
- required Project permission 只允许映射到 Manifest 已审批的
  artifact/run/secret/task 权限；
- 一代 Package 最多 128 个 Tool，继续服从全局 immutable registry 上限。

物化层输出 `ToolDefinition` 供后续受信 composition 使用，不接受 handler、execute、
module path 或 runtime register。Definition 存在不等于 Tool 可执行。

### 6. revision 自包含且不成为第二个 active pointer

`qinglong/plugin-package-materialized-revision@v1` 完整保存：

- active generation；
- immutable lock；
- canonical Manifest 与 Manifest digest；
- 与 generation 一一对应的 source bytes/digest 和规范化资源；
- domain-separated `revisionDigest`。

normalizer 重验 generation↔lock、Manifest↔lock、Manifest↔resource references、
source descriptors↔content tree、Package 引用、权限和 revision digest。revision 以
`generationDigest` 为 immutable key；未来 repository 只允许 create/exact replay。
consumer 仍先读 active generation，再找同 generation 的 revision，不引入第二个
“current”指针。

本 ADR 定义 repository port；ADR-0151 已在后续实现 SQLite/PostgreSQL durable
store。跨 Package 全局 Tool snapshot 与 Task/Workflow/Prompt 发布事务仍未完成。

### 7. 两种 Profile 使用不同 byte adapter、共享同一语义

本地 `@qinglong/local-admin/package-resource-materialization`：

- 一次打开 owner-only 0700 staging generation；
- 一次解析最大 64 KiB receipt；
- 验证目录 device/inode、0600 no-follow blob、exact inventory、bytes/digest；
- 每个 path 最多读取一次，close 后丢弃 session 元数据。

Cluster 复用
`@qinglong/cluster-admin/plugin-package-oci-stage` 的 allowlisted HTTPS、exact registry
credential、Manifest/config/referrer signature 与 canonical bundle inspector。同一
OCI layer 只流式取得一次，sink 最多保留 8 MiB 目标资源，并在 reader close 时清理
未消费 Buffer。它不把 resource reader 接入常驻 `cluster-control`。

## Profile 影响

- edge/standalone：只有显式物化请求才打开 staging；没有目录扫描、后台线程或新
  数据库连接。8 MiB 是单次业务资源输入硬上限，不是常驻保留目标。
- cluster：每次短生命周期 admin materialization 重新验证 digest-pinned OCI source；
  多副本可以竞争未来 immutable revision create，但不能覆盖 active pointer 或注入
  进程内动态 registry。
- worker：不导入管理 byte adapter；未来只消费已发布、与 execution revision 绑定的
  结果。

## 被否决方案

1. **为 materializer 新增 workspace package**：没有独立部署、权限或依赖生命周期，
   会继续把 `packages/` 拆碎。
2. **按路径逐项注册 Task/Tool**：中途失败会让同一 generation 部分生效。
3. **在 active pointer 中嵌入解析结果**：会突破 ConfigMap/路由器 pointer 预算，并让
   pointer publisher 获得业务语义 authority。
4. **运行时扫描 staging 或 watch ConfigMap**：扫描不是审批事实，watcher 又制造常驻
   资源和 stale cache。
5. **Package 自带 JS handler 或 dynamic import**：Definition 会变成控制面代码注入。
6. **现在发明 SecretRef 模板替换**：没有安装绑定审批、rotation 与审计 ceremony，
   会把字符串替换误写成安全 Secret authority。

## 验证

- runtime-core：四种 schema、Task command registry、Prompt parameter、Workflow DAG/
  引用、Tool namespace/permission、source/content/revision digest、strict UTF-8、
  active generation 双观察与 root/subpath 隔离；
- local-admin：真实 0700/0600 stage、单 session exact read、重复/越界、blob tamper、
  unknown inventory 和 close；
- cluster-admin：同一受信 OCI inspector 的资源 capture、lock source、exact read、
  digest/allowlist/credential 既有负向回归；
- ADR-0151：SQLite/PostgreSQL create/exact replay、损坏数据 fail-closed、双方言
  schema/readiness/ACL、真实 PostgreSQL 18.4 与 physical HA；
- architecture：workspace importer 仍为 21，不新增第三方依赖或常驻 Profile root。

## 后续

ADR-0151 已实现以 `generationDigest` 为键的 SQLite/PostgreSQL immutable revision
repository 与 create/exact-replay contract。下一阶段分别设计：

1. Package TaskDefinition 多资源原子 reconciliation；
2. 全部 active generation 的 immutable Tool registry snapshot；
3. Workflow/Prompt 独立版本仓库和执行器；
4. Package Secret requirement 到 Project SecretRef 的强认证、可审计绑定 ceremony。

在这些 Gate 完成前，物化结果可验证但仍不进入生产执行路径。
