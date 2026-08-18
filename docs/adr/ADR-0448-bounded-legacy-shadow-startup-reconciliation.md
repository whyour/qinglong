# ADR-0448：有界 Legacy Shadow 启动恢复

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-02、D-356、PR-4
- 关联 ADR：ADR-0001、ADR-0002、ADR-0445、ADR-0446、ADR-0447
- Amends：ADR-0002 的 Shadow 启动与恢复边界
- Amended by：ADR-0449

## 上下文

Legacy Shadow 已能旁路观察同一 ChildProcess、关联跨 worker callback/stop，并为 system crond 提供 response-loss-safe execution ID；但 HTTP worker
重启后，原 worker 的内存注册表和 ChildProcess listener 都已消失。数据库可能留下 queued/dispatching/running 的 legacy-owned Run，而 Legacy
`initData` 又会在 HTTP 启动期间先把旧 RunningInstance 从 running 归一为 stopped。

因此不能照搬 Primary Reconciler：Legacy Attempt 没有可复验的 durable Executor handle，PID 可能重用，system crond 还可能独立于 HTTP worker
继续运行。仅用 PID 存活检查会伪造 owner 连续性；把所有非终态 Run 一律 lost，又会提前终结仍可通过稳定 callback 收敛的 system crond。

部署范围同时覆盖低性能路由设备、standalone 和 cluster 节点。启动恢复不得引入常驻 watcher、第二个 SQLite authority 或对 cluster profile 的本机
数据库误装配。

## 决策

1. 只有 `QL3_SHADOW_ORIGINS` 至少显式启用一个已审 origin 时，HTTP worker 才加载恢复 Source、Run Repository、Writer 和 Reconciler。默认 off
   不导入重型 adapter、不查询数据库，也不创建 timer/listener。
2. 恢复发生在 Legacy `initData` 完成 RunningInstance 状态归一之后、manual Primary activation 与 HTTP listen 之前。这样启动期间没有新的 HTTP
   manual admission 与恢复扫描竞争，Primary 也不会先于 Shadow 遗留事实审计激活。
3. 新的只读 Source 使用 `(created_at_ms, run_id)` keyset 分页，只扫描 enabled origin、legacy owner 且状态为 queued/dispatching/running 的
   Run。单页硬上限 64；每个 Cron 的 RunningInstance 证据硬上限 8，超限、重复身份或冲突一律 ambiguous，不猜测更新。
4. Source 只把 RunningInstance 的 log path 转换为现有 36 字符 opaque log artifact ID；原始路径、command、用户名、Run ID 和 Cron ID 不进入
   audit message 或指标 label。
5. 状态裁决如下：
   - 唯一 PID/log/唯一实例证据已经 finished/error：复用 Shadow Writer 补齐 succeeded/failed；
   - 唯一 stopped 且带 finished time：补齐 cancelled，reason 为 reconcile；
   - queued + claimed 且没有 spawn 证据：以 reconciler actor 收敛为 cancelled，并记录 acceptance abandoned；
   - dispatching/running 的 Node worker-owned origin 在重启后没有终态证据：Attempt/Run 收敛为 lost；
   - scheduled_system 没有终态证据：保持 pending，等待稳定 execution ID callback，不能因 HTTP worker 重启提前终结外部 crond；
   - 多 Attempt、证据截断、身份冲突或非法状态：只计 ambiguous/failed，不覆盖 Legacy UI 状态。
6. lost/abandoned 的 Attempt 与 Run 使用两个既有原子命令事务推进。若 Attempt 已提交而 Run 响应丢失或进程退出，下次启动会从唯一 terminal Attempt
   修复 active Run；不产生第二个 Attempt，也不重放外部副作用。
7. Reconciler 每次 HTTP 启动只运行一次：edge 为 `8 × 1 page`，standalone 为 `32 × 4 pages`。页预算耗尽返回稳定 resume cursor 和
   `remaining=true`，不在进程内排队、不自动循环；后续差异报表和正式 Primary gate 必须把 remaining/ambiguous/failed 视为未闭合证据。
8. `cluster-control` 与 `worker` profile 拒绝本机 Legacy Shadow 恢复装配。它们未来必须使用 PostgreSQL/shared authority 的独立 Reconciler，不能复用
   Legacy SQLite。
9. Source、写入、配置或 audit sink 失败均保持 Shadow fail-open，只输出低敏 error type/有界 summary，不阻止 2.x HTTP 服务启动。

## 资源与部署影响

- 不新增 package、生产依赖、schema、migration、表、索引、进程、线程、端口、timer、watcher 或 Kubernetes 对象。
- edge 每次启动最多扫描 8 个 Run，每个带 Cron identity 的候选最多读取 8 条 RunningInstance；standalone 最多扫描 128 个 Run。
- 查询使用现有 Runs/RunAttempts 索引与 keyset，不用 OFFSET、不全表加载 Attempt，也不把原始日志路径带出 adapter。
- 默认 off 和 cluster/worker profile 都是零 Repository、零恢复查询、零写入；只有显式 Shadow 的本机 profile 承担一次性启动成本。

## 被拒绝的替代方案

### 复用 Primary Startup Reconciler

拒绝。Primary 依赖 durable Executor handle、receipt journal 和 runtime owner；Legacy Shadow 不具备这些证据，复用会把 PID 猜测伪装成精确身份。

### 启动后定时全表扫描

拒绝。它会给路由设备增加常驻 timer、重复数据库唤醒和不可控历史扫描，也与当前一次性启动门边界不符。

### 所有旧 active Run 一律 lost

拒绝。system crond 独立于 HTTP worker，并可用稳定 execution ID 在重启后补发终态 callback；提前 lost 会丢弃更强事实。

### 在 Source 中复用原始 log path 作为跨层 identity

拒绝。原始路径可能暴露任务结构或用户信息；adapter 内必须先转换为现有 opaque artifact ID。

### 在 cluster profile 打开同一 SQLite 恢复器

拒绝。多节点会形成多个本机 authority，既无法看到共享事实，也可能产生冲突终态。

## 验证

- 真实 SQLite 覆盖唯一 RunningInstance 成功终态、startup-reset lost、spawn 前 abandoned、显式 stopped、system-crond pending、重复身份拒绝、
  terminal Attempt response-loss 修复和稳定 keyset 分页。
- Bootstrap 合同覆盖默认关闭零 execute、cluster/worker 拒绝、edge/standalone 独立预算、低敏失败开放，以及
  `Legacy normalization → Shadow recovery → Primary activation → HTTP listen` 顺序。
- 聚焦测试 `15/15`；Legacy/Shadow 扩展 `63/63`，Legacy 身份专项 `8/8`，两者串行组合 `71/71`；完整 backend
  `1,434 pass / 0 fail / 2 conditional skip`；18 个 QL3 package 均完成 clean build/test，`build:back` 通过。
- 14/14 static audit 与 14/14 artifact audit 通过。edge/standalone 的 base、adopted、application、application-api、AI、
  application+AI、MCP 产物分别为 `2,589,998 / 2,590,076`、`2,809,293 / 2,809,416`、
  `3,632,877 / 3,632,997`、`3,800,430 / 3,800,574`、`3,069,251 / 3,069,341`、
  `4,493,151 / 4,493,283`、`7,315,930 / 7,316,038` bytes，与前一阶段一致。
- 本切片不改 schema/migration、数据库连接拓扑、容器或 Kubernetes 资源，未重跑物理 PostgreSQL HA/K3s 门；对象存储
  backup/WAL/restore/PITR 与 cert-manager mTLS 轮换继续保留为发布最终化现场证据门。
