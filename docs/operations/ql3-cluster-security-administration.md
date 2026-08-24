# QingLong 3.0 Cluster Security Administration

该命令是 Cluster Identity、API Credential 和 Security Audit 的短生命周期管理入口，不适用于 Edge/Standalone，也不会启动 HTTP listener。每次进程只执行一个命令，最多打开一个 admin PostgreSQL 连接，然后退出。

## 私有输入

准备一个仅当前操作者可访问的目录；command、assertion、keyset 和 pepper 必须使用规范绝对路径，私有文件不能向 group/world 开放。credential issue/rotate 还需要一个已存在的私有 delivery 目录，但目标文件必须不存在。

keyset 使用既有 generation/revocation 协议，例如：

```json
{
  "schemaVersion": 1,
  "generation": 1,
  "issuer": "https://identity.example.test/",
  "audience": "qinglong3-security-administration",
  "keys": [
    {
      "alg": "EdDSA",
      "crv": "Ed25519",
      "kid": "REPLACE_WITH_KEY_ID",
      "kty": "OKP",
      "use": "sig",
      "x": "REPLACE_WITH_ED25519_PUBLIC_JWK_X"
    }
  ],
  "revokedKids": [],
  "assuranceMappings": [
    {
      "acr": "urn:example:mfa",
      "assurance": "multi_factor",
      "requiredAmr": ["pwd", "otp"]
    },
    {
      "acr": "urn:example:hardware",
      "assurance": "hardware",
      "requiredAmr": ["hwk"]
    }
  ],
  "constraints": {
    "maxAssertionBytes": 8192,
    "maxLifetimeMs": 300000,
    "maxAuthenticationAgeMs": 300000,
    "clockSkewMs": 5000
  }
}
```

JWT header 必须使用 `typ=ql3-security-administration+jwt`；payload 的 issuer/audience 必须匹配 keyset，并包含 `ql3_purpose=security-administration`。只接受当前、未撤销的强认证 principal。其他管理面即使使用同一签名 key，也会因 type/purpose/audience 不同而被拒绝。

pepper 是现有 API credential digest authority 要求的 32-byte canonical base64url 值。它必须与已存 credential 的 pepper authority 一致，不要为了单次命令临时生成新值，也不要写入 command JSON。

## 精确命令

注册 Identity：

```json
{
  "schemaVersion": 1,
  "operation": "identity.register",
  "request": {
    "mutationId": "123e4567-e89b-42d3-a456-426614174301",
    "requestId": "security-identity-register-20260825-1",
    "expectedCurrentVersion": 0,
    "subject": { "type": "api_app", "id": "automation-client" }
  }
}
```

`identity.enable` 和 `identity.disable` 使用相同 request shape，只需修改 operation、mutationId、requestId 和 expectedCurrentVersion。

签发 API Credential：

```json
{
  "schemaVersion": 1,
  "operation": "credential.issue",
  "request": {
    "mutationId": "123e4567-e89b-42d3-a456-426614174302",
    "requestId": "security-credential-issue-20260825-1",
    "expectedCurrentVersion": 0,
    "credentialId": "automation-primary",
    "subject": { "type": "api_app", "id": "automation-client" },
    "notBeforeAtMs": 1787596800000,
    "expiresAtMs": 1787683200000
  }
}
```

`credential.rotate` 使用同一完整 shape 和新的 mutationId；`credential.revoke` 必须删除 `notBeforeAtMs`、`expiresAtMs`，且不提供 `--delivery`。所有 mutation 都必须携带当前版本 fence。

有界查询 Security Audit：

```json
{
  "schemaVersion": 1,
  "operation": "audit.list",
  "request": {
    "limit": 25,
    "filter": { "outcome": "allowed" }
  }
}
```

limit 范围为 1–200。可选 filter 只有 projectId、subject 和 outcome；翻页使用上一页的 exact `{occurredAtMs,eventId}` 作为 `before`，不支持 offset、自由文本或无界导出。

