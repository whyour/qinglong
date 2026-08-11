# ADR-0233：Cluster Secret 使用 authority-gated mounted-files provider

- 状态：Accepted
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-14、D-57、D-104、D-118、D-215、D-217
- 关联 ADR：ADR-0059、ADR-0073、ADR-0112、ADR-0119、ADR-0231

## 背景

Remote Worker Secret delivery 已经在 Attempt advisory lock 下复验 Worker
Session、Run/Attempt/Lease、generation/version/token、execution digest 和完整
SecretRef 集合，但 production process 只有注入 port，没有正式 material provider。
没有 provider 时 `/secrets` 按设计失败关闭，因此含 Secret 的 Remote Worker Task
无法运行。

把明文 Secret 放进 PostgreSQL或环境变量会扩大持久化、日志、进程快照和备份暴露
面；让 control Pod 直接访问 Kubernetes Secret API 会增加 ServiceAccount 权限和
网络故障域；把 Vault/KMS SDK 作为所有 Cluster、Standalone、Edge 的基础依赖，会
增加镜像、SBOM、credential chain、连接与小型设备成本。

Kubernetes Secret、CSI Secret Store 和 Vault Agent 都能把材料投影为只读文件，
并通过原子目录或 symlink 切换完成 rotation。Cluster 需要的是一个受限的
filesystem adapter，而不是在 v1 绑定某个外部 Secret 产品。

## 决策

### 1. provider 只在 Worker ingress 后、显式配置时加载

`QL3_WORKER_SECRET_PROVIDER` 首版只允许：

- `disabled` 或未设置：不构造 Secret service，Secret delivery 保持不可用；
- `mounted-files`：要求绝对
  `QL3_WORKER_SECRET_ROOT_DIRECTORY`，production process 动态加载 provider 并在
  Worker ingress 启动前验证 root。

Profile gate 先于这些环境变量。Edge、Standalone、Worker 及 disabled ingress
不会读取 root、加载 provider 模块或增加常驻资源。测试/embedding 可以继续经窄
`RemoteWorkerSecretValueProvider` port 注入其他 adapter。

### 2. authority 成功之后才能接触明文

调用顺序保持：

1. mTLS + Worker credential 认证；
2. PostgreSQL 在 Attempt authority 下复验 Session、Run、Attempt、dispatch lease、
   generation/version/token、execution revision/digest 和 exact SecretRef set；
3. provider 只接收去除 lease token 的 durable authority；
4. provider 读取 exact material；
5. TLS response 完成后调用 dispose。

fence、replay drift、Project/SecretRef mismatch 或 repository unavailable 时绝不调用
provider。provider 异常、缺文件、损坏或超预算统一映射为低敏 unavailable。

### 3. SecretRef 永远不成为路径

每个投影文件名固定为：

`lowercase_hex(SHA-256(canonical qlsecret:v1 SecretRef))`

文件名只含 64 个 `[0-9a-f]`，Project、name、version 不参与路径拼接。hash 是稳定
的 path-safe identifier，不被描述为加密或访问控制；部署者仍必须把 Secret
projection 视为敏感材料。

每次 resolve 都重新解析 root 和 exact candidate：

- configured root 必须是直接目录，不能是 symlink；
- candidate 的 resolved target 必须仍位于 root 下；
- 允许 Kubernetes atomic-writer 的 in-root symlink；
- resolved target 必须是单链接 regular file；
- 文件不可 executable、group writable 或 other-accessible；
- 单值最多 16 KiB、整批最多 64 KiB；
- 值必须是严格 UTF-8 且不能含 NUL。

读取期间 projection target 漂移会失败关闭，由下一次请求读取新 generation。

### 4. rotation 不建立 watcher、cache 或 Kubernetes client

provider 不缓存值、不保存 manifest、不 watch 文件系统、不启动 timer，也不访问
Kubernetes API。每次已经授权的 delivery 重新打开文件，因此 Secret/CSI/Agent
原子替换会被下一请求观察。

