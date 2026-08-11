# ADR-0069：持久化本机进程启动屏障与数据库索引回执清理

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-02、D-05、D-17、D-37、D-40、D-42、D-62、D-65、D-66、D-67、D-68、D-69
- 关联 ADR：ADR-0003、ADR-0007、ADR-0026、ADR-0040、ADR-0044、ADR-0063、ADR-0066、ADR-0068

> ADR-0087 现行增量：`@qinglong/local-process` 继续保持独立 package；execution/control/recovery/dispatch 已合并为 `@qinglong/local-execution` 的四个 subpath，且任何策略模块反向进入 local-process 仍由依赖门禁拒绝。

## 上下文

ADR-0068 已能在启动时消费可信 completion receipt 或复验 exact Linux 进程身份，但“能够恢复已有证据”不等于“3.0 已能生成这些证据”。若继续复用 legacy `LocalProcessExecutor`、Sequelize completion journal 或根应用的全局执行对象，新架构会重新继承 ORM、隐式生命周期和 2.x 组合根；若 launcher 直接依赖 recovery package，基础执行设施又会反向依赖恢复策略。

另一个容易被忽略的崩溃窗口是回执清理。任务终态提交后删除文件失败、非法回执隔离中断或进程在两者之间退出时，不能靠扫描目录恢复维护工作。路由设备不能承受递归扫描和高频 timer，standalone 又需要比启动时单次清理更快的收敛。因此需要一个数据库索引、严格有界且 Profile-aware 的维护协议。

## 决策

### 1. 本机进程基础设施与恢复策略保持单向依赖

新增 `@qinglong/local-process`，只生产依赖 `@qinglong/runtime-core`。它拥有 completion receipt codec/file store、Linux durable identity、POSIX launcher 和 receipt cleanup lifecycle。`@qinglong/local-run-recovery` 只拥有 Run/Attempt 聚合裁决，依赖 runtime-core Repository port 与 local-process 的证据协议；local-process 禁止反向导入 recovery。

固定依赖方向为：

```text
runtime-core
  <- local-process
  <- local-execution

runtime-core + local-process
  <- local-run-recovery

local-execution + local-run-recovery
  <- local-application
```

两包都不得导入 local-sqlite、Profile、legacy、cluster、ORM、HTTP 或根可变 singleton。SQLite 适配器只通过 runtime-core journal port 注入；这避免把文件/进程基础设施、数据库实现和恢复策略重新揉成一个万能 Executor。

### 2. launcher 必须在 spawn 前建立持久化登记屏障

`LocalProcessLauncher.start()` 的顺序固定为：

1. 严格校验 UUIDv7、命令、argv、环境、工作目录、输出路径、callback capability 和总字节预算；
2. 以 `O_NOFOLLOW` 打开 bundled launcher，对同一 fd 确认普通文件、大小上限和固定 SHA-256，并只从该 verified fd 执行；
3. 准备私有 receipt shard 与可选 `O_NOFOLLOW`、`0600` append 输出文件；
4. 通过 `LocalCompletionReceiptJournal.register()` 在数据库登记 exact Run/Attempt；
5. 只有登记成功才以独立 process group spawn 受审 POSIX wrapper；
6. 立即取得 Linux boot ID、PID、process group 与 `/proc/<pid>/stat` start ticks，生成 `ql3lp1` durable handle；身份不可取得时先 TERM、再 KILL 同一进程组并返回失败。

journal 失败、launcher 被替换、路径或预算无效都发生在用户代码 spawn 前。wrapper 在启动用户命令前清除所有 `QL3_RECEIPT_*`/`QL3_LAUNCH_*` 环境，转发 TERM/INT/HUP，等待用户进程结束，再以私有临时文件、fsync、hard-link no-overwrite 方式发布最多 4 KiB 的 completion receipt；回执发布失败不得改写用户进程原 exit code。

launcher 不负责把 Attempt 从 `claimed` 推进到 `starting/running`，也不自行生成 callback token hash。ADR-0070 的独立 local-execution coordinator 已在调用前原子持久化 start intent，在返回后以完整 CAS 保存 handle/PID，并在 ownership 写失败时按 exact identity 补偿；裸 launcher 继续保持无上层生产入口。

### 3. cleanup journal 是 Run 数据库的一部分，不是第二文件索引

runtime-core 增加 `LocalCompletionReceiptJournal` port。SQLite reviewed migration `0003-completion-receipt-journal` 新增 `LocalCompletionReceiptJournal`，以 Attempt 为主键并外键绑定 Run/Attempt，只允许：

- `pending`：spawn 前已登记、等待终态后删除 exact receipt；
- `quarantined`：已先持久化确定性 quarantine reference 与 purge time，等待完成移动/删除。

`LocalSqliteRunRepository` 在同一 `DatabaseSync`、有界 operation queue 和 close fence 上实现 register、quarantine、resolve 与稳定 `(updated_at_ms, attempt_id)` keyset page。register 只有在 exact `local_process` Attempt 已存在且 Run 匹配时成功；相同命令幂等，不同时间或身份冲突 fail closed。

恢复协调器对非法回执先写 `quarantined` intent，再移动文件；可信完成先提交 Attempt/Run/双 Event，再删除文件，文件删除成功后才 resolve journal。journal resolve 失败只留下可重试维护事实，不回退已经提交的业务终态。

### 4. 清理只消费数据库候选，不枚举目录

`LocalCompletionReceiptCleanupScanner` 每次只读取一页、逐项串行：

