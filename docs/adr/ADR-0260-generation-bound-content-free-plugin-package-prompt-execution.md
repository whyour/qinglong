# ADR-0260：Generation-bound、Content-free 的 Plugin Package Prompt 执行

- 状态：Proposed
- 日期：2026-08-02
- 关联：D-144、D-157、D-161、D-207、D-211、D-212、D-243

## 背景

Plugin Package 已经能够把 Prompt 文件物化为 generation-bound 语义资源，并通过
automation publication 发布 exact active definition。但“定义已发布”不等于“可以安全
调用模型”。如果执行端临时读取 current head、直接渲染后调用 provider，会出现以下问题：

- Package 在渲染、admission 和 provider I/O 之间发生升级、disable、quarantine 或
  publisher revocation，导致一次请求混合两代事实；
- provider 已产生费用，但 Run、StepRun、quota 或 audit 尚未提交；
- COMMIT 已成功但响应丢失时，重试再次调用 provider；
- 为了方便回放，把 template、参数或模型正文复制到数据库、日志、备份和 HA 副本；
- 把 Prompt 伪装成 Task 或单步 Workflow，引入错误的执行 authority，或让路由设备承担
  frontier、Attempt、timer、watcher 等不必要常驻成本；
- 为协议、SQLite adapter、PostgreSQL adapter 分别新增 workspace package，继续放大
  importer、构建、SBOM 和发布边界。

QingLong 同时面向小型路由设备和多节点集群，因此该能力必须满足两端同一语义：低配设备
按请求付费且禁用时零加载；集群在并发、响应丢失和数据库主从切换下仍可围栏和对账。

## 决策

### 1. Prompt 是显式 model execution

Plugin Package Prompt 不是 Task、Workflow、Trigger 或 scheduler。每次调用创建：

- 一个父 `Run`，从 admission 起为 `running`；
- 一个 `StepRun.kind=model`，从 `ready` 经唯一 ModelInvocation 链进入终态；
- 一个 content-free admission receipt；
- 一个由 ModelInvocation Completion 或 Resolution 支撑的 finalization receipt。

不创建 RunAttempt、child Run、Workflow frontier、后台 cadence 或 per-Prompt worker。

### 2. 执行计划不可变且不含内容

执行前从 exact `PluginPackageAutomationPublication` 生成最多 32 KiB 的 immutable plan。
plan 必须绑定：

- Project、Package、installation、lock；
- generation、generation digest、materialized revision digest；
- publication digest、Prompt ID、Prompt definition digest；
- request、invocation、Run、StepRun、trace、发起 Subject 与 Project Policy fence；
- provider、model、max output tokens、temperature、deadline；
- parameter digest、model request digest 和 input bytes。

plan、receipt、RunEvent 和数据库索引列不得包含 template、参数值、渲染后的 message 或模型
输出正文。

### 3. 内容只做一次瞬态 exact rendering

Prompt template 与参数只在调用栈内存中渲染：

- required 参数缺失失败关闭；
- optional 参数缺失表示省略，不等于显式空字符串；
- 参数值不会再次递归解释其中的 placeholder；
- 不接受未声明参数；
- 单参数值与单 message 均受 64 KiB 上限；
- 生成后的输入字节、token 和 deadline 继续受 Model Gateway 硬预算约束。

渲染结果仅交给本次 Gateway 调用，admission repository 永远看不到正文。

### 4. Admission 必须先于 provider I/O

首次 admission 在单个存储事务中完成：

1. 先检查相同 request ID 的 durable receipt；
2. 对新请求复验 exact active publication；
3. 在同一事务内复验发起 Subject 的 current Project/RoleBinding fence；
4. 复验 current install/lock、lifecycle、quarantine、publisher start guard；
5. 复验 exact materialized revision 中恰好存在一个同 digest Prompt；
6. 原子写入 Run、admission event、model StepRun、StepRun mutation 和 admission receipt。

