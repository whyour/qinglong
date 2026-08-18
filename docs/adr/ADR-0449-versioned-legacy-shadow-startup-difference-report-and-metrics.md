# ADR-0449：版本化 Legacy Shadow 启动差异报告与指标批次

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-02、D-357、PR-4
- 关联 ADR：ADR-0002、ADR-0448
- Amends：ADR-0448 的启动恢复可观测性边界

## 上下文

ADR-0448 已在监听前对 active Legacy Shadow Run 执行一次有界恢复，但返回值只有进程内总数。总数无法回答某个 execution origin 是否存在
unresolved difference，也没有稳定 schema 可供日志采集器、测试门或后续 Primary admission 使用。直接输出 Run/Cron/Attempt identity 会扩大敏感面；
用“完整率百分比”又会在分页未完成、历史分母未知时制造虚假精度。

本决策只关闭 startup reconciliation 的差异可见性，不宣称已经完成跨测量窗口的 Shadow/Legacy 历史终态对账。后者仍需独立读取终态、时间、
exit code 与 Artifact existence，并形成可审计窗口。

## 决策

1. 每个 startup candidate 必须且只能归入九个固定 outcome 之一：`completed`、`cancelled`、`abandoned`、`markedLost`、`repaired`、
   `pending`、`ambiguous`、`skipped`、`failed`。总 outcome 之和必须等于 scanned。
2. Reconciler 同时维护 aggregate 与按已配置 origin 的 outcome matrix。origin 只能来自受审 `ExecutionOrigin` 枚举，当前 Shadow 配置最多七项；
   不允许 Run ID、Cron ID、Attempt ID、PID、log path、task identity、用户名或错误消息进入维度。
3. Supervisor 必须跨页合并同一矩阵，不启动第二次扫描。bootstrap 在输出前验证页数、候选数、aggregate conservation、origin conservation、
   origin exact coverage、`remaining/stopReason` 和 page-limit resume cursor；任一不一致按 `RangeError` 失败开放。
4. 差异报告使用 `qinglong/legacy-shadow-startup-difference-report@v1`，只包含 Profile、固定预算、覆盖范围、aggregate outcomes、最多七条
   origin outcomes 和四态 assessment：
   - `converged`：扫描完成且没有 pending、ambiguous、skipped、failed；
   - `waiting_external_callback`：只剩可由 system crond 稳定 callback 收敛的 pending；
   - `incomplete`：页预算或 cursor stall 导致 remaining；
   - `attention_required`：存在 ambiguous、skipped 或 failed，优先级高于分页状态。
5. 不报告比例。`remaining=true` 时未知尾页不属于可证明分母；即使扫描完成，startup report 也只覆盖当次 active candidate，不冒充历史完整率。
6. 指标批次使用 `qinglong/legacy-shadow-startup-metric-batch@v1`。维度固定为 profile、assessment、stopReason；数值字段固定为预算、页数、
   scanned、remaining/resumeAvailable 和九个 outcome，并携带同一最多七条 origin matrix。字段是单次启动 snapshot，不伪装为进程内累计 counter。
7. 默认结构化 startup audit 内同时携带 report 与 metric batch；组合方也可注入单次 `collect` sink。sink 失败不得改变 audit、Legacy 启动或任务结果，
   不做内存积压、磁盘重试或网络重试。
8. `reconciled` audit 只用于 `converged`；其余可验证但未闭合状态均标为 `incomplete`。该状态本阶段仍只报告，不阻止 HTTP listen，正式
   origin-scoped Primary gate 必须在后续决策中显式消费报告并保持副作用前 fail-closed。

## 资源与部署影响

- 不新增 package、生产依赖、数据库查询、schema、migration、表、索引、连接、timer、watcher、线程、进程、端口或 Kubernetes 对象。
- 每个 candidate 只增加一次常数计数；矩阵最多七行，edge 仍最多处理 8 个 candidate，standalone 仍最多 128 个。
- 默认关闭和 cluster-control/worker 仍不加载 Repository，也不生成本机恢复 report/metrics。
- metric collector 是可选调用端口，不拥有 exporter、队列或重试 authority；后续 Prometheus/OTel adapter 必须保持固定维度并单独评审。

## 被拒绝的替代方案

### 只把原始 summary 打进日志

拒绝。它没有 schema、origin 分解、conservation fence 或稳定指标字段，后续 gate 只能猜测日志形状。

### 输出每条差异的 Run/Cron identity

拒绝。启动日志和 metric labels 会形成高基数与任务信息泄漏；需要逐条诊断时应由受认证、有界的独立查询产品提供。

### 用成功数除以 scanned 作为完整率

拒绝。startup active scan 不是测量窗口，remaining 时分母未知，pending 也不是失败；百分比会把局部 snapshot 冒充 rollout 证据。

### 在路由设备内常驻 metrics registry/exporter

拒绝。PR-4 当前只需要稳定采集合同；常驻 exporter、队列、网络重试和生命周期必须由 Profile 部署层独立决定。

## 验证

- 真实 SQLite 覆盖 manual lost 与 scheduled_system pending 的双 origin matrix，aggregate 与 origin outcome 精确守恒。
- Bootstrap 覆盖 report/metric schema、standalone 128 candidate 预算、waiting/incomplete/attention assessment、cursor identity 脱敏、畸形 summary
  失败开放和 collector failure 失败开放。
- 聚焦测试 `21/21`，Legacy/Shadow 串行扩展 `77/77`；`build:back` 与完整 backend
  `1,440 pass / 0 fail / 2 conditional skip`；18 个 QL3 package 均完成 clean build/test。
- 14/14 static audit 与 14/14 artifact audit 通过；七档 edge/standalone 产物字节与 D-356 完全一致，证明 Legacy report/metrics
  未穿透 QL3 package 产物边界。
- 本切片不改数据库/schema/migration、容器或 Kubernetes 部署面，未重跑物理 PostgreSQL HA/K3s 门；对象存储恢复/PITR 与
  cert-manager mTLS 轮换继续保留为发布最终化现场证据门。
