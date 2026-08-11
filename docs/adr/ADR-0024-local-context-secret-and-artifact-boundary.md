# ADR-0024：Local Context、Secret 与 Artifact 边界

- 状态：Proposed
- 日期：2026-07-18
- 关联：QL-RFC-0001、ADR-0003、ADR-0007、ADR-0022、ADR-0023

## 上下文

不可变 Task revision 只能保存执行模板和 opaque `contextRef`。真正启动 Attempt 时还需要环境、Secret、stdout/stderr Artifact 和 completion capability。这些数据生命周期不同：public 环境和 Secret 引用可以随 revision 保留，Secret 明文只能短暂存在于可信内存，Artifact 必须与 Attempt 绑定并在控制面重启后仍可定位。

QingLong 同时运行在小型路由设备和 cluster 节点。edge 不能为每个任务常驻队列、sidecar、Collector 或对象存储，但也不能继续把日志路径、Secret 和当前 Crontab 状态临时拼接后直接 spawn。cluster 则不能复用本机文件和 SQLite 作为共享能力。

## 决策

### 1. Context recipe 只保存 public 值和 Secret 引用

`LocalExecutionContextRecipe` 是按环境变量名排序的 canonical bindings：

- `public` binding 保存明确可持久化的普通字符串；
- `secret` binding 只保存 bounded `secretRef`，不保存解析值；
- 环境名唯一，最多 256 项，并继续受 ExecutionContext 的单值 64 KiB、总计 256 KiB 边界约束；
- `contextRef` 是 `localctx:sha256:<digest>` 内容地址，digest 只覆盖 canonical bindings。

`0013-local-execution-context-recipes` 以 `context_ref` 为主键，保存 canonical recipe、独立 digest 和首次创建时间。Repository 是 append-only：同内容重放幂等，不提供 update/delete；非法 JSON、非 canonical 顺序、非内容地址或 digest 损坏均 fail closed。

recipe 不包含 Secret 明文、Run/Attempt identity、callback token、Worker lease、PID/handle 或日志路径。

### 2. 发布顺序阻止可执行的悬空引用

本地发布器固定先插入 context recipe，再插入引用它的 Task execution revision，并要求两个 `contextRef` 完全相同：

- recipe 写入失败时绝不创建 revision；
- 两次 append-only 写之间断电最多留下不可执行的孤儿 recipe；
- 不会留下已经可调度但 recipe 不存在的 revision；
- 并发重放由两个 repository 各自收敛为 inserted/idempotent。

当前没有通用删除接口。未来清理孤儿 recipe 或 revision 前，必须建立引用证明、保留窗口和备份门禁。

### 3. Secret provider 只在 Attempt 物化时批量解析

materializer 先精确读取 `contextRef`，再把去重后的 Secret refs 与冻结 candidate 交给可信 provider。provider 返回与 refs 位置一一对应的内存值：

- recipe 或任一 Secret unavailable 时返回 plan unavailable；
- 缺失或非法结果在 Artifact 分配和 Executor 副作用前拒绝；
- 明文不写回 recipe、revision、RunEvent、普通日志或异常消息；
- 解析后的环境立即通过共享大小/NUL/prototype 边界规范化并冻结。

ADR-0025 已进一步提供 production-unreachable 的 AES-256-GCM envelope、append-only SQLite repository、私有文件 keyring 和批量 environment provider，并且没有把 Legacy `Envs` 表直接宣称为 3.0 SecretStore。权限/审计/API、自动 key 生成与备份、历史 rekey/退役证明和 cluster Secret provider 仍需独立实现。

### 4. 每个 Attempt 获得一个 opaque 本地 Artifact

本地文件 allocator 从 `(runId, attemptId)` 派生 36 字符 opaque Artifact ID，不在 ID 或日志路径暴露 Task 名、命令或 Secret。文件位于受控 root 的固定 shard，目录强制 `0700`、文件强制 `0600`，append 打开使用 `O_NOFOLLOW`，symlink target fail closed。

同一 Attempt 重放得到相同 ID 并追加同一文件，不同 Attempt 必须得到不同 ID。普通 pipe 模式下 output sink 串行已接受写入；durable LocalProcess 模式通过非枚举 adapter capability 把绝对文件路径和 receipt root 交给 launcher，常规 context 序列化看不到路径。

