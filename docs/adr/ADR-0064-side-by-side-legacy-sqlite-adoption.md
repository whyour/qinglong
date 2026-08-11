# ADR-0064：2.x SQLite 旁路孵化、恢复点与显式切换

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-05、D-17、D-37、D-40、D-42、D-62、D-63、D-64、D-65
- 关联 ADR：ADR-0004、ADR-0038、ADR-0042、ADR-0044、ADR-0062、ADR-0063、ADR-0065、ADR-0066

## 上下文

QingLong 2.x 的 `database.sqlite` 同时包含用户的定时任务、环境变量、认证配置、插件扩展表和逐步加入的 3.0 孵化表。旧启动路径还会先执行多次 Sequelize `Model.sync()`，再自动运行 `SchemaMigrations` stream。QingLong 3.0 的本机 adapter 则拥有独立的 `QingLong3SchemaMigrations` stream、受审约束和 node:sqlite authority。

把两条 stream 直接拼接或在启动时原地升级有三个不可接受的后果：

1. 旧进程可能仍在写库，备份、DDL 和切换之间没有可证明的一致边界；
2. preview 期间形成的旧 `Runs` 表与最终 3.0 CHECK/FK/index contract 可能同名但不同义，`CREATE IF NOT EXISTS` 会把不兼容结构误判为成功；
3. migration 失败、磁盘耗尽或新版本回退时，用户只剩一份被修改过的数据库。

因此 adoption 首先必须是可撤销的数据面操作，而不是启动过程中的便利副作用。

## 决策

### 1. 禁止自动原地接管

3.0 runtime、edge/standalone 组合根和普通启动脚本不得修改 2.x `database.sqlite`，也不得因为看到 legacy 表就自动补 migration。adoption 只能由独立、短生命周期的 `@qinglong/local-admin` authority 显式执行。

`local-admin` 不进入 base edge/standalone production closure，只能导入 `@qinglong/local-sqlite/runtime` 与 `@qinglong/local-sqlite/migration` 两个受审入口，不得加载 legacy 根、Sequelize、sqlite3、cluster、Worker 或 Drizzle。显式 adopted 产物只允许从 `@qinglong/local-admin/runtime` 取得无 DDL 的 activation 能力，dependency audit 和 require-cache 测试必须证明常驻入口没有加载 executable migration SQL。

### 2. 先检查并冻结 adoption plan

只读检查至少验证：

- source 是绝对路径下的普通文件，父目录和目标都不是 symlink；
- `quick_check` 与 `foreign_key_check` 成功；
- `Auths(id,type,info)`、`Crontabs(id,command,schedule)`、`Envs(id,name,value)` 三组 2.x sentinel 存在；
- schema object 数量和 SQL 总字节受硬上限保护；
- 不存在 `Runs`、`RunAttempts`、`RunEvents`、`RunRetryPolicies` 或 `QingLong3Schema*` 等冲突对象；
- file identity、catalog digest、Profile 和 plan payload 形成确定性的 SHA-256 `planDigest`。

真正 staging 时必须显式提交该 `expectedPlanDigest`，并重新检查 source。任何 inode、大小、mtime 或 catalog 漂移都在创建输出前拒绝。

### 3. adoption 是 side-by-side staging

staging 固定生成三个全新、互不重名且不得预先存在的文件：

1. `recoveryPath`：通过 Node 24 SQLite Online Backup 得到的只读逻辑恢复点；
2. `targetPath`：从恢复点复制后，仅在这份副本上运行 3.0 reviewed migration；
3. `manifestPath`：记录 plan、source identity、catalog、恢复点和目标库 SHA-256/字节、migration manifest、readiness evidence 的 0600 JSON。

原 2.x source 不执行 DDL、不写 adoption marker、不改变 journal。恢复点必须在 migration 前通过同一 legacy catalog 检查；目标必须在 migration 后通过完整 local-sqlite readiness。未知插件表、列、索引和行保留在恢复点与目标中。

