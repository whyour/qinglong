# ADR-0480：受认证、原子且可恢复的 Legacy Data Application

- 状态：Accepted
- 日期：2026-08-21
- 关联：QL-RFC-0001、ADR-0207、ADR-0395、ADR-0476、ADR-0478、ADR-0479

## 上下文

ADR-0479 只生成 `activation=disabled` 的 prepared model。模型内含待导入 Secret 明文，因此不能长期作为运行态事实，也不能由转换器顺便
写入目标数据库。应用阶段还必须同时解决四个问题：目标 Project 的强认证与授权、多个 Secret 和模型收据的原子提交、数据库提交后的
明文回收，以及进程在数据库 COMMIT 与文件清理之间崩溃时的确定性恢复。

QingLong 3.0 同时面向低配路由设备和集群节点。本地流程不能为了迁移增加 daemon、队列或第二套数据库；Cluster 又不能因本地简化而
失去 Project/RoleBinding fence、审计和幂等事实。SQLite 事务只能原子覆盖数据库，不能原子覆盖文件系统，因此协议必须明确承认并闭合
这个边界，而不是宣称跨介质事务。

## 决策

### 1. 延续既有领域，不新增 workspace package

既有 `ql3-adoption` 增加两个 exact、私有 command-file operation：

- `local-data-directory.adoption.apply`；
- `local-data-directory.adoption.apply.verify`。

职责分别内聚在 `@qinglong/local-owner-cli/lifecycle/data-directory-adoption/application`、
`@qinglong/local-admin/data-directory-adoption` 和 `@qinglong/local-sqlite/adoption/data-directory`。CLI 管文件 ceremony，Admin 管认证后的业务
组合，SQLite adapter 管唯一写事务。它们不是独立部署单元，不按源码文件拆成微包。

### 2. 强认证和 Project Policy 是提交前提

命令只接受 deployment root 内的 Owner pepper keyring、credential presentation 和 Local Secret keyring 路径；敏感 credential 不进入
command JSON 或 stdout。Owner credential 通过既有本地强认证建立 `local_data_adoption` authority，随后以目标 `projectId` 请求
`secret.manage`。只有 `owner|admin` 的 active RoleBinding 可继续；publisher 在 `BEGIN IMMEDIATE` 内再次校验 credential、Project 和
RoleBinding fence，消除预检到提交之间的权限漂移。

失败认证与拒绝授权写低敏 `legacy-data.apply` 审计，但不会读取 prepared Secret 或写入 adoption/Secret 表。

### 3. 一个 SQLite 事务提交完整批次

SQLite contract 从 v49 升到 v50，迁移 `0099/0100` 增加：

- `QingLong3LegacyDataDirectoryAdoptions`：唯一 mutation、transformation、disabled model、publication digest、receipt 和提交时间；
- `QingLong3LegacyDataDirectoryAdoptionSecrets`：按 ordinal 绑定每个来源名称摘要、目标 Secret、value digest、Secret envelope 和 audit；
- trigger、FK、唯一索引、typed schema、readiness relation 和 `legacy_data_directory_adoption=1` capability。

publisher 在一个 `BEGIN IMMEDIATE` 中依次验证 exact replay、Project/RoleBinding fence、所有目标 Secret 当前不存在，再写 encrypted Secret
envelope、每个 `secret.create` audit、父 `legacy-data.apply` audit、disabled model、子项和 canonical receipt。任一目标冲突、外部 authority
复验失败或约束失败都会回滚整个批次，不允许“部分 Secret 已导入”。同一 mutation 的 exact replay 读取 durable receipt，不再次读取明文或
创建新版本；同一 transformation 不能用另一 mutation 重复提交。

### 4. 只应用 `ready` 模型，永不顺带激活

apply 在数据库 mutation 前后重新验证 D-385 stage、SQLite activation 和 D-386 transformation binding。`manual_required`、目标漂移、源
漂移、Project/profile/digest 不匹配都失败关闭。写入的 config、Keyv、SSH 和 manual-review 模型仍固定 `activation=disabled`；本 ADR
不授权执行旧 shell、恢复 `authInfo`、启用 SSH host、启动任务或切换服务。

Secret 明文只用于当前进程内的 AES-256-GCM envelope 生成。每个 Secret 使用批次 mutation 和目标 identity 推导的稳定 v4 mutation ID，
并绑定独立 `secret.create` audit。key material 使用后立即覆盖；JavaScript 字符串的运行时内存擦除不作不可验证的保证。

### 5. 数据库 receipt 是恢复权威

数据库 COMMIT 是逻辑提交点。提交后 CLI 在 transformation root 写 `.commit-incomplete`，把 `model` 原子 rename 为
`.reclaiming-model`，逐个以 no-follow、owner/mode/inode 检查打开 Secret value 文件，覆盖、fsync、unlink，再删除其余 prepared model
文件。完成后写内容无关的 `commit.json`，最后删除 marker。成功根目录固定为：

```text
transformationRoot/
  manifest.json
  commit.json
```

如果进程在 COMMIT 后崩溃，同一 exact apply 先解析数据库 receipt，不依赖已被部分删除的 model；它只接受与 receipt 精确匹配的 marker 和
`model|.reclaiming-model` 状态，然后继续清理并重建同一 `commit.json`。未知文件、双 model、marker 漂移或 commit 漂移全部失败关闭，保留
现场供 operator 诊断。`apply.verify` 只验证完整终态，不隐式修复；恢复必须显式重放原 apply。

