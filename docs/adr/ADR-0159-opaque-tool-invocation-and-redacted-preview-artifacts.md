# ADR-0159：不透明 Tool Invocation 与脱敏 Preview Artifact

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0025、ADR-0026、ADR-0031、ADR-0133、ADR-0155、ADR-0158、
  ADR-0160；
  RFC D-29/D-30/D-131/D-149

## 背景

ADR-0155 的 trusted invocation plan 虽然不携带 handler 或 execute capability，但仍把
规范化后的 Tool input 和安全 preview 直接嵌入 plan。一旦 plan 为审批、重启恢复或
集群派发而持久化，就会把 Secret、token、prompt 和其他敏感参数复制到普通计划、
Audit、Trace 或 start barrier。

Tool input 必须在准入后仍可精确恢复，但能够展示给审批人的 preview 必须是独立的脱敏
事实。两者不能因为 edge 使用 SQLite、cluster 使用 PostgreSQL/KMS 而产生不同领域
语义，也不能为这个单一能力新增只有一个文件的 workspace package。

## 决策

### 1. plan 只保存 Artifact reference

`@qinglong/runtime-core/tool-invocation-artifact` 是现有 `runtime-core` 的显式 subpath。
trusted plan 删除 `input` 与 `preview`，改为保存：

- input Artifact 的 ID、artifact/input digest、key ID、算法和明文字节数；
- preview Artifact 的 ID、artifact/action/preview/redaction-contract digest 和字节数；
- 原有 snapshot、definition、binding、Policy fence、action 与 plan digest。

execution admission 复制这两个不可变 reference；后续 start command 的 canonical
digest 因而绑定准确 Artifact，不需要读取明文。Approval 只读取 preview reference 的
`previewDigest`。

### 2. input Artifact 使用有界 authenticated encryption

`qinglong/tool-invocation-input-artifact@v1`：

- 只接受已由 Tool Definition Registry 规范化、最大 64 KiB 的 JSON；
- 使用 AES-256-GCM、32-byte key、12-byte nonce 和 16-byte auth tag；
- AAD 绑定 Artifact/Project/action/requester/Tool/input/action/key/size/time；
- Artifact digest 再绑定完整 envelope；
- plan、Admission、Trace、Audit 与 barrier 均不得携带 ciphertext，更不得携带明文；
- 解封后必须再次通过相同 Tool Definition Registry，并复验 input digest；
- key material 只通过窄 `ToolInvocationArtifactKeyProvider` 取得，调用者持有的副本必须
  可擦除；数据库只保存 key ID，不保存 key。

nonce 必须由可信 composition 产生；领域 plan builder 不自行隐藏随机性。相同
Artifact ID 的重放只有内容完全一致才可接受。

### 3. preview 是独立的低敏 Artifact

`qinglong/tool-invocation-preview-artifact@v1` 只接受 exact-shape preview：

- 最多 16 个字段、8 个 warning、总 JSON 最大 8 KiB；
- `redacted` 字段的 value 必须为 `null`，其他字段不得为 `null`；
- title、summary、label、value 与 warning 各自有硬边界；
- preview digest 同时绑定 action digest，Artifact digest 再绑定
  redaction-contract identity、Project、action 与时间。

Preview 可由审批查询入口读取，但不能被当作执行输入。Input Artifact 与 Preview
Artifact 的 ID、digest 或 action binding 任一漂移都必须失败关闭。

### 4. 不新增 workspace package

纯协议和密码封装留在 `ql3-runtime-core`；SQLite repository 留在
`ql3-local-sqlite`，PostgreSQL repository 留在 `ql3-cluster-postgres`，KMS/本机
keyring 由各 Profile composition 注入。模块和显式 subpath 用于可读性；只有独立部署、
依赖、权限或发布生命周期才构成 package 边界。

## 低配与集群影响

- 不新增第三方依赖、进程、线程、timer、watcher、socket 或常驻缓存；
- Edge 每次调用最多加密 64 KiB input 和规范化 8 KiB preview；
- AES-GCM 与 SHA-256 为单次、线性、有硬上限操作；
- Cluster 可用 KMS-backed data key provider，但领域协议不要求网络调用或特定云厂商；
- ciphertext 已由双方言不可变 adapter 持久化；retention 与 key rotation 仍由后续
  Profile composition 完成。

## 被否决方案

1. **继续把 input 放在 plan，仅要求调用方不要持久化**：恢复和审批会迫使复制明文。
2. **只保存 input digest**：adapter 无法在重启后恢复准确调用。
3. **把 preview 和 ciphertext 放进 start barrier**：扩大热表、Audit 和重放面。
4. **用数据库透明加密替代应用层 envelope**：不能统一 SQLite 与 PostgreSQL/KMS。
5. **复用 Local Secret envelope**：16 KiB 上限和 Secret name/version 语义不匹配。
6. **为 Artifact 新增 workspace package**：没有独立部署或依赖生命周期。

## 验证

- runtime-core 完整测试：313/313；
- Artifact contract：4/4，覆盖密文不含明文、AAD/digest tamper、错误 key、Registry
  重验和 preview 独立摘要；
- trusted plan/admission/start barrier 定向测试：20/20；
- SQLite start barrier repository：5/5；
- PostgreSQL start barrier repository：4/4；
- SQLite Artifact migration/schema/repository：16/16 定向测试；
- PostgreSQL Artifact migration/schema/readiness/repository：33/33 定向测试；
- PostgreSQL 18.4 arm64 双节点物理 HA：input/preview 原子持久化、精确重放、
  `remote_apply` 复制、timeline 1→2 晋升后读取、runtime append-only、其余四个
  业务角色拒绝和数据库无明文均通过，总 `passed=true`；
- cluster dependency audit：`findings=[]`、`compatible=true`；
- `git diff --check` 通过。

## 后续门禁

双方言 immutable Artifact repository、capability migration、PostgreSQL 六角色最小
权限和物理 HA 已由 ADR-0160 完成。仍需：

1. Artifact retention、key rotation/rekey 与损坏恢复；
2. 首个 trusted built-in adapter 只在 durable start barrier 后解封 input；
3. post-start response-loss/进程崩溃的 inspect/manual recovery。
