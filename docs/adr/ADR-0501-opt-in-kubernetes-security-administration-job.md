# ADR-0501：可选的一次性 Kubernetes Security Administration Job

- 状态：Accepted
- 日期：2026-08-25
- 决策：D-406
- 关联：ADR-0050、ADR-0129、ADR-0276、ADR-0301、ADR-0500

## 背景

ADR-0500 已提供无 listener、单命令、单数据库连接的 `ql3-security-admin` 产品入口，但 Cluster 部署者仍需自行编写 Job、Secret 投影、网络策略和 credential delivery。自行组合容易把 admin credential 放入常驻 `cluster-control`、为 Job 挂载 Kubernetes API token、直接让宽权限 Secret 文件成为命令输入，或把新签发 token 留在日志和易失卷中。

QingLong 同时服务低性能路由设备、单机和多节点集群。Cluster 运维能力不能增加 Edge/Standalone package、依赖、启动路径或常驻资源；仅共享同一 Cluster Admin 镜像与故障生命周期的输入适配器也不应拆成单文件 workspace package。

## 决策

### 1. Job 必须显式选择且一次只执行一个操作

在 `deploy/kubernetes/ql3-cluster/operations/security-administration/` 提供通用 PostgreSQL、CloudNativePG、credential delivery 和二者组合的 Kustomize 入口。它们不进入共享 `operations/kustomization.yaml`，操作者必须显式 `create`；Job 设置 `backoffLimit=0`、300 秒 deadline、600 秒完成后 TTL，不运行 listener、timer、watcher 或 sidecar。

ServiceAccount 和 Pod 都关闭自动 token 挂载，不创建 Role、RoleBinding 或 ClusterRole。Job 只有 DNS 与受审 PostgreSQL egress；CloudNativePG overlay 精确限制到 `cnpg.io/cluster=ql3-postgres` 的 TCP 5432。通用 base 默认没有任意 PostgreSQL egress，部署者必须在私有 overlay 中为实际数据库增加精确目的地。

### 2. Kubernetes Secret 不是命令的直接私有文件边界

Secret volume 必须兼容 kubelet 的版本目录与 symlink 投影，默认 `0440` 以便固定的非 root group 读取；但 ADR-0500 的命令拒绝 symlink 和 group/world 权限。因此在既有 `@qinglong/cluster-admin/security-administration` 内增加专用 init stager，而不新建 package。

stager 只接受固定的 `command.json`、`assertion.jwt`、`keyset.json` 和 `pepper-keyring.json`，分别有 64 KiB、16 KiB、256 KiB 与 2 KiB 上限。Kubernetes 路径以 D-407 keyring 为唯一 canonical 输入；旧单 pepper 只保留在通用 CLI 兼容桥，不形成第二套 Kubernetes 配置模式。stager 解析 kubelet symlink 后仍要求 realpath 留在投影 authority 内，以 `O_NOFOLLOW` 打开最终文件，复验类型、权限、大小和读前/读后 inode 状态，再清零源 Buffer。目标目录必须不存在，由 stager 创建为 `0700`；文件以 `0600`、`fsync` 和 hard-link no-replace 发布到 1 MiB memory-backed `emptyDir`。任何输入失败都清理已发布目标，主容器不会启动。

### 3. 数据库和进程权限保持最小化

两个容器固定 UID/GID/fsGroup 10001、RuntimeDefault seccomp、只读 rootfs、drop all capabilities、禁止 privilege escalation；每个容器 request 为 25m/48 MiB，limit 为 250m/128 MiB。主容器直接执行同镜像的固定 Security Administration CLI，不经 shell，也不读取 ambient kubeconfig、home 或默认 credential。

通用 base 从独立 Secret 读取 `QL3_POSTGRES_ADMIN_URL`、TLS server name 和 CA。CloudNativePG overlay 使用 `ql3-postgres-admin-auth`、`ql3-postgres-rw` 和 `ql3-postgres-ca`；runtime、migration 和其他管理角色不能代替 `ql3_admin`。应用层仍强制 `verify-full`、显式 DNS server name、一个 Pool connection 和短连接生命周期。

### 4. Credential 交付是独立 opt-in capability

Identity 变更、revoke 和 audit query 使用无 delivery 的 base。只有 `credential.issue` / `credential.rotate` 选择 credential-delivery component；它要求调用方预置受加密和访问控制的 RWO PVC。init stager 在 PVC 内创建或复验 `0700` 私有目录，主容器只向操作者指定的唯一新文件执行 ADR-0500 的 `0600` no-replace 发布。token 不进入 stdout、日志、Secret patch、API response 或易失 `emptyDir`。

