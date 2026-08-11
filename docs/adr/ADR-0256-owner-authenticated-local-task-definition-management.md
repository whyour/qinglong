# ADR-0256：Owner-authenticated Local TaskDefinition Management

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-85、D-175、D-207、D-239
- 关联 ADR：ADR-0074、ADR-0085、ADR-0089、ADR-0091、ADR-0092、ADR-0217

## 背景

Fresh Edge/Standalone 已具备版本化 TaskDefinition、内建 `qinglong/command@v1`
语义注册表、原子 execution revision 物化、Owner credential 和 Project Policy，但产品入口
仍只能通过测试或直接 Repository 写入 TaskDefinition。部署者无法用受支持命令完成
create/update/enable/disable/inspect/list，也就无法在 fresh 安装后建立第一个可调度任务。

这个缺口不能靠向常驻 application 暴露写 Repository 解决。路由设备不应因此增加管理
daemon、第二数据库连接、timer 或新的 workspace package；Cluster 也不能复用本机文件
credential 和 SQLite authority 来绕过 PostgreSQL/RBAC/多副本管理边界。

## 决策

1. 在既有 `@qinglong/local-owner-cli` 增加唯一短生命周期 binary `ql3-task`，只接受
   `run --command-file /absolute/private-command.json`。command file 必须位于 deployment
   root 内、由当前 UID 持有、模式 `0600`、不是 symlink；不接受参数拼装的 Task spec。
2. v1 只开放 `task.put|task.inspect|task.list`。`task.put` 以
   `expectedRevision=null` 创建，以当前 revision 更新；`enabled=false|true` 分别表达
   disable/enable 的新 revision，不提供 update-in-place 或 delete。
3. 写入只接受已冻结 registry 中的 Task spec；当前 production registry 仍只有
   `qinglong/command@v1`。CLI 不因为 envelope 支持 `script|workflow|agent|tool` 就猜测其语义。
4. 每次命令建立短生命周期 SQLite connection，使用现有 Owner pepper/credential
   authentication 和 Project Policy。create/update 分别要求 `task.create|task.update`，查询
   要求 `task.read`；principal 必须是 strong User，owner/admin/operator 可写，viewer 只读。
5. 写事务在同一 `BEGIN IMMEDIATE` 内重新验证 credential/Identity/pepper fence、Project
   version/status、RoleBinding version/state，并原子提交 allowed audit、Task head、immutable
   revision、mutation replay 与适用的 local execution revision。任何 fence、semantic、revision
   或 audit replay 冲突整体回滚。
6. `mutationId` 同时是 allowed audit event ID；`requestId`、actor、Policy fence、operation 和
   immutable `occurredAtMs` 都属于 exact replay 语义。调用结果未知时只能原样重放 command
   file。复用 mutation 但改变 Task 或 audit 语义必须失败关闭。
7. inspect/list 使用当前 head、最多 256 条的稳定 `taskId` keyset；每页使用新的
   request/audit identity。输出只包含 Project/task、revision、name、kind/schema、enabled、
   content digest 与时间，不回显 spec/config/command 参数、SecretRef、credential、pepper、
   数据库路径或 command-file 路径。
8. 实现只增加现有 `runtime-core`、`local-sqlite`、`local-admin`、`local-owner-cli` 的显式
   subpath；workspace 保持 19 个 package，不新增第三方或 production dependency、migration、
   daemon、timer、watcher、listener、cache、Pool 或端口。Edge/Standalone 空闲成本为零，只有
   operator 发起命令时产生一个短进程和一个 SQLite connection。
9. `ql3-task` 明确不支持 Cluster。Cluster TaskDefinition 管理必须后续通过 PostgreSQL 管理
   repository、独立 credential/RBAC、强认证 transport、持久审计和多副本 fence 提供；不能
   挂载本机 Owner credential 或把 SQLite command file 当集群管理协议。

## 失败与恢复