## 执行

生产默认要求 TLS hostname verification：

```sh
export QL3_POSTGRES_ADMIN_URL='postgresql://ql3_admin:REDACTED@postgres.example.test:5432/qinglong'
export QL3_POSTGRES_ADMIN_TLS_SERVERNAME='postgres.example.test'
export QL3_POSTGRES_ADMIN_TLS_CA_FILE='/secure/qinglong3/postgres-ca.pem'

ql3-cluster-admin security \
  --command=/secure/qinglong3/security-command.json \
  --assertion=/secure/qinglong3/security-assertion.jwt \
  --keyset=/secure/qinglong3/security-keyset.json \
  --pepper=/secure/qinglong3/api-credential-pepper \
  --delivery=/secure/qinglong3/delivery/new-api-credential.json
```

也可以直接调用同镜像内的 `ql3-security-admin`。测试环境只有同时设置 `QL3_POSTGRES_ADMIN_TLS_MODE=disable` 与 `QL3_POSTGRES_ADMIN_ALLOW_INSECURE=true` 才能关闭 TLS；生产禁止这样部署。

成功签发或轮换时，stdout 只包含 delivery 文件名和 SHA-256。token 只存在于新建的 `0600` delivery 文件。目标已存在时命令失败且绝不覆盖。精确重放返回 `status=existing` 且不重新发布 token；如果首次响应丢失，先检查原 delivery 文件，确实丢失时使用新的 mutationId 执行 rotate，不能尝试恢复旧 token。

## Kubernetes 一次性 Job

仓库提供显式 opt-in 的部署模板，但不会随共享 Cluster operations 安装：

- `base`：外部 PostgreSQL；默认 NetworkPolicy 只有 DNS，必须用私有 overlay 增加数据库的精确 IP/Pod egress；
- `cloudnative-pg`：使用 `ql3-postgres-admin-auth`、`ql3-postgres-rw`、`ql3-postgres-ca`；
- `credential-delivery`：在 base 上增加调用方提供的 RWO PVC；
- `cloudnative-pg-credential-delivery`：CloudNativePG 与 PVC 交付的组合。

把 `input-secret.example.yaml` 复制到仓库外的私有目录，替换四个占位值，并保持 `immutable: true`。示例不属于任何 Kustomization。非签发操作不要选择 delivery overlay；`credential.issue` / `credential.rotate` 必须先按 `delivery-pvc.example.yaml` 创建受加密、受访问控制的 PVC，并把 manifest 中的 `replace-with-unique-delivery.json` 改为本次唯一文件名。

以 CloudNativePG 的无 delivery audit query 为例：

```sh
kubectl create -f /secure/qinglong3/security-administration-input.yaml
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/security-administration/cloudnative-pg \
  | kubectl create -f -
kubectl wait --for=condition=complete --timeout=300s \
  job/ql3-security-administration -n qinglong3-system
kubectl logs job/ql3-security-administration -n qinglong3-system \
  -c administrator
```

当前固定资源名只允许串行执行。收集 content-free 结果和（仅 issue/rotate）PVC 中的 `0600` delivery 文件后，删除 Job 与本次 immutable input Secret；不得重用 assertion、把 token 复制到终端输出，或以 `kubectl apply` 修改旧 Job。真实 K3s + PostgreSQL live ceremony 尚未验收，生产启用前仍需完成 ADR-0501 的 live gate。

## 当前边界

本入口没有远程 API/UI、双人复核或 break-glass、pepper rotation、audit retention/export/alert。可选 Job 已有受审静态部署契约，但不默认安装，真实 K3s + PostgreSQL/PVC ceremony 仍待验收；admin database credential 始终不得进入常驻 Cluster Control。命令决策见 [ADR-0500](../adr/ADR-0500-short-lived-cluster-security-administration-command.md)，部署决策见 [ADR-0501](../adr/ADR-0501-opt-in-kubernetes-security-administration-job.md)。
