# QingLong 3.0 Cluster Approval Management

这是 Cluster 中供人类检查并批准/拒绝 Approval 的独立管理面。它不是 MCP Tool、调度器或执行器，也不会 consume、dispatch 或
执行已批准动作。Edge/Standalone 与路由器用户继续使用短生命周期 `ql3-approval`，不会加载本服务、证书、OIDC 或
PostgreSQL Pool。

## 部署前置

1. PostgreSQL 已完成 65 条 control-core migration、capability v64 和正常 readiness；CloudNativePG 已创建
   `ql3_approval_manager` 与 `ql3-postgres-approval-manager-auth`。
2. 从
   `deploy/kubernetes/ql3-cluster/operations/approval-management/config.example.yaml`
   复制 TLS、client CA/CRL 和 public identity keyset 到私有 overlay，替换所有 placeholder。
3. 将 Deployment 的 client CA/CRL annotation sentinel 替换为 exact bundle SHA-256，并把 Admin image 的全零 digest 替换为
   独立验证的 release digest。
4. 先渲染并审查，再显式部署；该 operation 不在共享 `operations/kustomization.yaml` 中。

```bash
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/approval-management/cloudnative-pg \
  >/dev/null
kubectl apply -k \
  deploy/kubernetes/ql3-cluster/operations/approval-management/cloudnative-pg
kubectl -n qinglong3-system rollout status \
  deployment/ql3-approval-management
```

服务仅在 ClusterIP 8447 提供 `POST /api/v3/approvals/management`。base 只允许 DNS egress；CloudNativePG overlay 只允许到
`cnpg.io/cluster=ql3-postgres` Pod 的 TCP 5432。只有带
`qinglong.io/approval-management-client=true` label 的同 namespace Pod 能访问 8447。

## 身份约束

客户端必须同时提供未被 CRL 吊销的 mTLS client certificate 和短期 OIDC assertion：

- audience：`qinglong3-approval-management`
- JWT type：`ql3-approval-management+jwt`
- purpose：`approval-management`
- subject：User
- assurance：`multi_factor` 或 `hardware`

不得使用 Project API bearer、浏览器 Session、Worker credential、Kubernetes ServiceAccount token 或其他 management plane 的
assertion。服务会在进入领域服务前和提交前重新认证；身份、assurance 或 Policy fence 漂移会失败关闭并写入低敏审计。

## 第一步：检查 Approval

命令必须是 exact schema；每次检查使用新的 request、success audit 与 failure audit ID：

```json
{
  "schemaVersion": 1,
  "operation": "approval.inspect",
  "request": {
    "projectId": "default",
    "approvalRequestId": "approval-1",
    "requestId": "cluster-review-1",
    "auditEventId": "10000000-0000-4000-8000-000000000001",
    "failureAuditEventId": "10000000-0000-4000-8000-000000000002"
  }
}
```

成功结果包含 Approval version/state/risk/requester、过期时间、redacted preview 和完整 `expectedAction`。复制整个
`expectedAction` 到决定命令；不要从日志、MCP 输出或内部 ID 猜测 action reference/digest。

## 第二步：批准或拒绝

`expectedVersion` 固定为 1。决定必须使用新的 request/audit ID 和稳定 decision ID：

```json
{
  "schemaVersion": 1,
  "operation": "approval.decide",
  "request": {
    "projectId": "default",
    "approvalRequestId": "approval-1",
    "requestId": "cluster-decision-1",
    "auditEventId": "20000000-0000-4000-8000-000000000001",
    "failureAuditEventId": "20000000-0000-4000-8000-000000000002",
    "expectedVersion": 1,
    "expectedAction": {
      "permission": "run.start",
      "actionType": "tool.invoke",
      "actionRef": "<copy-from-inspect>",
      "actionDigest": "<64-lowercase-hex-from-inspect>",
      "previewDigest": "<64-lowercase-hex-from-inspect>"
    },
    "decisionId": "approval-decision-1",
    "decision": "approved",
    "reasonCode": "reviewed"
  }
}
```

将 `decision` 改为 `rejected` 可拒绝。`reasonCode` 只允许稳定、低敏的 snake_case 分类，不写自由文本、Secret 或个人信息。
成功返回 `decided` 与 version 2；同语义精确重放返回 `existing`。

## Secret Action 人工恢复

只有 controller 已报告 `executing + Job missing + durable binding/transition receipt missing` 时才使用本入口。先检查，不要从日志手工拼接 execution digest：

```json
{
  "schemaVersion": 1,
  "operation": "approval.recover.inspect",
  "request": {
    "projectId": "default",
    "dispatchId": "dispatch-secret-action-1",
    "requestId": "cluster-recovery-inspect-1",
    "auditEventId": "30000000-0000-4000-8000-000000000001",
    "failureAuditEventId": "30000000-0000-4000-8000-000000000002"
  }
}
```

结果必须是受支持的 Secret binding/transition action，execution effective status 必须是 `recovery_required`，resolution 必须为空。完成外部取证后，用 inspect 返回的 exact version/digest 和证据文件的 SHA-256 创建新命令：

```json
{
  "schemaVersion": 1,
  "operation": "approval.recover.resolve",
  "request": {
    "projectId": "default",
    "dispatchId": "dispatch-secret-action-1",
    "requestId": "cluster-recovery-resolve-1",
    "auditEventId": "40000000-0000-4000-8000-000000000001",
    "failureAuditEventId": "40000000-0000-4000-8000-000000000002",
    "expectedExecutionVersion": 3,
    "expectedExecutionDigest": "<64-lowercase-hex-from-inspect>",
    "mutationId": "manual-recovery-1",
    "decision": "abandon_unknown",
    "evidenceDigest": "<sha256-of-external-evidence>",
    "reasonCode": "orphan_absence_unverifiable"
  }
}
```

