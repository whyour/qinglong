# ADR-0166：Trusted Tool Result Key Catalog 与 Completion Fence

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0159、ADR-0163 至 ADR-0165；RFC D-150 至 D-155

## 背景

ADR-0163 已将 Trusted Tool 成功 output 密封为 Result Artifact，但 v1 只把 `keyId`
写进 Artifact 和 completion。若 Profile 仅从文件、环境变量或 KMS 按名称取得当前
密钥，数据库无法证明完成事务使用的 key 在事务提交时仍处于 active generation；
轮换与并发完成可能错绑，重启后也无法区分可解密旧 key、已退役 key 和明确丢失的
key。

QingLong 同时运行于低配路由设备和集群节点。方案必须让 SQLite 保持单连接、无后台
轮询，让 PostgreSQL 多副本共享同一 authority；也不能把原始密钥材料写进业务库，
或为了少量协议和 repository 再拆单文件 package。

## 决策

### 1. 数据库只保存无密钥材料的 append-only catalog

runtime-core 在既有包内新增显式 subpath
`@qinglong/runtime-core/tool-result-key-catalog`。固定 authority
`trusted-tool-results` 的每一 generation 保存：

- `keyId`、状态和上一 generation；
- `active | decrypt_only | retired | lost` 状态；
- 对外部 key provider 所持材料的 domain-separated HMAC-SHA256 proof；
- canonical command、command digest、mutation identity 和时间。

catalog 不保存原始 key、wrapped key、KMS credential 或文件路径。原始材料继续由
Profile 的私有文件、硬件/KMS 或其他受审 provider 管理。Repository 读取历史行时必须
重新规范化 command 并验证 digest，不能信任可漂移的数据库投影。

合法状态转换为：

1. 首代 `bootstrap` 建立唯一 active key；
2. `rotate` 把旧 active key降为 `decrypt_only`，同时建立新 active key；
3. `mark_lost` 明确记录 provider 无法取得的 key；
4. `restore` 只恢复为 `decrypt_only`，不能静默夺回 active authority；
5. `retire` 必须绑定 repository 生成的 retirement receipt，并在 catalog mutation 的
   同一事务中验证 receipt 的 authority、catalog generation、key ID、binding/head
   覆盖数量和摘要。

产品 composition 仍不得把 admin mutation authority 暴露给 runtime 或 transport。
调用方提供的任意 64 字符 digest 不构成退役证明。

### 2. 成功完成必须绑定 exact catalog generation

成功 completion command 升级为 v2，并携带
`resultKeyCatalogFence={authority,generation,keyId,entryDigest}`。协调器密封结果前：

1. 读取当前 catalog，并要求目标 key 为唯一 active；
2. 从外部 provider 取得 owned key；
3. 以 catalog 的 material proof 验证取得的是 exact key bytes；
4. 生成 Result Artifact，并让 Artifact `keyId`、completion fence 完全一致。

双方言 completion repository 必须在原有成功事务内再次读取当前 catalog，只有 fence
仍等于当前 generation 才能同时写入 Artifact、Completion 和不可变
ResultKeyBinding。轮换抢先提交时旧 fence 失败关闭，调用方必须重新取得 active key，
不得以旧 key 完成。

读取历史结果时先查询当前 rekey head。存在 head 时必须验证 immutable overlay chain、
target catalog fence 和 provider material proof 后解封 overlay；head/overlay 损坏时
不得回退原 Artifact。不存在 head 时才通过原 binding 定位创建时 generation。两条路径
都只接受 `active` 或 `decrypt_only`；`retired`、`lost`、缺行、digest 漂移或 binding
漂移都失败关闭。

### 3. 双方言使用各自最小并发原语

SQLite 使用短 `BEGIN IMMEDIATE` 串行化 catalog append 和 completion fence 检查；
PostgreSQL 使用 SERIALIZABLE transaction，并在 catalog mutation 和 completion
事务中取得同一个 transaction advisory lock。两者都保留完整命令 exact replay，
不得覆盖历史 generation。

SQLite migration stream 推进到 68 条、capability v34、60 张受管表；PostgreSQL
推进到 36 条、`control-core` capability v35、58 张表。PostgreSQL 权限保持分离：

- runtime 只能读取 catalog 与 rekey overlay/head，并对 ResultKeyBinding
  `SELECT, INSERT`；
- admin 只能通过显式 subpath append catalog/overlay/head/receipt；
- Package manager、Package executor、Worker ingress 和 PUBLIC 均无 catalog mutation
  authority。

