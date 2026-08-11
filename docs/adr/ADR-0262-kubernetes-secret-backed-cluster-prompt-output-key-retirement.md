# ADR-0262：Kubernetes Secret-backed Cluster Prompt 输出 Key Retirement

- 状态：Accepted
- 日期：2026-08-02
- 接受日期：2026-08-03
- 关联：QL-RFC-0001 D-207/D-244/D-245、ADR-0233、ADR-0261

## 上下文

ADR-0261 已实现 Prompt output Artifact 的双方言加密、retention GC 和两阶段 key
retirement，但 Cluster 只留下可注入的 material authority。把本机 POSIX file-keyring
直接放到共享卷会失去多副本 CAS、对象 identity 和 Kubernetes 权限边界；反过来，立即把某个
云厂商 KMS SDK、Vault client 或 HSM driver 放进常驻 control plane，又会把凭据、重依赖和网络
故障域扩散到每个 Cluster Pod。

本阶段需要一个可部署、可审计且不冒充最终 KMS/HSM 的中间实现：使用部署者专有、可变的
Kubernetes `Opaque` Secret 保存 canonical keyring manifest，只让一次性 maintenance Job 对
该单个对象执行退役 CAS。Secret 的首次创建、active rotation、外部加密/备份和运行时装配仍是
部署产品责任，不能由 migration 或 control plane 隐式生成。

## 决策

### 1. Secret 是单对象 material authority，不是数据库副本

Cluster retirement adapter 固定 namespace、Secret name、预先观察到的 Secret UID 和唯一 data key。
它只接受：

- `type: Opaque`、`immutable: false`；
- 恰好一个 data entry，内容是 ADR-0261 的 canonical bounded keyring manifest；
- 固定 managed label，以及与 manifest 一致的 generation/catalog-digest annotations；
- 非删除状态、相同 UID、合法 `resourceVersion`，且没有 `stringData` 或会复制密钥正文的
  last-applied annotation。

adapter 只调用 `readNamespacedSecret` 和 `replaceNamespacedSecret`。退役在内存中删除 inactive key
material、保留 content-free retirement receipt，再用当前 `resourceVersion` 做 CAS replace。409、响应
丢失和并发相同命令必须重读：只有 exact retirement 已成为 durable winner 才返回成功；UID 重建、
active key、proof/catalog 漂移或不同命令竞争全部失败关闭。禁止 list/watch/create/delete/patch、缓存、
timer 和后台 controller。

### 2. 数据库事实与 Secret CAS 由一次性 CLI 编排

既有 Cluster retirement process 继续先使用 `ql3_ai_maintenance` 在 PostgreSQL 中提交 preparation，
然后调用 material authority，最后追加 completion。新 `ql3-prompt-output-key-retire` 只接受绝对路径
command file，命令 exact 绑定 schema、operation、namespace、Secret name、expected UID、data key 和
key/retirement/request/mutation identity。stdout 只允许低敏状态和 digest，不返回 Secret、key、DSN、
token 或文件路径。

CLI 通过 in-cluster `KubeConfig` 创建官方 Kubernetes client，并在任何 material 读取前执行完整
`SelfSubjectAccessReview` 矩阵：必须允许对 exact Secret 的 get/update，同时明确拒绝 list/watch/
create/delete/patch、其他 Secret、ConfigMap 和 Pod。审查不一致时不打开 PostgreSQL retirement
authority。CLI 退出时清除 KubeConfig 中保留的 token/context 引用。

### 3. 部署保持 opt-in、短生命周期和默认断网

operation 使用独立 ServiceAccount、精确 `resourceNames` Role、SelfSubjectAccessReview-only
ClusterRole、`backoffLimit: 0`、300 秒 deadline、只读 root、非 root UID/GID 10001、全部 capability
drop 和 128 MiB memory limit。命令 ConfigMap immutable，作为单个 `subPath` 文件只读挂载，避免
Kubernetes atomic-writer symlink 与 CLI `O_NOFOLLOW` 冲突。

ServiceAccount 与 Pod 均关闭自动 token。无 volume mount 的同 Pod init container 必须先同时证明
Kubernetes API 可达、一个已由独立无策略 control Job 证明可达的 deny-canary 不可达，才允许主容器
启动；只有主容器挂载显式 projected ServiceAccount token/CA/namespace，token 有效期固定 600 秒。
这关闭了新 Pod 创建时 CNI policy 尚未收敛、自动 token 已提前可读的窗口。

base NetworkPolicy 只允许集群 DNS；CloudNativePG overlay 再只加入 exact PostgreSQL Pods 的 TCP
5432。Kubernetes API server 地址与端口依部署而异，因此仓库只提交 `/32 + TCP port` JSON patch
模板，不提供 `0.0.0.0/0`、namespace-wide 或默认可用的 API egress。部署者必须在私有 overlay 中
填入实际 control-plane endpoint。该 operation 不进入默认 `operations/kustomization.yaml`，每次命令
由 operator 显式创建，完成后不自动重试或轮询。

### 4. 不把 Secret adapter 宣称为最终 KMS/HSM

