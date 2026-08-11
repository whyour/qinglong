# ADR-0181：Immutable Package Signature Time and Local Publisher Trust Overlap Rotation

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-65、D-138、D-147、D-169、D-170、D-171；ADR-0135、
  ADR-0179、ADR-0180

## 背景

本机 recovery catalog 已能发布并消费签名 Plugin Package，但 publisher trust 仍由
部署者手工覆盖单个 JSON 文件。覆盖没有当前 Owner 复验、耐久审计、generation
并发控制或崩溃恢复；直接删除旧 key 还可能使当前 catalog 中仍由该 key 签名的包全部
无法恢复。

同时，签名 verifier 需要一个 key lifetime 观察时间。若 application 重启时使用当前
墙钟，合法包会在 publisher key 自然到期后变成不可恢复，导致同一 durable
`PackageLock` 的准入结果随重启日期漂移。签名有效性应回答“这个不可变 lock 创建时，
签名 key 是否有效”，而不是“今天该 key 是否仍可签发新包”。

## 决策

### 1. 签名有效期绑定不可变 lock 时间

本机 catalog publish 和 application recovery 都以 `PackageLock.createdAtMs` 调用
`PluginPackagePublisherTrustRegistry.verify()`。OCI staging 已使用相同语义，因此
offline、materialized OCI、本机发布与 Cluster staging 不再因墙钟不同而漂移。

publisher trust 的 `notBeforeMs/notAfterMs` 仍限制新 lock；key 到期后不能签发当前
lock，但不会撤销在有效期内已经形成的 durable lock。安全事件中的紧急撤销是另一种
显式语义，不能偷用自然到期模拟。

### 2. 在既有 package 内提供 generation trust root

不新增 workspace package或第三方依赖：

- `@qinglong/local-admin/package-publisher-trust` 管理本机 trust root；
- `@qinglong/local-owner-cli/package-publisher-trust-command` 提供认证命令；
- `ql3-package-trust` 是短生命周期 CLI，不进入 application 常驻闭包。

trust root 必须是当前 real/effective UID 拥有、非 symlink、规范真实路径、精确
`0700` 的目录。`current.json` 和 generation snapshot 都是 no-follow、当前 UID、
精确 `0600`、最大 256 KiB 的 exact JSON。最多保留 64 个 generation snapshot；
未知或越界文件使整个 authority 失败关闭。

每个 immutable snapshot 记录 generation、前一 snapshot/trust digest、mutation ID、
模式、审计时间、canonical trust 与自身 digest。generation 文件以 hard-link
no-replace 发布，`current.json` 在随后原子提升；目录在可见变更后 `fsync`。

### 3. provision 与 overlap rotate 是认证 Owner ceremony

命令只支持：

```text
plugin-package.publisher-trust.inspect
plugin-package.publisher-trust.provision
plugin-package.publisher-trust.rotate
```

`provision` 只接受 generation 0，并要求至少一个在审计时间有效的 Ed25519 key。
`rotate` 使用 `expectedGeneration` CAS，必须逐字保留全部现有 key，且至少新增一个在
审计时间有效的 key。候选 trust 必须是 deployment root 下的私有 `0600` 文件。

mutation 在任何可见文件变更前复验 credential、User 和 default Project Owner，写入
durable security audit，再次复验 fence。首次执行只生成一次 `occurredAtMs`，同值
同时绑定 audit 与 snapshot；精确 command replay 因而稳定返回 `existing`。

### 4. 崩溃恢复必须由同一 mutation 精确重放

SQLite 审计和文件系统 generation 不是跨介质事务。若进程在 snapshot durable 后、
`current.json` 提升前退出，inspect 只报告低敏
`recoveryRequired/pendingGeneration`，不会自动修复。只有相同 mutation ID、
expected generation、候选 trust 和审计 identity 的命令重放才能提升 current，并
返回 `recovered`；其他 mutation 全部失败关闭。

不增加 watcher、timer、listener、网络访问或后台 reconciliation。edge 路由器的
steady-state application 只在真实 queued stage 时读取 `current.json`。

### 5. 本切片不实现 key 删除、退休或紧急撤销

addition-only overlap rotation 只是安全换钥的第一阶段，不是完整 trust 生命周期。
在允许删除旧 key 前，管理面必须证明所有 current catalog entry 的 signer 影响，
并定义重签、替换、rollback 和崩溃恢复。紧急撤销还必须定义既有 durable lock 是立即
失效、进入 quarantine，还是要求双人 break-glass；不能与自然到期混为一谈。

因此当前 `rotate` 拒绝删除或改写任何既有 key。达到 32 个 runtime key 或 64 个
generation 前必须完成 retirement/revocation Gate，不能靠扩大上限掩盖生命周期缺口。

后续 ADR-0182 已关闭“有 signer 影响证明的正常退休”门，但不改变本 ADR 的
addition-only rotate 约束；紧急 revoke/quarantine 仍未实现。

## 拒绝方案

1. **application 启动时使用当前墙钟验证历史 lock**：让耐久事实随日期漂移，拒绝。
2. **直接覆盖单个 trust JSON**：没有 CAS、审计和恢复证据，拒绝。
3. **通过 rotation 删除旧 key**：未证明 current catalog signer 影响，拒绝。
4. **把 snapshot 放进 SQLite 事务**：文件发布与 SQLite 没有共同事务介质，拒绝。
5. **新拆 trust workspace package**：没有独立部署生命周期，只增加 package 碎片，
   拒绝。
6. **常驻 watcher 自动轮换/恢复**：扩大路由器 idle 成本和常驻 authority，拒绝。

## 当前证据

- 真实 Owner 产品流程完成 trust provision、catalog signed publish/consume、
  addition-only overlap rotate 和低敏 inspect；
- 相同 provision command 精确重放返回 `existing`，snapshot-before-current 故障由
  相同 mutation 重放返回 `recovered`；
- snapshot 与 security audit 共享同一 durable 时间；
- 非 Owner 在生成 `current.json` 前被拒绝，失败只留下低敏 audit；
- 历史 lock 在 key 的当前墙钟有效期已经结束后，仍按 `lock.createdAtMs` 成功 stage；
- 删除旧 key、未知文件、宽权限目录、陈旧 generation 和不同 mutation 恢复均失败关闭；
- local-admin 60/60、local-application 31/31、local-owner-cli 22/22、dependency/source
  boundary 30/30，edge import 121 modules 无越界；
- edge/standalone application 为 4,700,737/4,700,881 bytes、607 files；AI-inclusive
  为 5,378,558/5,378,714 bytes、651 files，全部在预算内；
- PostgreSQL 18.4 arm64 HA Docker 门额外重跑 `gates.passed=true`，timeline 1→2、旧主
  fencing、`pg_rewind` 只读重入、同步复制恢复与双 control replica 全部通过；
- workspace 仍为 22 package，未新增第三方依赖、timer、watcher、socket 或网络能力。

## 后续门禁

1. ~~current catalog signer impact report、旧 key 重签/替换和 authenticated
   retirement~~（由 ADR-0182 完成）；
2. 紧急 revoke/quarantine、双人或 break-glass ceremony、rollback 与恢复；
3. 短生命周期 OCI fetch authority 与 publisher metadata/update channel；
4. 固定低配 Linux 路由器上的断电恢复、闪存写入和 64-generation 容量证据；
5. Cluster 对等的双人 trust ceremony；本机 Owner CLI 不能管理 Cluster trust。
