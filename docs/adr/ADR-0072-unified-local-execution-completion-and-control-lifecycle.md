# ADR-0072：统一的本机执行完成、取消、超时与停机生命周期

- 状态：Proposed
- 日期：2026-07-20
- 关联：D-18、D-21、D-65、D-67 至 D-70、ADR-0005、ADR-0007、ADR-0066、ADR-0068 至 ADR-0071

> ADR-0087 现行增量：本文 control lifecycle 已迁入 `@qinglong/local-execution/control`；`/recovery` 可单向消费其 completion processor，其他 subpath 不得反向导入 control/recovery。

## 上下文

ADR-0068 至 ADR-0071 已分别建立启动恢复、持久化进程、原子启动协调和有界调度，但完成 Promise、启动恢复回执、取消、Attempt deadline、回执清理和应用停止仍可能由不同 lifecycle 推进。若每条路径各自实现终态映射或拥有 timer，会产生迟到成功覆盖取消、同一 Attempt 重复完成、停机后孤儿进程，以及低配路由器空闲唤醒和内存状态随任务数增长的问题。

## 决策

### 1. 新增独立 Profile-neutral 控制包

新增 `@qinglong/local-execution-control`。生产只依赖 `@qinglong/runtime-core` 与 `@qinglong/local-process`，不得导入 SQLite adapter、Profile importer、legacy、cluster、ORM 或 HTTP。依赖方向固定为：

```text
runtime-core <- local-process <- local-execution-control <- local-run-recovery
                                            ^
                                            |
                                   local-application
```

local-run-recovery 与在线 lifecycle 共享同一个 `LocalCompletionReceiptProcessor`；Run/Attempt 的成功、失败、取消和超时终态只能由该处理器或同包内的控制协调器提交，不再保留两套回执认证和终态事务实现。

### 2. 完成回执是唯一正常完成事实

dispatcher 不向 application stack 返回进程 completion Promise。它只在 Promise settle 后向组合根发送 Attempt ID；通知采用最多 64 个 identity 的进程内合并集合，不携带 token、exit code、命令或日志内容，也不是耐久事实。通知丢失时，周期性数据库候选与启动恢复仍能收敛。

处理器先从唯一 RunRepository 重读 Attempt/Run，再读取 exact receipt，并校验 Run ID、Attempt ID、callback sequence、token digest 和时间边界。可信回执在一个 Repository transaction 中按 Attempt Event、Run Event 顺序 CAS 终态；终态提交后才删除 receipt 并解除 journal。已终态 Attempt 的同一或下一 callback sequence 回执只做认证和清理，不得改写终态。非法回执必须先保存 quarantine intent，再移动文件。

### 3. deadline 先转为 durable cancellation intent

SQLite source 只使用已有 cancellation/deadline 索引，以 `(dueAtMs, kind, attemptId)` 稳定 keyset 返回最多 64 条候选。deadline 到期后，协调器先 CAS 写入 `cancelRequestedAtMs`、`cancelReason=timeout` 与 `run.cancel_requested`，随后才能停止进程；数据库失败不得 signal。

所有取消先尝试消费可信 completion。仍 active 时，只能把最新 runtime-owned local-process Attempt 的完整 durable handle 交给 `LocalProcessController`；禁止裸 PID signal。`claimed` 可直接终结，`starting/running` 只有 exact stop 返回 `stopped/already_exited` 或可信回执时才能终结。unknown、identity/provider 不可用和 stop timeout 保持待收敛，不能猜测退出。

### 4. application 只拥有一个周期 timer

`LocalExecutionControlLifecycle` 同时驱动完成通知、deadline/cancellation 单页扫描和低频 receipt cleanup。每个 application 只有一个 `unref` 周期 timer，没有每任务 timer、watcher、目录扫描或无界队列：

