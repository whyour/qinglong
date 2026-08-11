# QingLong 3.0 Cluster Automation Management

该 operation 是 Cluster Task/Trigger 的人类管理入口，不适用于 Edge/Standalone。路由器继续使用
短生命周期 `ql3-task` 与 `ql3-trigger`，不会因此增加 HTTPS listener、证书或 PostgreSQL Pool。

## 部署前置

1. 完成 PostgreSQL capability v53、54 条 control-core migration 与 readiness；
2. 从 `deploy/kubernetes/ql3-cluster/operations/automation-management/config.example.yaml`
   创建私有 TLS、客户端 CA/CRL 与 public identity keyset Secret；
3. 把 Pod template 的 CA/CRL digest sentinel 换成精确 bundle SHA-256；
4. 在私有 overlay 中把 Admin image 的全零 digest 换成已验证 release digest；
5. CloudNativePG 已创建 `ql3-postgres-automation-manager-auth` 与 `ql3-postgres-ca`。

```bash
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/automation-management/cloudnative-pg \
  >/dev/null
kubectl apply -k \
  deploy/kubernetes/ql3-cluster/operations/automation-management/cloudnative-pg
kubectl -n qinglong3-system rollout status \
  deployment/ql3-automation-management
```

基础清单不会被 `operations/kustomization.yaml` 自动引用。服务仅在 ClusterIP 8445 提供
`POST /api/v3/automations/management`，只接受同 namespace 且带
`qinglong.io/automation-management-client=true` label 的客户端 Pod。base 只有 DNS egress，
CloudNativePG overlay 只增加 PostgreSQL 5432。

## 身份与请求

客户端必须同时提供受信 mTLS 证书与短期 OIDC 断言。断言固定：

- audience：`qinglong3-automation-management`
- JWT type：`ql3-automation-management+jwt`
- purpose claim：`automation-management`
- subject：User
- assurance：`multi_factor` 或 `hardware`

业务 body 只接受 schema v1 的六个操作：

- mutation：`task.publish`、`trigger.publish`；
- inspection：`task.inspect`、`trigger.inspect`；
- bounded list：`task.list`、`trigger.list`。

mutation 调用方必须复用同一 `requestId`、`mutationId` 和 command 重试无响应请求；收到明确 HTTP/业务
拒绝后不得自动换 ID 重试。inspect/list 每次请求必须提供新的 UUID v4 `auditEventId`，分别要求
`task.read` 或 `trigger.read`。读取已经产生 append-only allowed audit，因此响应丢失后应使用新的
`requestId`/`auditEventId` 重新读取，不能把重复 audit identity 当作幂等读取。

inspect/list 与 mutation 使用相同的审计耐久性约束。HA 以 `synchronous_commit=remote_apply` 运行时，
主库提升后若同步备库尚未恢复，读取会因 allowed audit 无法获得同步确认而超时并失败关闭。这不是只读
服务故障，也不能临时降低 `synchronous_commit`；等待旧主 `pg_rewind` 并以同步只读备库重入后，再用
新的 request/audit identity 重试。已经返回成功的读取，其 audit 已同步应用到备库。

```json
{
  "schemaVersion": 1,
  "operation": "task.inspect",
  "request": {
    "requestId": "operator-request-20260804-1",
    "auditEventId": "123e4567-e89b-42d3-a456-426614174010",
    "projectId": "default",
    "taskId": "daily-backup"
  }
}
```

```json
{
  "schemaVersion": 1,
  "operation": "trigger.list",
  "request": {
    "requestId": "operator-request-20260804-2",
    "auditEventId": "123e4567-e89b-42d3-a456-426614174011",
    "projectId": "default",
    "limit": 64,
    "after": { "triggerId": "hourly-cleanup" }
  }
}
```

list 只接受 1–256 的 limit 与稳定 keyset cursor，不支持 offset。inspect 不存在时返回 `absent`；响应只
返回 Task/Trigger current-head 低敏摘要和分页状态，不回显 name、description、labels、spec、command、
cron expression、mutation、Principal、credential、assertion 或 audit identity。

仓库提供两个产品调用面：

- `ql3-automation-client`：从三个 owner-private `0600` 绝对路径读取 client config、command 和
  assertion，执行一次 TLS 1.3+mTLS 请求；
- `operations/automation-management-client`：caller 创建的一次性 Kubernetes Job，不含 RBAC 或
  ServiceAccount token，`backoffLimit=0`，只访问 DNS 和 exact manager Pod 的 8445 端口。

本地/CI 的真实 PostgreSQL + HTTPS 产品门可通过以下标准入口运行；未同时提供两个 URL 时测试只做
条件 skip，不会尝试隐式启动数据库：

