# ADR-0261：显式加密的 Durable Plugin Package Prompt 输出 Artifact

- 状态：Proposed
- 日期：2026-08-02
- 关联：QL-RFC-0001 D-207/D-243/D-244、ADR-0026、ADR-0027、ADR-0159、
  ADR-0160、ADR-0260、ADR-0262

## 上下文

ADR-0260 默认只向首次 live caller 返回模型正文。Prompt plan、RunEvent、ModelInvocation、
admission/finalization receipt 和数据库镜像列全部 content-free；exact replay 不再次调用
provider，也不承诺找回正文。这个默认值适合低配路由设备，但 UI、MCP 或长时间任务有时需要在
调用断线、进程重启或 Cluster 主库晋升后继续读取结果。

现有 Artifact 不能直接改名复用：Tool Invocation Artifact 是 input/preview 双对象和审批
start barrier；Remote Worker Artifact 是日志流、对象存储 promotion 与 Worker ACK；LocalProcess
Artifact 又依赖本地文件、range 与 truncation fact。Prompt 输出需要保存完整、最多 1 MiB 的
`GenerateResult`，并在 provider exactly-once 窗口修复 ModelInvocation completion。三者的原子性、
授权和 GC authority 均不同。

## 决策

### 1. 默认仍为 live-only，durable 必须显式 opt-in

Prompt execution plan 后续只允许 `live_only` 或带精确 retention policy revision/digest 的
`durable_artifact`。默认 `live_only` 不解析 key provider、不构造 Artifact repository、不执行
Artifact find/put/read，也不增加数据库行、文件、对象存储请求或后台状态。

当前 plan contract 已加入上述显式 output intent。为保持 alpha 孵化期间已经落盘的 receipt 可重放，
旧 plan 缺少 `output` 字段时按 `live_only` 解释，但计算旧 plan digest 时仍保持字段缺失；新建 plan
始终写入显式 `output`。这是一条仅用于既有 alpha 数据的 digest compatibility 规则，不允许新调用方
省略 output intent。

同一 request ID 的 output mode 和 retention digest 必须进入 immutable plan digest。live-only
完成后不能通过 retry 补取 durable output；durable request 也不能降级成 live-only exact replay。
调用方若改变模式或 policy，得到稳定 conflict，而不是隐式复用旧费用或正文。

### 2. Envelope、Reference 与端口留在现有 AI package

共享 contract 位于
`@qinglong/ai/plugin-package-prompt-output-artifact`，不新增 workspace package。首个 v1 已实现：

- `qinglong/plugin-package-prompt-output-artifact@v1` AES-256-GCM envelope；
- Project/Run/StepRun/ModelInvocation/User、provider/model、content digest、output bytes、key ID、
  retention revision/digest/eligible time全部进入 AAD 和 Artifact digest；
- Artifact ID 由 ModelInvocation ID 的 domain-separated SHA-256 确定性派生；
- ciphertext 打开后必须重新规范化 `GenerateResult`，复验 provider/model、UTF-8 output bytes 与
  content digest；
- content-free reference 只含 opaque identity、digest、bytes、key 与 retention metadata；
- immutable `put/find` repository、key provider 与 read authorizer ports；
- 明文沿用 Model Gateway 的 1 MiB 上限，完整 JSON envelope 硬限 1.5 MiB；retention 只允许
  1 小时至 365 天。

Edge/Standalone adapter 已留在既有 `@qinglong/ai` SQLite storage subpath，Cluster adapter
已留在既有 AI PostgreSQL storage subpath。它们共享 protocol/test contract，但不共享连接或部署
实现。单个领域文件、repository 或 migration 不构成新 package；只有未来出现独立对象存储重依赖、
进程/权限域或可替换部署单元时才重新评审边界。

### 3. Artifact 必须先于成功 Completion，并由同一事务绑定

不能在 `gateway.generate()` 已写成功 Completion 并返回后再保存 Artifact：进程可能在两者之间
退出，exact replay 会正确阻止 provider，却永远失去正文。

durable 路径必须把以下事实放进同一个方言事务：

1. 读取并复验 ModelInvocation start、Prompt plan output intent 与 Project policy fence；
2. 以 active key 构造确定性 Artifact，执行 immutable put/exact replay；
3. 让 ModelInvocation completion 的 output reference 指向 Artifact reference digest；
4. 写 usage/quota/pricing settlement、StepRun completion 与 RunEvent；
5. commit 后才向 live caller返回正文和 reference。