所有输出使用 no-overwrite 创建和 0600 权限。失败时只清理本次调用已经创建的精确文件，不递归删除目录；source 永远不属于清理集合。manifest 使用严格、不可扩展 shape，校验时重新计算自身 digest、两个数据库 digest/字节、恢复点 catalog 和目标 readiness。

### 4. activation 是数据库级接管凭证，不是进程停机证明

staged manifest 只证明“存在一份可恢复的 2.x 快照和一份已迁移的 3.0 候选库”，不能直接启动 adopted Profile。短生命周期 authority 必须显式提交已审阅的 manifest digest，并按 source → target 的固定顺序对两库取得 `BEGIN IMMEDIATE` 写栅栏。在栅栏窗口内再次使用 Online Backup 证明 source 内容与 recovery 完全一致、再次严格校验 target 初始 SHA-256/readiness，然后以 no-overwrite、0600 文件写入严格 `state: prepared` activation document。

activation 绑定 adoption/plan/source/recovery/初始 target digest，并额外绑定 target 的绝对路径 digest、device 和 inode。它证明凭证生成时两库均无并发 writer，但不能证明旧进程已退出，也不能证明其网络请求、子进程或其他数据库外副作用已静默。部署 supervisor 仍必须先停止并确认 2.x application，再允许 adopted Profile 取得 activation；不得把一次 SQLite 锁成功包装成完整进程 cutover。

### 5. 常驻接管校验必须允许目标库演进

`@qinglong/local-adopted-profile` 只由 `edge-adopted`/`standalone-adopted` 显式组合且默认关闭。启用时固定执行：验证 expected activation digest → 校验不可变 manifest/recovery → 校验 target readiness 与稳定路径/device/inode → 对 source 取得完整生命周期写栅栏并以新 Online Backup 复核 → 打开目标 storage → 再次复核 target identity → 发布 `adopted_storage_ready`。

target 在 activation 后是 3.0 可写事实源，因此重启不能继续要求它与初始 staged SHA-256 相同；该 digest 只用于 lineage 和“尚未发生目标写入”的判断。常驻路径必须继续严格校验 recovery 和 manifest，但对 target 使用 readiness + stable identity。用另一个即使 readiness 合法的文件替换同一路径也必须 fail closed。停止顺序固定为先关闭 target storage，再释放 source 写栅栏；失败路径同样不得泄漏栅栏。

这里的 readiness 分成两个明确阶段。staging、显式 verifier 和 activation preparation 仍要求
初始 target 的完整 readiness 与 manifest 精确相等；常驻 activation acquisition 则要求
`contractName`、`contractVersion`、`sqliteVersion`、核心 `migrationIds` 与 `journalMode`
精确一致，并要求当前 `tableCount` 不低于 staged 基线。这样默认关闭的可选 Feature 可以在
activation 后通过独立 migration 只增表，且下一次启动不会被初始表数误拒；删除已审阅的
legacy/plugin 表、改变核心 stream、契约或 journal mode 仍会作为 readiness drift 拒绝。
这不是对任意 schema 漂移的放行：当前数据库还必须先通过完整 local-sqlite quick check、
foreign-key check、migration history、capability、必需 schema 与领域完整性审计。

该状态只装配 storage authority，不启动 scheduler、executor、HTTP admission 或自动 legacy projection。旧进程的完整停止证明和应用栈接管由部署 supervisor 的后续 gate 负责。

### 6. 回退分为“未写 target”和“已写 target”

若 target 仍与 activation 记录的初始 SHA-256/字节完全一致，可以证明 3.0 尚未产生新数据库事实；在 supervisor 保证两边应用均停止的前提下，关闭 adopted storage、释放 source 栅栏并重新启动未修改的 2.x source，不需要逆向 migration。