任何 guard、identity、digest、外键或计数冲突都整体回滚。exact replay 必须先于 current
guard，使已提交 winner 在 Package 后续 disable、withdraw 或 upgrade 后仍能收敛。

### 5. ModelInvocation 是唯一 provider fence

Prompt executor 不直接持久化 provider 状态，也不建立第二套 invocation 状态机。所有
provider I/O 必须经过 D-157 的 ModelInvocation：

- `ready→running`、Run/Event/Mutation 和 ModelInvocationStart 原子提交；
- quota reservation、price quote、usage 和 completion 沿用既有 Gateway policy；
- `running→succeeded|failed|timed_out|lost` 由唯一 StepRun mutation chain 决定；
- durable start 已存在但 completion 缺失时禁止 provider replay；
- completion 为 `outcome_unknown` 且没有人工 Resolution 时保持不可判定；
- Resolution 为 retry 时父 Prompt Run 保持运行，cancel/fail 才能终态化。

### 6. 父 Run 从终态证据收敛

finalization repository 在一个事务中读取 exact admission、Run/StepRun 与
ModelInvocation Completion/Resolution：

- Completion `succeeded|failed|timed_out` 直接决定父 Run 状态；
- `outcome_unknown` 只接受绑定同一 completion digest 的终态 Resolution；
- Run version 与 event sequence 必须保持相等并 CAS 增加一次；
- final RunEvent 只保存 evidence digest、final StepRun digest、plan digest 和低敏状态；
- finalization receipt 与 Run/Event/StepRun/evidence 必须可双向复验。

### 7. Replay 不承诺返回模型正文

首次 live 调用可以把 `GenerateResult` 返回当前 caller。exact replay 返回 admission 与
finalization receipts，但 `result` 为 `null`，绝不再次调用 provider。

如果产品需要跨请求读取输出，必须后续引入显式、受保留期与加密策略约束的 Artifact sink，
并只在 ModelInvocation completion 中保存 bounded output ref/hash/bytes。不得把正文补进
Prompt admission/finalization 表。

### 8. 双方言与权限边界

SQLite：

- AI feature 未 active 时不加载 Prompt executor、不建新进程或连接；
- 与 Local ModelInvocation 共享同一 operation authority；
- admission/finalization 使用短 `BEGIN IMMEDIATE`；
- 两张 Prompt 表属于可选 `ModelInvocation*` schema allowlist，不污染主 schema readiness；
- 停用 AI 时既有 exact replay 可读，但新 mutation 受 feature fence。

PostgreSQL：

- 使用独立 `ql3_ai` migration stream 的 9007/9008；
- `model_invocation_prompt_admissions` 和
  `model_invocation_prompt_finalizations` 为 append-only；
- `ql3_runtime` 只有 `SELECT, INSERT`，没有 `UPDATE, DELETE`；
- AI schema 提供 Prompt 专属 `SECURITY DEFINER`
  `plugin_package_prompt_admission_snapshot`，不借用名称错误的 Workflow 入口；
- snapshot 复用核心 `plugin_package_automation_start_allowed`，并锁定 publication 与
  materialized revision；它同时按 Subject type/ID、Project version 与最新 RoleBinding
  version 复核 API admission 的 immutable policy fence；
- mutation 使用带 5 秒 statement、2 秒 lock timeout 的短 SERIALIZABLE transaction，
  对 serialization/deadlock 最多重试三次。

### 9. Package 与部署边界

实现全部留在既有 `@qinglong/ai` package 的显式 subpath：

- `plugin-package-prompt-execution`；
- `plugin-package-prompt-executor`；
- `local-plugin-package-prompt-admission-storage`；
- `postgres-plugin-package-prompt-admission-storage`；
- `postgres-plugin-package-prompt-application`。

这些是同一可选 AI capability 的协议和 adapter，不满足独立部署、进程、权限域或重依赖
隔离价值，因此不得新增 workspace package。

