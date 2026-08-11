# ADR-0266：Externally staged、resourceVersion-fenced 的 Cluster Prompt Output Active Key Rotation

- 状态：Accepted
- 日期：2026-08-03
- 关联：QL-RFC-0001 D-207/D-244/D-245/D-247、ADR-0261、ADR-0262

## 上下文

ADR-0262 已让 Cluster 使用固定 Kubernetes Secret 作为 Prompt output keyring material authority，
并以一次性 Job 完成 inactive key retirement；后续运行时同源投影也已证明同一 Pod/进程可观察
generation 更新，并继续解密历史 Artifact。尚未关闭的是首次 provision 与 active key rotation。

Kubernetes RBAC 的 `create` 不能由 `resourceNames` 限定。若 QingLong 自带 Job 创建目标 Secret，
它将取得 namespace 内创建任意同类对象的权限，超出一次 rotation 的最小 authority。另一方面，若
Job 在内存中随机生成新 key 后再替换目标 Secret，更新响应丢失时无法重新构造完全相同的 material；
盲目重试会产生另一个 key，无法判断首次写入是否已成为 durable winner。

因此，本阶段需要把 material custody、目标 Secret CAS 与 PostgreSQL 审计拆成三个明确边界：外部
部署 Secret manager/KMS 负责首次 provision 和 staged material，caller-driven Job 只消费一次不可变
投影并更新固定目标，PostgreSQL 只保存 content-free prepare/complete facts。

## 决策

### 1. 首次 provision 保持外部责任

QingLong 不内置对目标 Secret 的宽泛 `create`。首次创建
`ql3-prompt-output-keyring`、encryption-at-rest、备份、KMS wrapping/HSM custody 和 lost-key recovery
继续由部署者选择的 Secret manager/KMS ceremony 负责。首次对象必须满足 ADR-0262 的固定 identity、
canonical manifest、label/annotation 和唯一 data key 约束；rotation Job 只接受预先观察到的 UID，
不能把删除重建后的同名 Secret 当作原对象。

### 2. 新 material 由外部不可变 staging Secret 投影

每次 rotation 由外部 authority 创建固定名
`ql3-prompt-output-key-rotation-material` 的 immutable Secret，只含一个原始、恰好 32-byte 的
`material.bin`。kubelet 将该项以 `0440`、read-only、单文件 `subPath` 投影给 Job；Job 没有对 staging
Secret 的 get/list/watch/create/update/patch/delete API 权限，也不把 material 放进 command、ConfigMap、
环境变量、stdout、日志或 PostgreSQL。

命令只包含 expected target UID、active key ID、catalog digest、新 key ID 和低敏 operation identity。
material reader 使用 `O_NOFOLLOW`、regular-file、single-link、exact-size、mode 和 pre/post stat 围栏；
读取后复制到受控内存，并在完成或失败时清零。

### 3. 目标 Secret 使用三重预期与 resourceVersion CAS

rotation 必须同时匹配：

- 预观察的 Secret UID；
- expected active key ID 与完整 expected catalog digest；
- 当前读取所得 `resourceVersion`。

成功 successor 只追加唯一的新 key、把它设为 active、将 generation 加一，并保留全部旧 key 供历史
Artifact 解密。adapter 只能对固定 `ql3-prompt-output-keyring` 执行 get/update；不同 UID、active/catalog
漂移、key ID 复用、material 改写、manifest 非 canonical 或并发不同命令都失败关闭。

相同命令和相同 staged material 的重放必须得到完全相同 successor。Kubernetes update 响应丢失或连接
中断时，adapter 重新读取目标：只有 UID、generation、active key、catalog 和 material proof 都与预期
successor 一致时才返回 existing；不能以 HTTP 状态缺失直接宣告失败或盲写第二次。

### 4. PostgreSQL 采用 content-free prepare/complete protocol

在 target Secret mutation 前，专用 maintenance authority 必须追加 immutable preparation，绑定
rotation/request/mutation identity、expected UID/active/catalog、新 key ID和 staged material proof，但
不得保存 material、base64、Secret body、token、DSN 或文件路径。Secret CAS 成功后再追加 completion，
绑定 successor generation/catalog 与 preparation digest。

崩溃恢复由 durable facts 和同一 staged material 裁决：

1. 没有 preparation 时创建 preparation；
2. 有 preparation、无 completion 时重读/必要时 CAS 同一个 successor；
3. Secret 已是 exact successor 时只补 completion；
4. preparation 或 Secret 与命令/material proof 不一致时失败关闭；
5. completion 已存在时返回 exact existing，不再更新 Secret。

PostgreSQL append-only protocol、最小权限 ACL、COMMIT-response-loss convergence、physical HA
promotion survival 与真实 K3s Job 纵切面均已由下述证据关闭。CLI stdout 始终只能视为低敏操作结果，
不能冒充 durable audit。

