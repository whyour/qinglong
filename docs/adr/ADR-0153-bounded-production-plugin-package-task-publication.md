# ADR-0153：有界的生产 Plugin Package Task 发布与启动恢复

- 状态：Accepted（共享协调器、本机 application gate、Cluster package-executor Job、
  双方言 pending source 与真实 PostgreSQL/HA 门已实现；receipt 级
  COMMIT-response-loss、Tool/Workflow/Prompt consumer 尚未实现）
- 日期：2026-07-26
- 关联：ADR-0138 至 ADR-0140、ADR-0149 至 ADR-0152、
  QL-RFC-0001 D-144 至 D-147

## 背景

ADR-0152 已经保证一代 Package Task 在数据库内原子发布，但没有决定谁在生产入口中
连接 active generation、source bytes、immutable materialized revision 和
reconciliation repository。仅有 adapter 会留下四个产品缺口：

- 安装已 active、Task receipt 尚未提交时，应用可能提前开放 scheduler/executor；
- 每次重启若重新读取 staging/OCI，会把已经耐久化的 revision 又退化成外部可用性依赖；
- generation 在物化或提交期间切换时，旧 receipt 可能被误报为当前；
- 无界扫描、后台 watcher 或常驻缓存会把低性能路由设备的启动和空载预算变成未知量。

Cluster 还必须保持 management 与 execution authority 分离：公开管理 Pod 不能因为
Task 发布取得 Registry credential、Kubernetes write RBAC 或 package-executor 数据库
角色。

## 决策

### 1. 不新增 workspace package

共享发布与恢复协议放在既有
`@qinglong/runtime-core/plugin-package-task-publication` 显式 subpath。pending adapter
分别留在 `local-sqlite` 和 `cluster-postgres/package-executor`；本机组合进入
`local-application`，Cluster 组合进入 `cluster-admin` 已有的一次性 recovery process。

该能力没有独立版本、部署或供应链生命周期，因此不得拆出只有少量文件的新 importer。
本切片不新增第三方依赖、schema、连接池、timer、watcher、socket 或常驻缓存；
`packages/` 仍为 21 个 importer。

### 2. 每次发布都以 active generation 为围栏

`PluginPackageTaskPublicationCoordinator.publishActive(Project, Package)` 固定执行：

1. 读取当前 active resource generation；不存在则返回 `absent`；
2. 按 `generationDigest` 查 immutable materialized revision；
3. revision 已存在时直接复用，禁止再次读取 staging/OCI；
4. revision 不存在时，以当前 generation、完整 lock 和受限 byte source 执行一次
   materialization，再 create/exact-replay 发布 revision；
5. 调用 generation-bound Task reconciliation repository；
6. 再次读取 active generation。

最终 generation 仍完全相同时才返回 `current`。已经切换或消失时返回
`superseded`，不得把旧 receipt 当作当前 admission 事实。损坏输入与确定性冲突进入
人工处理；外部存储、OCI、Kubernetes 或数据库不可用只进入有界重试。

### 3. pending source 只暴露缺 receipt 的当前 active Package

SQLite/PostgreSQL repository 实现相同的稳定 keyset page：

- 只选择当前 active install；
- 以 Project、Package、generation、lock 精确左连接 reconciliation receipt；
- 只返回缺少当前 receipt 的候选；
- 按 `Project + Package` 唯一排序，读取 `limit + 1` 生成 continuation；
- 单页最大 64，最多 64 页。

恢复默认使用 8 项 × 8 页并逐项处理；Cluster 已有 Job 配置当前默认使用 16 × 16，
但同样受 64 × 64 硬上限约束。每轮结束必须从游标起点额外 probe 1 项，捕获扫描期间
新出现或被 generation 切换重新暴露的 pending work。只要还有 pending、retry 或
manual-required，`safeToAdmit=false`。

### 4. 本机 application 在 Secret 与执行栈之前失败关闭

edge/standalone 启动顺序固定为：

1. storage ready；
2. 既有 Plugin Package install/activation recovery；
3. Plugin Package Task publication recovery；
4. Secret keyring、Run recovery、scheduler/execution lifecycle；
5. application admission。

本机复用同一个 SQLite operation authority、同一个 activation publisher 和既有私有
staging byte source。相关 adapter 保持 lazy import：无 pending Package 时不打开
staging resource session，不引入扫描器或后台线程。默认最多观察 64 个候选，适合低配
路由设备；需要更大批次的 standalone 可显式提高预算，但不能越过硬上限。

### 5. Cluster 复用一次性 package-executor recovery Job

Cluster 不创建常驻 publisher，也不把能力装入 `cluster-control` 或公开 management
host。已有 package recovery Job 在同一个最多 1 连接的 package-executor Pool 中：

