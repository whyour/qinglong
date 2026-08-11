# ADR-0097：私有且可认证的 Legacy adoption 决策文件

- 状态：Accepted（流式载体、HMAC issuer capability、私有 no-replace 发布、同 descriptor 消费及 ADR-0098 Policy/audit 原子 publisher 已实现；产品 issuer ceremony 待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-03、D-04、D-08、D-17、D-23、D-62、D-70、D-85、D-88、D-90、D-91、D-92、D-93、D-94、D-95、D-96
- 关联 ADR：ADR-0073、ADR-0074、ADR-0078、ADR-0085、ADR-0086、ADR-0087、ADR-0088、ADR-0095、ADR-0096

## 背景

ADR-0096 的 receipt 是常量大小的逐项决策摘要，适合路由设备，但 publisher 仍需要完整 decision stream 才能知道每一行采用、以 shell compatibility 采用或跳过。若只保存 receipt，进程重启后无法重建决策；若把最多 100,000 项放进一个 JSON 数组，读取时又会制造与任务数成正比的内存峰值。

普通 SHA-256 还能被任意持有内容的调用方重算，不能证明 durable decision stream 是由持有部署级 issuer capability 的管理面发布。直接复用可覆盖文件、宽权限目录或符号链接，则会在 review 与 publisher 之间留下替换、降权和 TOCTOU 窗口。

## 决策

### 1. 载体留在 local-admin，不新增 package

决策文件是 `@qinglong/local-admin` 的短生命周期内部模块，与 classifier、receipt 和未来 publisher 共同拥有一个 adoption 管理边界。它不是独立部署物、没有第二个 production consumer，也不引入不同 engine/native 依赖，因此按 ADR-0087 不拆新的 workspace package。

根入口只用 type import 和 lazy `require()` 暴露 publish/verify；`@qinglong/local-admin/runtime` 不载入文件、HMAC、classifier 或 receipt 模块，不创建 timer、watcher、连接池或常驻 key cache。

### 2. 文件采用有界 NDJSON 和两遍流式验证

文件顺序固定为一个 header、零到 100,000 个 decision row、一个 receipt 和一个 authentication footer。每行最多 64 KiB，整个文件最多 32 MiB，并且必须以 newline 结束。decision row 只保存 `rowOrdinal/sourceDigest/disposition/reason`，不得保存 command、hook、path、label、Secret 或任意 replacement spec。

发布时 decision iterable 一边被 receipt classifier 锁步消费，一边写入临时文件；不会缓存数组。验证第一遍以固定 64 KiB chunk 检查 record 顺序、行数、总字节、内容摘要和 HMAC，只保留 decision 区间的起止 offset；认证通过后第二遍从同一已打开 inode 逐行向 receipt verifier 提供 decision。内存上限与任务数无关，代价是一次性管理操作进行两遍顺序文件读取。

### 3. 文件系统边界必须 owner-only、no-follow、no-replace

目标必须是规范化、绝对、非根路径；父目录必须由当前 real/effective POSIX UID 拥有、为真实目录且权限精确为 `0700`。最终文件必须由同一 UID 拥有、为真实 regular file、权限精确为 `0600`，读取执行 `lstat → O_NOFOLLOW open → fstat` 并在完成后同时复核打开 inode 与路径 inode。

发布先以随机同目录 `O_CREAT|O_EXCL|O_NOFOLLOW` 临时文件写入，强制 `0600`、完整 write、`fsync`，再以 hard link 原子发布，目标存在即失败且绝不覆盖；随后删除临时链接并同步目录。失败只清理未发布的临时文件，若 hard link 已成功但目录 durability 无法确认，则保留最终事实供显式恢复，不伪装成未发生。

### 4. HMAC issuer capability 认证完整内容

authentication footer 使用 `HMAC-SHA-256`，对域隔离的 content digest 与精确 content byte count 认证。key ID 使用共享的有界 key contract；发布调用 `LocalSecretKeyProvider.active()`，验证按 footer 的 exact key ID 调用 `resolve()`，不尝试所有历史 key。每次取得的 32-byte key copy 在使用后立即擦除，比较使用 constant-time equality。

