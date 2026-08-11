# QingLong 3.0 本机 Headless Application 操作手册

本手册适用于 `edge` 与 `standalone`。它启动独立 QingLong 3.0 target，不会接管
`back/app.ts`，也不会自动停止 2.x。全新安装使用
[Fresh 初始化](./ql3-local-fresh-setup.md) 与 v2 `storage.mode=fresh`；下文保留
2.x adopted v3 配置、legacy silence commitment 和 fence 流程。v1 adopted
配置仍可被离线解析，但生产进程会在取得任何 runtime authority 前拒绝启动。

## 前置条件

1. 已完成 legacy SQLite inspection、side-by-side adoption 和 activation，保存
   `activationDigest`。
2. 已显式 provision 本机 Secret keyring；runtime 不会自动生成主密钥。
3. 若 Plugin Package install recovery 队列未收敛，必须配置 materialized recovery
   catalog；`disabled` 模式遇到 queued stage 会失败关闭。
4. 使用与数据文件相同的专用 OS 用户运行；配置目录建议 `0700`，配置文件必须
   `0600`。
5. 先由 `ql3-local-deploy cutover-legacy-stop` 对精确 Docker container ID 关闭 restart
   policy、停止并检查，再取得不可覆盖的 legacy silence commitment。SQLite source
   write fence 不能替代该部署证据。

## 配置

创建 `/opt/qinglong/private/local-application.json`：

```json
{
  "schema": "qinglong/local-application-process@v3",
  "instanceId": "router-edge-1",
  "profile": "edge",
  "storage": {
    "mode": "adopted",
    "sourcePath": "/opt/qinglong/data/database.sqlite",
    "targetPath": "/opt/qinglong/data/qinglong3.sqlite",
    "recoveryPath": "/opt/qinglong/data/database.pre-ql3.sqlite",
    "manifestPath": "/opt/qinglong/data/qinglong3-adoption.json",
    "activationPath": "/opt/qinglong/data/qinglong3-activation.json",
    "expectedActivationDigest": "REPLACE_WITH_64_HEX_ACTIVATION_DIGEST",
    "busyTimeoutMs": 100
  },
  "cutover": {
    "cutoverId": "router-edge-1-ql3",
    "commitmentPath": "/opt/qinglong/service/cutovers/router-edge-1-ql3/0002-legacy-stopped.json",
    "expectedCommitmentDigest": "REPLACE_WITH_64_HEX_COMMITMENT_DIGEST"
  },
  "runtime": {
    "receiptRoot": "/opt/qinglong/data/receipts",
    "artifactRoot": "/opt/qinglong/data/artifacts",
    "secretKeyringPath": "/opt/qinglong/private/secret-keyring.json"
  },
  "pluginPackages": {
    "stagingRoot": "/opt/qinglong/data/plugin-staging",
    "activationRoot": "/opt/qinglong/data/plugin-activation",
    "recoverySource": {
      "mode": "disabled"
    },
    "pageSize": 4,
    "maxPages": 4,
    "taskPublicationPageSize": 4,
    "taskPublicationMaxPages": 4
  },
  "ai": {
    "deployment": "excluded"
  }
}
```

所有 path 必须是规范化绝对非根路径。storage、runtime、Plugin Package
staging/activation/catalog/bundle/trust 的全部 authority path 必须互不相同；未知字段、
symlink、非当前 UID、非普通文件、超过 16 KiB 或配置权限不是 `0600` 都会在打开
storage 前拒绝。commitment 必须同时绑定 cutover ID、Profile、instance ID、activation
digest、Docker endpoint/container 稳定身份和前一条 journal digest；摘要、权限、形状或
任一绑定漂移都会在 signal subscription、SQLite、Plugin Package、Secret 和 AI 之前失败关闭。

```sh
chmod 0700 /opt/qinglong/private
chmod 0600 /opt/qinglong/private/local-application.json
ql3-local-application --config /opt/qinglong/private/local-application.json
```

## Plugin Package 恢复 catalog

空 install recovery 队列或明确不允许本机恢复时使用：

```json
{ "mode": "disabled" }
```

如果 durable queued install 需要在崩溃后继续，配置部署者已经物化的私有 catalog：

```json
{
  "mode": "materialized_catalog",
  "catalogRoot": "/opt/qinglong/private/plugin-package-catalog",
  "bundleRoot": "/opt/qinglong/private/plugin-package-bundles",
  "publisherTrustFilePath": "/opt/qinglong/private/plugin-package-publisher-trust/current.json"
}
```

