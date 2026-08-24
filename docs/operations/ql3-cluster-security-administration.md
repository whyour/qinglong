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

## 当前边界

本入口没有远程 API/UI、双人复核或 break-glass、pepper rotation、audit retention/export/alert，也没有默认安装的 Kubernetes Job。生产部署应把它放在受控工作站或自行审查的一次性 Job 中，并确保 admin database credential 不进入常驻 Cluster Control。完整安全决策见 [ADR-0500](../adr/ADR-0500-short-lived-cluster-security-administration-command.md)。