Artifact ID 由 local Dispatcher 随 claimed activation 传入，并在 spawn 前的 `attempt.starting` 事务中持久化。非法/path-like ID 在 Run 状态变化前拒绝；已有 claimed Attempt 若夹带 Artifact identity 被视为 stale authority。这样 Reconciler、日志 API 和 retention 不必从文件名或进程推测所有权。

### 5. 清理只释放 capability，不提前删除历史日志

plan 校验、激活竞争或启动失败时会等待可选异步 dispose；成功激活后在 completion settle 后释放。dispose 关闭当前进程持有的文件 descriptor，并等待已经接受的写入，不删除 Artifact 内容。

删除策略必须独立依据 terminal Attempt、receipt 清理、保留期、容量水位和 revision fencing。ADR-0026 已提供 production-unreachable 的单 Attempt hard quota、statfs admission reserve、压力 retention、SQLite tombstone 和安全文件 retirement；生产启用前仍必须完成 lifecycle/cursor、容量告警、durable truncation fact 与真实 edge ENOSPC/inode/断电测试。

### 6. edge 与 cluster 共享语义，不共享存储实现

- edge/standalone：SQLite immutable recipe + 本地 Secret provider + 私有文件 Artifact；
- cluster-control：PostgreSQL recipe/revision metadata + 集中 Secret provider + 对象 Artifact；
- worker：只接收已授权的 Attempt-scoped capability，不读取控制面的 SQLite 或 Secret 表。

cluster adapter 必须复用 canonical digest vectors、exact resolve、batch Secret、Attempt Artifact identity 和 fail-closed 规则。共享挂载 `database.sqlite` 或本机 Artifact root 不是 cluster 实现。

## 影响

正面影响：

- 自动重试能重建同一 public/Secret 引用意图，同时为 Attempt N+1 分配新 Artifact；
- Secret 明文与静态 revision、recipe、日志 metadata 分离；
- edge 每个 revision/recipe 各一次单行写，每个 Attempt 只持有有界数量的文件 descriptor；
- Artifact ownership 在 spawn 前持久化，重启恢复不依赖内存映射。

代价与风险：

- 需要把 ADR-0025 的本地 SecretStore 补齐权限、审计、key lifecycle 和轮换产品入口后才能生产接入；
- 本地日志仍需要把 ADR-0026 adapters 接入受控 lifecycle，并完成 ENOSPC/告警/截断事实的运维闭环；
- 两步发布可能留下孤儿 recipe，必须用引用感知维护任务清理，不能盲删；
- context 环境仍驻留进程内存，诊断和 heap dump 策略必须避免泄漏。

## 未选择的方案

1. **把 Secret 明文写入 recipe/revision**：静态泄漏与备份扩散，拒绝。
2. **启动时读取当前全局 Envs 并全部继承**：不可复现且权限过宽，拒绝。
3. **先写 revision、后写 recipe**：断电会留下可调度悬空引用，拒绝。
4. **日志文件名使用 Task 名或命令**：泄漏且存在路径边界风险，拒绝。
5. **Artifact ID 只存在内存**：重启后无法证明日志属于哪个 Attempt，拒绝。
6. **plan dispose 删除日志**：激活竞争与 completion 时机无法证明 retention，拒绝。
7. **cluster 复用本地文件/SQLite adapter**：多副本一致性和权限模型错误，拒绝。

## 验证要求

- recipe canonical 顺序、内容地址和 digest 有固定 vectors；
- recipe 并发同内容写入恰好一次 inserted，其余 idempotent；
- 非 canonical、任意 ref、非法 JSON 和 digest 损坏 fail closed；
- recipe 失败时 revision repository 不被调用；
- Secret refs 去重批量解析，missing/错位/越界值在 Artifact 前拒绝；
- 本地 Secret current/exact 版本、CAS/mutation 幂等、密文损坏和跨 Project fail-closed 通过 ADR-0025 contract；
- Artifact ID 对同 Attempt 稳定、跨 Attempt 不同且长度有界；
- 目录/文件权限、symlink、late write、异步 dispose 和 replay append 有真实文件测试；
- Artifact ID 在 spawn 前持久化，invalid ID 不改变 queued Run；
- manual Primary 未传 Artifact ID 时行为不变；
- SQLite adapters 拒绝 cluster dialect，生产启动链保持不可达；
- Node 22、Node 24 全量回归通过。
