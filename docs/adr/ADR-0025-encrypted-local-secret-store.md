# ADR-0025：加密本地 SecretStore 与版本化密文

- 状态：Superseded
- 日期：2026-07-18
- 关联：QL-RFC-0001、ADR-0007、ADR-0022、ADR-0024
- 被取代：ADR-0073 将实现从 legacy `back/runtime`/Sequelize 迁入全新 QL3 package graph；本 ADR 的 SecretRef、envelope 和威胁模型仍作为历史决策保留

## 上下文

ADR-0024 已规定 Task revision/context recipe 只能保存 Secret 引用，明文只能在 Attempt 物化时短暂进入可信内存。但只有 provider port 不能满足 edge/standalone 部署：路由设备通常没有 KMS、Vault 或常驻 sidecar，仍需要低资源、断电可恢复的本地实现。另一方面，直接复用 Legacy `Envs`、把主密钥写进 `database.sqlite`，或允许 cluster Worker 读取控制面数据库，都会破坏 Project 隔离、备份边界和多副本语义。

本地实现需要同时处理随机密文的幂等写入、并发轮换、历史版本引用、密钥轮换、SQLite 损坏和错误信息泄漏。加密静态存储只能缩小磁盘/备份泄漏面，不能防御已控制 QingLong 进程、root、调试器、heap dump 或实际 Executor 环境的攻击者。

## 决策

### 1. SecretRef 是 opaque Project capability

内置本地 provider 使用 canonical `qlsecret:v1:<base64url-json>`：payload 只允许 `projectId`、`name` 和可选的正整数 `version`。省略版本解析当前版本，显式版本精确解析历史密文；未知字段、非 canonical base64url/JSON、超长值或非法版本 fail closed。

Task revision/context recipe 继续只保存完整 opaque ref，不解析或保存 Secret 明文。通用 `SecretRef.version` 仍是 provider contract；内置 v1 codec 将其收敛为单调递增整数。执行时 provider 必须在访问仓储或密钥前证明 ref 的 `projectId` 与 Run candidate 相同。

### 2. SQLite 只保存 append-only envelope

`0014-local-secret-envelopes` 新增 `LocalSecretEnvelopes`，复合主键为 `(project_id, secret_name, version)`，并为 `(project_id, secret_name, mutation_id)` 建立唯一索引。每个版本保存：

- `key_id` 与固定算法 `aes-256-gcm`；
- 96-bit 随机 nonce、ciphertext、128-bit authentication tag；
- mutation identity 和创建时间。

明文、主密钥、解密缓存、API actor token 和 Run identity 不进入该表。AES-GCM AAD 绑定 Project、Secret name、version、mutationId、keyId 和 algorithm，因此复制密文到另一个 Project/name/version 或篡改 metadata 都无法通过认证。

SQLite repository 只支持 append、按 mutation 查询和最多 64 项的有界批量解析；没有 update plaintext/delete current 接口。current 解析在单条查询中选择最大版本，显式版本精确匹配并保持输入位置。

### 3. CAS 与 mutation 分别解决轮换和请求重放

写命令同时携带：

- `expectedCurrentVersion`：创建为 0，轮换 N→N+1 时必须为 N；SQLite `IMMEDIATE` 事务串行检查并写入，过期 writer 得到稳定 version conflict；
- `mutationId`：同一 Project/name 下标识一次调用。AES-GCM 每次生成随机 nonce，所以 repository 不能用密文字节判断幂等；并发 winner 的 envelope 返回应用层后，必须使用对应历史 key 解密并与本次 plaintext 比较。版本和明文都相同才是 existing，否则是 mutation conflict。

错误对象只携带稳定错误码和通用摘要，不包含 Project、Secret name、ref、plaintext、ciphertext 或 key ID。

### 4. 主密钥与数据库分离

edge key provider 从独立 JSON keyring 文件按需加载：

```json
{
  "version": 1,
  "activeKeyId": "edge-key-2026-07",
  "keys": {
    "edge-key-2026-07": "<canonical-base64url-32-bytes>"
  }
}
```

文件必须是绝对路径下的普通文件，拒绝 symlink，禁止 group/other 任意权限位，大小上限 16 KiB、密钥最多 16 个，每个 key 恰好 32 bytes。provider 每次调用重新读取，因此原子替换 keyring 后新写入可使用新的 active key；历史 key 必须保留到其所有 envelope 超过恢复/备份保留窗口。消费者获得独立 key copy，并在使用后尽力清零 Buffer。

keyring 不进入 `database.sqlite`、普通配置导出或 Artifact。备份必须把数据库与 keyring 当作两个独立敏感对象，并验证能够配对恢复。

### 5. 明文只在 Attempt 解析窗口存在

`EncryptedLocalSecretService` 同时提供版本写入服务和 `LocalSecretEnvironmentProvider`：