调用方必须为 adoption authorization 配置专用 keyring/capability，不得把 Secret envelope encryption key 或 Owner credential pepper 当作无区分的全局密钥复用。`local-admin` 只依赖 `runtime-core/local-secret` 的窄 provider contract，不直接依赖 `local-secret` package；这样 edge/standalone adopted 产物不因一次性管理能力被迫携带或加载完整 Secret 管理实现。旧 authorization 在 TTL 内可由 provider 精确解析历史 key；key retirement 必须先证明没有仍可能消费的文件。

### 5. 认证文件仍必须复验 receipt 与当前 source

HMAC 通过只证明持有 issuer key 的组件发布过这些字节，不证明当前 Legacy source、plan、Profile、timezone 或 reviewer TTL 仍有效。公开 verify API 必须显式给出 expected decision ID 与 plan digest，重建当前 inventory，并让 ADR-0096 verifier 对文件中的全部 decision 重新执行处置矩阵、receipt digest、强 User、TTL 和 source identity 校验。

header、receipt、authentication、expected inputs 任一不一致都失败关闭。文件不能跨 decision、Profile、plan、inventory 或 source snapshot 重放。

### 6. 本 ADR 不授予 Task mutation authority

认证文件不是 Policy decision、ApprovalRequest、安全审计或数据库 transaction。当前没有任何常驻 Profile、Scheduler、Run admission 或 migration 自动消费它，也没有 API/CLI/UI 获得 key provider。

产品入口仍必须把经过认证的 User principal、`task.manage`/adoption 专用 Policy、Project/RoleBinding fence、低敏 audit 与专用 key capability 组合成受审 ceremony。未来 publisher 必须在一个 SQLite write transaction 内重验 source fence、plan、receipt、decision stream 和 target expected versions，并让 TaskDefinition、context recipe、execution revision 与全部 Trigger 同成同败；HMAC 不能替代该事务。

## 被否决的替代方案

1. **为载体新增 package**：没有独立部署、依赖或 consumer 边界，只会继续 package-per-file，拒绝。
2. **单个 JSON decision 数组**：解析内存随 100,000 项增长，不适合路由设备，拒绝。
3. **只保存 receipt，不保存 decision stream**：重启后无法执行逐项 publisher 复验，拒绝。
4. **只用 SHA-256**：持有文件内容者可自行重算，不能证明 issuer capability，拒绝。
5. **rename 覆盖固定文件**：可能替换已审阅授权，破坏 decision ID 的一次性事实，拒绝。
6. **信任 `0600` 而不做 HMAC**：同 UID 或错误装配仍可构造可解析文件，不能区分 issuer capability，拒绝。
7. **把 HMAC 当作 Policy 或 audit**：密码学完整性不包含 RBAC、撤权 fence、业务授权或审计原子性，拒绝。
8. **在常驻 runtime 自动生成 keyring**：混淆部署责任并扩大路由器常驻 authority，拒绝。

## 验收证据

1. local-admin 测试完成 publish→JSON-lines durable file→verify 往返，结果与原 receipt 完全一致。
2. 测试证明文件为 `0600`、父目录要求 `0700`、已存在目标不可覆盖，命令和脚本路径不会进入载体。
3. 测试覆盖错误 key、TTL expiry、内容篡改、同 inode 同大小语义等价改写、宽权限父目录和宽权限文件并全部失败关闭。
4. receipt 测试补充五分钟认证年龄与三十分钟 lifetime 的精确上限负例。
5. dependency audit 只允许新模块访问 `runtime-core/local-secret`，没有新增 package 或第三方依赖。
6. runtime import 与六种 Profile artifact gate 必须证明新模块仍为 lazy，loaded-module 基线不得上升。

## 后续约束

ADR-0098 已实现 adoption publisher 的单目标事务、Project/RoleBinding fence、allowed audit 与 ledger。publisher 在同一已认证 descriptor 上第三遍消费 decision，按顺序生成 canonical Task/Trigger facts，`skip` 不写任何 head；任一行、identity、source fence 或 audit 失败都回滚整个批次。受信产品 issuer ceremony、Scheduler/Run admission 尚未就位；大批量 transaction 的锁时长、SQLite WAL/rollback journal 增长和路由设备写放大仍必须另设物理门禁，不能仅以逻辑测试宣称可用于 100,000 项。
