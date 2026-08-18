# ADR-0450：闭合窗口的 Legacy Shadow 终态差异审计

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-02、D-358、PR-4
- 关联 ADR：ADR-0002、ADR-0448、ADR-0449
- Amends：ADR-0449 的跨测量窗口待办

## 上下文

ADR-0448/0449 只证明一次启动时 active Shadow Run 的恢复结果，不能回答一个明确时间段内已经写入的 Shadow Run 是否与 Legacy 执行终态一致。
直接用 startup scanned 计算比例会把未知尾页和未稳定执行混入分母；把全部 `RunningInstances` 当成 Shadow 应写集合也不成立，因为 QingLong 2.x
表没有可信的 execution origin，manual、system crond 与其他 Legacy 路径可能复用同一 Cron。

部署跨度还要求同一能力既能在低性能路由设备运行，也能在 standalone 节点处理较大窗口。审计不能增加启动查询、常驻 timer、第二数据库 authority、
无界数组或高基数指标，更不能为了“补齐”历史数据而改写 Run/Attempt/RunningInstance。

## 决策

1. 新增显式、只读、一次性的 `audit:legacy-shadow-terminal:ql3` 运维入口。调用方必须给出至少一个已支持 Shadow origin 以及
   `[windowStartMs, windowEndMs)`；窗口 cohort 以 `legacy-owned Shadow Run.created_at_ms` 为准，不自动选择“最近一段时间”。
2. 窗口只有在 `windowEndMs <= observedAtMs - minimumSettlingAgeMs` 时闭合，默认 settling age 为五分钟。窗口未闭合、候选页未扫完或
   Legacy evidence 达到硬上限时，不输出任何比例。
3. Source 使用 `(created_at_ms, run_id)` 稳定 keyset，复用现有 `Runs(project_id, created_at_ms)` 索引；Run 与 latest Attempt 在同一有界查询中读取。
   每页再执行一次有界 RunningInstance evidence 查询，不逐 candidate 发出 N+1 查询。单页候选硬上限 64、Legacy evidence 硬上限 512。
4. Profile 默认预算保持与 startup recovery 一致：edge `8 × 1 page`，standalone `32 × 4 pages`。查询不安装 timer、watcher、线程、进程、连接池
   常驻生命周期或后台续扫；预算耗尽返回 `incomplete`，操作者缩小窗口后重试。
5. 关联优先级固定为 direct Attempt/Run reference，其次同 Cron 下的 opaque log artifact ID、PID，最后才允许唯一且在容差内的 started time。
   多个候选或 evidence 截断一律归入 ambiguous，不用“最近一条”猜测。原始 log path 只在 adapter 内哈希，不进入 application/report。
6. 每个 Shadow candidate 必须且只能归入八类之一：`matched`、`shadow_not_terminal`、`shadow_attempt_missing`、
   `shadow_attempt_ambiguous`、`legacy_evidence_missing`、`legacy_evidence_ambiguous`、`status_mismatch`、`field_mismatch`。
   aggregate 与按 origin matrix 都必须守恒。
7. status、exit code、started time、finished time 与 log artifact 使用固定 dimension counters 记录 compared/matched/mismatched/unavailable。
   时间默认允许两秒精度差，硬上限一分钟；`terminalAgreementPermille` 与 `fullyComparablePermille` 只在窗口闭合、候选与 evidence 都完整且分母非零时出现。
8. 报告 schema 为 `qinglong/legacy-shadow-terminal-difference-report@v1`。报告只包含 Profile、窗口、预算、固定计数、最多七条 origin matrix 和
   `matched/empty/differences_found/window_open/incomplete` assessment；不输出 Project/Run/Attempt/Cron/PID/log/task/user/error identity。
9. 报告明确声明 `direction=shadow_to_legacy` 和 `legacyWithoutShadow=not_measured`。当前数据模型无法可靠证明“存在 Legacy 执行但 Shadow Run 未写入”，
   因而本报告不能单独作为 Primary gate；D-360 必须组合 observer failure/capture evidence，或先引入可信 origin-scoped admission ledger。
10. 审计不写数据库、不修复差异、不启动 Executor、不改变 Legacy 返回值。`--fail-on-difference` 只把非 `matched` assessment 映射为进程退出码 1，
    供人工 rollout/CI gate 使用。

## 资源与部署影响

- 不新增 package、生产依赖、schema、migration、表、索引、数据库 authority、HTTP/gRPC 路由、timer、watcher、worker、容器或 Kubernetes 对象。
- edge 默认最多读取 8 个 Shadow candidate 与 64 条 Legacy evidence；standalone 默认最多 128 个 candidate 与每页 256 条 evidence。
- CLI 数据库连接固定只读、单连接池；报告为固定字段 aggregate，不保留 candidate identity，也不建立进程内累计 registry。
- `Runs(project_id, created_at_ms)` 负责 cohort keyset；RunningInstance 查询每页一次且结果有硬上限。若未来固定设备证明表扫描 CPU 不可接受，应通过新 migration
  增加 `(cron_id, started_at, id)` 索引并单独评审升级写放大，而不是在本 ADR 中静默修改已发布 migration checksum。

## 被拒绝的替代方案

### 双向扫描所有 RunningInstances 并计算 Shadow 捕获率

拒绝。2.x `RunningInstances` 没有可信 execution origin，无法知道某条记录是否属于已开启 Shadow 的入口；把它们都放进分母会制造假阴性。

### 在每次 HTTP startup 自动审计历史窗口

拒绝。它会重复 D-356 的启动查询、延迟路由设备监听，并需要隐式选择时间窗口。历史证据必须由操作者显式触发。

### 为每个 Shadow candidate 单独查 RunningInstances

拒绝。即使 candidate 数有上限，N+1 仍会让低性能 SQLite 设备承担不必要的查询调度和重复表扫描。

### 只输出差异明细 ID 方便排障

拒绝。运维日志会泄露高基数任务身份；需要明细时应新增受认证、Project-scoped 的诊断产品面，而不是扩大默认 CLI 报告。

## 验证

- 真实 SQLite 覆盖完全一致、status/exit field 差异、missing/ambiguous evidence、active Shadow、窗口未闭合、edge 页预算耗尽、evidence overflow、
  双 origin 守恒、空分母和只读 CLI 脱敏输出。
- 真实 SQLite/CLI 聚焦测试 `14/14`、Legacy/Shadow 串行扩展 `91/91`、`build:back`、完整 backend
  `1,455 pass / 0 fail / 2 conditional skip`、18-package clean build/test、14/14 static audit 与 14/14 artifact audit 全部通过。
- edge/standalone 的 base、adopted、application、application-api、AI、application+AI、MCP 产物分别为
  `2,589,998 / 2,590,076`、`2,809,293 / 2,809,416`、`3,632,877 / 3,632,997`、
  `3,800,430 / 3,800,574`、`3,069,251 / 3,069,341`、`4,493,151 / 4,493,283`、
  `7,315,930 / 7,316,038` bytes，与 D-357 完全一致。
- 本切片不修改 PostgreSQL、容器或 Kubernetes 部署面，因此物理 PostgreSQL HA/K3s 门不作为本切片的新证据；D-359 仍负责 edge/standalone 资源压力与
  Shadow-off 回滚演练。
