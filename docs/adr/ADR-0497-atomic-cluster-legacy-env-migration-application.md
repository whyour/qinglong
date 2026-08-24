# ADR-0497：Cluster Legacy Env 的原子 Task/Trigger 迁移与只追加回执

- 状态：Accepted
- 日期：2026-08-24
- 决策：D-402
- 关联：ADR-0104、ADR-0233、ADR-0259、ADR-0491、ADR-0495、ADR-0496

## 背景

ADR-0495 冻结了无敏感内容的 Cluster migration plan，ADR-0496 又让 Task 与执行修订只需保存
一个固定版本的 `environmentBundleRef`。此前仍缺少真正提交计划的 authority：如果分别调用现有
Task 与 Trigger repository，会开启两个独立事务，出现 Task 已改而 Trigger、schedule 或 receipt
尚未提交的裂脑窗口；如果一次把 100,000 个 Task 和 500,000 个 Trigger 全部装入 JS 数组，又会
让 Automation Manager 在低内存节点上不可用。

迁移还必须处理合法的历史 pin：Trigger 可能仍固定 Task r1，而 Task 当前 head 已推进到 r2。
新 Trigger 应固定本次迁移产生的 Task r3，不能错误假设旧 Trigger pin 等于 Task current head。

## 决策

### 1. 使用可重放流与双摘要冻结输入

新增 profile-neutral application contract 与
`qinglong/cluster-legacy-env-migration-application-receipt@v1`。调用方提供可重放的 Task/Trigger
mutation stream；每项包含 ordinal、实体身份、旧 revision/content digest 和独立 UUID mutation。
Task 与 Trigger 分别计算 source revision-set digest 和 mutation-set digest：前者必须匹配已发布
plan，后者必须匹配 application intent。

流必须从 ordinal 0 连续、按 Task/Trigger ID 严格递增，不允许重复、未知字段、非规范 UUID 或
超过 100,000/500,000 项。Task/Trigger ID 延续现有定义契约的 128-byte、无控制字符边界，不用
更窄的 ASCII 正则误伤合法历史数据。Trigger 可以为空，但 Task 至少一个。

### 2. 一个 Project-serialized SERIALIZABLE 事务完成全部写入

Automation Manager repository 先开启 `SERIALIZABLE`，取得 domain-separated Project advisory
transaction lock，再验证 active Project、plan ID/digest 和 exact mutation replay。每批最多只保留
128 项，先完整处理 Task，再处理 Trigger；任何流摘要、head、ownership、spec 或 CAS 不一致都会
回滚 receipt 和全部 revision DML。

Task 阶段对每个 current head 执行 `FOR UPDATE`，拒绝 Plugin-owned、非 `command@v1`、已有
`environmentBundleRef`、revision/digest 漂移和数据库时间倒退；新 revision 保留 name、description、
command config、labels、enabled 与 created time，只追加 plan 中的固定 bundle ref。enabled Task 同时
生成新的 `remote_worker` Cluster execution revision，数据库只保存 ref，不保存 Env 名称或值。

Trigger 阶段复验 current Trigger revision、旧 Task pin 和 schedule revision，保留 spec 与 enabled，
但绑定同 application 中该 Task 的新 revision/content digest。新 Trigger revision、head CAS 与
schedule reset 同事务提交；schedule 清空 due/claim 字段并递增 state/claim fence。旧 Trigger pin
可以是历史 revision，不要求等于 Task 迁移前 current head。

### 3. v70 提供三张只追加、无敏感内容的回执表

`pg-0071-cluster-legacy-env-migration-applications` 将 control contract 推进到 v70，新增：

- `cluster_legacy_env_migration_application_receipts`：application/plan/mutation、四个 set digest、
  固定 bundle ref、计数、数据库提交时间和精确 canonical receipt JSON；
- `cluster_legacy_env_migration_application_tasks`：每个 Task 的 before/after revision digest、mutation、
  可选 execution digest 和 item digest；