catalog 与 bundle root 必须是当前 UID 的非 symlink、规范真实路径 `0700` 目录，
各最多包含 64 个 final object。catalog entry 为 `<lockDigest>.json`，bundle 为
`<artifactDigest>.bundle`；两者都必须是当前 UID、no-follow、精确 `0600` 的
regular file。entry 最大 256 KiB，exact schema 为：

```text
schema = qinglong/local-plugin-package-recovery-source@v1
lockDigest = durable PackageLock.lockDigest
source = durable PackageLock.source 的完整精确副本
bundlePath = bundleRoot/<source.artifactDigest>.bundle
manifest = 受签名保护的 Plugin Package manifest
signature = Plugin Package Ed25519 signature
```

publisher trust 文件同样必须为当前 UID、no-follow、精确 `0600`、最大 256 KiB：

```text
schema = qinglong/plugin-package-publisher-trust@v1
keys = 受信 publisher key 定义数组
```

不要直接覆盖 `current.json`。先创建精确 `0700` 的 trust root 和 deployment root
下精确 `0600` 的候选 trust，再由当前 Owner 执行 provision：

```json
{
  "schemaVersion": 1,
  "operation": "plugin-package.publisher-trust.provision",
  "options": {
    "deploymentRoot": "/opt/qinglong",
    "databasePath": "/opt/qinglong/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong/private/owner-keys",
    "credentialFilePath": "/opt/qinglong/private/credential.json",
    "trustRoot": "/opt/qinglong/private/plugin-package-publisher-trust",
    "catalogRoot": "/opt/qinglong/private/plugin-package-catalog",
    "bundleRoot": "/opt/qinglong/private/plugin-package-bundles"
  },
  "request": {
    "requestId": "publisher-trust-provision-v1",
    "auditEventId": "REPLACE_WITH_UUID_V4",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "mutationId": "publisher-trust-provision-v1",
    "expectedGeneration": 0,
    "trustFilePath": "/opt/qinglong/private/publisher-trust-v1.json"
  }
}
```

```sh
chmod 0700 /opt/qinglong/private/plugin-package-publisher-trust
chmod 0600 /opt/qinglong/private/publisher-trust-v1.json
chmod 0600 /opt/qinglong/private/publisher-trust-command.json
ql3-package-trust run \
  --command-file /opt/qinglong/private/publisher-trust-command.json
```

重叠轮换使用 `plugin-package.publisher-trust.rotate`、当前 generation 作为
`expectedGeneration`、新的 mutation/audit identity，以及同时包含全部旧 key 和至少
一个当前有效新 key 的候选文件。`rotate` 始终拒绝删除/改写旧 key。正常退休先用新
key 发布替代 recovery entry，并 collect 所有仍由旧 key 签名的 entry，再执行
`plugin-package.publisher-trust.retire`；命令 request 只包含
`publisher/keyId/expectedGeneration` 和新的 mutation/audit identity，不接收候选
trust 文件。retire 会先写 durable intent（此后旧 signer 发布立即失败），再要求
catalog signer 引用和未决事务都为零，最后写证明和新 generation。紧急 revoke 不是
retire，疑似泄露时不要继续此流程。若 inspect
返回 `recoveryRequired=true`，只能精确重放造成 pending generation 的原命令，不能
提交另一轮换。

```json
{
  "schemaVersion": 1,
  "operation": "plugin-package.publisher-trust.retire",
  "options": {
    "deploymentRoot": "/opt/qinglong",
    "databasePath": "/opt/qinglong/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong/private/owner-keys",
    "credentialFilePath": "/opt/qinglong/private/credential.json",
    "trustRoot": "/opt/qinglong/private/plugin-package-publisher-trust",
    "catalogRoot": "/opt/qinglong/private/plugin-package-catalog",
    "bundleRoot": "/opt/qinglong/private/plugin-package-bundles"
  },
  "request": {
    "requestId": "publisher-trust-retire-v3",
    "auditEventId": "REPLACE_WITH_UUID_V4",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "mutationId": "publisher-trust-retire-v3",
    "expectedGeneration": 2,
    "publisher": "packages.example.com",
    "keyId": "release-2026"
  }
}
```

疑似或确认 key 泄露时不要等待普通 retirement 的引用归零。先执行紧急提案：