SQLite 使用现有单 operation authority 的短 `BEGIN IMMEDIATE`；PostgreSQL 使用现有 AI schema
的短 `SERIALIZABLE` transaction。v1 不把最多 1 MiB 的密文转移到 Worker 本地文件或 S3，因为
那会在数据库 completion 与对象 promotion 之间引入第二个事务域。若未来 Cluster 改用对象存储，
必须先增加 durable staged→bound→published bridge、响应丢失裁决和 orphan GC，不能只替换 URI。

### 4. exact replay、恢复和错误语义

- completion + matching Artifact：返回 content-free receipt/reference；只有再次通过 read policy、
  key resolution 和 retention 状态后才可打开正文，provider 调用数保持不变；
- Artifact + incomplete completion：同事务复验 Artifact 后补 completion，再 finalization；绝不调
  provider；
- start 已存在但 Artifact/completion 都缺失：沿用 in-progress/outcome-unknown，不能假定 provider
  未执行；
- completion 声称 durable 但 Artifact 缺失、digest/key/identity 漂移：corrupt/unavailable，不能
  回退 live-only 或再次调用 provider；
- 同 Artifact ID 不同规范化内容：conflict；相同内容：exact replay。

该顺序把 crash window 收敛为“全回滚”或“Artifact 与 completion 同时 durable”。SIGKILL fixture
必须覆盖加密前、Artifact insert 后、completion/settlement/StepRun/Event 后和 COMMIT response loss；
物理断电仍需独立设备证据，不能由进程 crash 冒充。

### 5. 读取授权、Retention 与 GC 是独立 authority

执行 runtime 只有 insert/select，不取得 delete 或任意跨 Project read。产品读取只接受
subject + Project + Run + opaque Artifact identity，不接受 key、路径、URI 或 ciphertext；固定顺序为
metadata identity → `artifact.read` Project Policy → retention/tombstone → key resolve/decrypt。deny、
require-approval 与 not-found 对非可信 transport 默认屏蔽存在性。

Artifact 保存创建时 policy revision/digest 和 eligible time，但这不是自行删除授权。GC 由显式、
短生命周期 maintenance authority 执行 bounded keyset page：重新验证 retention policy、终态
Prompt/Run，并在同一写事务中先写 content-free immutable tombstone、再按精确 Artifact digest 删除
密文。v1 不增加读取租约：repository 单次读取取得完整 immutable row，授权、retention inspection 与
解密只处理该次调用已持有的内存副本；GC 若在 retention inspection 后提交，不得使已经开始的读取在
同一进程内凭空失效。读取在 inspection 前观察到 tombstone 则只返回 `retained`，不会重算正文。
这条线性化规则避免为每次读增加写事务、租约表、续租 timer 与 WAL。

Edge 不增加 timer；由 Owner CLI 或现有单 maintenance cadence 显式触发。Cluster 使用独立
`ql3_ai_maintenance` 短生命周期 role/Job，不把 DELETE 授给 control runtime。GC 对每个候选重新读取
精确 row、终态与 policy revision/digest，使用方言内互斥并把 tombstone+DELETE 原子提交；崩溃只能
留下“密文仍在”或“tombstone 已在且密文已删”两种状态，不能先删后丢失 retained 证据。

key rotation 允许新写使用 active key、旧读按 key ID resolve。key retirement 现固定为“不改写
immutable Artifact”的两阶段协议：先把旧 key 切为 inactive，再以方言内事务追加 preparation fence、
在同一 key advisory/SQLite write authority 下证明 live ciphertext 为零，外部删除 key material 后追加
completion；崩溃后由 preparation、material absence 与确定性 absence proof 恢复。共享 coordinator、双方言
repository/migration 与 PostgreSQL HA 已实现。Edge/Standalone 已有私有 POSIX file-keyring material
authority：限定当前 UID、目录私有、文件 `0600`、非 symlink、有界 generation/key/retirement，并以
CAS + atomic rename + directory fsync 完成 rotation/retirement；同一 preparation 的删除响应丢失可由
持久 absence proof 精确恢复。既有 `ql3-owner-gc` 已提供一次性 `owner.prompt-output-key.retire` 命令；
Cluster Admin 的注入式 one-shot retirement process 已由 ADR-0262 接入固定 UID/resourceVersion 的
Kubernetes Secret material authority、command-file-only CLI 与 opt-in Job/RBAC/NetworkPolicy。这个
adapter 只关闭 Kubernetes Secret 上的单对象 retirement CAS，不等同于 KMS/HSM；运行时同源读取已由
独立只读投影组件闭环，首次 provision/active rotation 管理面、外部 wrapping/non-exportable key、
遗失 key 人工恢复仍须闭环。read
service、双方言 GC adapter 与 storage authority 已实现；Local Owner
maintenance 命令使用 private durable command file 携带最多 128 条 Project+revision+digest 绑定的
策略目录，每次只执行一个 bounded page。Cluster 使用同一目录协议和独立 maintenance role 的显式
one-shot Job；GC 完成仍不能等同于所有部署的 key 生命周期已经完成。