`confirm_failed` 只用于外部证据明确证明业务 mutation 未发生，终态为 failed；仍无法判定时使用 `abandon_unknown`，终态为 blocked。不存在人工 succeeded，也不得借此重建 Job 或重置 execution。响应丢失时只能用相同 User、mutation、decision、evidence、reason 和 execution fence 精确重放，返回 `existing` 表示原事务已提交。

## 使用一次性 Kubernetes Client Job

复制
`deploy/kubernetes/ql3-cluster/operations/approval-management-client/config.example.yaml`
到私有 per-command overlay，替换 client config、一个 command、短期 assertion、client certificate/key 与 server CA。不要把私有
overlay 提交到仓库。

再创建一个只引用仓库 operation 并替换全零镜像 digest 的私有 Kustomization：

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - /absolute/path/to/qinglong/deploy/kubernetes/ql3-cluster/operations/approval-management-client

images:
  - name: registry.example.com/qinglong/qinglong3-cluster-admin
    newName: registry.example.com/qinglong/qinglong3-cluster-admin
    digest: sha256:REPLACE_WITH_REVIEWED_PRODUCTION_DIGEST
```

```bash
kubectl create -f /absolute/private/approval-command-inputs.yaml
kubectl create -k /absolute/private/approval-client-overlay
kubectl -n qinglong3-system wait \
  --for=condition=Complete job/ql3-approval-management-client \
  --timeout=150s
kubectl -n qinglong3-system logs \
  job/ql3-approval-management-client --container=client
```

Job 无 RBAC 和 ServiceAccount token，`backoffLimit: 0`。init container 只重试 TLS 1.3 `/readyz`；main container 只执行一次
业务请求。固定 Job 名再次使用前，应等待 TTL 清理或只删除该精确 Job 与本次 immutable inputs。

也可在受控管理工作站直接运行：

```bash
ql3-approval-client \
  --config=/absolute/private/client.json \
  --command=/absolute/private/command.json \
  --assertion=/absolute/private/assertion.jwt
```

三个参数和它们引用的证书/key 都必须是当前 UID 拥有、不可经 symlink 到达的私有 regular file。若 endpoint 仍是 ClusterIP，
工作站必须通过受审的私网入口；不要临时把 Service 改为公共 LoadBalancer。

## 重试、故障与恢复

- inspect 响应丢失：用新的 request/audit/failure audit ID 重读，因为 allowed read audit 已可能提交。
- decide 响应丢失：只用同一 decision ID、decision、reason、User、expected version 与完整 action binding 重放；不要生成新决定。
- binding/version/state/expiry 冲突：重新 inspect 并重新人工审查，不得手工替换 digest。
- authentication/Policy fence 失败：检查 assertion lifetime、assurance、client CRL、RoleBinding 与 active credential；撤权后必须继续失败。
- database/audit unavailable：readiness 会撤销，Pod 有界 drain 并退出。等待 CloudNativePG 恢复可写主库和同步确认后，由 fresh Pod
  完整通过 schema/role/keyset readiness；不得降低 `synchronous_commit` 或跳过 readiness。
- CA/CRL 或 server certificate 变化：更新 annotation digest，完成 `maxUnavailable: 0` 的滚动更新。keyset generation 只前进，先
  overlap 再 append revoke，不能复用或删除已撤销 kid。

## 资源档位

生产 base 为 2 Pod，每 Pod 最多 2 条 PostgreSQL connection、32 个 TLS connection、16 个并发请求；requests 为
50m CPU/96Mi，limits 为 1 CPU/384Mi。单节点开发 overlay 可明确降为 1 Pod/Pool 1 并移除 PDB/required anti-affinity，但该形态
不属于 HA 支持矩阵。扩容必须同步评审 database role connection limit、transport quota、identity ledger contention 与故障域，
不能只增加 replica。

## Kubernetes 多节点发布门

生产发布前可显式运行三节点 K3s、三实例 CloudNativePG 与双 Approval manager 的 live contract。该门不会自动进入普通 CI，也不适用于 Edge/Standalone：

```bash
QL3_APPROVAL_MANAGEMENT_KUBERNETES_LIVE=1 \
QL3_KUBECTL_BIN=/absolute/path/to/kubectl \
QL3_CNPG_OPERATOR_MANIFEST_FILE=/absolute/path/to/cnpg-1.30.0.yaml \
pnpm test:approval-management-kubernetes-live:ql3 \
  --report=/absolute/private/approval-management-live-report.json

pnpm audit:approval-management-kubernetes-live:ql3 \
  --report=/absolute/private/approval-management-live-report.json
```

operator manifest 必须是已审查的 CloudNativePG 1.30.0 完整文件；CI 使用 SHA-256
`f8bede43fe4ee0d478c2355b204a36876b2ae4faac60f2a9452280b293da3b88`。report 路径必须为已存在私有目录下的绝对新路径，runner 拒绝覆盖，并以 `0600` 写入。完整证据只存在 report，不进入 stdout。

门禁验证跨节点 anti-affinity、mTLS/OIDC、identity overlap/revoke/rollback、client CRL、CloudNativePG primary failover、数据库断连 readiness fence、fresh Pod recovery、CNI NetworkPolicy、RBAC deny 和 durable Approval/audit。它不证明生产 control-plane HA、外部 IdP 或基础设施 STONITH；这些限制必须和报告一起保留。

仓库提供手工 workflow `.github/workflows/ql3-approval-management-live.yml`。成功后还必须确认 `ql3-approval-live-*` Docker container/network 均为空。
