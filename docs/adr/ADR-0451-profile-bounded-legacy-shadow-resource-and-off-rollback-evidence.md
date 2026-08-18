# ADR-0451：按 Profile 有界的 Legacy Shadow 资源与关闭回滚证据

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-02、D-359、PR-4
- 关联 ADR：ADR-0002、ADR-0088、ADR-0450
- Amends：ADR-0450 的资源压力与 Shadow-off 回滚待办

## 上下文

ADR-0450 已冻结闭合窗口的 Shadow→Legacy 终态审计语义，但只证明查询结果，不证明它能在 128 MiB 路由档运行，也没有证明进程重启后把
`QL3_SHADOW_ORIGINS` 从 enabled 改为 off 会立即停止新 Shadow 写入而继续执行 Legacy。单元测试或主机 RSS 不能替代受限 Linux cgroup；反过来，
在 128 MiB 门中同时驻留 Node 测试父进程和预期被 SIGKILL 的子进程，也不是路由设备的单进程产品模型。

资源门此前还要求 `/workspace` 必须是独立只读 mount。只读容器根已经让该路径继承只读语义；额外复制约 1.5 GiB 工作区到匿名 volume 会把私有页缓存
计入 128 MiB cgroup，制造与产品 RSS 无关的 `memory.events max`。门禁必须验证路径实际生效的最具体 mount，并拒绝 `/workspace/**` 的任何可写覆盖，
而不是要求一种特定 mount 拓扑。

## 决策

1. 新增一次性证据入口 `benchmark:legacy-shadow`，报告 schema 固定为
   `qinglong/legacy-shadow-resource-rollback-evidence@v1`。报告只包含 Profile、预算、固定资源计数、回滚布尔结论和限制，不输出数据库路径、命令、Run、Attempt、
   Cron、PID、log 或 task identity。
2. 审计 fixture 使用真实 Sequelize + SQLite、真实 migration、真实 Legacy Shadow writer 和 ADR-0450 auditor。edge 固定 8 个 candidate、`8 × 1 page`；
   standalone 固定 128 个 candidate、`32 × 4 pages`。每页必须精确执行一条 candidate 查询和一条 evidence 查询；8 个样本分别固定为 16 和 64 条查询。
3. 审计连接为单连接、SQLite read-only。运行前后同时比较 database、WAL、SHM 与 journal 的 logical bytes、allocated bytes 和 file count；任一变化均失败。
4. `full` 模式必须启动三个独立进程：audit、Shadow-enabled Legacy execution、重启后的 Shadow-off Legacy execution。enabled 进程必须执行真实
   `ScheduleService.runTask` 子进程、Legacy exit 0 且恰好新增一个 terminal Shadow Run；off 进程仍须 Legacy exit 0，但 configured origins 为空、fact factory
   调用为零、默认 Shadow observer/Repository 未加载且 Run 增量为零。
5. Legacy `TaskLimit` 构造器的异步数据库初始化必须在调度和 teardown 前通过同一单例显式等待；证据进程不得用 sleep、吞掉 unhandled rejection 或提前关闭
   Sequelize 来伪造成功。
6. `router-stress-ci` 保持 128 MiB、0 swap、0.5 CPU、64 PID、非 root、只读根、`NoNewPrivs` 和 seccomp，只运行 edge audit-only。该档位保留真实 Edge
   executor、产品 Workflow、SQLite lock 和失败升级恢复，但不运行需要同时驻留测试父/子 Node 的 crash matrix。
7. `edge-release-ci` 保持 256 MiB、0 swap、1 CPU、128 PID，并运行 edge full rollback、standalone audit-only，以及 Edge+Standalone 的完整 Workflow/Prompt
   crash matrix。把双进程 crash harness 放到发布门不减少覆盖，也不把测试框架开销冒充路由产品最低内存。