## 低配与 Cluster 影响

- live-only 路径的目标增量是 0 Artifact I/O、0 常驻资源、0 package；
- durable 单请求最多额外持有一个 bounded result JSON、ciphertext 和数据库事务；128/256 MiB
  arm64 门现以 512 KiB 输出分别运行 Edge DELETE/FULL 与 Standalone WAL/FULL 产品纵切面，并硬校验
  peak RSS、SQLite logical/allocated growth 与 WAL 写放大；
- SQLite 写入大 envelope 只对明确 opt-in 请求发生，不能成为默认日志策略；
- PostgreSQL 密文会进入 WAL/HA replica，因此需要独立 9009/9010/9011 migration、ACL、角色与 timeline
  promotion/rewind 门。`pg-9009-ai-plugin-package-prompt-output-artifacts` 和
  `pg-9010-ai-plugin-package-prompt-output-tombstones`、
  `pg-9011-ai-plugin-package-prompt-output-key-retirements` 已在 PostgreSQL 18.4 arm64
  physical-streaming HA 门完成 `remote_apply`、timeline 1→2、旧主 fencing/rewind、fresh control
  replicas、GC 后 exact replay 与 promotion 后 schema/ACL 复验；用户现有 evidence control-plane
  容器未被修改。

## 当前实现与接受门

当前已完成以下显式 opt-in 的写入闭环：

- 共享 envelope/reference/key/read-authorizer contract，以及加密 round-trip、content-free reference、
  tamper fail-closed 和 retention/key budget 四项定向测试；
- plan 的显式 `live_only|durable_artifact` intent、retention digest binding 与旧 alpha plan digest
  compatibility；
- SQLite `9010-ai-plugin-package-prompt-output-artifacts` 与 PostgreSQL
  `pg-9009-ai-plugin-package-prompt-output-artifacts` migration；
- 两方言 immutable put/find/exact-replay repository。repository 会复验 admission plan、
  Project/Run/StepRun/Invocation/requester/provider/model 和 retention mirror，live-only plan 在 insert 前
  fail closed；
- SQLite `BEGIN IMMEDIATE` 与 PostgreSQL `SERIALIZABLE` repository 已把 Artifact、
  ModelInvocation completion/usage/quota/pricing settlement、StepRun/Event output reference 放入同一
  方言事务；已有 Artifact 可修复缺失 completion，已有 completion 但 Artifact 缺失或漂移会失败关闭；
- Model Gateway 只在部署组合显式提供同一个 successful-completion capability 时启用 durable hook；
  Prompt executor 会做 capability identity handshake，缺少任一 key/repository/hook 时都在
  admission/provider 前失败关闭；
- Local application 与 Cluster Prompt application 均只在显式注入 `promptOutputKeys` 后装配该能力；
  live-only 路径不读取 active key，也不增加第二个 provider registry、连接、timer、watcher 或 package；
- Cluster Prompt route 已以 exact body 开放 `live_only|durable_artifact`，严格校验 1 小时至 365 天的
  retention policy，并只返回 content-free Artifact reference；
- PostgreSQL runtime 仅有 artifact table `SELECT/INSERT`，无 `UPDATE/DELETE`，其余管理/执行/Worker
  roles 无权访问；该边界已通过 physical-streaming HA promotion/rewind；
- Local/Cluster 产品读取 service 已固定执行 metadata identity → Project Policy → retention/tombstone
  → key/decrypt，使用 opaque Artifact identity、屏蔽 forbidden/not-found，并对响应施加硬上限；
- SQLite tombstone migration 与 PostgreSQL `pg-9010` 均只保存 identity/digest/policy/删除时间等
  content-free 事实；双方言 GC 都是 caller-driven bounded page，逐项复验终态与 policy 漂移，并在
  同一事务内先插入 tombstone、再删除精确密文；
- PostgreSQL 新增非继承、短连接的 `ql3_ai_maintenance` 角色。runtime 只能读 tombstone，maintenance
  只能读取裁决所需事实、插入 tombstone 和删除 Artifact，不能取得 runtime/admin authority；
