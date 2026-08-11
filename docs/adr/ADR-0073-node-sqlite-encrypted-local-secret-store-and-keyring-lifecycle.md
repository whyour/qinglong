# ADR-0073：Node SQLite 加密本机 SecretStore 与 Keyring 生命周期

- 状态：Proposed
- 日期：2026-07-20
- 关联：D-05、D-17、D-25、D-37、D-62、D-65、D-70、D-72、ADR-0024、ADR-0025、ADR-0063、ADR-0066、ADR-0071
- 取代：ADR-0025 中位于 `back/runtime`、`0014` 和 Sequelize adapter 的实现事实；保留其 SecretRef、envelope 与威胁模型决策

## 上下文

ADR-0025 已定义 Project-bound SecretRef、AES-256-GCM append-only envelope 和数据库外 keyring，但实现仍位于 2.x 根目录的 `back/runtime`，repository 依赖 Sequelize migration `0014`。新的 `@qinglong/local-application` 只接受可选内存 provider；因此全新 3.0 package graph、Node 24 SQLite authority 和真实 dispatcher 没有可达的默认本机 SecretStore。继续把 legacy 原型视为 3.0 已实现，会让 RFC、产物依赖和运行事实相互矛盾。

本机实现还必须兼顾路由设备：不能引入 KMS sidecar、第二 SQLite 连接、常驻 key cache、轮询 timer 或每任务 Secret worker。另一方面，runtime 自动生成主密钥会让数据库迁移、密钥备份和应用启动形成不可审计的隐式副作用。

## 决策

### 1. 契约进入 runtime-core，密码学进入独立包

`@qinglong/runtime-core/local-secret` 拥有 canonical `qlsecret:v1` codec、envelope、repository、key provider 和 environment provider port。`@qinglong/local-secret` 生产只依赖 runtime-core，拥有 AES-256-GCM、私有 keyring provider、加密服务和显式 keyring 管理函数；不得导入 SQLite、Profile、legacy、cluster、ORM、HTTP 或 Worker。

依赖方向固定为：

```text
runtime-core <- local-secret <- local-application
       ^
       |
 local-sqlite
```

SQLite adapter 实现 envelope port，但不依赖密码学包；local-secret service 消费 port，但不打开数据库。这样 cluster 可以实现 PostgreSQL + KMS/Vault adapter，而不在领域服务中增加 Profile 分支。

### 2. Node 24 SQLite 是唯一 envelope authority

`0007-local-secret-envelopes` 新增 `QingLong3LocalSecretEnvelopes`，以 `(project_id, secret_name, version)` 为主键，只保存 key ID、固定算法、12-byte nonce、最大 16 KiB ciphertext、16-byte tag、mutation ID 和时间。mutation/current/key-usage 三个索引分别服务幂等、当前版本和未来 rekey 证明。

`0008-capability-v4` 将 local-control-core 推进到 v4。repository 直接加入现有 `LocalSqliteRunRepository`，与 Run、dispatch、receipt 和 control 共用一个 DatabaseSync、256 operation 队列和 close fence；禁止创建 Secret 专属 SQLite 连接。append 使用 `BEGIN IMMEDIATE`，先查 mutation replay，再比较 current version，最后写 envelope；两个 authority 对同一 expected version 只能有一个 winner。

### 3. Keyring 生成和轮换必须显式、原子、可恢复

keyring 是数据库外、最多 16 个 32-byte key 的私有 JSON 文件：

- 首次 provision 使用 CSPRNG，写入同目录 0600 临时文件并 fsync，再用 hard-link no-replace 发布；已存在目标绝不覆盖；
- active-key rotation 要求调用方提供 expected active key ID，并以 0600 exclusive lock file 串行化管理者；新快照同目录写入、fsync、rename 和 directory fsync；
- lock 残留、active ID 漂移、key 数耗尽、symlink、宽权限、畸形/超大文件全部 fail closed；不得自动猜测或删除 stale lock；
- runtime 每次解析按需重读 keyring，不建立常驻 key cache、watcher 或 timer；同一批次相同 key 只复制一次并在结束时清零。

轮换只改变新写入使用的 active key，不等于历史 rekey。历史 key 在其 envelope、数据库备份和恢复窗口都有可达引用前不得删除。

### 4. Application 必须在恢复和 admission 前证明 SecretStore ready

