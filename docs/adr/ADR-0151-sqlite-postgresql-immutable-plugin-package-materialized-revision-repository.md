# ADR-0151：SQLite/PostgreSQL 不可变 Plugin Package 物化修订仓库

- 状态：Accepted（双方言仓库、迁移、readiness、共享合同与真实 PostgreSQL 门已实现；
  Task 批量发布、全局 Tool snapshot 和 consumer activation 尚未实现）
- 日期：2026-07-25
- 关联：ADR-0136、ADR-0137、ADR-0149、ADR-0150、QL-RFC-0001 D-144/D-145

## 背景

ADR-0150 已把同一 active Package generation 的 Task、Workflow、Prompt 和 Tool 文件
物化为自包含、可规范化的
`qinglong/plugin-package-materialized-revision@v1`。此前只有纯领域 repository port，
没有耐久 adapter：

- edge/standalone 重启后必须重新打开 staging 才能取得语义；
- Cluster 多副本无法围绕同一 `generationDigest` 收敛；
- consumer 无法在读取 active generation 后取得一份可审计的 exact revision；
- 如果分别保存 source、Task、Workflow、Prompt 和 Tool，多行提交会产生同一 generation
  的部分可见状态。

耐久化不能成为第二个 active pointer，也不能让 Package manager、常驻 runtime 或
Worker 获得原始 Package 语义写权限。

## 决策

### 1. 不新增 workspace package

repository port 继续位于
`@qinglong/runtime-core/plugin-package-resource-materialization`；SQLite adapter 放入
既有 `@qinglong/local-sqlite/plugin-package-materialized-revision`，PostgreSQL
adapter 放入
`@qinglong/cluster-postgres/plugin-package-materialized-revision`，并只从 Cluster
`package-executor` 权限入口导出。

两个 adapter 都是显式 subpath，不从 Profile-neutral root 聚合导出。不新增第三方
依赖、连接池、timer、watcher、socket 或常驻缓存；workspace importer 保持 21 个。

### 2. 一代一行，自包含保存

双方言分别新增：

- SQLite `QingLong3PluginPackageMaterializedRevisions`；
- PostgreSQL `ql3.plugin_package_materialized_revisions`。

每行保存：

- `generation_digest` 主键；
- `project_id`、`package_name`、`generation`、`lock_digest`；
- `manifest_digest`、`revision_digest`；
- 完整 canonical `revision_json`；
- 数据库观察的创建时间。

`generationDigest` 是 repository identity；`project + package + generation` 另有唯一
约束，防止同一代出现不同语义。数据库 CHECK 从 JSON 中复验上述重复 identity，
避免索引列与 payload 漂移。只外键到 Project，不外键到可变 install head 或 lock
history：语义修订需要在安装记录回收后仍可作为执行和审计事实存在。

完整 revision 单行保存是刻意选择。repository port 返回一份完整 revision，单行
`INSERT` 可以保证 publish 原子性；若拆为资源明细表，必须再引入 batch commit 标记与
复杂的 incomplete-generation 恢复协议。

### 3. create 或 exact replay

仓库只提供：

- `create(revision)`；
- `findByGenerationDigest(generationDigest)`。

`create` 先通过 runtime-core normalizer 复验完整 revision。首次写入成功；同一
`generationDigest` 重放时，只有 durable row 规范化后的完整值和摘要均 exact 相同才
返回既有记录。任何 identity、lock、Manifest、source 或语义差异都作为 conflict
失败关闭，不允许 update、delete、upsert overwrite 或“最后写入获胜”。

SQLite 在既有单 operation authority queue 内执行一个
`INSERT ... ON CONFLICT DO NOTHING` 与 exact read，不打开第二连接。PostgreSQL 使用
`INSERT ... ON CONFLICT DO NOTHING RETURNING`，冲突后 exact read；因为一行 append
本身即是原子发布，不要求连接 pinning 或跨网络长事务。

损坏的 durable JSON、数据库不可用和非预期 SQL 错误都映射为 unavailable；受审唯一/
CHECK/FK 约束映射为 conflict。调用方不得把不确定写入透明重放成不同 revision。

### 4. 明确存储与内存上限

ADR-0150 仍限制每个 resource 1 MiB、业务 resource source bytes 总计 8 MiB。
materialized revision 还包含 normalized semantic values、Manifest、lock、generation
和 JSON 编码开销，因此 durable `revision_json` 另设 24 MiB 硬上限，并在：

- runtime-core normalizer；
- SQLite CHECK；
- PostgreSQL CHECK

三处保持一致。

24 MiB 是一次显式安装/物化操作的最坏输入上限，不是常驻 RSS 预算。repository 不做
目录扫描、后台预热或全表加载；consumer 必须按 active `generationDigest` 精确读取。

### 5. 双方言 schema 与能力版本

SQLite：