- key retirement preparation/completion 是 content-free append-only 事实；SQLite Artifact insert 与
  preparation 共用 `BEGIN IMMEDIATE`，PostgreSQL 两条路径共用 key-scoped advisory transaction lock，
  因而 preparation 一旦提交，迟到/重放的旧 key Artifact 就不能重新落库；completion 仍会复验 live
  ciphertext 为零，且精确重放保留首次时间戳；
- `@qinglong/ai/plugin-package-prompt-output-file-keyring` 实现 Edge/Standalone 的 bounded 私有文件
  material authority；active key 不可退役，inactive material 的 catalog/material proof 必须与 durable
  preparation 完全一致，删除后保存 content-free preparation、retired catalog digest 与确定性 absence
  proof。死进程 lock 可回收，不增加 timer、watcher、daemon 或 workspace package；
- 既有 `ql3-owner-gc` 新增 `owner.prompt-output.collect`，只从 mode 0600 private command file 读取
  bounded digest-bound policy catalog，一次执行一页并只输出 scanned/tombstoned/skipped/hasMore；
  非该命令分支不加载 AI 模块，未新增 package、daemon、timer 或 watcher；
- 同一个 `ql3-owner-gc` 又新增 `owner.prompt-output-key.retire`，命令文件只携带 key/retirement/request/
  mutation identity，返回只含状态、identity、prepare/complete digest 与数据库时间；真实 SQLite feature、
  file-keyring 删除和 exact replay 已贯通。Cluster Admin 的
  `prompt-output-key-retirement-process` 使用 `ql3_ai_maintenance` 短连接、启动时复验 retirement 表的
  append-only ACL，并只接受显式注入的 material authority；它不把 Kubernetes Secret 删除伪装为 KMS
  一致性，也不让常驻 control plane 获得该权限；
- `@qinglong/cluster-admin/prompt-output-kubernetes-secret-keyring` 只对固定 namespace/name/UID/data key
  的 mutable Opaque Secret 执行 get/update `resourceVersion` CAS；拒绝 list/watch/create/delete/patch、
  Secret 重建、active key、last-applied material 副本和 annotation/manifest 漂移。响应丢失与并发相同
  retirement 通过 winner 重读收敛；
- `ql3-prompt-output-key-retire` 在 material 读取前用 SelfSubjectAccessReview 证明 exact Secret
  get/update 且扩权矩阵被拒绝，再打开 `ql3_ai_maintenance` 短连接。对应 opt-in Job 为
  `backoffLimit=0`、非 root、只读根、128 MiB；Role 只绑定单 Secret，base 默认仅 DNS egress，
  CloudNativePG overlay 仅再放行数据库 5432，Kubernetes API `/32 + port` 必须由部署私有 overlay 提供；
- `cluster-ai-prompt-output` Kustomize Component 现在把同一个
  `ql3-prompt-output-keyring/keyring.json` 以 required、单文件、`0440`、read-only volume 装配到既有
  Cluster AI runtime，并只注入已有 projected-keyring adapter 的两个环境变量。默认 Cluster 和默认
  `cluster-ai` 仍保持 live-only；该组件不创建 Secret、不挂载 ServiceAccount token、不授予 RBAC，也不
  新增 package、进程、listener、watcher 或 timer；
- 三节点 K3s v1.34.3/Flannel arm64 实跑已证明真实 Kubernetes atomic-writer symlink、Secret generation
  1→2 与 revision 变化会被同一 Pod/同一进程重新打开。新 active key 生效后，历史 key 仍能解开轮换前
  创建的真实 encrypted Artifact；运行时无 Kubernetes 凭据，投影仍为 exact `keyring.json`/`0440`/
  read-only。轮换窗口中真实命中的中间代竞态返回
  `PLUGIN_PACKAGE_PROMPT_OUTPUT_PROJECTED_KEYRING_UNAVAILABLE`，没有读取混合代数据；正式门允许该
  fail-closed 操作重试后再验证稳定新代；
- 既有 Cluster Admin image 增加同协议的 `ql3-prompt-output-gc` 一次性 CLI；Kubernetes Job
  `backoffLimit=0`、无 API token、只读 root、128 MiB limit，NetworkPolicy 只允许 DNS 与
  CloudNativePG 5432，policy ConfigMap immutable 且故意不进入默认 Kustomization；
- SQLite 故障注入已证明 Artifact insert 之后、usage ledger 之前失败会整事务回滚，Run/StepRun 不会
  冒充成功；recovery 将已调用 provider 但无终态的 invocation 收敛为 `outcome_unknown`；