无 version 的 current SecretRef 可以在相同 hashed key 下 rotation；带 version 的
SecretRef 使用不同 key，部署者在所有引用和 retention 完成前保留旧文件。自动
retention/GC、rotation approval 和用户可见 inventory 是后续独立产品切片。

读取 Buffer 在 response dispose 或失败时覆盖为零。现有 wire contract 使用 JS
string，因此不能承诺垃圾回收前擦除 immutable string；v1 通过短请求生命周期、
不缓存、不记录、TLS、硬字节预算和及时 dispose 缩小暴露面，不能把它表述为硬件级
内存清除。

### 5. Kubernetes base 使用独立可选只读 Secret

base 固定：

- provider：`mounted-files`；
- root：`/var/run/secrets/qinglong3/worker-values`；
- 独立 Secret：`ql3-cluster-worker-values`；
- `optional: true`、`defaultMode: 0440`、read-only mount；
- Pod `fsGroup: 10001`；
- `automountServiceAccountToken: false`。

base 不提交业务 Secret 内容。Secret 缺失时 volume/root 为空，启动仍可服务无
Secret Run；具体 SecretRef resolve 失败关闭。TLS/Worker credential/Artifact
credential 继续使用原来分离的 Secret，不与业务值合并。

## 不采用的方案

### 将明文值保存到 PostgreSQL

拒绝。数据库角色、WAL、备份、复制、诊断和 SQL 查询面都会获得不必要的明文
custody，也破坏现有 digest/reference-only contract。

### 直接读取 Kubernetes Secret API

拒绝。control Pod 不应获得 Secret list/get/watch 权限；API client还会引入 token、
RBAC、网络、缓存和 watch 生命周期。只读 projection 已能提供所需 rotation 语义。

### 在 v1 内置 Vault/KMS SDK

拒绝作为基础闭包。部署者可以让 CSI/Vault Agent 投影文件，或后续通过同一 provider
port 增加显式可选 adapter。基础镜像不应预付特定云厂商依赖、credential chain 和
空闲连接成本。

### 使用 Project/name 作为目录层级

拒绝。即使先校验，也会让用户控制的数据参与路径、权限和运维命名，并产生 traversal、
Unicode、大小写和 Kubernetes key 兼容问题。canonical ref hash 更小且稳定。

### 把全部值放进一个 JSON manifest

拒绝。一个值 rotation 会重写整个明文集合，解析时同时把无关 Project material
加载进内存，也更难实现单值权限、大小和 retention。

## 当前验证

1. provider 定向覆盖 stable hash、atomic replacement、in-root Kubernetes
   symlink、root/target escape、权限、严格 UTF-8、缺失 root/material 和 dispose；
2. Worker config/process/Secret delivery 定向 21/21；
3. cluster-control 全量 159 项：157 pass、2 条外部服务条件 skip、0 fail；
4. deployment audit 无 findings，证明独立可选 Secret、`0440`、只读 mount、固定
   provider/root 和无 ServiceAccount token；
5. Linux arm64 Node 24.18.0 在 512 MiB、2 CPU、256 PID、零 swap、非 root、只读
   root/workspace 下通过：`memory.peak=42033152` bytes、模块加载 RSS 增量
   `24526848` bytes、零 OOM/oom_kill；
6. workspace 仍为 20 个 QL3 package，没有新增 migration、表、生产依赖、timer、
   watcher、listener、Pool、连接、sidecar 或 Kubernetes API 权限。

## 尚未关闭

1. Secret 管理 CLI/API/UI、Project Policy/Approval、rotation inventory/receipt、
   version retention/GC 和告警；
2. 直接 Vault/KMS/HSM adapter 的可选供应链、认证、rate limit 和 outage contract；
3. Worker materialization 后的 tmpfs/文件清除、Executor-specific injection 与真实
   Pod/节点回收证据；
4. Kubernetes Secret/CSI/Vault Agent live rotation、并发 delivery、raw-wire
   response loss 和多副本故障证据。