一旦 target 产生任何合法 3.0 写入，回到旧 source 会丢失切换后的新事实。此时系统不得声称“自动无损 rollback”，也不得用旧 source 覆盖 target；必须进入显式 reconciliation/export 流程，列出受影响的数据域、冲突和不可逆事实，由操作员选择继续 3.0、接受有损回退或执行受审数据回灌。当前 storage-only 切片保留 source 作为灾难恢复资产，但不实现写后自动合并。

## 被否决的替代方案

1. **在 3.0 启动时直接 migrate 旧库**：把常驻 runtime 变成 DDL/admin authority，拒绝。
2. **只复制数据库主文件**：WAL 中已提交内容可能丢失，拒绝；必须使用 SQLite Online Backup。
3. **用 `CREATE IF NOT EXISTS` 兼容 preview 表**：同名不代表同 contract，拒绝。
4. **migration 成功后覆盖原文件**：失去稳定恢复点且 rename 不能证明旧 writer 已停止，拒绝。
5. **只保存 schema dump**：不能恢复认证、任务、插件数据和未知对象，拒绝。
6. **把 staged manifest 当作安全 cutover token**：它没有证明旧 writer 停止，拒绝。
7. **每次重启都要求 target 等于 staged hash**：正常 3.0 写入会让合法目标永久无法重启，拒绝；运行期绑定稳定文件身份和 readiness。
8. **target 已写后仍自动回到旧 source**：会静默丢失 3.0 新事实，拒绝；必须显式 reconciliation。

## 影响

正向影响：

- 2.x 数据源始终保留；target 未写时回退不依赖逆向 migration；
- 备份、migration、readiness 和 manifest 各有独立证据；
- preview 同名表会 fail closed，不会被静默接管；
- 插件未知数据被保留，且不迫使 3.0 理解所有插件 schema；
- base edge/standalone 常驻产物不支付 admin/backup 代码成本，adopted 变体只在显式选择时支付 activation runtime 成本。

代价与限制：

- staging 至少需要约两份额外数据库空间；大库哈希和 Online Backup 是短生命周期 I/O；
- 当前只识别有三组稳定 sentinel 的 2.x baseline，更老或损坏的数据库需要单独兼容评审；
- SQLite 写栅栏不能停止旧进程的数据库外副作用，完整切换仍依赖部署 supervisor；
- target 写入后没有通用、自动且无损的 3.0 → 2.x 数据合并；
- Keyv SQLite、日志、配置文件和 Secret key 不在本 ADR 的单数据库恢复点内，完整升级仍需要多资产 backup manifest。

## 验证

1. 两次只读检查对未变化 source 生成相同 plan digest，且 source 字节不变。
2. plan 审阅后 source schema 漂移时，在创建任何输出前拒绝。
3. recovery 不含 3.0 migration 表，target 同时保留 legacy/插件行并通过 3.0 readiness。
4. source、recovery、target 和 manifest 的 hash/mode/不可覆盖语义均由测试覆盖。
5. 缺 sentinel、同名 3.0 对象、symlink、畸形或可扩展 manifest 均 fail closed。
6. activation 只能在 source/target 双写栅栏和最终快照复核内生成；source 漂移、target 替换或凭证 digest 漂移均 fail closed。
7. activation 生命周期内旧 source writer 被阻断，stop 后释放；目标 storage 打开后还会复核 inode，失败不泄漏 connection 或 source 栅栏。
8. target 发生合法 3.0 写入或可选 Feature 只增表后仍可按 stable identity/readiness 重启，
   严格 staged verifier 会明确拒绝把它误判为“未写快照”；表基线减少、核心契约、
   migration、SQLite version 或 journal mode 漂移仍 fail closed。
9. dependency audit 证明 local-admin 只访问两个 local-sqlite 管理入口，adopted composition 只能访问 local-admin runtime 子入口；四个本机产物集合与导入闭包均受门禁。
10. supervisor 停机证明、完整应用接管和写后 reconciliation 未落地前，最多宣称 `adopted_storage_ready`，不能宣称生产 cutover 或无损自动 rollback。