```json
{
  "schemaVersion": 1,
  "operation": "plugin-package.publisher-trust.revoke.propose",
  "options": {
    "deploymentRoot": "/opt/qinglong",
    "databasePath": "/opt/qinglong/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong/private/owner-keys",
    "credentialFilePath": "/opt/qinglong/private/credential.json",
    "trustRoot": "/opt/qinglong/private/plugin-package-publisher-trust",
    "catalogRoot": "/opt/qinglong/private/plugin-package-catalog",
    "bundleRoot": "/opt/qinglong/private/plugin-package-bundles"
  },
  "request": {
    "requestId": "publisher-trust-revoke-v3-propose",
    "auditEventId": "REPLACE_WITH_UUID_V4",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "mutationId": "publisher-trust-revoke-v3",
    "expectedGeneration": 2,
    "publisher": "packages.example.com",
    "keyId": "release-2026"
  }
}
```

proposal 一旦返回 `runtimeAction=stop_required`，目标 signer 的新 catalog publish 和
queued application stage 已被持久阻断；立即停止 application，并保存响应中的
`impactDigest`。proposal 没有取消或解除阻断操作。已经 active、staged 或
activating 的 Package 及其 Task/Tool **不会**被本命令自动热停止。

默认由另一位仍为 current default Project Owner 的 subject 完成确认。确认命令必须
复用 proposal 的 `mutationId`、`expectedGeneration`，把提案者 subject 写入
`proposerSubjectId`，并逐字复制返回的 `impactDigest`：

```json
{
  "schemaVersion": 1,
  "operation": "plugin-package.publisher-trust.revoke.confirm",
  "options": {
    "deploymentRoot": "/opt/qinglong",
    "databasePath": "/opt/qinglong/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong/private/owner-keys",
    "credentialFilePath": "/opt/qinglong/private/second-owner-credential.json",
    "trustRoot": "/opt/qinglong/private/plugin-package-publisher-trust",
    "catalogRoot": "/opt/qinglong/private/plugin-package-catalog",
    "bundleRoot": "/opt/qinglong/private/plugin-package-bundles"
  },
  "request": {
    "requestId": "publisher-trust-revoke-v3-confirm",
    "auditEventId": "REPLACE_WITH_UUID_V4",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "mutationId": "publisher-trust-revoke-v3",
    "expectedGeneration": 2,
    "publisher": "packages.example.com",
    "keyId": "release-2026",
    "proposerSubjectId": "OWNER_SUBJECT_FROM_PROPOSAL",
    "authorizationMode": "dual_control",
    "reasonCode": "confirmed_key_compromise",
    "expectedImpactDigest": "COPY_SHA256_FROM_PROPOSAL_RESULT"
  }
}
```

没有第二位 Owner 且延迟风险更高时，可显式选择
`authorizationMode=break_glass`；这仍要求当前 Owner 强认证、精确 impact digest
和 `suspected_key_compromise` 或 `confirmed_key_compromise` reason，不是普通单人
撤销的别名。确认允许撤销最后一个 key；空 trust 会令 runtime registry 失败关闭，
必须先通过受审恢复流程建立替代信任。确认返回
`runtimeAction=restart_required` 只表示信任代已持久更新，不代表可直接启动：先审查
`quarantinedLockCount`、替代 bundle/lock 与资源处置计划。D-174 完成前，受影响的
active Package/Task/Tool 仍须保持 application 停机并由 operator 管理。

`offline` 和 digest-pinned `oci` lock 都可恢复，但 OCI bundle 必须已经由短生命周期
部署/管理 authority 下载到私有 source path，再经发布命令写入 content-addressed
bundle root。application 不连接 Registry、不读取
Registry credential，也不会 watch catalog。只有 queued stage 实际发生时才读取
entry、trust 和 bundle；空队列不产生额外加载或 I/O。

不要手工拼装或覆盖 entry/bundle。先用 `ql3-package` 完成
`propose → decide → consume → dispatch`，确保 SQLite 中已有当前 durable lock；再
准备 deployment root 下 `0600` 的 source bundle 和 publication descriptor；catalog
命令读取上一步管理出的 `current.json`：

```json
{
  "schema": "qinglong/local-plugin-package-recovery-publication@v1",
  "bundlePath": "/opt/qinglong/private/incoming/example.bundle",
  "manifest": {},
  "signature": {}
}
```

最后以同一 Owner credential 执行私有 command file：

