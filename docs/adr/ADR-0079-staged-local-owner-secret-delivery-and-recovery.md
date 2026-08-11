# ADR-0079：本机 Owner Secret 分阶段交付与崩溃恢复

- 状态：Proposed（安全核心与 Owner ceremony 产品 CLI 已实现；fresh setup 和实机门禁待完成）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-27、D-76、D-77、D-78
- 关联 ADR：ADR-0075、ADR-0076、ADR-0077、ADR-0078

> ADR-0087 现行增量：原 `@qinglong/local-owner-bootstrap` 与 `@qinglong/local-owner-credential-recovery` 已物理合并为无聚合根入口的 `@qinglong/local-owner-ceremony/bootstrap` 与 `/credential-recovery`；本文中的旧包名保留为当时实现证据，现行依赖与权限门禁以新 subpath 为准。

## 上下文

本机 Identity provisioning 和 Owner challenge 都只在数据库保存 domain-separated digest。若数据库事务已经提交，而进程在把一次性明文交给部署用户前退出，digest 无法恢复 secret；若 exact replay 再生成 secret，又会让数据库事实与返回值分叉。

先提交数据库、再 best-effort 写文件不能关闭该窗口。反过来直接把临时文件 rename 到目标名又可能覆盖同 mutation 的既有交付事实。协议还必须适用于性能很小的路由设备：不得引入 watcher、timer、第二 SQLite 连接、无界扫描或常驻 secret cache。

## 决策

### 1. Secret delivery 是 bootstrap service 的显式端口

`LocalOwnerBootstrapSecretDelivery` 只提供 `prepare(candidate)` 与 `publish(prepared)`。service 在数据库事务前调用 prepare，并以返回的 canonical record 计算 credential/challenge digest；事务返回后逐字段核对 identity、digest 与 TTL，再调用 publish。

配置 delivery 后，provision/issue 响应无论首次还是重放都返回 `token: null`。未配置 delivery 的单元/内部组合能力保留“仅首次返回”语义，但不能作为产品入口。

prepare 可以为相同 mutation/request/TTL/project 返回既有 record，使响应丢失后的新进程使用同一 secret 和 identity；mutation 语义不同必须冲突。数据库 replay 对 issuer 只比较稳定 subject、authentication ID 与 assurance，不比较每次启动都会变化的认证时间窗口；不同 authentication ID 仍拒绝。

### 2. 使用专用私有、有界 outbox

delivery directory 必须是 deployment root 下专用的真实 `0700` 目录，由当前 POSIX UID 拥有，并在 console 激活期间按 device/inode/uid/mode/type 复核。数据库和 pepper 不得位于该目录内。

正式文件名固定为：

- `credential-<mutation UUID>.pending.json`
- `credential-<mutation UUID>.ready.json`
- `challenge-<mutation UUID>.pending.json`
- `challenge-<mutation UUID>.ready.json`

record 必须是当前 UID 拥有、无 symlink、最多 4 KiB 的 `0600` 普通文件；字段 exact-shape，secret/identity/mutation/TTL 使用领域 canonical validator。目录最多扫描 64 项，出现未知名称或超限即 fail closed。orphan 临时文件只计数，不在 authority 启动时自动删除。

### 3. Prepare 先耐久化，再允许数据库提交

prepare 在同一目录以随机、不可预测名称和 `O_CREAT|O_EXCL|O_NOFOLLOW` 创建 `0600` 临时文件，写完整 canonical record 并 fsync 文件。随后以 hard link 将临时 inode no-replace 发布为 pending，fsync 目录，再移除临时名称。

hard link 的 `EEXIST` 只能表示并发 winner；实现必须重新读取 winner，并验证请求语义一致。其他错误全部 fail closed。这样数据库调用只会发生在完整、耐久的 pending 已可恢复之后。

### 4. Publish 由数据库事实授权

数据库提交后，service 必须验证 repository 返回的 subject/credential/challenge ID、digest 和 TTL 与 prepared record 完全一致。验证通过后，publish 以 hard link 将 pending inode no-replace 发布为 ready，fsync 目录，重新读取并验证 ready；若 pending 仍存在，还必须证明 pending/ready 是同一 device/inode，才移除 pending 并再次 fsync 目录。

既有 ready 只有在内容与 prepared record 完全一致时才视为幂等成功。协议不得覆盖 ready，也不得把 secret 写入 stdout、argv、env、日志、错误或 SQLite。