- active Attempt 保留；
- terminal Attempt 只删除 exact receipt，成功后 resolve；
- terminal receipt 已缺失时等待显式 retention 后才解除索引；
- 到期 quarantine 先幂等完成隔离，再 purge，最后 resolve；
- 任一单项失败只增加低敏计数并保留该事实。

它没有递归、目录枚举、worker pool 或第二数据库连接。cursor 与 `truncated` 含义分离：cursor 是最后观测位置，只有截断页才在同一轮继续推进；完整页后下一 tick 从头复核仍 active 的候选。

### 5. application composition root 独占维护生命周期

`@qinglong/local-application` 在 adopted storage ready 后创建 receipt store、launcher、durable controller、execution coordinator 和 cleanup scanner。ADR-0071 后 coordinator 也保持私有，stack 只取得有界 dispatcher 与冻结 definition writer facade。启动顺序变为：

```text
storage ready
  -> assembly
  -> receipt-first Run recovery
  -> one bounded receipt cleanup page
  -> domain recovery
  -> stack lifecycles + cleanup lifecycle
  -> admission
```

停止顺序为 admission drain → receipt cleanup lifecycle → stack → storage。cleanup lifecycle 只有一个 `unref` timer、禁止重叠、每 tick 一页且 stop 等待有上限。edge 使用 5 分钟、8 条、24 小时 retention 和 2 秒 stop；standalone 使用 1 分钟、32 条、1 小时 retention 和 5 秒 stop。disabled application 不创建 store、launcher、timer 或数据库 authority。

### 6. 低资源约束优先于后台“及时性”

空 journal 的启动与 tick 只支付一次数据库点页查询，不触碰 receipt 文件或 `/proc`。页上限硬限制为 64，实际 edge/standalone 分别为 8/32；清理不递归追页、不并行删除、不为每个 Attempt 创建 timer。cluster-control/remote Worker 继续使用 PostgreSQL/Worker journal 和远端 authority，不能复用本机 PID 或 SQLite maintenance 模型。

## 被否决的替代方案

1. **复用 legacy LocalProcessExecutor/Sequelize journal**：重新引入根应用、ORM 和 2.x 生命周期，拒绝。
2. **让 local-process 依赖 local-run-recovery**：基础协议反向依赖策略，形成新耦合环，拒绝。
3. **把 receipt journal 做成第二 SQLite 文件或 JSON 索引**：产生双 authority、额外连接与恢复顺序，拒绝。
4. **启动时扫描 receipt root**：成本随孤儿文件增长，无法证明文件属于哪个 Attempt，拒绝。
5. **每个 receipt 一个 watcher/timer 或并行清理池**：路由设备常驻资源和尾延迟不可控，拒绝。
6. **终态提交后无条件删除 journal**：文件删除失败将永久失去可发现性，拒绝。
7. **身份捕获失败仍返回裸 PID**：PID 可复用且不能证明进程组，拒绝。

## 影响与未完成项

已完成：

- local-process/recovery 的单向 package 边界和 fail-closed dependency audit；
- reviewed SQLite journal migration；ADR-0071 后同队列 Repository adapter 与 dispatch plan migration 将整体 capability 提升至 v3；
- digest-bound POSIX launcher、pre-spawn registration、immutable receipt 与 exact Linux identity；
- journal-driven startup cleanup、Profile-aware 单 timer lifecycle和反向停止；
- application 私有 coordinator、窄 dispatcher capability 与真实 SQLite cleanup/启动协议纵向测试；
- application tarball 继续不含 legacy、cluster、Worker、ORM 或额外 SQLite addon。

仍未完成：

- 加密本机 Secret provider、Task definition 管理权限/审计与 Artifact retention/read stack；
- ADR-0072 已接管新执行路径的 cancellation、timeout 与 shutdown drain；仍缺 retry 与人工 recovery 产品流程；
- Linux x64/arm64、PID namespace、控制面强杀、断电、ENOSPC/inode 和固定物理路由设备门禁；
- target executable、systemd/Docker/s6 controller、API/UI 状态与默认部署入口。

因此当前完成的是可注入的 3.0 本机进程基础设施与可恢复维护协议，不代表 scheduler 已经调用它，也不代表 2.x Primary 可以删除。

## 验证

1. journal register 在 spawn 前发生；register 失败时用户命令没有副作用。
2. bundled launcher digest 漂移在登记和 spawn 前拒绝；登记后替换路径仍只执行已验证 fd。
3. identity 捕获失败会停止进程组，绝不返回裸 PID handle。
4. receipt no-overwrite、4 KiB、`O_NOFOLLOW`、callback 环境清除和用户 exit code 语义通过测试。
5. SQLite registration exact-idempotent，非 local-process/missing Attempt 拒绝；分页和 quarantine due 顺序稳定。
6. invalid receipt 先保存 quarantine intent；可信 completion 删除文件成功后才 resolve journal。
7. cleanup 只处理 terminal exact candidate，保留 active，lifecycle 显式启动、无重叠且幂等停止。
8. application 真实 SQLite 测试证明启动清理删除一个精确终态 receipt 并解除 journal。
9. ADR-0073 后 edge-application 产物为 1534395 bytes、355 文件、48 个加载模块、11632640 bytes RSS 增量；standalone-application 为 1534539 bytes、355 文件、48 个加载模块、11632640 bytes RSS 增量，均为 12 个 package，且低于 4 MiB/512 文件/16 MiB 门禁。
