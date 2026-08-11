# ADR-0258：Owner-authenticated Local Trigger Management 与 Current Task Fence

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-85、D-175、D-207、D-239、D-241
- 关联 ADR：ADR-0074、ADR-0085、ADR-0089、ADR-0091、ADR-0092、ADR-0256、ADR-0257

## 背景

ADR-0256 已让 fresh Edge/Standalone 能通过受支持入口创建 TaskDefinition，但部署者仍不能
创建、更新、停用、启用或查询 Trigger，Fresh Setup 因此停在 Task 而不能完成
Task→Trigger→Run。既有 scheduler 还只检查 Trigger current head；Task 更新或停用后，固定到
旧 Task revision 的已启用 Trigger 仍可能继续产生 Run。这会绕过部署者对 Task current head
作出的撤权决定。

该缺口不能通过新增常驻管理服务、每 Trigger timer 或新 workspace package 解决。路由设备的
空闲资源边界必须不变；Cluster 也不能复用本机 SQLite、Owner credential file 或 command file
来绕过 PostgreSQL/RBAC 与多副本围栏。

## 决策

1. 在既有 `@qinglong/local-owner-cli` 增加短生命周期 binary `ql3-trigger`，只接受
   `run --command-file /absolute/private-command.json`。command file 必须位于 deployment root
   内、由当前 UID 持有、模式 `0600` 且不是 symlink。
2. v1 只开放 `trigger.put|trigger.inspect|trigger.list`。`trigger.put` 以
   `expectedRevision=null` 创建，以 current revision 更新；enable/disable 都追加 immutable
   Trigger revision，不提供原地修改或 delete。production registry 只接受
   `qinglong/cron@v1`。
3. 创建或更新必须绑定 exact `taskId`、`taskRevision` 与 `taskContentDigest`。启用的 Trigger
   只能绑定同 Project 下当前、内容摘要一致且 enabled 的 Task head。Task 更新、停用或重新启用
   后，旧 Trigger 失败关闭，必须由部署者显式提交新 Trigger revision 完成 repin。
4. 为避免撤权死锁，`enabled=false` 的新 Trigger revision 可以继续绑定历史 Task revision；
   因此 Task 已变化或停用后，operator 仍能明确停用 stale Trigger。再次启用时必须 repin 当前
   Task head。
5. scheduler 在两个位置复验 Task current fence：候选发现必须联结 current Task head；最终
   创建 Run 的事务必须再次验证 Task current revision、content digest 和 enabled。扫描后发生
   Task race 时不得创建 Run，不能只依赖 Trigger 写入时的检查。
6. 每次命令建立短生命周期 SQLite connection，复用 Owner pepper/credential authentication
   与 Project Policy。put 要求 `task.update`，inspect/list 要求 `task.read`；principal 必须是
   strong User。沿用 Task 权限是因为 Trigger 直接改变该 Task 的调度能力，v1 不另造含义重叠的
   permission。
7. 写事务在同一 `BEGIN IMMEDIATE` 内重新验证 credential/Identity/pepper、Project 与
   RoleBinding fence，并原子提交 allowed `trigger.create|trigger.update` audit、Trigger head、
   immutable revision、mutation replay 和本机 schedule reset。任何认证、Policy、Task、revision、
   audit 或 replay 漂移都整体回滚。
8. `mutationId` 同时是 allowed audit event ID；request、actor、Policy fence、完整 Trigger
   mutation 与 immutable `occurredAtMs` 都属于 exact replay。结果未知时只能原样重放同一个
   command file。
9. inspect/list 只返回低敏 current-head 摘要：Project/Trigger、revision、Task binding、schema、
   enabled、content digest 与时间；不回显 cron expression、timezone、misfire policy、credential、
   pepper、数据库路径或 command-file 路径。list 使用最多 256 条的稳定 `triggerId` keyset。
10. 实现只增加既有 `runtime-core`、`local-sqlite`、`local-admin`、`local-owner-cli` 的 source
    module 与 subpath。workspace 保持 19 个 package，不新增 production dependency、migration、
    daemon、timer、watcher、listener、cache、Pool、连接或端口。只有 operator 执行命令时产生
    一个短进程和一个 SQLite connection。
11. `ql3-trigger` 只支持 Edge/Standalone。Cluster 必须使用后续 PostgreSQL 管理 repository、
    集群 credential/RBAC、强认证 transport、durable audit 与多副本 fence；不得把本机文件挂进
    Pod 伪装集群管理入口。