- 一次最多解析 64 个去重 ref，保持位置对齐；任一 ref 跨 Project、密文损坏、key 缺失或 authentication 失败均 fail closed；
- missing envelope 返回 unavailable plan，不用空字符串代替；
- 同批次相同 `keyId` 只加载一个 key copy，结束时统一清零；
- plaintext Buffer 在 UTF-8 解码后立即尽力清零，不写入 revision、recipe、RunEvent、Artifact metadata 或异常消息。

JavaScript string、Executor 环境和子进程内存无法可靠擦除。因此禁止在诊断对象、结构化日志、Trace、heap dump 上传和错误 cause 中附带解析结果；日志脱敏仍是附加防线，不是存储边界。

### 6. edge 与 cluster 复用端口，不复用密钥实现

- edge/standalone：SQLite envelope repository + 私有文件 keyring，零常驻 sidecar、无轮询 timer；
- cluster-control：PostgreSQL envelope/metadata repository + KMS/Vault/云 Secret Manager adapter，必须实现相同 Project、exact/current、batch、CAS 和错误 contract；
- worker：只接收授权后、Attempt-scoped 的临时值或 capability，不读取控制面的 SQLite/keyring。

共享挂载 keyring 或 `database.sqlite` 不是 cluster SecretStore。外部 Secret Manager 的 provider-specific version 可以在其 adapter 内映射，不能放宽内置 `qlsecret:v1` codec。

### 7. 当前保持 production unreachable

本 ADR 的 migration、crypto、repository、keyring provider 和 environment provider 已实现，但没有接入默认 bootstrap、API/UI、Task 管理或 Dispatcher lifecycle。启用前还必须完成：

- 首次安装的 CSPRNG key 生成、原子写入和权限校验；
- keyring 独立备份/恢复演练、丢失告警和灾难恢复文档；
- active key 轮换管理入口、历史 key 使用审计、全量 rekey/退役证明；
- `secret.manage`/`secret.use` 权限、actor 审计和不回显 API；
- ADR-0026 quota/retention 的受控 lifecycle、日志脱敏、heap dump 策略和真实 edge 磁盘耗尽测试；
- PostgreSQL/KMS contract suite 与多副本并发验证。

因此 migration 被注册不等于 SecretStore 已对生产调用可达，Legacy `Envs` 也不会自动迁移为 3.0 Secret。

## 影响

正面影响：

- 数据库、WAL 和常规数据库备份中没有 Secret 明文或主密钥；
- edge 无需额外进程即可获得 authenticated encryption、历史版本和并发安全轮换；
- key provider/repository 可独立替换，cluster 不需要在领域服务中增加 Profile 分支；
- 随机 nonce 与请求幂等不再冲突，损坏和错误路径默认不泄漏身份或内容。

代价与风险：

- 数据库和 keyring 任一丢失都会导致不可恢复，备份复杂度高于单文件 SQLite；
- 只切换 active key 不会重加密历史数据，删除历史 key 前必须有可验证的 rekey/保留证明；
- AES-GCM nonce 安全依赖 CSPRNG，测试注入的固定 nonce 绝不能进入生产装配；
- 进程内 plaintext string 无法可靠擦除，运行时与日志治理仍是强制门禁。

## 未选择的方案

1. **复用 Legacy `Envs` 明文表**：权限、版本和备份边界不足，拒绝。
2. **把主密钥放进同一 SQLite**：数据库泄漏即可解密，拒绝。
3. **用 Secret name 作为环境全局键**：跨 Project 混淆且不可复现，拒绝。
4. **覆盖当前值而不保留版本**：历史 Run/重试不可解释，拒绝。
5. **比较随机密文判断 mutation 幂等**：相同 plaintext 的 nonce 不同，语义错误，拒绝。
6. **允许 keyring 宽权限或 symlink**：扩大本地用户读取和路径替换攻击面，拒绝。
7. **将固定测试 key/nonce 作为默认值**：破坏机密性，拒绝。
8. **cluster 共享本地 keyring/SQLite**：没有多副本一致性、KMS 审计和节点隔离，拒绝。

## 验证要求

- canonical SecretRef current/exact vectors，拒绝未知字段、非 canonical 编码和非法版本；
- AES-256-GCM 固定 vector，metadata/AAD 篡改、错误 key/tag 均 fail closed；
- 创建/轮换 CAS、mutation replay/conflict、双连接并发轮换恰好一个 winner；
- current/exact/missing 有界批量解析保持位置，跨 Project 在 repository 前拒绝；
- 原始 SQLite row 只有密文 BLOB，不出现测试 plaintext；
- keyring mode、symlink、大小、schema、key 长度、active key reload 测试；
- 所有 corruption/unavailable 错误不包含 Secret identity 或 plaintext；
- SQLite adapter 拒绝 cluster dialect，默认生产启动链保持不可达；
- Node 22、Node 24 全量回归通过。
