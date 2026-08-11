# ADR-0099：专用 Legacy adoption decision issuer keyring 与可信签发 capability

- 状态：Accepted（专用 keyring、可信 reviewer capability、publication 前最终复核与逻辑/制品门禁已实现；流式 review-file 和产品签发 CLI 由 ADR-0100 完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-04、D-08、D-16、D-17、D-23、D-61、D-62、D-78、D-84、D-85、D-86、D-95、D-96、D-97、D-98
- 关联 ADR：ADR-0078、ADR-0084、ADR-0085、ADR-0087、ADR-0095、ADR-0096、ADR-0097、ADR-0098

## 背景

ADR-0097 定义了由 `LocalSecretKeyProvider` capability 提供 HMAC material 的私有 decision carrier，ADR-0098 让 publisher 在 Policy、source/file fence 与目标事务内消费它。但抽象 provider 不是产品 ceremony：若直接把 Secret encryption keyring 或 Owner credential pepper 传入，会复用错误密钥域；若 CLI 允许请求 JSON 自报 reviewer Principal，则任何本机调用者都可伪造 `local_console`；若签发时只在开始检查外部 authority，认证环境在 hard-link publish 前漂移仍会留下可用文件。

低性能路由设备还要求 issuer 不进入常驻启动闭包，历史 key 查找有固定上限；集群节点则必须保留可轮换、可精确验证旧 carrier 的确定 key identity。这个单一 consumer、同部署责任的能力不应再新增 workspace package。

## 决策

### 1. 使用 local-admin 的显式 subpath，不新增 package

`@qinglong/local-admin/decision-issuer` 是短生命周期 subpath，公开专用 keyring 的 provision、rotate、inspect 和 provider；根入口仅 lazy-load provider 以组合签发。常驻 `@qinglong/local-admin/runtime`、base/adopted Profile activation 与 application 启动不得导入该 subpath。

新增能力仍在第 27 个 importer 内，local-admin 从 6 个源文件增至 8 个；dependency audit 只允许 `legacyCrontabDecisionIssuerKeyring.ts` 和既有 carrier 精确访问 `@qinglong/runtime-core/local-secret` 的 provider/key-ID contract。不得导入 `@qinglong/local-secret` 实现，也不得让其他 local-admin 文件取得该入口。

### 2. keyring 使用独立密钥域和私有 POSIX 边界

key ID 固定使用 `qladk-` 前缀，material 为 32 字节 CSPRNG，最多保留 8 个 active/history key。manifest 是 exact-shape、canonical JSON，summary 只返回 active key ID、排序后的 key IDs、数量和 domain-separated SHA-256，不返回 material。

父目录必须是当前 real/effective POSIX UID 拥有的精确 `0700` real directory，manifest 必须是同 UID `0600` regular file。每次 `active/resolve/inspect` 都执行目录 identity、`lstat→O_NOFOLLOW open→fstat`、大小和 canonical base64url 校验；provider 构造后父目录 inode 被替换也会失败关闭。

首次 provision 以同目录 `0600` 临时 inode 写入、fsync、hard-link no-replace 和目录 fsync 发布。rotation 使用 `O_EXCL` 私有 lock、expected active key ID + keyring digest 双 CAS，保留全部历史 key；写新 manifest 并 fsync 后，在 rename 前再次验证原 manifest 和父目录 identity。未取得的其他进程 lock 永远不能被本进程清理。

### 3. reviewer 和时间只能来自可信 capability

`issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile()` 不接受 caller-supplied reviewer、`issuedAtMs` 或 `expiresAtMs`。受信 composition root 必须提供：

- `authenticateReviewer()`：返回刚完成认证的 User Principal；既有 receipt validator 继续要求 `local_console|multi_factor|hardware`、五分钟认证年龄和未过期状态；
- `clock()`：默认进程可信时钟，只作为测试/受信装配 seam；
- `confirmIssuerAuthority()`：复核 POSIX/认证 composition identity。

issuer 自行计算最长 30 分钟、默认 5 分钟且不超过 Principal expiry 的 receipt lifetime。弱认证在 HMAC key 读取和公开文件创建前失败。provider 每次取 key 前复核 issuer authority；carrier 在临时文件 fsync 后、hard-link no-replace 前再执行最终复核，漂移时只清理未发布临时 inode。

### 4. 资源和产品边界

keyring 常驻内存至多一次解析 16 KiB/8 keys，返回独立 `Uint8Array` copy；没有 timer、watcher、sidecar、数据库连接或后台 rotation。decision stream 仍沿用 ADR-0097 的 100,000 rows、64 KiB/line、32 MiB/file 和 iterator 约束。

本 ADR 只定义安全签发原语，不把任意 JSON 文件视为人工 review。ADR-0100 已补同 descriptor 多遍扫描的私有流式 review-file，并通过本机 Identity credential + POSIX proof 构造 `authenticateReviewer`；credential/token 不进入 argv、stdout 或普通 command JSON。后续 ADR-0101 已把正式 mutation 的产品 commit command 接入 ADR-0098 publisher。

## 被否决的替代方案

1. **复用 local Secret encryption keyring**：跨越用途与轮换域，泄露一个 authority 即同时危及 Secret 和 adoption，拒绝。
2. **复用 Owner credential pepper**：HMAC carrier 生命周期会阻碍 credential pepper GC，并扩大认证根用途，拒绝。
3. **CLI 请求直接携带 reviewer Principal**：assurance 可自报，拒绝。
4. **把 key material 放进 argv、环境变量或 command file**：进入 shell history、进程环境或持久 intent，拒绝。
5. **只在签发开始检查 authority**：无法关闭 HMAC 后、publish 前的替换窗口，拒绝。
6. **为 keyring/issuer 新增 workspace package**：单 consumer、无独立部署和第三方依赖，不满足 D-85，拒绝。
7. **为了减小文件数把 issuer eager-load 到 runtime**：让一次性高权 key capability进入常驻闭包，拒绝。

## 验收证据

1. keyring 测试覆盖 no-replace provision、精确 CAS rotation、历史 key resolve、8-key 上限、宽权限、篡改、symlink、父目录 inode 替换和外部 lock 保留。
2. issuer 测试覆盖单次认证、内部 lifetime、专用 `qladk-*` key、完整 verify、弱 reviewer 在 key 读取前失败，以及第 4 次最终 authority 复核失败时输出和临时 inode 都不存在。
3. local-admin 32 项与 dependency boundary 22 项测试通过；dependency audit 仍为 27 importer、local-admin 8 source files、无 finding。
4. 六种 Profile 制品门禁通过：base edge/standalone 仍为 216 files/34 loaded modules；adopted 为 238 files/37 modules；application 为 299 files/64 modules。最大制品 1,992,865 bytes，最大本轮抽样 RSS delta 11,845,632 bytes，低于 4 MiB/512 files/16 MiB。

## 后续约束

ADR-0100/0101 已在现有本机管理 CLI importer 内增加 `ql3-adoption` binary/subpath及显式 commit command，没有新建 package；下一步补物理 Edge 写放大证据，随后再连接 Scheduler/Run admission。PostgreSQL/cluster 使用远程管理身份和独立 KMS/HSM，不得复用本机文件 keyring。