8. mount 验证按目标路径选择最具体 mount。`/workspace` 可继承只读 `/`，但其任一可写 descendant mount 都使门禁失败；`/tmp` 仍必须是独立、可写且有容量上限的
   tmpfs。门禁不得为满足断言而复制整个工作区。
9. 资源报告继续对 `memory.events max/oom/oom_kill/oom_group_kill` 的任一增量失败，不以“没有 OOM”接受内存触顶；也不放宽既有 latency、RSS、写放大或
   SQLite integrity contract。
10. 本证据只证明 CI 容器内的有界行为，不证明物理路由、flash wear、断电存活、生产任务内容、Legacy→Shadow capture rate、Primary eligibility、
    PostgreSQL 或 Cluster runtime。

## 被拒绝的替代方案

### 把路由内存上限提高到 192/256 MiB

拒绝。失败来自测试拓扑和 workspace volume 页缓存，不是产品 Edge workload 超出预算；扩大内存会掩盖错误建模。

### 增大 crash child 的 30 秒 timeout

拒绝。128 MiB 下父/子双 Node 的回收抖动不是业务时延。完整 crash matrix 已在 256 MiB 发布门保留，路由门不应靠等待更久制造假稳定。

### Shadow-off 只调用配置解析函数

拒绝。回滚证据必须经过进程重启、真实 Legacy child 和数据库计数，证明 off 路径在执行发生时不构造 fact、不加载默认写入组件。

## 验证

- 主机聚焦门 `23/23`；edge full 与 standalone audit-only 都使用 compiled backend 并通过数据库完整性检查。
- Linux arm64 router gate：128 MiB/0.5 CPU/0 swap/64 PID，cgroup peak `80,416,768` bytes；所有 `memory.events` 增量为 0。edge audit 8 个样本、16/16 查询、
  p95 `3.914 ms`、RSS 增量 `131,072` bytes，SQLite storage 前后相同。
- Linux arm64 edge release gate：256 MiB/1 CPU/0 swap/128 PID，cgroup peak `139,079,680` bytes；所有 `memory.events` 增量为 0。edge full audit p95
  `32.056 ms`、16/16 查询、RSS 增量 `3,407,872` bytes；enabled/off Legacy 均 exit 0，Run 增量分别为 1/0，进程峰值 RSS 分别为
  `94,224,384 / 92,577,792` bytes。standalone audit 为 32 pages、64/64 查询、p95 `19.265 ms`、RSS 增量 `1,572,864` bytes，SQLite storage
  前后相同。
- 同一发布门完整通过 Workflow admission/control、Prompt model/outer transaction 等 Edge+Standalone crash matrix；Prompt live execution 与 exact replay
  固定发生 2 次 key resolution、1 次 key load，门禁拒绝计数漂移。
- 完整 `test:back` 与 18-package clean build/test 均退出 0；五个 package/deployment/image/vulnerability 静态契约文件为 `126/126`，Edge import、
  Cluster dependency、package boundary 与 Cluster deployment 四个可执行审计均为 compatible 且零 finding。14 个 Local Profile artifact 全部通过预算；
  Edge/Standalone 字节依次为：base `2,589,998 / 2,590,076`、adopted `2,809,293 / 2,809,416`、application
  `3,632,877 / 3,632,997`、application-api `3,800,430 / 3,800,574`、AI `3,069,251 / 3,069,341`、application+AI
  `4,493,151 / 4,493,283`、MCP `7,315,930 / 7,316,038`。

## 后续

D-360/ADR-0453 已建立 origin-scoped Legacy→Shadow capture authority，并把 observer capture/failure、startup、ADR-0450 terminal 与本 ADR resource/rollback
组合为可由 rollout v2 loader 独立重放的 manual Primary gate bundle；首次目标实例 manual canary bundle 仍必须在实际启用前产生。
固定物理 edge、真实 flash 写放大和断电演练必须作为独立现场证据，不能由本 ADR 的 Docker arm64 结果替代。
