# ADR-0187：Cluster Plugin Package 发布者 Provenance 与撤销影响集

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-137、D-140、D-175、D-176、D-177；
  ADR-0135、ADR-0137、ADR-0140、ADR-0185、ADR-0186

## 背景

ADR-0186 已能对一个已知的 exact installation/lock 原子撤出 Task 与 Tool，但 Cluster
安装事实没有保存 OCI bundle 验签时的 publisher/key。仅凭 package 名、registry 或
当前 trust 文件无法证明某个历史 install 由哪个 key 签名，也无法在 key 泄露时生成
完整且可重放的影响集。

同时需要覆盖两个竞态：

1. revocation 扫描结束后，并发 stage 才提交，导致影响集漏项；
2. receipt 已提交而大量 quarantine 尚未物化时，新 Run/Tool 或 recovery 再次发布
   已撤销能力。

管理 API 的 identity assertion keyset 只认证调用方，OCI publisher trust 认证包内容。
二者属于不同信任域，不能共享 ledger 或用其中一个替代另一个。

## 决策

### 1. control-core v37 保存 installation 绑定的不可变 provenance

`pg-0038-plugin-package-publisher-provenance` 新增：

- `plugin_package_publisher_provenance`；
- `plugin_package_publisher_revocation_receipts`；
- `plugin_package_publisher_revocation_impacts`；
- `plugin_package_publisher_revocation_impact_items`。

provenance 绑定 project/package/installation/lock、artifact/manifest/content/stage evidence、
publisher/key/signature、key lifetime、verified time 与自身 digest。表只追加；
installation 和 digest 均唯一。

`ql3_plugin_package_stage_provenance_guard` 在数据库层要求 `queued→staged` 已存在与
install lock、stage receipt 完全一致的 provenance。生产 recovery 使用一个装饰
repository，在同一事务内先插 provenance、再更新 install 和 mutation；旧 direct
repository 因 trigger 失败，不能绕过。

### 2. stage 与 revocation 使用同一 signer advisory lock

stage commit 和 `recordRevocationImpact` 都按 canonical `(publisher,keyId)` 取得相同
PostgreSQL advisory transaction lock。

- stage 在锁内检查 signer 未撤销，然后提交 provenance 与 install transition；
- revocation 在锁内复验 authorization，写 immutable receipt，并快照当前
  `staged|activating|active` install head；
- impact 最多 4096 项，按稳定 identity 排序，绑定每项 provenance digest 和数据库
  generated time；
- 同 receipt/mutation 重放返回同一 impact，任何字段漂移均冲突。

因此 impact 不会漏掉已经能够执行的并发 stage。后续新 stage 会看到 durable receipt
并失败。

### 3. v36 数据先回填，未收敛前不开放 admission

Cluster startup recovery 先分页查找当前 staged/activating/active 且缺 provenance 的
install，重新通过 stage authority 验证 durable bundle evidence，再写 exact provenance。
扫描有硬页数和页大小；仍有剩余时抛出专用 provenance recovery required error，
不进入普通 Package recovery、Task/Tool publication 或 admission。

该回填不猜 signer，也不接受 request body 自报 publisher。找不到 lock、stage evidence
或可信 bundle 时失败关闭。

### 4. receipt 先关闭启动门，withdrawal 后台有界收敛

v37 替换 D-176 的 Run/Tool guard：除 quarantine event 外，还从 reconciliation/snapshot
source 回溯 provenance；匹配任意 durable publisher-key revocation receipt 即返回 false。
runtime 仍只有两个布尔函数的 EXECUTE 权限，没有四张新表的 SELECT。

Task reconciliation pending/direct commit 和 Tool snapshot current/source/pending 查询均
排除 revoked provenance。这样 receipt 提交后，即使 quarantine 需要多批处理，也不会
重新发布受影响 Package。

`@qinglong/cluster-admin/plugin-package-publisher-revocation` 是短生命周期 composition：

1. readiness；
2. 原子创建或重放 receipt/impact；
3. 每批最多 128 个 current target 生成 D-176 event；
4. 每个 quarantine 事务重新确认 authorization；
5. 跳过任何已隔离 target 与已被新 install head 取代的历史 item；
6. 到达页预算时返回 `remaining=true/safeToAdmit=false`，允许相同 receipt 重跑。

不新增 listener、timer、controller 或 workspace package。

### 5. 权限与包边界

四张表先对 PUBLIC 和全部应用角色撤权，只给 `ql3_package_executor`
`SELECT,INSERT`；trigger function 对所有应用角色无直接 EXECUTE。schema readiness
精确验证函数 owner、security-definer 标志、volatility、`search_path`、PUBLIC ACL 和
各角色权限。

实现保留在：

- `runtime-core`：纯 provenance/receipt/impact contract；
- `cluster-postgres`：migration、schema、readiness、repository；
- `cluster-admin`：OCI evidence、startup recovery、短生命周期 producer。

workspace 仍为 22 包，符合 ADR-0185；Edge/Standalone 制品不导入 Cluster 代码。

## 不采用方案

### stage 后异步补 provenance

进程崩溃或 COMMIT 不确定时会留下 active install，却无法证明 signer。数据库 trigger
必须让 provenance 成为 staged transition 的前置事实。

### 先扫描 impact，再单独写 revocation

扫描与 receipt 之间的并发 stage 会漏项。共享 signer advisory lock 把两条路径串行化。

### 等 quarantine 全部完成后再拒绝启动

4096 项影响集不应放进一个超大事务；但分批期间不能继续启动。receipt-first guard
提供立即 deny，D-176 overlay 再负责持久能力撤出。

### 复用管理 identity keyset ledger

它认证管理调用方，不认证 OCI artifact。复用会混淆 issuer、lifetime、rotation 和
审计语义。

### 新增 provenance workspace package

该领域没有独立制品、进程或第三方依赖边界；subpath 已足够，新增包只会扩大低配设备
的 lockfile/build/供应链成本。

## 验收证据

- runtime-core publisher provenance contract：3/3；
- PostgreSQL v37 migration + strict readiness：34/34；
- Cluster recovery/process 相关测试：10/10；
- 三个涉及包的 TypeScript check 全通过；
- PostgreSQL 18.4 Debian arm64 physical-streaming HA：
  - 旧 direct `queued→staged` 被 trigger 拒绝；
  - provenance 与 staged install 改为同事务后正常激活；
  - revocation receipt、impact、impact item 各 1；
  - quarantine 物化前 Run/Tool guard 已由 true 变 false；
  - quarantine COMMIT 响应丢失后 event/withdrawal exact-once；
  - `remote_apply`、timeline 1→2、旧主 fence、`pg_rewind`、同步 rejoin 后上述事实与
    deny fence 均持续；
  - 最终 `gates.passed=true`。

## 后续

1. 已由 ADR-0188 将 receipt 接入正式 Cluster 双人/break-glass 管理 transport、
   durable trust generation 与 Approved Action executor；request body 不得自报 trust
   transition；
2. 为 4096 项跨 Project 大 impact 增加 operator 进度与限流指标，但保持单 target
   quarantine 事务的 Project 锁边界；
3. 补充真实 registry trust rotation/revocation ceremony 与发布者 trust durable
   source；不得把管理 assertion ledger 当作替代品。