- PostgreSQL 18.4 arm64 HA 门已用真实 durable Prompt execution 证明 GC 前 Artifact 为 1、GC 后为 0
  且 tombstone 为 1，StepRun output reference 与 Artifact ID 一致，GC 后 exact replay 仍不再次调用
  provider；随后旧 key preparation/material deletion/completion 精确重放、迟到密文拒绝、同步复制和
  promotion 后逐字段一致也已通过。Prompt/输出明文不进入 durable JSON；原子 Artifact、
  tombstone-before-delete、GC 后 replay、key retirement durable fence、maintenance least-privilege
  专用 gate 与总 `gates.passed` 均为 true。
- Node 24.18.0 arm64 的 128 MiB/0.5 CPU/64 PID 压力门和 256 MiB/1 CPU/128 PID release 门均在
  零 swap、非 root、只读 root/workspace、seccomp、NoNewPrivs 下通过，且零 max/OOM。512 KiB
  durable output 的 Edge DELETE/FULL process peak RSS 为 103,616,512/104,517,632 bytes，SQLite
  logical/allocated 写放大均为 1.383×；Standalone WAL/FULL peak 为
  102,330,368/97,800,192 bytes，logical/allocated/WAL 写放大为 2.185×/2.188×/2.185×。
  两档都同时证明 provider 两次（live 与 durable 各一次）、各自 exact replay 零重调、live-only 零
  key load、durable key load/resolve 各一次、零 RunAttempt 与 durable bytes 无明文；门禁会对任一证据
  漂移失败关闭。这是 tmpfs/cgroup CI 写入放大，不是物理闪存 FTL 或最低配置承诺。

AI suite 当前为 142 项、139 通过、3 项仅因未提供外部 PostgreSQL 环境而条件跳过；Local
application 为 42 项、39 通过、3 项平台条件跳过，Local Owner maintenance 为 13/13；Cluster
control 为 172 项、170 通过、2 项外部服务条件跳过，Cluster Admin 为 206 项、204 通过、2 项
外部服务条件跳过；Cluster PostgreSQL 为 272 项、271 通过、1 项真库条件跳过。本切片的 package
closure/dependency/SBOM/deployment/DR 组合门禁为 75/75，独立依赖审计为 `compatible: true`。
workspace 仍为 19 个 QL3 package（pnpm 输出的 20 个 workspace project 包含根项目），没有为本
能力新增 package。

接受前必须完成：

1. [x] output intent 已进入 plan digest、双方言 admission mirror 与 Cluster route strict body；
2. [ ] SQLite 同事务 Artifact + completion、exact replay、事务中段失败回滚与 20 点外层
   SIGKILL phase matrix 已完成；仍需物理断电证据；
3. [x] PostgreSQL migration、最小 ACL、同事务产品 repository、exact replay 与
   physical-streaming HA promotion/rewind；
4. [x] Local/Cluster 已显式注入 key/repository/completion capability，disabled/live-only 零加载；
   产品读取组合已接入 read authorizer、存在性屏蔽与 bounded response；
5. [x] read service、双方言 retention tombstone/GC storage authority、PostgreSQL 最小权限角色、
   digest-bound policy catalog、Local Owner maintenance CLI 与 Cluster one-shot Job；
6. [x] 128/256 MiB arm64 durable-output resource/write-amplification gate；
7. [ ] key retirement 的共享状态机、双方言 durable fence/repository、POSIX file-keyring authority、
   Local Owner 产品命令、Cluster Kubernetes Secret adapter/CLI/Job 与 PostgreSQL HA 已完成；仍需
   首次 provision/active rotation 的受审管理面、具体 KMS/HSM backend 与遗失 key 人工恢复。Cluster
   运行时同源 read-only projection、同进程 active rotation/historical decrypt 和 retirement 的真实
   Kubernetes API 纵切面均已完成；
8. [ ] 固定物理 Edge 存储/闪存写放大与断电证据。

## 被拒绝方案

1. **新建 `ql3-prompt-artifact` package**：没有独立部署或重依赖价值，违反 D-207。
2. **复用 Tool Invocation 双 Artifact 表**：input/preview、审批和 action identity 均不相容。
3. **复用 Worker S3 log store**：会引入第二事务域和 cluster-only SDK，扩大 Edge closure。
4. **Gateway 返回后异步保存**：completion→Artifact crash window会永久丢正文。
5. **把正文写入 completion/finalization receipt**：扩大热表、审计、备份和 HA 泄漏面。
6. **exact replay 再调 provider**：重复计费且破坏 exactly-once。
7. **runtime 自带删除 timer/DELETE**：混淆执行与数据生命周期 authority，增加低配稳态成本。