- `0045-plugin-package-materialized-revisions` 建表和索引；
- `0046-capability-v23` 把 local contract 推进至 v23；
- capability 增加 `plugin_package_materialized_revision:1`。

PostgreSQL：

- `pg-0025-plugin-package-materialized-revisions` 建表、索引和角色授权；
- `control-core` capability 从 v23 推进至 v24；
- migration stream 为 25 条，catalog 为 38 张表；
- capability 增加 `plugin_package_materialized_revision:1`。

SQLite readiness 同时要求 migration、capability、表和两个业务索引。PostgreSQL
readiness 同时要求 migration、capability、表、索引、CHECK/FK 与精确 ACL。

### 6. PostgreSQL authority 只属于 Package executor

`pg-0025` 撤销 PUBLIC、runtime、admin、package-manager 和 worker-ingress 对新表的
全部权限，只授予 `ql3_package_executor`：

- `SELECT`；
- `INSERT`。

executor 没有 UPDATE/DELETE/TRUNCATE authority。Package manager 继续只负责公开管理
准入；常驻 runtime、Worker ingress 和 admin 不能读取或改写原始物化语义。迁移仍由
短生命周期 `ql3_migration` authority 执行。

### 7. durable revision 仍不是 active pointer 或执行发布

consumer 的顺序固定为：

1. 从 ADR-0149 source 读取一次 active generation；
2. 以其 `generationDigest` 精确查 revision；
3. 规范化并复验完整 identity；
4. 由后续受审 publisher 执行原子业务发布；
5. 发布前再次确认 active generation 未漂移。

repository 不提供 `current` 查询，不更新 active pointer，也不逐项创建 TaskDefinition、
注册 Tool handler、执行 Workflow/Prompt 或绑定 Secret。仓库完成只关闭“耐久语义事实”
缺口，不关闭“生产执行可见性”缺口。

## Profile 影响

- edge/standalone：复用现有单 SQLite operation authority；无新连接、线程或后台任务。
  只有显式 Package 物化/读取操作承担最多 24 MiB JSON 的短生命周期成本。
- cluster：多 executor 可以竞争同一 append；数据库唯一约束和 exact replay 使结果
  收敛。RPO-0/切换语义继续由既有 PostgreSQL HA 约束承担。
- worker：不导入 repository，不取得表权限，只消费后续 execution revision 绑定结果。

## 被否决方案

1. **新增 `plugin-package-revision-store` workspace package**：没有独立部署或依赖
   生命周期，会继续细碎化 `packages/`。
2. **按 Task/Workflow/Prompt/Tool 拆多张表**：当前 consumer 需要完整 revision，
   多表会引入部分发布和额外恢复协议。
3. **把 revision 塞进 active pointer/ConfigMap**：会突破 pointer 预算并合并文件发布、
   语义 authority 与业务激活。
4. **只存 digest、每次从 staging/OCI 重建**：无法给重启和多副本提供耐久 exact
   evidence，也把外部制品可用性带入执行读路径。
5. **给 manager 或 runtime 读写表权限**：会把公开 transport 或常驻控制面升级为
   原始 Package 语义 authority。
6. **允许 update/delete 以便升级或 GC**：升级本来就应产生新 generation；在引用感知
   retention 设计完成前删除会破坏执行与审计事实。

## 验证

- 共享 repository contract：首次 create、exact replay、按 generation digest 查询、
  absence；
- SQLite：真实 Node 24 `DatabaseSync`、单 operation authority、损坏 JSON
  fail-closed、root/subpath 隔离、typed schema/catalog/readiness lockstep；
- PostgreSQL：SQL 生成、数据库时钟、SQLSTATE conflict、损坏 JSON fail-closed、
  package-executor/root entrypoint 隔离；
- PostgreSQL 18.4 arm64 真库：25 条 migration 后完成 revision create、exact replay
  与 find；
- PostgreSQL 18.4 physical HA：`pg-0025`/v24/38 表和角色 readiness 在
  timeline 1→2 promotion 前后通过，旧主 fencing、`pg_rewind` 只读同步重入及既有
  24 项领域/HA 门全部通过；
- architecture：21-package 全量测试、edge import audit 和 cluster dependency audit
  必须保持无 finding。

## 后续

1. 设计 Package TaskDefinition 多资源单事务 reconciliation，以 generation 为批次，
   防止一代内部分可见；
2. 为全部 active generation 构造一次性 immutable Tool registry snapshot，Definition
   与受信 handler/preview publisher 分离；
3. 为 Workflow/Prompt 建立独立版本仓库和执行协议；
4. 建立 Package Secret requirement 到 Project SecretRef 的审批、rotation 和审计
   ceremony；
5. 在 execution revision/Run 引用建立后，再设计引用感知 retention；当前禁止 GC
   durable materialized revision。

上述 Gate 完成前，durable revision 仍不可直接进入生产执行路径。