enabled local-application 必须提供绝对 `secretKeyringPath`。ADR-0140 后顺序固定为
adopted storage ready → bounded Plugin Package recovery safe → keyring
private/readable/active-key preflight → `secrets_ready` → Run/domain startup recovery →
lifecycle → admission。Package stage source 不可用时不读取 keyring；缺失、宽权限、
symlink、错误 key 或损坏 keyring 必须在 stack factory、dispatcher、Artifact 和 spawn
前失败，并按 storage/fence ownership 反向清理。

application 私有构造 `EncryptedLocalSecretService(storage.localSecrets, keyring)` 并注入 dispatcher；不再接受调用方用 `undefined` 绕过本机 SecretStore。Task recipe 仍只保存 opaque ref，明文只在 Attempt materialization 窗口进入环境对象，不进入 SQLite、Event、Artifact metadata、审计或错误。

### 5. 不自动把 2.x Envs 变成 Secret

旁路 adoption 保留 legacy `Envs`，但不会复制到新 envelope 表，也不会生成 keyring。首次 provision、Secret 创建/轮换和未来 legacy import 必须由短生命周期管理 authority 执行。runtime migration 和 application bootstrap 都不得自动生成 key、选择 Secret、回显明文或删除旧数据。

## 替代方案

1. **继续调用 `back/runtime` 的 Sequelize SecretStore**：让全新 3.0 反向依赖 legacy ORM/migration，拒绝。
2. **application 缺 provider 时把 Secret 解析为 missing**：可在无 Secret 的测试中假装 active，生产配置错误直到任务运行才暴露，拒绝。
3. **首次启动自动生成 keyring**：密钥副作用与数据库 adoption、备份和容器重建耦合，拒绝。
4. **把 keyring 放入 SQLite 或共享集群卷**：数据库泄漏即可解密，且没有 KMS/多副本审计语义，拒绝。
5. **常驻解密 cache 或 keyring watcher**：扩大明文/密钥驻留并给 edge 增加隐藏资源，拒绝。
6. **rotation 后立即删除旧 key**：历史版本与备份不可恢复，拒绝。

## 影响与未完成项

已完成：

- runtime-core exact-shape Secret contract 与 canonical Project-bound ref；
- 独立 local-secret 包的 AES-GCM、通用错误和有界批量解析；
- Node 24 SQLite v4 migration/schema/readiness/repository 与双 authority CAS；
- 私有 keyring no-replace provision、expected-active rotation、历史 key 保留和运行期 reload；
- application `secrets_ready` 门禁和真实 dispatcher provider 注入；
- edge/standalone 均无新增 timer、sidecar、第二连接或 cluster dependency。

仍未完成：

- ADR-0074 已补齐 `secret.manage` 的强 Principal、Project Policy、durable security audit、撤权 fence 与不回显领域服务；仍缺首 owner bootstrap、`secret.use` 全入口装配和不回显 CLI/HTTP/UI；
- 按 key usage 有界扫描、历史 envelope rekey、key retirement proof 与 crash-resume journal；
- 数据库/keyring 配对备份、恢复演练、丢失告警和容器 Secret mount 文档；
- 日志已知值掩码、heap/core dump 策略和物理 edge 的写放大/ENOSPC/断电门禁；
- PostgreSQL envelope 与 KMS/Vault contract、多副本并发和 Remote Worker 临时 Secret delivery。

因此本 ADR 关闭“全新本机运行链没有 SecretStore”的架构断层，但不授权未认证入口管理 Secret，也不表示 cluster Secret 生命周期完成。

## 验证

1. canonical ref、固定 AES-GCM vector、AAD/密文/key/tag 篡改均有测试。
2. 原始 SQLite row 不包含 plaintext；current/exact/history 保持位置并跨 active-key rotation 可解密。
3. mutation replay 比较解密后语义，stale expected version 稳定冲突；双 SQLite authority 只有一个 rotation winner。
4. keyring 必须 0600、普通文件、无 symlink；provision 不覆盖，rotation 保留历史 key并 fenced active ID。
5. application 在 stack factory 前验证 keyring，失败不启动 recovery/lifecycle/admission 并释放 storage/fence。
6. dependency/source/lock、Profile advisory 门禁包含第二十二个 importer；application tarball 明确不包含短生命周期 Secret 管理 authority。