cluster runtime composition 只装配 read-only reader；admin repository 不进入
cluster-control。local lazy runtime bundle 同样只暴露 reader，避免仅因 catalog 存在
而赋予路由设备运行时轮换或退役权限。

rekey repository 只追加 overlay revision，以 expected head 做 CAS；coverage receipt
按 64 行 keyset page 扫描 immutable binding 与当前 head，以常量额外内存生成摘要，
并使用数据库时钟。PostgreSQL rekey 与 catalog retire 使用同一 advisory lock 和
SERIALIZABLE transaction；SQLite 使用同一 `BEGIN IMMEDIATE` authority。两者都在
写入前复验 source Artifact/binding、target active catalog 和当前 head。

### 4. 不新增 workspace package

纯 contract、SQLite adapter 和 PostgreSQL adapter分别留在既有
runtime-core/local-sqlite/cluster-postgres package，通过显式 subpath分权。它们没有
独立部署、版本或依赖边界，拆成单文件 package 只会增加低配设备的安装元数据、构建
图和集群供应链审计面。

## 被否决方案

1. **只相信环境变量中的 current key ID**：数据库无法证明完成事务与轮换的先后。
2. **把 raw/wrapped key 写入 catalog**：扩大数据库备份、复制和运维读取的泄露面。
3. **完成事务只保存 key ID**：同名 key 被替换后无法证明历史密文对应哪组 bytes。
4. **轮换时立即删除旧 key**：历史 Result Artifact 会在 rekey 前不可恢复。
5. **原地改写 Artifact 密文**：会破坏 append-only completion、Artifact digest 和
   审计证据。
6. **仅凭调用方 receipt digest 允许 retire**：字符串格式不是 rekey 完成证明；必须
   读取并验证 durable receipt。
7. **为 catalog contract/repository 分拆新 package**：没有真实部署边界，却增加 edge
   和 cluster 的依赖树及发布面。

## 验证

- runtime-core：343/343，覆盖 catalog 转换、material proof、completion v2 fence、
  轮换竞态、lost/retired 拒绝、restore 只能恢复 decrypt-only，以及 append-only rekey
  overlay 的 revision/head fence、AES-GCM、source Artifact/binding、target catalog fence、
  反字典序 catalog canonicalization、历史 completion 优先读取 durable overlay 和显式
  subpath；
- local-sqlite：124/124，覆盖 catalog/rekey append、exact replay、rotation、stale
  generation/head、coverage receipt、同事务 retire、typed schema、checksum、readiness
  与 runtime 只读装配；
- cluster-postgres：188 pass/1 条件 skip，覆盖共享 advisory lock、SERIALIZABLE
  retry、durable overlay/head、常量内存 coverage receipt、catalog retire 同事务校验、
  reader/admin 入口分权、权限矩阵、typed schema、checksum 和 readiness；
- cluster-control：139 pass/2 条件 skip，确认同一 Pool runtime 只取得 catalog/rekey
  reader，且不暴露 append；
- package 数量和第三方依赖均未因本决策增加；清空全部 `dist` 后的 21-package
  拓扑 build/test 总门整体退出 0。

全新 PostgreSQL 18 六角色真库 integration 为 42 pass/1 条件 skip，直接覆盖一个
durable binding 从 A→B 追加 overlay、数据库生成 binding/head 覆盖 receipt、A retire，
以及 runtime reader 读取 durable head。

当前 36 条 migration 又在 PostgreSQL 18.4 arm64 物理 HA 总门中从空库执行。fixture
通过真实 runtime repository 创建 Run、StepRun 和 start barrier。第一个 completion
在已经读取 catalog A 后暂停；A→B rotation 的 `COMMIT` 已由 driver 确认后 backend
被终止，调用方收到 `ECONNRESET`，普通 catalog repository exact replay 收敛为
`existing`。释放旧 completion 后，其 A fence 被事务内复验拒绝，Completion 和
ResultKeyBinding 计数都为 0，StepRun 仍为 running，Run version/event sequence
仍为 2/2。

以 B 发起的第二次安全读取在 completion `COMMIT` 确认后使用相同响应丢失故障；统一
completion coordinator 直接检查并解封 durable winner，返回 `existing`，获胜尝试
adapter 只执行 1 次，竞争与重试合计 2 次。随后 B→C overlay 的事务也在确认
`COMMIT` 后丢失响应，普通 rekey repository exact replay 收敛为 `existing`。数据库
生成的 receipt 精确得到 `bindingCount=1`、`overlayHeadCount=1`，B retire 后先在
primary 由统一 coordinator 以 C 解封；全部事实经 `remote_apply` 复制并在 timeline
1→2 promotion 后再次以 C 解封，两个 reopen 的 adapter 执行次数都保持 0。

