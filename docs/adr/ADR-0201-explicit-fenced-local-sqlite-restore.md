# ADR-0201：显式、围栏化的本机 SQLite 恢复

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-184、D-189、D-190、D-191
- 关联 ADR：ADR-0194、ADR-0199、ADR-0200

## 背景

ADR-0200 在 generation 2+ rollout 前保存在线一致的 SQLite snapshot，并明确禁止
健康失败后自动覆盖数据库。这样避免了候选已经提交有效事实时的静默丢失，但当候选
和旧 image 都无法安全运行时，operator 仍需要一个可执行、可审计、可崩溃重放的
data restore。

Docker selection、rollout lock、SQLite 文件和 receipt 之间没有跨介质事务。恢复
过程还必须覆盖磁盘满、服务未真正停止、prepare 后数据库漂移、进程在 rename
之间退出，以及 commit receipt 已发布但锁尚未清理等窗口。低配路由设备不能为此
常驻另一个恢复 daemon。

## 决策

### 1. 恢复只处理失败 rollout 的既有证据

恢复入口复用 `ql3-local-deploy`，只接受私有 exact-shape command file，并拆成：

- `local.deployment.compose.restore.prepare`
- `local.deployment.compose.restore.commit`

prepare 必须绑定仍存在的原始 `.compose-rollout.lock`、该 rollout 的不可变
snapshot、已经前进到 rollback generation 的 active selection，以及同一 Docker
executable/socket。存在成功 rollout receipt、generation 漂移、不同 rollout ID
或 source snapshot 漂移时一律失败。

该入口不是任意 SQLite 文件复制工具，也不接受调用方提供 source path 或 digest。

### 2. Prepare 只建立恢复授权，不覆盖当前数据库

prepare 先发布 exact `.compose-restore.lock`，再显式停止 Compose service，并通过
container inspect 证明它不在运行。随后：

1. 对当前数据库执行 `wal_checkpoint(TRUNCATE)`；
2. 切换到 `journal_mode=DELETE`，拒绝残留 `-wal`/`-shm` sidecar；
3. 记录当前数据库完整 contract/page/bytes/SHA-256；
4. 创建当前数据库的不可变 safeguard；
5. 发布 command-digest-bound prepare receipt。

source、current 和 safeguard 都必须为当前 UID `0600`、单链接、完整且
`integrity_check=ok` 的 self-contained SQLite 文件。source 与 current SHA 必须
不同。prepare 结束时服务保持停止，数据库内容不被覆盖。

每个 restore ID 对应一个 safeguard，目录最多保留 4 份。达到上限时新 prepare
失败关闭；本决策不自动删除恢复证据。

### 3. Commit 以 current SHA 作为最后一道数据围栏

commit 只接受与 prepare lock/receipt 相同的 deployment root、Docker
executable/socket、restore ID 和 generation，且 commit 时间不得早于 prepare。
它再次停止并检查 service，重新 checkpoint 当前数据库，并要求 SHA 仍等于
prepare 记录的 current，或者已经等于 source（commit 响应丢失的重放状态）。

prepare 后任何新提交都会改变 SHA，使 commit 在覆盖前失败。operator 必须保留
现场并重新决策，不能通过改 command 或 receipt 绕过。

### 4. 文件替换是可恢复状态机

commit 使用同一文件系统上的确定路径执行：

```text
source snapshot -> restore stage
current database -> restores/<restoreId>.replaced.sqlite
restore stage -> current database
```

每一步都复验 SQLite evidence 并同步 file/directory。崩溃后重放可从以下状态收敛：

- stage 已创建、current 尚未移动；
- current 已移动、数据库路径暂时缺失；
- source 已安装、replaced 尚未清理；
- database 已恢复、commit receipt 尚未发布；
- receipt 已发布、restore lock 尚未删除。

ENOSPC 创建 stage 时会清理不完整 stage，当前数据库保持原位；replaced evidence
缺失或 SHA 不符时不猜测恢复。

### 5. 恢复数据后仍由原 rollout 完成服务恢复

commit 发布不可变 receipt 后删除 `.compose-restore.lock`，但故意保留原始
`.compose-rollout.lock`。此时 SQLite 已恢复，service 仍停止。operator 必须原样
重放原来的 `compose-apply` command，让旧 image 重新通过当前数据库的完整
read/write contract preflight、启动并发布最终 rollout receipt。

因此 data restore 不伪装成 service recovery。恢复锁存在期间 `compose-apply`
直接失败关闭；commit receipt 的只读重放不会再次停止一个后来已经恢复运行的
service，结果明确返回 `service.state=unchanged`。

### 6. 保持低配设备闭包

实现继续位于既有 `@qinglong/local-sqlite/rollout-safety` 和
`@qinglong/local-owner-cli/local-deployment`，不新增 workspace package、第三方
依赖、进程、端口、listener、timer、watcher 或自动 GC。只有 operator 显式执行
短生命周期命令时才加载恢复代码；systemd/OpenRC 与 Cluster PostgreSQL 不使用
该文件协议。

## 验收证据

- `local-sqlite` 144/144；storage primitive 覆盖 Edge/Standalone checkpoint、原子 restore、
  current-moved 崩溃恢复与 ENOSPC；
- `local-owner-cli` 46/46；覆盖 prepare/commit、restore lock 阻断 rollout、post-prepare SHA
  漂移、safeguard 容量失败、current-moved 恢复、原 rollout 继续完成及低敏回放；
- 类型检查与 22-package 依赖边界审计通过，无新增生产依赖；
- arm64 Docker 上，Edge 128 MiB/64 PID 与 Standalone 256 MiB/256 PID 对同一
  localhost exact manifest 都完成 generation `1→2`、generation 3 写入后健康证据
  失败、rollback generation 4、prepare/commit、原 rollout 恢复、commit 回放不
  停止服务及 graceful cleanup；临时 Compose 资源为零；
- PostgreSQL 18.4 arm64 physical HA 回归门使用本地 exact repo digest，完成
  `remote_apply`、timeline `1→2`、旧主 fencing、`pg_rewind` 同步只读重加入，
  全部领域门 `gates.passed=true`，且无残留 HA Docker 资源。

真实 Compose data restore、物理断电、不同文件系统、闪存寿命与恢复点 GC 仍是
独立后续门禁；本 ADR 不把单元故障注入冒充物理设备证据。

## 被拒绝的替代方案

- **候选失败自动恢复 snapshot**：会丢弃候选已提交的有效事实。
- **单条 restore 命令直接覆盖**：没有 operator 审查窗口，也无法围栏 prepare 后
  新写入。
- **先删除 current 再 copy source**：ENOSPC 或断电会失去唯一当前数据库。
- **接受任意 source path**：把部署恢复扩大为宿主机文件读取/覆盖 authority。
- **commit 顺便启动容器**：把 data restore 与 image compatibility、健康恢复再次
  混成不可原子提交的操作。
- **后台自动清理 snapshot/safeguard**：增加路由器 idle 成本，并可能删除尚未
  完成人工审查的恢复证据。
