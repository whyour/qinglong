# ADR-0487：Reconciliation Apply 证据封存与回滚存储生命周期

- 状态：Accepted
- 日期：2026-08-22
- 决策：D-393
- 关联：ADR-0309、ADR-0314、ADR-0482、ADR-0485、ADR-0486

## 背景

Automation apply 已具备写前 SQLite backup、原子 Task/Trigger adoption、写后 receipt、instance-head CAS 和显式全库 rollback，但第一版为了让 restore primitive 随时可写临时文件，把整个 apply root 和 backup 长期保留为 `0700/0600`。这同时产生两个问题：

- 已完成的 intent、receipt 和 backup 仍可写，terminal evidence 没有最小权限封存；
- rollback 完成后仍保留一份与数据库同量级的 backup，低容量路由设备会永久承担无用写放大和磁盘占用。

直接把整棵目录封为 `0500/0400` 又不可行。既有 identity-preserving restore 要求 source、stage、replaced file 的父目录可写且为当前 UID 的 `0700` 私有目录；为 restore 临时解封整棵 evidence root 会扩大可变范围，并使 crash recovery 无法区分 immutable evidence 与 mutable work material。

## 决策

### 1. 把证据与回滚工作区分离

每个 Automation apply 使用固定布局：

```text
apply/<automationId>/
├── intent.json
├── receipt.json
├── backup/
│   └── before.sqlite
└── rollback-work/
    ├── restore-source.sqlite
    ├── restore-stage.sqlite
    ├── replaced.sqlite
    └── receipt.json
```

`intent.json`、apply `receipt.json` 与 `backup/before.sqlite` 是已认证的 immutable evidence；`rollback-work/` 是预先建立的短生命周期 mutable workspace。固定 exact catalog 拒绝额外文件、目录和 symlink，不允许调用方提供任意临时路径。

### 2. Applied 状态立即最小权限封存

apply receipt 与 `reconciliation_automation_applied` head 都已发布后：

- root、`backup/` 封为 `0500`；
- intent、apply receipt、backup 封为 `0400`；
- `rollback-work/` 保持当前 UID `0700` 且必须为空。

封存前以固定 64 KiB buffer 流式重算 backup SHA-256、字节数和 inode/owner/mode/link identity。JSON evidence 使用有界 stable-descriptor read；terminal 验证要求单 link `0400`，不会把遗留 hard-link stage 当作已封存成功。

封存是幂等、可恢复的。文件、backup directory、root 依次收紧；因此任一步骤掉电后只会形成受审的 `0700|0500`、`0600|0400` 中间组合，exact replay 可继续收紧，不能重新放宽 immutable evidence。

### 3. Rollback 只在隔离工作区恢复

rollback 不直接把 `0400` backup 交给 restore。当前 reviewer、Project Policy、publication、applied head 和 target-after snapshot 复验完成后，将 backup 复制为 `rollback-work/restore-source.sqlite`，以固定内存重算相同 SHA-256 并要求 `0600` 单 link。restore stage、replaced database 和 rollback receipt 都只出现在该 `0700` 工作区。

这样既保留既有 `preserveDatabaseIdentity=true` 的恢复语义，也不需要解封 apply intent、receipt、root 或原 backup。restore response loss 时，下一次调用先检查当前 target snapshot；若已经等于 backup，则直接发布/重放 rollback receipt 和 head，不会因临时副本尚在而错误要求 applied 工作区为空。

### 4. Rolled-back 状态同步回收重资产

rollback receipt 与 `reconciliation_automation_rolled_back` head 收敛后：

- 删除 restore source、stage、replaced 等临时材料；
- 删除已完成职责的 `backup/before.sqlite`；
- 保留 intent、apply receipt 和 rollback receipt，全部封为 `0400`；
- root、空 `backup/` 和只含 rollback receipt 的 `rollback-work/` 全部封为 `0500`。

备份删除不是后台 GC，也不依赖 daemon、timer、watcher 或数据库表。它发生在已经用 restored snapshot、rollback receipt 和 instance head 证明回滚完成的同一次短生命周期 Owner 命令中，因此路由设备没有额外常驻成本，集群节点也共享同一确定性状态机。

Applied backup 在尚未 rollback 时不得自动删除。跨 Automation、Secret、Plugin、Identity、history 等领域的全局 completion fence 尚未建立；在该 fence 接受之前，系统不能自行推断 rollback authority 已过期。

### 5. Profile 与部署规模

- Edge/Standalone：hash/read/copy 使用 64 KiB 固定 buffer，不把数据库读入内存；rolled-back 后同步释放数据库等量 backup。
- 较大单机/集群节点：不增加包、production dependency、连接、SQL migration、Pool 或 cluster workload；可由未来独立 adapter 复用状态语义，但 PostgreSQL 必须有自己的 snapshot/HA authority，不能把本机文件复制当作集群备份。
- 所有 Profile：verify 只读且不修复 drift；apply/rollback 的恢复行为只在显式 mutation command 内发生。

## 被拒绝的替代方案

### 永久保留 `0700/0600`

拒绝。它扩大 terminal evidence 可变面，并让已回滚设备永久保留无用数据库副本。

### Applied 后立即删除 backup

拒绝。显式 rollback 仍是当前 D-393 的必要能力；在跨领域 completion fence 前删除会把成功 apply 变成不可恢复的单向操作。

### Restore 时解封整个 apply root

拒绝。restore 只需要三个临时路径。隔离 `rollback-work/` 可以保持 immutable evidence 全程只读，并缩小掉电恢复状态空间。

### 后台定时 GC

拒绝。它为低配设备增加 timer、扫描、写唤醒和新的竞态，也无法仅凭文件年龄安全判断跨领域 rollback 已失效。

## 验收证据

- reconciliation 聚焦套件 `44 total / 42 pass / 2 conditional Docker skip / 0 fail`，覆盖 apply head/seal 与 rollback restore/receipt/head/seal 共十个 response-loss 窗口、实体 mode/catalog、identity-preserving restore、backup 回收及 terminal replay。
- 完整 Local Owner 在真实 loopback 环境 `266 total / 259 pass / 7 conditional skip / 0 fail`；18-package clean build/逐包测试退出 0；真实 stopped-target Docker reconciliation `2/2`。
- cluster dependency 与 package boundary 组合门 `70/70`，workspace 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Local Owner 为 `169 source / 168 nested / 1 root binary entry`。
- 不新增 workspace package、production dependency、daemon、timer、watcher、listener、SQL migration、PostgreSQL role/ACL、Pool 或 cluster workload。
- 后续 ADR-0488 已建立跨领域 completion fence：八域全 `no_effect` 可进入 `reconciliation_completed` 并获得 target generation 2 重启 authority；Automation apply 只有在其余七域同样 `no_effect` 时才能完成并回收 backup。当前完整迁移库仍有 Secret、Identity、history 等 manual 领域时会失败关闭并继续保留 rollback authority。