Edge/Standalone 通过 Local application 在 AI active 后动态装配。Cluster 通过显式、默认
关闭的 PostgreSQL application composition 装配；disabled 分支不得打开 Pool、执行 readiness
或加载 provider，active 分支必须按“只读 migration/ACL readiness → bounded recovery → provider
credential load”顺序启动。该 composition 不增加进程、listener、端口或 workspace package。
Cluster Control 只在显式注入 `promptExecution` capability 时增加
`POST /api/v3/projects/{projectId}/packages/{packageName}/prompts/{promptId}/executions`；
默认 allowlist 仍只有 Run read/cancel。该 route 复用现有 bearer authentication、认证前
rate shield、Project Policy、durable security audit、TLS/body/response/in-flight/request
timeout，并使用独立 `model.invoke` permission。客户端只能提交 publication digest，不能
提交 publication JSON；服务端从受限 snapshot 解析 exact publication，随后 admission
事务再次复核 publication 与 policy fence。route 不新增进程、listener、端口、依赖或包。

## 已实现证据

- immutable Prompt plan、非递归 rendering、digest/size/identity normalizer；
- SQLite admission/finalization repository 与 Local AI lazy composition；
- PostgreSQL 9007/9008、Prompt 专属 snapshot 与 SERIALIZABLE repository；
- Prompt executor 的 first execution、safe resume、completion repair 与 exact replay；
- SQLite 真库覆盖原子 admission、publication withdrawal 后 replay、target drift rollback、
  parent Run finalization、provider exactly-once 与内容排除；
- 原生 Linux arm64 Node 24.18.0 的 `router-stress-ci`（128 MiB、0 swap、0.5 CPU）与
  `edge-release-ci`（256 MiB、0 swap、1 CPU）已直接运行 Local AI active product vertical：
  正式 install/materialize/publication → Prompt execute → `succeeded@v5` → exact replay，
  provider 恰好一次、零 RunAttempt、durable SQLite 不含私有输入/输出。两档 Prompt process
  peak RSS 分别为 `92282880`/`90951680` bytes，数据库 logical/allocated growth 均为 `0`，
  cgroup `memory.peak` 分别为 `128229376`/`129253376` bytes，零 max/OOM；
- 同一两档门已纳入 ModelInvocation start/completion 的 7 点/profile、14 场景
  `SIGKILL → reopen → exact replay` 矩阵；Prompt admission/finalization 外层事务再覆盖
  10 点/profile、20 场景，其中 16 个 COMMIT 前 crash 全回滚、4 个 COMMIT 后 crash durable，
  exact replay/content-free/integrity/foreign key 全绿并报告
  `promptAdmissionFinalizationCrashProven=true`。所有 CI 证据仍固定
  `physicalPowerLossProven=false`，不把进程崩溃或 tmpfs 文件增长冒充闪存写放大或真实断电；
- crash fixture 通过 `@qinglong/ai` 的 test-only workspace devDependency 使用正式
  `@qinglong/local-sqlite` baseline migration 与 Package repositories；AI production
  dependencies 仍只有 `@qinglong/runtime-core`，没有新增 importer、生产依赖或部署闭包；
- AI suite 共 115 项：112 pass、3 个无 URL 条件 skip、0 fail；新增覆盖 Prompt 外层事务
  20 点 crash matrix、Cluster disabled
  零加载、exact migration/ACL readiness、先 recovery 后 provider、幂等资源释放与 readiness
  失败不开 provider；
- runtime-core 430/430 通过，`model.invoke` 仅 owner/admin/operator 可直接使用，viewer
  拒绝，agent 保持 `require_approval`；Cluster Control 167 项为 165 pass、2 个外部服务
  条件 skip、0 fail，覆盖 strict body、subject/fence 传递、request abort、低敏错误、live
  result 与 content-free replay receipt，以及未注入时 route 不存在；
- 独立 PostgreSQL 18 真库使用 migration、package-executor、runtime 三个非特权账号，完成
  Cluster application readiness、Package install/materialize/publish、Prompt execute、
  ModelInvocation completion、父 Run finalization 与 replay；provider 调用一次，Run 收敛到
  `succeeded@v5`，durable JSON 不含私有参数和模型输出；