- 配置、路径、权限或 Task semantic 失败：修正后创建全新的 command identity；
- 认证、授权或 fence 失败：恢复 credential/RoleBinding 后创建新命令，不复用已改变语义的
  mutation；
- revision conflict：先 inspect 当前 revision，再以新 mutation/时间提交明确更新；
- COMMIT 结果未知：保留原 `0600` command file 并逐字重放；`existing` 表示 durable semantic
  已存在，不重新创建 revision；
- audit 与 Task replay 不一致：停止自动重试并人工检查，禁止直接 SQL 修补或删除历史。

## 被拒绝的替代方案

1. **新建 `task-admin` workspace package**：没有独立部署、依赖或权限域，只会让 19 包拓扑
   再次碎片化，拒绝。
2. **把写入口放进常驻 local application**：扩大空闲 authority 和攻击面，也让路由设备为偶发
   管理持续付费，拒绝。
3. **直接使用 SQLite/Repository 脚本**：绕过 authentication、Policy、audit、semantic registry
   和 revision fence，拒绝。
4. **用 `task.enable|disable` 修改 head bool**：破坏 append-only 历史、pinned Run 解释和 exact
   replay，拒绝；状态变化必须是新 revision。
5. **让 Cluster 复用本机 CLI**：SQLite 单 authority 和本机 credential 不具备 PostgreSQL HA、
   多副本竞争或集群 RBAC 语义，拒绝。

## 验证

- `ql3-task` 真实 SQLite 纵切面覆盖 create、exact replay、disable、inspect、keyset list、
  operator allow、viewer deny、credential/Policy race rollback、Task semantic drift、audit semantic
  drift、私有 command file 与低敏输出；当前 5/5；
- `@qinglong/local-owner-cli` 完整 dependency closure strict TypeScript 通过；
- Owner CLI 83/83、local-admin 81/81、local-sqlite 189/189、backend 956 pass/2 条件
  skip/0 fail；19 个 QL3 package 清理后顺序构建并完成全量测试，所有已执行 suite 零失败；
- dependency boundary 40/40 且 repository audit `findings=[]`，Edge import 与 local image
  静态 inventory audit 均 compatible；GitNexus compare-to-develop 为 LOW、0 条受影响执行流；
- PostgreSQL 18.4 arm64 physical HA 同轮重新通过 `remote_apply`、timeline 1→2、旧主先
  fencing、`pg_rewind` 只读同步重入、两个 fresh control replica 与全部业务 gate，
  `gates.passed=true`；测试容器、网络、卷零残留。此项只证明 Cluster 基线未回归，不把
  本机 `ql3-task` 宣称为 Cluster 产品入口；
- 完整 package/backend/dependency/artifact 回归是合入前门禁。

D-239 验证时曾发现 storage-only 超过 512 files、adopted assembly 漏收 `local-secret`，且
application 为 741 files、约 6.40 MiB、import RSS delta 约 20.2--20.35 MiB，因此本 ADR
当时没有把 Profile gate 标记为通过。后续 ADR-0257/D-240 已通过内部运行制品裁剪、精确 adopted
闭包和 eager import 收口修复该 blocker；十档门现已全部通过。D-239 没有自行放宽预算，完整
application 的 24 MiB import delta 分层也不改变 Edge 96 MiB 总物理进程预算。

## 后续约束

后续 ADR-0258/D-241 已完成 Trigger create/update/enable/disable/inspect/list 和
Task→Trigger→Run 的可操作 fresh 用户闭环，并在 Trigger 写入、scheduler candidate 与最终 Run
commit 三处执行 Task current-head fence。下一步为 Cluster 实现 PostgreSQL/RBAC 对等管理入口。
HTTP/UI 只能调用同一服务语义，不能复制 Task/Trigger semantic、Policy、current-head fence 或
replay 规则。非 command kind 仍须各自完成 semantic、权限、编译与执行评审后才能进入
production registry。