Kubernetes Secret 只关闭“Cluster 可执行 retirement CAS”这一层。要成为完整生产 material plane，
运行时 Prompt application 必须从同一个 Secret 的只读投影或同一外部 authority 获取 active/history
key；首次 provision、active rotation、备份/恢复、encryption-at-rest、KMS wrapping/HSM non-exportable
语义、lost-key 演练和审计告警必须另行交付。当前常驻 cluster-control 不获得 Secret API token，
retirement Job 也不获得 create/delete 或任意 Secret 权限。

## 低配与 Cluster 影响

- Edge/Standalone 继续使用 POSIX file-keyring，零新增依赖、进程、连接或 timer；
- workspace 保持 19 个 QL3 package；实现位于既有 `@qinglong/ai` manifest subpath 和
  `@qinglong/cluster-admin` adapter/CLI subpath；
- `@kubernetes/client-node` 只在既有 Cluster Admin image/一次性 Job 中加载，control runtime 和本机
  Profile 闭包不增加该依赖；
- 每次退役最多读取/替换一个不超过 256 KiB 的 Secret，最多 16 个 key、64 个 retirement receipt，
  无 list/watch 和随集群规模增长的内存集合。

## 验证

- Kubernetes Secret adapter 3/3：正常退役/exact replay、响应丢失与并发 exact convergence、active/
  UID 重建/非 canonical authority 拒绝；
- CLI/process 定向 3/3，并验证命令行只接受 command-file、widened shape 和 secret-bearing failure
  失败关闭；
- Cluster Admin 整包 206 项中 204 通过、2 项外部集成条件跳过；
- Cluster deployment audit 39/39，包含 RBAC 扩权、去除单文件 `subPath`、公共 egress 三项 mutation；
- base 与 CloudNativePG Kustomize 均可渲染，dependency/deployment audit 均
  `findings=[]`、`compatible=true`；
- PostgreSQL 18.4 arm64 physical HA 重新完成 `remote_apply`、timeline 1→2、旧主 fencing、
  `pg_rewind` 只读同步重入、双 fresh control，Prompt output key retirement 的 durable/fenced gate 与
  总 `gates.passed=true`，`ql3-ha-*` 容器、volume、network 零残留。
- 2026-08-03 的显式 opt-in 实机门使用 3 个 privileged K3s Docker 节点、Flannel、CloudNativePG
  1.30.0 与 PostgreSQL 18.4 arm64，3/3 database instance Ready，核心/AI migration 为 52/15。
  两次真实 Job 分别由持久状态判定为 `completed`/`existing`：Secret identity 保持不变、generation
  1→2、inactive key 删除、active key 保留、`resourceVersion` 只改变一次，preparation/completion
  各 1 条。exact RBAC、同 Pod allow+deny 网络屏障、init 无 token、主容器 600 秒 projected token、
  TLS 与 content-free report 全部通过，`gates.passed=true`；随机 Docker/K3s 资源零残留，既有
  `ql3-cnpg-evidence-control-plane` 未被操作。

该实机门使用 dynamic local-path volume 和单 control-plane，deny-canary 是集群内确定性 fixture；它
不等同于生产 CSI/基础设施/control-plane HA。Kubernetes Secret `resourceVersion` CAS 也不等同于
KMS wrapping、HSM non-exportability 或外部 key custody。运行时同源读取、首次 provision/active
rotation、外部 KMS/HSM、备份恢复与 lost-key recovery 仍是后续独立发布门，但不再阻止本 ADR 的
“真实 Kubernetes 一次性 Secret retirement CAS”边界被接受。

## 2026-08-03 后续证据修正

本 ADR 接受后，运行时同源读取已由独立、默认关闭的 `cluster-ai-prompt-output` Component 闭环。
它只把同一个 `ql3-prompt-output-keyring/keyring.json` 以 required、`0440`、read-only Secret volume
投影给既有 Cluster AI projected-keyring adapter；默认 Cluster/`cluster-ai` 仍为 live-only，Pod 无
ServiceAccount token、RBAC 或 Secret mutation authority。三节点 K3s v1.34.3 arm64 实跑已证明同一
Pod/进程观察 generation 1→2、真实 atomic-writer symlink、新 active key 生效和历史 encrypted
Artifact 解密；轮换窗口竞态失败关闭，稳定新代可重新读取。首次 provision/active rotation 的受审
管理面、KMS/HSM、备份恢复与 lost-key recovery 仍为后续发布门。本节只修正后续实现状态，不改写
本 ADR 当时接受的 retirement 边界。

## 被拒绝方案

1. **Cluster 复用 POSIX 共享卷 keyring**：没有对象 UID/resourceVersion CAS，节点与权限边界错误。
2. **control plane 直接取得 Secret update**：把短生命周期 destructive authority 提升为常驻网络面。
3. **Role 允许 create/delete/list/watch/patch**：退役只需 exact get/update，其他 verb 均扩大 blast radius。
4. **Job 自动重试或常驻 controller**：不确定响应必须由 durable facts 裁决，盲重试会掩盖冲突。
5. **提交公共 API egress**：Kubernetes API endpoint 是部署事实，仓库不能以公网/全网规则代替。
6. **把 Kubernetes Secret 称作 KMS/HSM**：缺少 wrapping、non-exportable key、外部审计和灾难恢复语义。