- `cluster_legacy_env_migration_application_triggers`：每个 Trigger 的 before/after revision、旧 Task pin、
  新 Task pin 和 item digest。

表中没有 Env name/value、bundle carrier、plaintext/ciphertext、key ID、Task/Trigger spec、命令或
provider path。application/plan/mutation/receipt 唯一，ordinal 与 revision 关系有 named constraints；
子表通过 `(application_id, project_id)` 复合外键隔离 Project，Trigger item 又通过复合外键固定到
同 application 的 Task item。三表均从 PUBLIC 撤销，只向 `ql3_automation_manager` 授予
`SELECT, INSERT`，不授予 UPDATE/DELETE/TRUNCATE。

### 4. Exact replay 不重新消费输入流

相同 application mutation 先读取 durable receipt，精确比较 intent，然后聚合验证 Task heads、
Task/execution revision、Trigger heads/revision 和 schedule 仍与逐项 receipt 一致。验证成功直接返回
`existing`，不调用 Task/Trigger stream factory；intent drift、receipt 缺项、ordinal gap 或 current
head 已继续推进均失败关闭。序列化、死锁和 lock timeout 使用新 stream factory 最多重试三次。

### 5. 不为该能力新增微包或 Edge 常驻成本

纯契约位于既有 `runtime-core` 的显式 subpath，PostgreSQL authority 位于既有
`cluster-postgres` 显式 subpath；不进入 runtime/admin/root entrypoint，不新增 workspace package、
生产依赖、daemon、controller、timer、watcher 或全集缓存。低内存 Cluster 节点只承担固定 128 项
batch；Edge/Standalone 默认 import graph 不加载 PostgreSQL authority。

## 被拒绝的替代方案

### 分别调用 Task 与 Trigger repository

拒绝。两个事务无法保证 Task、Trigger、schedule 和 receipt 原子，response loss 也无法证明哪一半
已经提交。

### 先收集全部候选再写数据库

拒绝。100,000/500,000 上限会把路由级设备或小型管理节点变成内存压力点；可重放有序流和固定 batch
已经能在事务回滚后重新计算摘要。

### 要求 Trigger 旧 Task pin 等于 Task current head

拒绝。不可变 Trigger 合法固定历史 Task revision；只需复验该旧 pin，并把新 Trigger 显式重定向到
本次 application 产生的新 Task revision。

### 把 Task/Trigger spec 或 Env 名称写进 receipt

拒绝。revision 本身已经保存规范 spec；receipt 只需要 identity、digest、count 和 fence，复制内容会
扩大 PostgreSQL backup、HA replica 和审计泄漏面。

## 当前验证与后续门禁

runtime-core 完整测试 `591/591`；cluster-postgres package 测试 `361 total / 358 pass / 3
conditional skip / 0 fail`；v70 migration/schema/readiness 定向门 `74/74`。真实 PostgreSQL 18.6
arm64 HA 多次通过 146 gates，timeline `1→2`；最终报告 SHA-256 为
`42ca97de43cfebd4611282b1fd5c0b09030eda89e88144967497902b01d18b3a`。

真实数据库用例证明：带空格的合法 Task/Trigger ID 可迁移；Trigger 固定 Task r1、Task current r2
时会原子生成 Task r3 与 Trigger r2 并让新 Trigger 固定 r3；execution plan 只出现 bundle ref；
schedule fence 递增且 claim/due 清空；exact replay 不消费 stream；Automation Manager UPDATE 以及
runtime/admin SELECT 均以 `42501` 被拒绝。

本 ADR 关闭 D-402 的 Cluster Task/Trigger application/receipt 边界，但 ADR-0491 仍保持 Proposed。
后续仍必须完成 direct Vault/KMS/HSM custody、migration Job 的短期身份与装配、在 PostgreSQL
promotion **之后**对既有 application receipt 执行 exact replay，以及固定低性能 Edge 设备的真实
空间、写放大、断电与恢复证据。