旧主 fencing、双 control replica 重建、`pg_rewind` 只读回加入与总 `passed=true`
保持成立。该门已经覆盖 catalog rotation/completion 的精确赢家裁决、stale completion
零部分写入、catalog/completion/rekey 三个 repository/coordinator
COMMIT-response-loss 窗口、WAL、promotion 和 durable winner reopen；fault 位于
PostgresClient 边界，不冒充 raw PostgreSQL wire packet-loss。

SQLite 进一步增加真实文件和子进程 `SIGKILL` crash 矩阵，不在 production repository
中植入 failpoint。Edge 使用受审 `journal_mode=DELETE`、Standalone 使用
`journal_mode=WAL`，两者均保持 `synchronous=FULL`。每种 Profile 覆盖 10 个窗口：

1. completion 已密封但尚未 `BEGIN IMMEDIATE`、最后 ResultKeyBinding 已写但尚未
   `COMMIT`，以及 `COMMIT` 已完成但调用方未收到响应；
2. rekey overlay 已写、overlay 与 head 均已写但尚未 `COMMIT`，以及 rekey
   `COMMIT` 后未响应；
3. coverage receipt 插入后/`COMMIT` 前与 `COMMIT` 后未响应；
4. retire catalog generation 插入后/`COMMIT` 前与 `COMMIT` 后未响应。

20 个独立数据库均由子进程在精确 SQL 边界写入私有 marker 并自杀。12 个未提交窗口
重启后所有关联事实完整回滚，正常仓储重试返回 `created`；8 个已提交窗口保留完整
durable winner，第一次重放即返回 `existing`。每个窗口随后再次 exact replay，并执行
`PRAGMA integrity_check`，20/20 均为 `ok`。local-sqlite 全包因此为 127/127；该门没有
增加 workspace package、生产依赖、timer、watcher 或第二 SQLite connection。

超过单页的 coverage 与并发压力门也已关闭。PostgreSQL repository test 构造 129 个
已覆盖 binding/head，验证 `COVERAGE_PAGE_SIZE=64` 的 keyset cursor 精确执行
`64 + 64 + 1` 三页，cursor 依次为 `''`、`artifact-...-063` 和
`artifact-...-127`，receipt 得到 binding/head 各 129、uncovered 各 0；
cluster-postgres 全包为 189 pass/1 条件 skip。

SQLite 没有为了模拟 PostgreSQL 而引入分页数组：production repository 继续在单一
`LocalSqliteOperationAuthority`/单连接事务内使用 SQLite statement cursor
`.iterate()` 逐行送入常量状态 coverage builder。Edge `DELETE/FULL` 与 Standalone
`WAL/FULL` 各自写入并 rekey 129 个 binding/head；129 个 rekey command 通过既有
有界 authority queue 串行落库，随后同一命令 8 路并发 replay、同一 receipt 8 路并发
创建、同一 retire 8 路并发提交，后两者均精确收敛为 1 个 `created` 与 7 个
`existing`。两种 Profile 最终都只有 1 个 receipt，catalog digest 一致且
`integrity_check=ok`。测试没有增加第二 SQLite connection、生产 timer、watcher、
package 或第三方依赖。

本轮 PostgreSQL HA 重跑还暴露了 fixture 时序缺陷：due occurrence 到
promotion/`pg_rewind`/同步重入/fresh activation 已稳定超过生产 scheduler 默认的
30 秒 misfire grace，因此 trigger 按 `misfirePolicy=skip` 正确收敛，而旧测试只等待
queued Run。HA replica fixture 现显式使用允许上限 5 分钟 grace；生产默认值和
scheduler 实现均未修改。修正后的 PostgreSQL 18.4 arm64 完整门验证
claim expiry 后 takeover、单次 admission、Result Key promotion reopen 和全部
具体 gate，最终 `passed=true`。

## 后续产品门禁

1. ADR-0166 的 storage、crash、跨页 coverage 与并发收敛门已经完成；
2. 这些证据不自动授予产品 authority；key provider 生命周期、管理 API/CLI/UI、
   授权与审计入口完成前，产品 transport 继续不开放 rotation、restore 或 retire。