### 5. 一次性权限与网络边界保持显式

operation 使用独立 tokenless ServiceAccount、`backoffLimit: 0`、短 deadline、只读 root、non-root、
drop ALL。只有主容器取得 600 秒 projected token；tokenless init 先证明 exact API allow 与 deny-canary
不可达。RBAC 仅允许对固定目标 Secret get/update 和创建 SelfSubjectAccessReview；staging Secret 不在
API authority 中。base NetworkPolicy 只允许 DNS，Kubernetes API 必须由私有 overlay 以 exact
`/32 + TCP port` 放行；接入 PostgreSQL 后，CloudNativePG overlay 也只能放行数据库 Pods 的 5432。

## 低配与 package 影响

- Edge/Standalone 不装配 Kubernetes client、staging Secret、Job、listener、Pool、timer 或 watcher；
- runtime Cluster Pod 仍只读同源投影，没有 ServiceAccount token、Secret API 或 mutation authority；
- 实现留在既有 `@qinglong/ai` manifest subpath、`@qinglong/cluster-admin` one-shot process 和
  `@qinglong/cluster-postgres` maintenance adapter，不新增 workspace package；
- workspace 保持 19 个 QL3 package，低配设备不会因 Cluster rotation 文件数增加 importer/SBOM 闭包；
- 每次 ceremony 最多读取一个 32-byte staged material 和一个有界 keyring Secret，无 list/watch/cache。

## 当前实现与接受门

已完成：

- shared manifest rotation：exact 32-byte、新 identity、generation+1、保留历史 key、exact replay；
- Kubernetes Secret adapter：UID/resourceVersion CAS、并发单赢家、状态缺失的 update-response-loss 重读；
- command-file-only CLI 与 hardened staged-material reader；
- 独立 Job/RBAC/ServiceAccount/NetworkPolicy、命令/material/token 三种分离挂载及 deployment mutation audit；
- `pg-9016` append-only preparation/completion、source CAS fence、content-free digest、专用 maintenance
  SELECT/INSERT-only ACL、readiness 与 COMMIT-response-loss durable re-read；
- one-shot process 的 Kubernetes authority/readiness → PostgreSQL prepare → Secret CAS → PostgreSQL
  complete 顺序，以及 prepare 后恢复、Secret update 响应丢失和 completion 响应丢失 exact convergence；
- AI 183 项中 180 pass/3 条件 skip、Cluster Admin 252 项中 250 pass/2 条件 skip，dependency/deployment
  audit 43/43、两套 Kustomize render 与构建全绿；
- 2026-08-03 PostgreSQL 18.4 arm64 physical HA 门包含本 ADR 的 rotation facts 后重跑全绿：
  `remote_apply`、timeline 1→2、一次 Secret durable write、材料 authority 两次调用、response-loss
  convergence、historical Artifact decrypt、content-free facts、promotion survival、旧主 `pg_rewind`
  只读同步重入与总 `gates.passed=true`；`ql3-ha-*` 零残留，受保护 evidence control-plane 未被操作。
- 2026-08-03 真实三节点 K3s/Flannel + CloudNativePG 1.30.0/PostgreSQL 18.4 arm64 纵切面通过：
  3/3 database Ready、52/16 migration、两次 one-shot Job 形成 completed/existing、Secret generation
  1→2 且 resourceVersion 只改变一次、preparation/completion 各一条并保持 content-free；staged material
  为 immutable Secret 的 `0440` 单文件投影，Job 对它无 API read authority；同一 tokenless runtime Pod
  观察新 active key 并用保留的旧 key 解密历史 Artifact。exact RBAC/API/PG/DNS egress、同 Pod deny
  barrier、600 秒 token 与全部 gate 为 true；随机 K3s 资源和临时镜像零残留，受保护 control-plane 未触碰。

Accepted 后仍保留的独立发布门：

1. 生产 KMS/HSM/backup/lost-key ceremony 继续作为独立发布门，不由本 ADR 的 Kubernetes Secret
   证据替代。

## 被拒绝方案

1. **Job 创建目标 Secret**：Kubernetes `create` 无法按 `resourceNames` 收紧，会扩大 namespace authority。
2. **Job 内随机生成 key**：响应丢失后无法 exact replay，可能产生两个不同 successor。
3. **把 material 放入 command/ConfigMap/PostgreSQL**：扩大日志、etcd、备份和审计泄漏面。
4. **给 Job staging Secret API read**：kubelet 投影已足够，额外 API authority 允许枚举或旁路读取。
5. **rotation 删除旧 key**：会破坏历史 Artifact decrypt；删除只属于独立、已证明零引用的 retirement。
6. **自动重试 Job/controller**：不确定结果必须由 durable facts 裁决，后台重试会掩盖冲突并扩大常驻面。
7. **为 rotation 新拆 package**：没有独立制品或依赖反转价值，只会重新引入 D-207 的碎片化。