```bash
QL3_TEST_POSTGRES_URL='postgresql://ql3_migration:...@127.0.0.1:5432/ql3_contract' \
QL3_TEST_POSTGRES_AUTOMATION_MANAGER_URL='postgresql://ql3_automation_manager:...@127.0.0.1:5432/ql3_contract' \
pnpm test:automation-postgres-integration:ql3
```

该门会启动两个独立 manager 验证同请求并发，再模拟第三实例已 COMMIT 但响应丢失并从另一实例精确
重放；测试 identity adapter 只用于隔离验证 transport/repository，不构成生产 OIDC ceremony 证据。

### 三节点 Kubernetes + PostgreSQL HA live gate

完整 Cluster 纵切面是显式 opt-in，必须提供已下载并审查、且与 operator lock 一致的 CloudNativePG
1.30.0 release manifest。它会创建随机命名的一个 K3s server、两个 agent 和独立 Docker network，
拒绝复用同名资源，并在 `finally` 中只清理由本次 fixture 记录的容器、网络、临时目录与两张测试镜像：

```bash
QL3_AUTOMATION_MANAGEMENT_KUBERNETES_LIVE=1 \
QL3_CNPG_OPERATOR_MANIFEST_FILE=/owner-private/cloudnative-pg-1.30.0.yaml \
pnpm test:automation-management-kubernetes-live:ql3
```

该门使用锁定的 `rancher/k3s:v1.34.3-k3s1`、CloudNativePG 1.30.0 与 PostgreSQL 18.4，真实执行
三实例引导、54 条 migration/capability v53、十三角色、双 manager、TLS 1.3/mTLS、identity/CRL
轮换、primary deletion/promotion、数据库失联与 fresh-Pod 恢复、CNI ingress/egress 和 RBAC 拒绝。
K3s 默认 Flannel 是分发内嵌组件，不存在可假定的三副本 `kube-flannel` DaemonSet；证据由锁定的 K3s
分发、三个现场 Ready+唯一 PodCIDR 节点、server 的 Flannel VXLAN/subnet-manager annotation，以及
真实跨节点正负网络探针共同构成。最终 stdout 只输出 exact-schema 低敏报告，任何 assertion、证书、
私钥、DSN、kubeconfig 或 Secret 都会被审计器拒绝。

这是单 Docker host 上的应用/数据库故障门，不是生产基础设施 STONITH、Kubernetes control-plane HA、
CSI/节点断电或真实外部 IdP 证据。路由器/低配设备不运行此门，也不因此新增常驻进程、workspace package
或依赖闭包；夹具与 PKI helper 留在 `scripts/lib`，只在维护工作站或 CI 的 opt-in lifecycle 中加载。

Task source、command、environment recipe 等可能含敏感信息，因此 Kubernetes operation 的
`ql3-automation-management-request` 必须是 immutable Secret，不能照搬 Worker client 使用 ConfigMap。
从 `deploy/kubernetes/ql3-cluster/operations/automation-management-client/config.example.yaml`
复制四个输入对象到私有 per-command overlay，替换 assertion、客户端证书、CA、Task/Trigger command
以及全零 Admin image digest，然后执行：

```bash
kubectl create -k \
  deploy/kubernetes/ql3-cluster/operations/automation-management-client
kubectl -n qinglong3-system wait \
  --for=condition=Complete job/ql3-automation-management-client \
  --timeout=2m
kubectl -n qinglong3-system logs job/ql3-automation-management-client
```

Job 名称固定；再次执行前等待 TTL 清理或只删除该精确 Job 和对应 per-command immutable inputs。
init container 只重试 `/readyz`，不会发送业务命令；main container 只执行一次。若客户端在收到响应前
断线，mutation operator 必须先以完全相同的 `requestId`、`mutationId` 和 command 查询/重放，不得生成
新 mutation 身份；inspect/list 则使用新的 request/audit identity 再执行一次有审计读取。

## 资源档位

生产 HA base 是 2 Pod，每 Pod PostgreSQL Pool 2、最多 32 个 TLS connection 与 16 个并发请求，
Pod requests 为 100m CPU/128Mi。单节点开发 overlay 可以显式降为 1 Pod、Pool 1 并移除 PDB/required
anti-affinity，但不属于生产支持矩阵。更大集群扩容前必须同时评审数据库角色 `connectionLimit`、全局
限流、故障域和身份 ledger 竞争；禁止只增加 replica。

## 轮换与恢复

public keyset generation 只能递增。新旧 key 先 overlap，再把旧 `kid` 追加到 `revokedKids`；不能删除
或复用已吊销 ID。CA/CRL 改动必须更新 Pod annotation 并完成零不可用 rollout。服务端 TLS 材料只在
进程启动时加载，因此证书替换也需要滚动 Pod。任何数据库错误会撤销 readiness；恢复应由新 Pod
重新完成 schema、identity ledger 和 TLS 校验，不能通过跳过 readiness 强行开放业务路由。