| Profile | 控制周期 | 控制页 | cleanup 周期 | cleanup 页 | drain 页预算 |
| --- | ---: | ---: | ---: | ---: | ---: |
| edge | 5 秒 | 4 | 5 分钟 | 8 | 2 |
| standalone | 1 秒 | 32 | 1 分钟 | 32 | 8 |

每次工作串行且不重叠；页、通知、停止等待和 drain 页数均有硬上限。cluster-control/worker 不装配该本机 lifecycle，其远端 Session/Lease/Attestation 继续使用独立 authority。

### 5. 停机顺序包含 execution drain

application 停止顺序固定为 admission close/drain → local execution stop/drain → injected stack stop → storage close。execution drain 只读取有界 active keyset，为尚无取消意图的 Attempt 先提交 `shutdown` cancellation，再按 exact handle 停止并终态化。已有 user/policy/timeout 意图必须保留，不能被 shutdown 覆盖。生命周期 stop 自身幂等；页预算、stop 证据或时间预算未收敛时返回 `timed_out`，但仍继续关闭后续 owner。

## 替代方案

1. **每个任务一个 timeout timer**：任务数直接决定 timer/closure 数和停机竞态，拒绝。
2. **Promise settle 直接写终态**：内存事实无法跨重启，且绕过 receipt capability，拒绝。
3. **取消先 signal 后写数据库**：数据库失败后无法证明意图与审计，拒绝。
4. **扫描 receipt 目录发现完成**：空闲和大目录成本不可控，也无法证明 active authority，拒绝。
5. **复用 cluster CancellationDispatch/Lease**：让路由设备携带多副本 authority 和驱动，拒绝。
6. **停机直接关闭 SQLite**：仍运行的进程失去控制面与终态收敛路径，拒绝。

## 影响与未完成项

已完成：

- 共享完成处理器、回执认证、原子 Attempt/Run 双终态和迟到回执幂等清理；
- SQLite cancellation/deadline/active stable keyset source，无新 migration 或第二连接；
- deadline→durable timeout intent、user/policy/shutdown cancellation 与 exact process stop；
- dispatcher 内部完成通知、单 timer Profile lifecycle 和 application admission-first shutdown drain；
- 启动恢复复用同一个完成处理器；
- 真实 SQLite completion、deadline、user cancellation、shutdown drain、通知合并和幂等停止测试。

仍未完成：

- retry policy 的产品入口与安全重试协调；
- 加密 Secret provider、Artifact retention/read API 与可观测指标/告警；
- target executable、systemd/Docker/s6 controller 和 2.x cutover 产品流程；
- Linux x64/arm64、PID namespace、强杀/断电/ENOSPC 与固定物理路由器实机门禁；
- PostgreSQL/Remote Worker completion、expiry、cancellation 和 retry 对等生命周期。

因此本 ADR 关闭本机单次执行的 completion/cancellation/timeout/shutdown 纵向缺口，但不表示整个 3.0 target 已可默认接管存量任务。

## 验证

1. completion receipt 认证后原子写入 Attempt/Run 双终态和顺序事件，清理发生在提交之后。
2. cancellation 与 deadline 在 signal 前已有 durable intent；数据库失败、无 exact handle 或 stop unknown 时不写假终态。
3. due source 使用既有索引、稳定 keyset、最多 64 条；edge/standalone 只读取 4/32 条。
4. shutdown drain 先写 `shutdown`，保留已有 reason，并在 storage close 前停止 exact active execution。
5. dispatcher 不暴露 completion Promise，重复完成通知只消费一次 identity。
6. startup recovery 与在线 completion 使用同一处理器，迟到回执不能覆盖 cancelled/timed_out。
7. lifecycle 只拥有一个周期 timer、无任务级 timer/watcher，stop 调用幂等且有硬超时。
8. 本 ADR 落地时 dependency/source/lock、Profile vulnerability 和 application artifact 门禁包含第二十个 importer；ADR-0073 已将 local-secret 扩展为第二十一个。