```json
{
  "schemaVersion": 1,
  "operation": "plugin-package.catalog.publish",
  "options": {
    "deploymentRoot": "/opt/qinglong",
    "databasePath": "/opt/qinglong/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong/private/owner-keys",
    "credentialFilePath": "/opt/qinglong/private/credential.json",
    "catalogRoot": "/opt/qinglong/private/plugin-package-catalog",
    "bundleRoot": "/opt/qinglong/private/plugin-package-bundles",
    "trustRoot": "/opt/qinglong/private/plugin-package-publisher-trust"
  },
  "request": {
    "requestId": "package-catalog-example-v1",
    "auditEventId": "REPLACE_WITH_UUID_V4",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "projectId": "default",
    "packageName": "example",
    "descriptorFilePath": "/opt/qinglong/private/publication.json"
  }
}
```

```sh
chmod 0700 /opt/qinglong/private/plugin-package-catalog
chmod 0700 /opt/qinglong/private/plugin-package-bundles
chmod 0600 /opt/qinglong/private/package-catalog-command.json
ql3-package-catalog run \
  --command-file /opt/qinglong/private/package-catalog-command.json
```

首次成功返回 `status=published`，相同 lock/command 重放返回 `status=existing`。只有此后
才启动或重启 application。dispatch 与 filesystem publish 不是一个原子事务；中间
崩溃时 queued recovery 会失败关闭，重放 publish 收敛，不能伪造 stage evidence。

`plugin-package.catalog.inspect` 的 request 必须是空对象，只返回 current/stale 与
文件计数。`plugin-package.catalog.collect` 使用新的 request/audit/failure UUID，
可选 `limit` 在 edge 最大为 4、standalone 最大为 16；重复执行直到
`remaining=false`。collect 只删除已证明非当前 SQLite head 的 entry、无引用 bundle
和识别出的临时事务。同一 catalog 的 publish/collect 应由 supervisor 串行执行。

看到以下低敏事实才表示 target active：

```json
{
  "schemaVersion": 1,
  "component": "qinglong3-local-application",
  "level": "info",
  "event": "active",
  "instanceId": "router-edge-1",
  "profile": "edge",
  "aiStatus": "deployment_excluded"
}
```

## 停止

向进程发送一次 `SIGTERM` 或 `SIGINT`。入口只接受第一个信号，并按：

```text
scheduler stop/drain → execution control drain → SQLite/source fence release
```

停止。必须等待 `event=stopped` 且 `stopResult=stopped` 后再操作数据库或启动 2.x。
`timed_out`、没有 stopped fact 或进程被 `SIGKILL` 都不能当成安全切换证据。

## AI 边界

基础路由部署使用：

```json
{ "deployment": "excluded" }
```

该路径不会加载 `@qinglong/ai` 或 provider。`deployment=installed` 已进入 process
contract，但通用 CLI 尚没有 provider binding/Policy/Secret material ceremony，会以
`QL3_LOCAL_APPLICATION_PROCESS_AI_PROVIDER_UNAVAILABLE` 在 storage 前失败关闭。不要把
API token 写进配置或环境变量绕过该门；AI-inclusive embedded host 必须注入受信
provider authority，完整启停流程见
[本机 AI Feature 手册](./ql3-local-ai-feature.md)。

## 常见失败

- `PRIVATE_LOCAL_COMMAND_FILE_INVALID`：配置 path、UID、类型、大小、symlink、权限或 JSON
  不合法；
- `QL3_LOCAL_APPLICATION_PROCESS_CONFIG_INVALID`：schema、shape、Profile、digest、path
  或预算不合法；
- `QL3_LOCAL_APPLICATION_PLUGIN_SOURCE_UNAVAILABLE`：存在 queued Plugin Package，但
  当前进程没有受信 recovery source；
- `QL3_LOCAL_APPLICATION_PROCESS_AI_PROVIDER_UNAVAILABLE`：声明 installed AI，但没有
  provider authority；
- `LocalApplicationStartupRecoveryRequiredError`：Run/Attempt 证据未收敛，禁止直接删
  行或伪造 receipt；
- `Local Secret is unavailable`：keyring 缺失、权限错误、损坏或与数据库不配对。

故障输出只包含 name/code。详细诊断应结合低敏 activation facts、离线 inspection 和
备份恢复流程，不要要求常驻进程打印 path、digest、SecretRef 或 token。