- PostgreSQL 18.4 arm64 physical-streaming HA 门在最新 9008 checksum 上
  `gates.passed=true`：9001—9008 history/ACL、runtime 只读 migration history、Prompt
  admission/finalization、provider exactly-once、content-free durable facts 在晋升前复制并在
  timeline 1→2 后完全一致；旧主先 fencing，再经 `pg_rewind` 以只读同步 standby 重加入，
  新 product service 从数据库解析 publication，RoleBinding 撤销后旧 policy fence 被拒绝且
  provider 调用数保持一次；`gates.passed=true`，临时容器/网络/卷零残留，用户现有
  evidence control-plane 未被触碰；
- 通用三节点 K3s/CloudNativePG 1.30/PostgreSQL 18.4 HA 门继续全绿，覆盖 TLS 1.3、
  identity/certificate rotation、failover/outage recovery、CNI/RBAC 与 durable facts。

## 接受门与非目标

本 ADR 保持 Proposed，直到以下门完成：

1. [x] 在 PostgreSQL physical streaming timeline promotion、旧主 fencing、rewind/rejoin
   后，独立证明 9007/9008 migration、ACL、admission/finalization receipt 完全一致；
2. [x] Cluster application 显式装配 Prompt executor，且不存在 repository 可用即等于
   route 上线的隐式行为；
3. [x] 产品 API transport 完成受认证 Principal、Project Policy、`model.invoke`、rate/body/
   timeout budget、request abort 和低敏错误映射；agent 自动化仍必须先通过 approval 产品链；
4. [x] API 入口明确区分 live result 与 content-free receipt replay；UI/MCP 可复用该 API，
   但不作为本 ADR 接受前提；
5. [ ] durable output 已由 ADR-0261 单独冻结 envelope、transaction、authorization、retention
   与 GC 边界；双方言原子 adapter、产品读取和 maintenance authority 完成前保持不可达；
6. [x] 在固定 128/256 MiB 原生 Linux CI envelope 中补充 active application、RSS、SQLite
   logical/allocated growth、exact replay、内容排除、ModelInvocation 与 Prompt admission/
   finalization 外层事务 SIGKILL/reopen 矩阵；disabled 零数据库/provider 加载继续由组合测试
   证明；
7. [ ] 在固定物理低配路由设备上采集最终 application artifact 的 active RSS、真实数据盘/
   闪存写放大与受控断电重启矩阵。CI 报告必须保持
   `physicalPowerLossProven=false`，完成前不得形成最低支持声明。

以下不属于本 ADR：

- Prompt 定时执行或 Workflow 内嵌 Prompt；
- Agent、多模型编排、Tool calling 或向量检索；
- Secret 自动插值；
- provider 自动重试；
- Prompt/输出正文默认采集；
- 新 workspace package、daemon、watcher、listener 或 per-Prompt timer。

## 被拒绝方案

1. **把 Prompt 包装成单步 Workflow**：引入不需要的 frontier、Attempt、cancellation 与
   recovery ownership，放大路由设备成本。
2. **把 Prompt 当普通 Task**：绕过 Model Gateway policy、quota、price、usage 与唯一
   model StepRun fence。
3. **provider I/O 后补 Run**：数据库故障时产生无 durable owner 的外部费用和结果。
4. **exact replay 自动再调 provider**：COMMIT response loss 或 caller retry 会重复计费。
5. **持久化 template、参数和输出**：扩大 Secret、个人数据、日志、备份和 HA 副本泄漏面。
6. **复用 Workflow snapshot 函数**：实现可行但 authority 名称错误，会把 Prompt 生命周期
   隐式耦合到 Workflow admission；因此改为 AI schema 内 Prompt 专属入口。
7. **为每个 adapter 拆 package**：没有独立部署或依赖价值，违反 D-207 并增加供应链成本。