## 失败与恢复

- Task 已更新或停用：scheduler 自动停止 admission；先 inspect Task current head，再明确停用
  stale Trigger，或以新 mutation 将 Trigger repin 到已启用的 current Task；
- revision conflict：inspect Trigger current revision 后人工确认，再生成新 command identity；
- 认证、授权、Task fence、semantic 或 audit conflict：失败关闭，不创建半个 revision 或 Run；
- COMMIT 结果未知：逐字重放原 `0600` command file；`existing` 表示相同 durable semantic 已提交；
- 禁止直接修改 Trigger、schedule 或 audit 表来“恢复”，历史 revision 必须保留解释既有 Run。

## 被拒绝的替代方案

1. **新增 `trigger-admin` package**：没有独立交付、依赖或权限域，会重现单文件/小包碎片化，拒绝。
2. **让旧 Trigger 永久执行 pinned Task**：Task current head 的停用/替换将不能撤销后续 admission，
   拒绝；历史 pin 只用于解释已创建 Run。
3. **只在 Trigger 写入时检查 Task**：扫描与 commit 之间仍有竞态，拒绝；最终 Run admission 必须
   重验 current Task fence。
4. **Task 变化时自动改写 Trigger pin**：会在没有 operator intent、audit 和 replay identity 时改变
   执行语义，拒绝；恢复必须显式 repin。
5. **禁止 stale Trigger 的任何更新**：Task 先变化后将无法停用旧 Trigger，形成撤权死锁，拒绝；
   只允许追加 disabled revision，重新启用仍须 current pin。
6. **每 Trigger 建 timer 或管理 daemon**：扩大路由设备空闲 RSS、唤醒与连接数，拒绝；复用唯一
   application scheduler cadence。

## 验证

- `ql3-trigger` 真实 SQLite 纵切面 5/5：create、exact replay、disable、inspect/list、operator
  allow、viewer deny、credential/Policy race、Task fence、audit drift、私有 command file 与低敏输出；
- SQLite Trigger/schedule 定向 7/7：Task 更新或停用后候选为空，扫描后 stale commit 不生成 Run，
  stale Trigger 可停用，Task 重新启用并显式 repin 后才恢复候选；
- fresh 产品链 1/1：`ql3-task` 创建 Task、`ql3-trigger` 创建 cron Trigger、production
  `LocalSchedulerCoordinator` 生成唯一 queued Run；Task 停用后不再产生第二个 Run；
- 19 个 QL3 package 清理、顺序构建与完整测试零失败；Owner CLI 88/88，backend 958 pass/
  2 条件 skip/0 fail；Trigger 精确依赖边界加入后定向审计 41/41，全仓 19-importer audit
  `findings=[]/compatible=true`，Edge import 和 local image inventory 均 compatible；
- 十档 exact offline artifact 全绿：storage 322 files/3,491,202--3,491,250 bytes，adopted
  361/4,064,367--4,064,451，application 415/4,548,022--4,548,166，AI-only
  345/4,082,310--4,082,370，application+AI 438/5,139,202--5,139,358；最大 import RSS delta
  20,480,000 bytes，全部低于既有分层门；
- PostgreSQL 18.4 arm64 physical HA 重新完成 `remote_apply`、timeline 1→2、旧主先 fencing、
  `pg_rewind` 只读同步重入、两个 fresh control replicas、scheduler exactly-once 与全部业务门，
  `gates.passed=true`；测试容器、网络和卷零残留。它只证明 Cluster 基线未回归，不把本机
  `ql3-trigger` 宣称为 Cluster 管理入口；
- 实现没有新增 workspace package、第三方依赖、migration 或常驻资源；GitNexus 刷新后为
  37,577 nodes/85,540 edges/280 flows，相对 `develop` 与整个工作树的 change detection 均为
  LOW、0 affected process。

## 后续约束

- 下一步为 Cluster 提供 PostgreSQL/RBAC 对等的 Task/Trigger 管理 transport，不能共享本机
  credential 或 SQLite authority；
- HTTP/UI 只能调用同一 administration service 语义，不能复制 Policy、Task current fence、
  audit 或 replay 逻辑；
- 新 Trigger schema 必须先完成 semantic registry、资源预算、安全与执行语义评审；
- 每次修改 Task/Trigger/scheduler admission 都必须覆盖“候选后 race、最终 commit 失败关闭”。
