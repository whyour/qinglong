# ADR-0498：Cluster Legacy Env application 的 HA 晋升后精确重放

- 状态：Accepted
- 日期：2026-08-24
- 决策：D-403
- 关联：ADR-0092、ADR-0094、ADR-0491、ADR-0495、ADR-0496、ADR-0497

## 背景

ADR-0497 已让 Automation Manager 在一个 Project-serialized `SERIALIZABLE` transaction 中提交
Legacy Env plan、Task/Trigger 新 revision、execution revision、schedule reset 与只追加 application
receipt。此前 PostgreSQL HA 门只能证明通用 migration、role/readiness 及其他领域状态跨 timeline
晋升存活，尚未证明这一新 application 的首次提交已同步复制，也未证明晋升后的同一 intent 会读取既有
receipt，而不是重新打开大规模 mutation stream 或追加第二组 durable state。

通用 HA 成功不能替代领域重放。若 promotion 后只检查表存在，Task/Trigger head、execution digest、
schedule fence 或逐项 receipt 仍可能漂移；若重放重新消费最多 100,000/500,000 项的输入流，则恢复成本
不再有界，也可能把“检查既有提交”退化成第二次迁移。

## 决策

扩展既有 PostgreSQL 18 physical HA contract，不新增 workspace package、生产依赖、daemon、controller、
timer、watcher 或部署资源。领域逻辑放在独立
`scripts/ql3-postgres-ha-legacy-env-application-fixture.cjs`，14,000 行以上的 HA orchestration 只保留
fixture import、主库调用、晋升后调用、report 与 gate 装配。

门禁固定执行以下顺序：

1. 主库与 standby 已进入 `synchronous_commit=remote_apply`、`sync_state=sync` 后，以 migration authority
   建立 active Project、Task r1、固定 Task r1 的 disabled cron Trigger r1，再把 Task 推进到 r2；
2. 以 `ql3_automation_manager` 发布 content-free plan，并通过 ADR-0497 repository 原子生成 Task r3、
   Trigger r2、execution revision、schedule reset 与 application receipt；
3. 在 standby 仍处于 recovery 时读取 17 项 content-free facts，要求与主库完全相同，然后才允许制造
   replication partition、fence 旧主库和 promotion；
4. promotion 后先以 `pg_rewind --write-recovery-conf` 把旧主库作为同步 standby 重接，恢复
   `remote_apply` 写入能力，再使用新的 Automation Manager Pool 重放完全相同的 application intent；
5. replay 必须返回 `existing`，Task/Trigger mutation stream factory 均不得被调用，receipt、逐项 ledger、
   Task/Trigger revision、execution digest 与 schedule fence 必须逐字段不变，新增 durable row 必须为 0。

Trigger fixture 保持 disabled，避免给 HA contract 中独立 scheduler failover 场景增加第二条合法可领取的
schedule；它仍真实创建并迁移 cron schedule，因此会验证 revision、state/claim fence 与 reset。

## 证据边界

私有 HA report 只包含计数、revision、state/claim version 与 SHA-256 digest，不包含 Project/Task/Trigger
ID、SecretRef、Env name/value、row body、ciphertext、key ID、数据库 DSN 或 credential。evidence audit
现在强制要求三份事实对象只有固定 17 个 key、逐字段相同，并要求：

- `replicatedBeforePromotion=true`；
- `exactReplayAfterPromotion=true` 且 `replayStatus=existing`；
- `mutationStreamsOpenedAfterPromotion=0`；
- `durableRowsAddedByReplay=0`；
- 两个新增 timeline state 位于同步复制之后、partition/promotion 的正确顺序；
- 缺证据、字段扩张、digest 非法、facts 漂移、SecretRef marker 泄漏或 gate 为 false 都失败关闭。

本 ADR 不声明 direct Vault/KMS/HSM custody，也不证明固定低性能 Edge 设备的空间、写放大或断电恢复；
这两项仍是 ADR-0491 转 Accepted 前的独立门禁。mounted-files live rotation 也不能替代直接外部 custody。

## 验证

PostgreSQL 18.6 arm64 physical HA 通过 `147/147` gates，timeline `1→2`。主库提交、standby WAL
投影与晋升后 replay 的 17 项 facts 完全一致；replay 返回 `existing`，mutation stream 打开次数与新增
durable row 都为 0。独立 evidence audit 返回 `compatible=true`、`findings=[]`。最终私有报告
SHA-256 为 `8bb61bc126ba96e7d4e20b1bfad4db960768c03473744d9d24e11b1b5b1a9286`。

本切片没有修改 production source、PostgreSQL schema/migration/ACL、package topology、依赖树、镜像或
Edge/Standalone import graph；完整 backend 为 `1569 total / 1567 pass / 2 conditional skip / 0 fail`，
package/Cluster dependency/122-module Edge/service bridge 边界均 compatible。基础 Edge/Standalone
仍只包含 Local SQLite、runtime-core 与 SemVer，均为 325 files/58 modules，大小为
`2,669,390 / 2,669,468 bytes`，距 4 MiB 上限保留 `1,524,914 / 1,524,836 bytes`。这些结果只证明
常驻闭包未被 D-403 扩大，不冒充固定低性能设备的真实断电/写放大证据。D-403 把 ADR-0497 已有领域
语义提升为 promotion 后可验证的发布证据。