### 5. 启动恢复以 SQLite 事实作最终裁决

console 打开专用 bootstrap SQLite authority 后、创建业务 service 前，串行检查目录内所有 pending 和 ready：

- pending 没有对应数据库事实：保留，允许同 mutation exact retry 使用；
- pending 与数据库 provisioning/issue 事实完全一致：执行 publish；
- ready 与数据库事实完全一致：接受；
- ready 没有数据库事实，或任一 record 的 request、identity、digest、TTL、权限、类型、内容不一致：拒绝启动。

恢复只使用同一 SQLite connection/queue，不建立 watcher、timer、后台清理器或第二 authority。summary 只包含 inspected/published/retained/orphan 低敏计数。

### 6. Ready 的消费确认由 ADR-0081 继续约束

ready record 是私有交付 outbox，不是长期 SecretStore。ADR-0081/0082 已实现精确 delivery digest inspect、数据库事实绑定 acknowledge、文件 ack→SQLite ledger→ready/文件 ack 清理，以及崩溃窗口恢复；未确认的 ready 仍不会被启动流程猜测或自动删除。ADR-0084 已完成 versioned tombstone retention/GC；ADR-0086 的独立 `ql3-owner` 在 console 内部消费 credential/challenge ready record 完成 claim，不把 secret 送回 transport，并在文件确认删除后从数据库事实精确重放。`@qinglong/local-owner-console` 自身继续没有 `bin`。

## 崩溃窗口

| 窗口 | 重启后结果 |
| --- | --- |
| 临时文件完整前退出 | 只有 orphan temp；数据库未调用，低敏计数暴露运维债务 |
| pending 发布后、数据库调用前退出 | pending 无数据库事实并保留；exact retry 复用 |
| 数据库事务失败 | pending 保留；不同语义重试冲突，相同语义可继续 |
| 数据库提交后、publish 前退出 | recovery 核对 digest/identity/TTL 后发布 ready |
| ready link 后、pending unlink 前退出 | recovery/publish 验证同 inode 后完成清理 |
| 响应前退出 | ready 保持；新进程 exact replay 返回 existing/null |

## 被否决的替代方案

1. **提交后普通写文件**：ENOSPC 或退出会永久丢失一次性 secret，拒绝。
2. **从 digest 恢复或重放时重新生成**：密码学上不可恢复，重新生成又与数据库 digest 不一致，拒绝。
3. **rename 覆盖目标**：可能改写既有 mutation 的交付事实，拒绝。
4. **把 plaintext 存 SQLite journal**：数据库泄漏面扩大，并破坏 digest-only 边界，拒绝。
5. **启动时删除无数据库 pending**：无法区分数据库调用前崩溃与用户主动放弃，破坏 exact retry，拒绝。
6. **后台 watcher/清理 timer**：增加常驻资源和竞态，不适合 edge，拒绝。
7. **把该协议复用于 cluster**：多节点共享文件系统不提供同等 authority；cluster 继续使用独立管理面和 Secret Manager，拒绝。

## 验收证据

1. `@qinglong/local-owner-bootstrap` 8 项测试覆盖稳定 principal 跨进程重放、不同 authentication identity 冲突、一次性 secret 语义与原子 claim。
2. `@qinglong/local-owner-console` 19 项测试覆盖完整 ceremony、预提交 pending、credential/challenge 提交后发布失败恢复、响应丢失 replay、transport-free claim 与文件删除后数据库事实重放、私有 mode、digest/账本篡改、并发确认、ENOSPC/EROFS 注入和 64 项瞬时目录预算。
3. delivery 启用时所有 provision/issue 响应均为 `token: null`；SQLite 文件不包含 credential/challenge plaintext。
4. composition root 仍无 `bin`、listener、timer、watcher、第二 SQLite connection，默认 runtime/application 不导入该 authority。

## 未完成项

ready 消费确认、安全删除、SQLite acknowledgement ledger、独立有界 pepper keyring、catalog/active CAS、Runtime exact-key authentication、同 key material recovery、credential-version key provenance、ack-first credential rollover/revoke、bounded pepper reference inspection、版本化双材料 GC、可恢复 acknowledgement tombstone retention/GC 与 Owner ceremony CLI 已由 ADR-0081/0082/0080/0083/0084/0086 完成。fresh database/pepper setup、真实断电/ENOSPC/只读文件系统故障注入、Linux rootless/root 容器 volume ownership、固定路由设备 RSS/闪存写放大和完整运维文档仍未完成。