1. 通过 package-executor schema/role readiness；
2. 完成 install/activation recovery；
3. 复用同一个 Kubernetes generation publisher；
4. 复用同一个 allowlisted、签名校验的 OCI authority，并只在 revision 缺失时创建
   caller-owned resource byte reader；
5. 使用 executor-only materialized/reconciliation repository 完成 Task 发布；
6. 关闭数据库和短生命周期 authority 后退出。

注入非 OCI stage authority 的测试或特殊部署必须同时显式注入 resource byte source，
不能隐式取得 ambient 文件、网络或 credential authority。完成事件同时输出安装恢复和
Task 发布恢复的低敏汇总。

### 6. 本 ADR 只开放 Task 发布闭环

这次接入不等于 Package 的所有资源都可执行：

- Tool 仍只有 Definition，没有 immutable global handler snapshot；
- Workflow/Prompt 仍只有 materialized definition，没有版本仓库和执行 consumer；
- Secret binding ceremony 仍未建立；
- receipt/history/ownership retention 仍禁止删除。

因此 production startup 只以 Task reconciliation receipt 作为 Task admission gate，
不能由 materialized revision 的存在推导其他资源已激活。

## Profile 影响

- **edge**：默认 8 × 8、单 SQLite authority、逐项恢复、无后台线程；revision exact
  replay 不再读取 staging，空队列只执行有界数据库 probe。
- **standalone**：与 edge 使用同一实现，可显式提高恢复预算，不改变事务和资源上限。
- **cluster**：默认 caller-driven Job 16 × 16、单连接 Pool；多 Job 竞争由 generation
  fence、数据库锁和 exact replay 收敛，可按队列规模水平调度 Job 而不扩大单进程预算。
- **worker**：不导入 coordinator、OCI authority 或 reconciliation repository。

## 被否决方案

1. **为 coordinator/recovery 新建 package**：没有独立生命周期，只会增加单文件包。
2. **由 activation publisher 顺手物化并发布 Task**：合并 Kubernetes/文件发布与业务
   repository authority，且难以精确恢复 response loss。
3. **每次启动都重读 staging/OCI**：让耐久 revision 失去意义，并把重启可用性绑定到
   Registry。
4. **目录 watcher、数据库 LISTEN 或常驻 reconciliation loop**：增加低配设备空载
   内存、fd、timer 和不可预测 wakeup；当前 caller-driven startup/Job 足够收敛。
5. **扫描全部历史 install**：工作量随历史无限增长；pending 必须只来自当前 active
   generation 且缺 receipt 的集合。
6. **冲突后继续 admission**：会让 scheduler 看见与 active Package 不一致的 Task
   generation；冲突只能人工处理并失败关闭。

## 验证

- runtime-core：265 pass，覆盖首次物化/发布/reconciliation、revision exact replay
  不读 source、末次 generation 切换、有界 final probe、manual/retry 分类；
- local-sqlite：86 pass，覆盖 pending→receipt→empty、两代原子发布、回滚与旁路拒绝；
- local-application：14 pass，证明 Task 发布 gate 位于 Secret 和执行 lifecycle 之前，
  不安全结果释放 storage 且不开放 admission；
- cluster-admin：98 pass、0 fail、1 条真实 Kubernetes 条件 skip，覆盖双恢复空队列、
  package-executor readiness、进程配置和 authority subpath；
- PostgreSQL package：146 pass、0 fail、1 条真库条件 skip；
- PostgreSQL 18.4 arm64 真库：34 pass、0 fail、1 条分角色环境 skip，两代
  reconciliation、pending 查询与 manager/executor 精确 ACL 通过；
- PostgreSQL 18.4 physical HA：24 个具体 gate 与总 `passed` 全为 true，覆盖
  `remote_apply`、timeline 1→2、旧主先 fencing、`pg_rewind` 只读重入及晋升前后
  package authority readiness。

HA 门证明 schema、ACL 和组合依赖可跨 promotion 保持 ready，但尚未在
Task reconciliation receipt 的 COMMIT response-loss 窗口注入故障；不能把通用
transaction 或其他领域 receipt 的证据外推到本协议。

## 后续

1. 给本机与 Cluster 增加“真实 active Package 启动后 Task 可调度”的产品级 vertical
   test，并覆盖 generation 在 final probe 前切换；
2. 把 reconciliation receipt 纳入 HA COMMIT-response-loss durable inspection；
3. 设计 immutable Tool handler generation snapshot；
4. 设计 Workflow/Prompt version repository 与 caller-driven activation；
5. 建立显式 Secret binding approval ceremony；
6. 在完整引用图和 retention policy 前继续禁止删除 Package ownership、receipt 和历史
   revision。