### 6. 明文回收不冒充物理擦除

协议保证 prepared model 中的明文文件被逻辑覆盖并 unlink，最终 transformation root 不再含 model 或 Secret value 文件。由于 SSD、闪存
FTL、CoW、快照、备份和宿主文件系统可能保留旧块，receipt 固定声明 `physicalErasureGuaranteed=false`。需要物理销毁保证的部署者必须使用
加密卷、销毁卷密钥或设备级擦除流程；不能把本地 overwrite 结果写成合规证明。

### 7. Profile 资源边界与部署边界

Edge/Standalone 继续使用 D-386 的 128/512 Secret 上限；单条 envelope 最高 16 KiB。事务只打开一个短生命周期 SQLite writer，认证使用
独立短生命周期 handle 以避免嵌套 operation authority；没有网络、timer、watcher、后台 retry、缓存或常驻内存。Cluster 后续可以复用
prepared-model/receipt 语义，但必须以 PostgreSQL、separation-of-duty 和 Cluster 专用 authority 实现，不能把本地 credential ceremony
直接搬进控制面。

## 被拒绝的替代方案

### 每个 Secret 独立调用现有 `secret.put`

拒绝。第二个 Secret 冲突会留下第一个已提交，无法证明批次与 transformation receipt 一致。

### 先删除明文，再提交数据库

拒绝。数据库失败后会失去唯一待导入值，D-385 staging 也不能安全地代替已审核 transformation。

### 用文件锁或后台 daemon 模拟跨介质事务

拒绝。文件锁不能回滚 SQLite COMMIT；daemon 会给路由设备增加常驻资源和长期高权限。durable DB receipt 加调用方显式重放已经能闭合崩溃窗。

### 成功 apply 后直接启用配置、SSH 或服务

拒绝。数据提交、风险复核、运行时 activation 和 service cutover 是不同 authority；合并会让迁移 credential 获得过宽副作用。

### 声称 overwrite 等于安全物理擦除

拒绝。对现代闪存、CoW 和快照不可证明，会产生错误的安全与合规承诺。

## 影响

### 正面

- prepared model 首次具有强认证、Project-scoped、可审计的最终数据库提交路径；
- Secret、子审计、disabled model 和 receipt 同事务提交，目标冲突不会留下部分状态；
- COMMIT-response-loss 和清理中断可用同一命令收敛，不依赖残存明文；
- 成功后高敏 model 被回收，stdout、manifest、commit 和 receipt 只保留低敏摘要；
- workspace package 数量和低配常驻拓扑保持不变。

### 代价与限制

- SQLite contract 升到 v50，旧 v49 binary 不能写新库，部署镜像 label/readiness 必须同步升级；
- DB COMMIT 后、文件清理前的命令可能以失败退出，但 durable receipt 表明逻辑提交已发生，operator 必须重放同一 apply；
- 逻辑明文回收不保证介质级擦除；
- 本 ADR 不迁移 `scripts/upload` 到最终 runtime，不完成 service cutover，也不实现 Cluster 数据提交。

## 验证结果

- focused data-directory `13/13`，覆盖成功提交、Secret 解密一致、stdout 脱敏、exact apply/apply.verify replay、COMMIT 后 renamed-model 恢复、
  第二个 Secret 冲突整批回滚和 viewer 拒绝零发布；
- Local SQLite `236/236`，覆盖 v50 migration manifest、typed schema、readiness、unknown table drift 和既有 repository 回归；schema readiness
  以 mode-0600 Edge 数据库实测为 contract v50、100 migrations、83 tables、SQLite 3.53.3、DELETE journal；
- Local Owner 为 `208 total / 203 pass / 5 conditional skip / 0 fail`；backend 为
  `1,535 total / 1,533 pass / 2 conditional skip / 0 fail`；`pnpm build:back` 和 18-package clean build/逐包测试退出 0；
- package boundary 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Local Admin、Local Owner、Local SQLite 新源码均进入
  既有领域子目录，Local Owner 为 `131 source / 130 nested / 1 root binary entry`；
- 八项架构审计、本地镜像审计和十四档 artifact audit 全 compatible；基础 Edge/Standalone 为 319 files/58 modules，最小 artifact
  2,611,978 bytes；Application+AI 为 514 files/142 modules，最大 4,515,703 bytes；MCP 为 805 files/228 modules，最大 7,338,018 bytes，
  全部保留既有预算；
- GitNexus `compare develop` 如实返回整条 `next` 孵化分支的 CRITICAL 累计差异；提交前另以 staged diff 收窄并核验 D-387 的预期符号与流程影响，
  不用全分支风险替代切片审计；
- 本切片不修改 PostgreSQL schema、ACL、role、Pool、连接或 HA 拓扑，不重新占有 PostgreSQL HA 证明。

## 后续

- D-388：把 committed transformation receipt 接入 systemd/OpenRC/Compose deployment lineage，并保持 activation 与 rollback 独立授权；
- 在固定物理 Edge/NAS 上执行 RSS、I/O、磁盘峰值、ENOSPC、断电和加密卷销毁演练；
- 为 Cluster 定义 PostgreSQL/SoD 版本的 prepared-model application，而不是复用本地 Owner credential 文件。
