# ADR-0084：版本化 Owner Delivery Acknowledgement 压缩与重放 Tombstone

- 状态：Proposed（核心、GC CLI 与本机自动化门禁已完成；Linux/路由器和故障注入门禁待实现）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-75、D-81、D-82
- 关联 ADR：ADR-0079、ADR-0081、ADR-0082、ADR-0083

## 上下文

`QingLong3LocalOwnerDeliveryAcknowledgements` 让确认后的 credential/challenge mutation 在交付目录已清空时仍能于 entropy 生成前 exact replay。直接删除旧行会让 service 再次创建 CSPRNG candidate；即使 provisioning/challenge 的 mutation 唯一约束最终拒绝写入，也已经违反“不重新生成 secret”，并可能留下新的 pending 文件。

账本 retention 因此不能等同于 `DELETE WHERE acknowledged_at_ms < ?`。需要把完整 acknowledgement 压缩为仍可在生成 entropy 前识别、可从 immutable source 重建并能检测 source 漂移的 tombstone。

## 决策

### 1. 压缩而非遗忘 mutation

GC 在唯一 SQLite authority 的一个 `BEGIN IMMEDIATE` 中完成：验证完整 acknowledgement 与 provisioning/challenge source、插入 versioned GC/tombstone、写低敏 audit、删除完整 acknowledgement。tombstone 至少绑定原 mutation、kind、delivery digest、首次确认时间、完整 acknowledgement semantic digest、retention policy、bridge-clear evidence 与 GC mutation。

`resolveDeliveryAcknowledgement` 先读完整账本；不存在时读取 tombstone并从 immutable provisioning/challenge source 重建 acknowledgement，再比较 semantic digest。完整行与 tombstone 同时存在、source 缺失或摘要漂移均 fail closed。service 因而仍在 entropy 生成前返回 `existing/null`。

### 2. 文件 crash bridge 必须先证明为空

短生命周期文件 authority 对目标 mutation 执行一次已有 64 项硬上限目录扫描，并确认 `.pending.json`、`.ready.json`、`.acknowledged.json` 三个精确名称均不存在。bridge-clear evidence 绑定目录 device/inode、kind、mutation 和 authority-owned 当前时间；GC command 不接受调用方时间，也不允许只凭“文件当前不存在”的布尔值删除。

### 3. Retention 与 source 终态共同裁决

v1 policy 的 replay retention 和 audit retention 最低均为 30 天、最高 10 年。credential acknowledgement 只有在 credential 已过期或 latest version 已 revoked，且没有涉及它的未完成 credential recovery 时才可压缩；challenge 必须已 claim 或过期。eligible time 至少取 acknowledgement+replay retention、source expiry/terminal time以及相关 issue/claim/provision audit+audit retention 的最大值。

### 4. 只存在于短生命周期 authority

常驻 runtime/application 不扫描候选、不持有 timer，也不取得 GC repository。最终组合根必须显式指定单个 mutation 或最多 64 项的有界页；默认不自动压缩。edge/standalone 常驻制品的 package、文件和 RSS 门禁不得因该能力增加。

## 被否决的替代方案

1. **按时间直接删除 acknowledgement**：会重新进入 entropy 路径，拒绝。
2. **永久保留完整行**：安全但未完成 retention/数据最小化目标，拒绝作为最终状态。
3. **只保留 mutation ID**：无法验证历史 delivery digest、首次确认时间和 source 漂移，拒绝。
4. **GC 时扫描整个 outbox 或账本**：成本随历史增长，不适合路由设备，拒绝。
5. **application timer 自动清理**：把短生命周期管理 authority 注入常驻运行面，拒绝。

## 分阶段实现与验收

1. contract（已完成）：exact-shape GC command、固定审计身份、30 天最低保留、10 年上限、bridge-clear evidence 绑定及 acknowledgement semantic digest。
2. 文件证据（已完成）：`FileLocalOwnerBootstrapSecretDelivery.inspectBridgeClear` 使用已有目录硬上限并拒绝任一目标桥文件存在。
3. SQLite（已完成）：`0025/0026` reviewed migration、capability v13、typed schema/readiness、credential/challenge tombstone reconstruction、source terminal/reference/retention 裁决，以及 audit+tombstone+完整行删除的单个 `BEGIN IMMEDIATE` transaction；双连接 winner、mutation conflict、active reference 与 entropy-free replay 均有测试。
4. 组合根（已完成）：`@qinglong/local-owner-maintenance/acknowledgement-gc` 只接受目标 mutation/kind/delivery digest，使用 authority-owned clock，从受 inode 约束且 64 项有界的 delivery directory 生成 evidence，再调用专用 SQLite `/acknowledgement-gc`；maintenance 不提供聚合根入口，无 timer，常驻入口不可导入。
5. 本机门禁（已完成）：ADR-0087 与 ADR-0106 物理合并后 21 个 importer dependency audit、联网 production vulnerability audit、全包测试、六种常驻制品闭包和 edge import audit 均须持续通过；console 内部 ceremony 与 maintenance/CLI authority 未进入闭包。
6. GC CLI（已完成）：ADR-0085 的 command adapter 与 `ql3-owner-gc` bin 已并入 `@qinglong/local-owner-maintenance`；它只接受 `0600` durable command file，经同包相对模块复用两个受审 authority 并只输出低敏结果，不直接取得 SQLite 或 destructive keyring 子入口。旧 `@qinglong/local-owner-gc-cli` 名称为 dependency tombstone。
7. 实机门禁（待实现）：Linux x64/arm64、物理路由器、断电窗口与真实 ENOSPC/EROFS 证据。

## 未完成项

核心与受审单次 GC CLI 已能安全压缩 acknowledgement，但仍不得据此自动启用 production GC：Linux/路由器、断电和真实存储故障门禁尚未完成。ADR-0082 的“不遗忘 mutation”长期 retention 架构项已由本 ADR 闭环；fresh Owner 与远程产品入口仍保持默认关闭。
