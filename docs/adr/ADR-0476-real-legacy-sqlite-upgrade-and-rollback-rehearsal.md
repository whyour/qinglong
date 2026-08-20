# ADR-0476：真实 Legacy SQLite 升级与回滚演练

- 状态：Accepted
- 日期：2026-08-21
- 关联 RFC：QL-RFC-0001 D-383
- 关联 ADR：ADR-0064、ADR-0310、ADR-0314、ADR-0472、ADR-0475

## 背景

此前的 Local SQLite adoption、activation、target stop 与 rollback 已分别拥有单元测试和合成 fixture，但还没有一条从生产形态
QingLong 2.x Sequelize 数据库出发、只走产品 CLI 和正式 repository、同时证明 clean rollback 与 target 写后拒绝回滚的闭环。
这意味着“代码存在”仍不能证明现有部署用户能安全孵化 3.0。

演练还暴露了一个被小型假 fixture 隐藏的架构错误：SQLite Online Backup 生成的 recovery 数据库与 source 在逻辑上可以完全等价，
但页布局、freelist 或 checkpoint 状态可能使两个主文件的物理 SHA-256 不同。旧 classifier 把 live source 的哈希与
`recoverySha256` 比较，因此会把真实 clean rollback 错判为 `manual_review`。回滚判定需要区分三个事实：activation 时的原始
source 字节、Online Backup recovery 字节，以及迁移后 target 字节。

该能力必须同时适用于资源很小的路由设备和单机节点；Cluster 节点不能因此把 Local SQLite authority、Owner CLI 或迁移写权限
引入控制面。新增入口也不能继续把 `packages/` 拆成单文件包。

编辑前 GitNexus upstream impact 均为有界：adoption CLI `main`、activation parser/preparer/acquirer、target evidence 读取与消费
均为 LOW；`LocalSqliteActivationPayload` 为 MEDIUM（7 个直接、27 个累计影响），没有 HIGH 或 CRITICAL symbol。实现按该边界
更新全部 exact parser 和 fixture。

## 决策

### 1. 在既有 `ql3-adoption` 中提供产品级四阶段命令

不增加 package、binary 或依赖。现有一次性 `ql3-adoption run --command-file` 根据 exact operation 延迟加载 SQLite adoption
实现，并保留原 Legacy Crontab adoption 命令。新增操作为：

1. `local-sqlite.adoption.inspect`：只读盘点 source、schema catalog 与 task adoption plan；
2. `local-sqlite.adoption.stage`：绑定人工复核后的 `expectedPlanDigest`，通过 SQLite Online Backup 生成独立 recovery 和 target，
   只对 target 执行 3.0 migration，并发布 manifest；
3. `local-sqlite.adoption.verify`：重新证明 target、recovery、manifest、migration 与 readiness；
4. `local-sqlite.activation.prepare`：绑定 `expectedManifestDigest`，同时围栏 source 与 target，发布后续 adopted runtime/cutover
   消费的 activation。

命令只接受 `schemaVersion=1`、`edge|standalone`、精确 key 集和最长 4096 bytes 的 normalized absolute non-root path；未知字段在
检查数据库前失败。command file 和所有输出必须是 current-UID、canonical、non-symlink、单链接私有文件；deployment/output
目录必须是 current-UID canonical `0700`，输出只能位于 deployment root 内。source 可以位于既有 2.x data root，但必须由同一
UID 拥有、不是 symlink/硬链接且不可被 group/world 写。执行前后的 inode、size、mtime、ctime、mode 与 UID 必须稳定。

### 2. Activation 分别绑定 source、recovery 和 target 的物理身份

`LocalSqliteActivationPayload` 新增 `sourceSha256`。prepare 在 source write fence 内读取该哈希；runtime acquire 在相同围栏内
重新计算并拒绝 source 字节漂移。`recoverySha256` 继续证明 Online Backup 产物，`targetSha256` 继续证明刚迁移完成的 target，
三个摘要不得互相替代。

target stop/reconciliation 现在使用：

- `targetMatchesActivation = current target SHA-256 == targetSha256`；
- `sourceMatchesActivation = current source SHA-256 == sourceSha256`；
- source 与 target 的 `-wal`、`-shm`、`-journal` 必须全部不存在。

只有 target/source 均保持 activation 字节且 sidecar clear 才是 `rollback_candidate`。target 有任何写入或 sidecar 即
`reconciliation_required`；source 漂移、activation/稳定文件身份无法证明则是 `manual_review`。旧的误导字段名
`sourceMatchesRecovery` 在 3.0 首发前改为 `sourceMatchesActivation`，证据 digest 和 exact verifier 同步更新；尚未发布的孵化
记录不作为跨版本兼容格式。

### 3. 使用生产形态双态演练，而不是复制合成摘要

回归 fixture 建立 2.x 生产形态的 `Crontabs`、`Dependences`、`Apps`、`Auths`、`Envs`、`Subscriptions`、
`CrontabViews`、`CrontabStats`、`RunningInstances`、`sqlite_sequence`，并保留未知的 `PluginOwnedState`。测试只通过产品
CLI 完成 inspect → stage → verify → prepare，再启动正式 adopted storage：

- recovery 保留 legacy/plugin 数据且没有任何 `QingLong3*` 表；
- target 保留 legacy/plugin 数据并只在 target 上增加 3.0 表；
- adopted storage 持有 source write fence，legacy writer 在此期间不能提交；
- target 未写即停止时得到 `rollback_candidate`，fence 释放后 legacy 写恢复；
- 通过正式 Run repository 向 target 写入后得到 `reconciliation_required`，source 不含 3.0 表且字节不变；
- 带额外 authority 字段的命令在 inspect 前失败。

