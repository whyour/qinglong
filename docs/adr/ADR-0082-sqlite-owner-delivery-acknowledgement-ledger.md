# ADR-0082：SQLite Owner Delivery 确认账本与瞬时文件桥梁

- 状态：Proposed（安全核心已实现，长期 retention/revoke 策略尚未实现）
- 日期：2026-07-21
- Supersedes：ADR-0081 第 5 节的永久文件墓碑决策
- 关联 RFC：QL-RFC-0001 D-78、D-80、D-81
- 关联 ADR：ADR-0063、ADR-0075、ADR-0076、ADR-0077、ADR-0078、ADR-0079、ADR-0080、ADR-0081

## 上下文

ADR-0081 的无密钥文件墓碑能阻止确认后的 mutation 重新生成 secret，但永久墓碑与 pending/ready 共用 64 项目录预算。该设计把“有界启动扫描”错误地变成“设备生命周期最多确认约 64 次”，对后续 credential recovery/rotation 不可接受；简单放大目录或自动删最旧文件又分别制造无界路由器成本和旧 mutation 再生成窗口。

确认事实本质上属于 mutation/database 事实，而文件只需要跨越“SQLite 已记录确认”和“ready 已删除”之间的异构原子性窗口。因此需要把长期 authority 移回唯一 Node 24 SQLite operation authority，同时保留短暂文件桥梁处理崩溃。

## 决策

### 1. 新增 append-only SQLite 确认账本

reviewed migration `0015-local-owner-delivery-acknowledgements` 新增 `QingLong3LocalOwnerDeliveryAcknowledgements`，`0016-capability-v8` 把 `local-control-core` 提升到 capability v8。

每个 mutation 最多一条记录，只保存 kind、稳定 ID、request/project、fact digest、delivery digest、TTL 与首次确认时间；不保存 secret。credential/challenge 记录通过 nullable exact-shape foreign key 分别绑定 provisioning mutation 或 challenge issue mutation，SQLite CHECK 约束 kind-specific shape、digest、TTL 和时间。

typed Drizzle schema、reviewed SQL、migration checksum、readiness table/column/index/foreign-key/trigger audit 必须保持 lockstep。runtime/migration/bootstrap/adoption 都只接受完整 capability v8，常驻 application 仍不能取得 bootstrap repository。

### 2. Repository 在一个事务内验证并记录

`LocalOwnerBootstrapRepository.recordDeliveryAcknowledgement` 在共享 operation queue 的 `BEGIN IMMEDIATE` 中：

1. 规范化 exact-shape、无 secret 的 acknowledgement；
2. 重读 provisioning/challenge 与关联 credential/audit；
3. 比较 mutation、request、project、subject/credential/challenge、fact digest 和 TTL；
4. 插入账本并重新读取验证后提交。

同一稳定语义的并发写只有一个 inserted winner，后续返回 existing，并采用先提交的 `acknowledgedAtMs`。除时间戳外任何差异都返回 mutation conflict；损坏记录或关联事实不一致返回低敏 unavailable。

### 3. 文件墓碑变为瞬时 crash bridge

acknowledge 顺序固定为：

1. 验证 expected ready digest 与数据库事实；
2. hard-link no-replace 发布并 fsync 无 secret 文件 acknowledgement；
3. 在 SQLite 写入 durable acknowledgement ledger；
4. 删除 ready 并 fsync 目录；
5. 删除文件 acknowledgement 并再次 fsync。

任一步崩溃都可收敛：数据库写入前崩溃由文件墓碑驱动账本补写；数据库写入后崩溃由账本与文件摘要共同完成 ready/墓碑清理。DB-ledger + pending 非法；DB-ledger + ready 只有 digest/事实完全一致时删除 ready。

### 4. Service replay 先读取账本

provision/issue 在生成 CSPRNG candidate 和调用 delivery prepare 之前查询 acknowledgement ledger。匹配 mutation/request/project/TTL、稳定 authority 和关联数据库事实时，只返回 `status=existing`、稳定 ID、`token=null`；冲突或损坏 fail closed。

因此已收敛的交付目录可以为空，同一旧 mutation 仍不会生成新 secret，也不需要永久占用文件条目。

### 5. 账本 retention 与 credential 生命周期分开交付

账本当前 append-only，单条记录有界且不参与每次 application 启动扫描。它解除文件目录 64 次生命周期上限，但不宣称长期 retention 已完成。

删除账本前必须同时证明 mutation replay retention 已结束、关联 credential/challenge 已按受审 revoke/recovery 策略终结、备份/审计保留期满足，并以版本化 GC mutation 记录裁决。最终 credential rotation 管理面仍受该策略和 pepper version 门禁。

## 被否决的替代方案

1. **把文件目录上限调到几千或取消上限**：把启动 I/O、内存和恶意目录成本转嫁给路由器，拒绝。
2. **自动删除最旧文件墓碑**：会让旧 mutation 重新生成 candidate，拒绝。
3. **只写 SQLite、不保留 crash bridge**：数据库提交与 ready 删除之间仍有异构崩溃窗口，拒绝。
4. **把 secret 或完整 ready JSON 写进 SQLite**：扩大备份与常驻数据库泄漏面，拒绝。
5. **在 application 启动扫描整个账本**：成本随历史增长，且常驻 runtime 不需要 bootstrap authority，拒绝。
6. **新增第二 SQLite connection 专供确认**：破坏 edge 单 authority/queue/close fence，拒绝。

## 验收证据

1. local SQLite 16 条 reviewed migration、capability v8、typed schema/catalog/readiness contract 通过 23/23 测试。
2. runtime-core 83/83 测试覆盖 credential/challenge acknowledgement exact-shape、无 secret 与 widened input 拒绝。
3. local-owner-bootstrap 8/8，确认后跨新 console authentication replay 不生成 secret。
4. local-owner-console 21/21，覆盖两个独立 SQLite authority 的并发确认、DB ledger 首写单 winner、文件墓碑清理、DB-ledger + ready crash recovery、DB-ledger + pending 拒绝和账本篡改按读取 fail closed。
5. edge/standalone 六种 production artifact 仍不包含 local-owner-console，常驻 Profile 没有新增连接、timer、watcher 或 listener。

## 未完成项

credential key provenance、受审 pepper keyring/active CAS、ack-first credential rollover/revoke、bounded reference inspection 与版本化双材料 GC 核心已由 ADR-0083 完成；可恢复 versioned acknowledgement tombstone retention/GC 已由 ADR-0084 完成。最终 CLI、真实断电/ENOSPC/只读文件系统、Linux rootless/root 容器与固定物理路由器证据仍未完成。
