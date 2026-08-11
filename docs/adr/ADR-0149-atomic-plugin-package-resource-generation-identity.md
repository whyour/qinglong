# ADR-0149：原子 Plugin Package Resource Generation Identity

- 状态：Accepted（lock、activation intent、本地/Kubernetes pointer 与只读 source 已实现；
  ADR-0150 已补纯领域语义 materializer 与本地/OCI byte source，ADR-0151 已补
  durable revision repository；执行发布仍未实现）
- 日期：2026-07-25
- 关联：ADR-0132 至 ADR-0143、QL-RFC-0001 D-130/D-132/D-137/D-140

## 背景

Plugin Package 已能从受审批 lock 经过 staging 原子切换为 active，但此前 active pointer
只说明哪个 package content/generation 已发布，没有给资源消费者一份可直接读取、
可恢复且与切换同时生效的资源集合。若后续 consumer 重新读取 Manifest、扫描 staging
目录或按文件逐项更新，会产生三类错误：

- 重启恢复可能看到与审批时不同的目录或 Manifest；
- upgrade 期间 Task、Workflow、Prompt、Tool 可能来自两代 package；
- 路由器需要 watcher/cache 才能维持视图，集群多副本又无法靠进程内锁形成一致事实。

另外，Manifest 路径曾允许 1024 字节，而 canonical bundle entry 只允许 255 字节，
导致一份 Manifest 可能在计划阶段通过、到归档阶段才失败。

## 决策

### 1. lock 保存受审批的资源引用快照

`PluginPackageLock` 升级为 `qinglong/plugin-package-lock@v2`。构造 lock 时从已经
规范化的 Manifest 生成最多 256 条 `{kind, path}`：

- kind 只允许 `prompt | task | tool | workflow`；
- path 必须位于对应的 `prompts/ | tasks/ | tools/ | workflows/` 下；
- path 全局唯一、按 kind/path 排序，UTF-8 最大 255 字节；
- 快照同时进入 Approved Action payload 与 lock digest。

durable recovery 因而只需要既有 lock，不需要重新取得 Manifest、打开 bundle 或扫描
目录。旧 `@v1` lock 缺少该事实，必须失败关闭；3.0 alpha 不做静默补值。

Manifest content path 上限同步前移为 255 字节，与 canonical bundle 一致，让错误在
提案和计划之前出现。

### 2. generation 是完整、受限且可验证的值

新增 runtime-core 显式 subpath
`@qinglong/runtime-core/plugin-package-resource-generation`，不新增 workspace package。
`qinglong/plugin-package-resource-generation@v1` 固定绑定：

- installation、Project、Package、lock digest；
- generation、exact previous active lock；
- content tree digest；
- lock 中的完整有序资源引用；
- domain-separated `generationDigest`。

它只包含低敏元数据，不包含资源字节、解析结果、handler、Secret 或执行 authority。
`contentDigest` 继续绑定 bundle 中的路径、字节和 entry digest；后续 materializer
仍必须通过 staging evidence 读取并验证实际字节，不能只信任路径。

### 3. activation 与 pointer 同时切换 generation

activation intent 升级为
`qinglong/plugin-package-activation-intent@v2`，完整携带 resource generation，且
intent digest 绑定 `generationDigest`。normalizer 必须逐项复验 generation 与 intent
的身份、lock、代数、previous lock 和 content digest。

本地 pointer 与 Kubernetes pointer 分别升级为：

- `qinglong/plugin-package-active-pointer@v2`；
- `qinglong/plugin-package-kubernetes-active-pointer@v2`。

因此 POSIX rename 或 ConfigMap `resourceVersion` CAS 赢得切换时，package active fact
和资源集合在同一个 pointer 中同时生效。旧 pointer 精确形状不兼容并失败关闭。

最多 256 条、每条最多 255 字节的路径会使原 32 KiB pointer 上限不充分。上限提升为
512 KiB，仍低于 Kubernetes ConfigMap 1 MiB 限制；normalizer 的条数和路径上限是首要
容量边界，publisher 不接受更宽对象。

### 4. consumer 只读 active generation，不扫描目录

新增 `PluginPackageResourceGenerationSource`：

```ts
findActiveResourceGeneration(
  projectId: string,
  packageName: string,
): Promise<PluginPackageResourceGeneration | null>
```

本地 publisher 以一次私有 pointer 文件读取实现；Kubernetes publisher 以一次
ConfigMap GET 实现。读取不重新验证全部 blob、不创建 cache、timer、watcher、socket
或数据库连接。后续语义 materializer 必须以 source 返回的 generation 作为唯一输入
身份，并在解析受信 staging 字节后一次性发布自己的不可变 revision。

本 ADR 不宣称 Task/Workflow/Prompt/Tool schema、交叉引用、冲突策略、Trigger/Tool
Registry 接入或执行装配已经完成。

## Profile 影响

- edge/standalone：只有显式安装或资源解析请求才读取一个小型 pointer；没有常驻
  generation 进程，空资源集合仍是固定小对象。
- cluster：所有副本读取同一个 ConfigMap CAS 赢家；无 informer/watch 依赖，consumer
  可在自身请求边界决定是否缓存，但缓存不能成为权威事实。
- 两种 Profile 共享同一纯领域 generation normalizer，不复制语义。

## 被否决方案

1. **新增 `resource-generation` workspace package**：没有独立部署或依赖生命周期，
   会继续把 `packages/` 拆成单文件包。
2. **激活后扫描 staging 目录**：目录不是审批事实，也不能保证跨代原子性。
3. **每个资源独立写数据库/ConfigMap**：会制造部分发布、回滚顺序和大量小对象。
4. **pointer 只保存 generation digest**：consumer 无法在不回读 Manifest 的情况下
   得到精确资源集合。
5. **在 publisher 内解析 YAML/JSON 并注册资源**：把字节发布 authority 与业务语义、
   Tool/Task authority 合并，且增加路由器峰值资源和集群失败窗口。

## 验证

- runtime-core：generation canonicalization、两种构造路径、摘要/顺序/路径/重复/256
  条上限、lock v2、intent v2 与恢复链路；
- local-admin：无 pointer 返回 null、POSIX 原子发布后读取 exact generation、upgrade
  返回新代、旧代/stage/pointer 漂移失败关闭；
- cluster-admin：无 ConfigMap 返回 null、create/replace/并发/response-loss 后读取
  CAS 赢家、metadata/data 漂移失败关闭；
- package boundary：使用 runtime-core 新 subpath，不新增 workspace importer、第三方
  依赖或常驻 authority。

## 后续

ADR-0150 已实现显式、受限的 semantic materializer：四类 JSON 文件格式、Package
内引用/权限校验、不可变 revision、POSIX staging reader 与 OCI streaming reader。
下一阶段要为 revision 增加 SQLite/PostgreSQL create/exact-replay repository，并以
active generation 为唯一选择事实接入 TaskDefinition/Tool Registry；仍不得重新发明
目录扫描或第二套 active pointer。