这是一条真实 schema/产品路径 rehearsal，但仍是本机临时目录中的自动门，不冒充用户实际路由器、NAS 或生产数据快照。

### 4. 低配设备与 Cluster 边界

四个操作都是显式的一次性进程，没有 daemon、listener、watcher、timer、poller、queue 或后台 retry。基础 Edge 制品不包含
Local Admin adoption；只有 adopted profile 增加该能力。SQLite Online Backup 以数据库页为单位，不把整个数据库加载到 JS
heap；schema inventory 上限为 4096 个对象，manifest 上限 256 KiB。operator 仍必须预留 source 之外至少 recovery + target 两份
数据库及 SQLite 临时/sidecar 余量，空间不足必须在切换前失败，不能删除 recovery 腾空间。

Cluster dependency audit 只允许现有 Local Owner 中精确的 `lifecycle/sqlite-adoption/command.ts` 从
`@qinglong/local-admin` package root 导入 adoption API；其他 Cluster/Worker/Edge source 不能借此获得 Local storage authority。
实现增加在既有 Local Owner 的 `lifecycle/sqlite-adoption/` 内聚目录，没有新增 workspace package；package audit 保持
`singleSourcePackages=[]`、`shallowSourcePackages=[]`。

## 被否决方案

1. **新建 `ql3-sqlite-adoption` package/binary**：没有独立交付或生命周期理由，只会加剧 package 碎片化，拒绝。
2. **把 recovery SHA 当作原 source SHA**：Online Backup 不保证物理字节相同，会拒绝合法 clean rollback，拒绝。
3. **直接覆盖 2.x source 后再迁移**：失去独立恢复副本和双态证据，失败时不可安全分类，拒绝。
4. **target 写后自动覆盖回 source**：Run/Task/Workflow 与 legacy 表之间没有通用无损逆迁移，拒绝。
5. **在 application 启动时隐式 inspect/stage**：把高风险数据变更藏进 daemon 生命周期，也无法让 operator 审核 digest，拒绝。
6. **为 Cluster 共用迁移服务**：扩大数据库 authority 和部署闭包，且低配 Local 不需要远端控制面，拒绝。

## 升级与回退

升级前保留原 2.x source，所有 stage 输出使用新路径且 no-replace 发布。operator 必须保存 inspect 的 `planDigest`、verify 的
`manifestDigest` 和 prepare 的 `activationDigest`，后续 cutover 命令只能消费这些 exact digest。不得手工编辑 manifest、activation，
不得把 target 重命名覆盖 source。

若 3.0 target 从未接受写入并得到 `rollback_candidate`，只能继续既有双阶段 Legacy rollback ceremony；该 classification 本身不
授权启动 2.x。若 target 已写，必须保留 source、target、recovery 和证据，进入独立 reconciliation，不得自动回退。

activation schema 增加 `sourceSha256`，且 evidence 字段改名；旧孵化 activation/target-stop journal 必须从 inspect 开始重新生成，
不能混用旧记录。QingLong 3.0 尚未发布，因此本 ADR 优先修正语义，不维持错误的预发布持久格式。

## 验收证据

- 产品级真实 SQLite rehearsal `3/3`；Local Admin 全量 `91/91`；Local Owner 全量
  `190 total / 185 pass / 5 conditional skip / 0 fail`。
- D-383 相关 focused regression 共 `102/102`；backend 全量
  `1,535 total / 1,533 pass / 2 conditional skip / 0 fail`；`pnpm build:back` 通过；18-package clean build 与逐包测试由
  单条命令完成且退出 0。
- workspace 保持 18 packages，无新增 dependency、binary 或部署对象；Local Owner 为
  `116 source / 115 nested / 1 root binary entry`，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。
- 14 档 Local artifact audit 全部 compatible：基础 Edge/Standalone 为
  `2,598,669 / 2,598,747` bytes、316 files、57 loaded modules；Adopted 为
  `2,818,404 / 2,818,527` bytes、336 files、58 loaded modules；Application+AI 为
  `4,502,262 / 4,502,394` bytes、511 files、141 loaded modules；MCP 为
  `7,324,601 / 7,324,709` bytes、802 files、227 loaded modules。
- package boundary、Cluster dependency、Edge import、Service Bridge import、Cluster/Worker deployment、Console 与 Console
  distribution 八项审计全部 compatible/passed。
- 本阶段不修改 PostgreSQL schema、ACL、repository、role、Pool、连接或 failover 语义，因此不重跑且不重新占有 PostgreSQL HA
  证明；D-373/D-374 的 HA 结果只作为相邻既有基线。

## 未完成

- 从真实 2.x 完整 data directory 接管 scripts、configs、logs 与其他文件资产；
- 固定物理 Edge/NAS 上的磁盘峰值、耗时、cgroup RSS 与断电恢复演练；
- target 写后的显式数据域 reconciliation/导出工具；
- 真实用户数据快照与 systemd/OpenRC/Compose 全链路升级回退演练；
- OpenRC live actor（待镜像基础设施恢复）。

本 ADR 关闭单个生产形态 2.x SQLite 主库的产品级升级与 clean/write-after 双态回滚分类，不代表完整 2.x data directory 或
QingLong 3.0 GA 升级门已经完成。