固定示例文件只含占位符且不被任何 Kustomization 引入。每次 dispatch 必须使用新的 mutation ID、短期 assertion 和唯一 delivery 文件名；固定资源名使当前基线只支持受控的串行 ceremony，Job 与输入 Secret 完成后必须显式清理。并发 dispatch、自动命名和 delivery acknowledgement 属于后续产品化门禁。

## 被拒绝的替代方案

### 默认安装 Admin Deployment 或 CronJob

拒绝。它会把高权限数据库凭据、pepper 和资源成本变成常驻面，并影响不使用该能力的集群与低配设备。

### 直接把 projected Secret 交给主命令

拒绝。kubelet 的 symlink 和 group-readable 投影与 ADR-0500 的 POSIX 私有文件契约不同，放宽主命令会同时削弱工作站路径。

### 给 Job Kubernetes Secret 读写权限并写回 token

拒绝。API token/RBAC 会扩大 blast radius，更新 Secret 还引入资源版本竞争、日志/审计暴露和难以证明的响应丢失语义。

### 新建 Kubernetes Stager workspace package

拒绝。它只由同一 admin 镜像、同一 Security Administration ceremony 使用，没有独立发布、依赖、权限或故障生命周期；拆包会重新制造单文件 package。

## 验证

- stager 聚焦测试覆盖真实 kubelet symlink 布局、2 KiB keyring 边界、`0700/0600` 收紧、持久 delivery 目录复验、realpath 逃逸、world-readable material、目标不可覆盖和 CLI 无敏感回显。
- 部署审计冻结无 API token/RBAC、caller-driven/零重试/deadline/TTL、non-root/read-only/drop-all、资源上限、固定 CLI、内存私有输入、独立 admin credential、CloudNativePG egress、PVC delivery 和默认聚合不可达；失败注入覆盖权限扩大、非持久 delivery 与误入共享 aggregate。
- `kubectl kustomize` 已分别渲染 base、CloudNativePG、credential-delivery 和 CloudNativePG + delivery 四个入口。
- 18-package clean build/test 退出 0；当前 `cluster-admin` 为 456 total / 453 pass / 3 conditional skip / 0 fail，backend 为 1590 total / 1588 pass / 2 conditional skip / 0 fail。
- opt-in live gate 在本机 arm64 建立 1 control-plane + 2 worker 的 K3s `v1.34.3+k3s1`/Flannel、CloudNativePG 1.30.0 和 3 个 PostgreSQL 18.4 实例；migration 71 与 control-core capability 70 通过后，6 个串行产品 Job 完成 register、audit query、issue、exact replay、rotate 与 revoke，另一个 `0444` 输入 Job 按预期在 init 阶段失败且主容器未启动。
- live gate 证明 immutable Secret 的真实 kubelet Atomic Writer 投影、memory-backed 私有 stage、PVC 跨 Job persistence/no-replace replay、不同 rotation material、TLS 与单连接最小权限；同时实测拒绝 Kubernetes API/公网 egress、Secret read/Job mutation RBAC，并在 finally 删除 Job、Secret、证据 Job、fixture root Job、PVC、K3s 容器、网络与卷。
- 所有 Security Administration Job 继续以 UID/GID 10001 运行并使用 `fsGroupChangePolicy=OnRootMismatch`，避免后续只读证据 Pod 递归改写 `0700/0600` custody。K3s local-path 实现把新 PVC 根暴露为 `02777 root:10001`，live gate 因此先用一个专用、无网络、无 API token、drop-all 的 root fixture Job 精确收紧为 `02770`；该 fixture 例外不是产品管理 authority，也不证明生产 CSI 加密或权限模型。
- content-free 报告权限为 `0600`，独立审计结果为 `compatible=true/findings=[]`，SHA-256 为 `e5c24af77034e1a2efee062107176e218c11a9f9f0d6c8c7308fdc280b0a82cf`。可手动触发的专用 CI workflow 固定 K3s/CNPG/PostgreSQL 供应链并重复同一 ceremony。

## 影响与剩余门禁

D-406 已关闭“每个部署者都要从零编写一次性 Admin Job”及其单主机 K3s/CNPG/PVC live 缺口，且 Edge/Standalone 和默认 Cluster 常驻资源保持不变。该 gate 不代表生产 Kubernetes control-plane HA、跨主机故障隔离/STONITH、灾备恢复、加密 CSI custody 或外部 IdP 已完成；之后仍有双人复核/break-glass、pepper rotation、audit retention/export/alert、并发 dispatch 和远程管理 UI/API。
