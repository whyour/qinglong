# ADR-0455：Profile-bounded Manual Primary 运行态激活凭据

- 状态：Accepted（实现完成；首次真实目标实例执行仍待运维）
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-362、PR-4、PR-5
- 关联 ADR：ADR-0002、ADR-0453、ADR-0454
- Amends：ADR-0454 的运行态 durable activation receipt 缺口

## 上下文

ADR-0454 把 `primary_selected` 与运行态 `activated` 明确分开，但后者仍只存在于进程日志。日志可能没有持久 sink、可能被轮转，也无法在进程退出后区分“曾经激活”与“当前实例仍在运行”。仅记录 PID 又会受到 PID 重用、宿主重启和容器 namespace 变化影响。

Edge 可能只有 128 MiB 内存与低耐久 flash，不能为运行态证明增加 watcher、心跳 timer、数据库表、遥测 sidecar 或无限增长事件日志。Standalone 即使运行在集群节点上，也仍是本机 Profile，不能把宿主形态当成 cluster-control authority。

## 决策

1. 默认 HTTP worker 仅在 accepted schema v2 manifest 精确选择 `manual=primary` 且 Profile 为 `edge|standalone` 时，惰性加载凭据 adapter。disabled、rejected 和非 Primary 路径不 import adapter、不读写凭据。
2. 当前状态固定为 config root 下唯一的 `qinglong3-manual-primary-runtime.json`，schema 为 `qinglong/manual-primary-runtime-receipt@v1`。它是 observed-state projection，不是 rollout authority；`qinglong3-rollout.json` 仍是唯一期望配置。
3. 凭据只包含随机 activation ID、Profile、manifest revision、manifest 原始 SHA-256、激活/更新时间、`active|stopping|stopped|failed` 状态、进程身份和 domain-separated 自摘要。文件不包含 Task、Run、Cron、命令、路径、用户、日志、Secret 或错误正文。
4. 文件必须位于当前 UID 拥有、非 symlink、group/world 不可写的真实 config root，以 `0600` 临时 inode、file fsync、原子 rename 和 best-effort directory fsync 发布。大小硬上限为 8 KiB；读取使用 `O_NOFOLLOW` 并复验 owner、mode、普通文件、exact shape 与自摘要。
5. Linux 当前性使用 `/proc` 的 boot ID、PID、process-group ID 和 start-time ticks 联合身份，避免 PID 重用。已有 `active|stopping` 凭据只有在该联合身份确定 `exited|identity_mismatch` 后才能由下一实例替换；仍为 `running` 或无法反证时 fail closed。非 Linux 只写 portable PID，允许开发启动，但独立 auditor 必须返回 `unsupported`，不得宣称 current。
6. 激活顺序固定为 reconciliation → 三个 lifecycle → router install → durable `active` → structured `activated` audit。写 `active` 失败时必须立即撤销 router、停止已启动 lifecycle，并保持原激活错误；因此日志中的 `activated` 必然晚于 durable receipt。
7. 干净停止先写 `stopping`，再撤销 router 并按 timeout → cancellation → completion 停止 lifecycle，最后写 `stopped`。任一停止或凭据转换失败时尝试写 `failed`，停止调用仍返回第一个错误；`stopping|stopped|failed` 都不能被审计为 active。重复 stop 共用同一 Promise，不重复释放资源或写状态。
8. 独立 canary auditor 新增 `--require=active`：必须同时复核 plan、qualification、selection、live enabled manifest、receipt binding 和 Linux 联合进程身份。报告分开输出 `runtimeActivationObserved`、`runtimeActivationCurrent`、receipt state 与 process state，不输出 PID、boot ID 或 activation ID。
9. `--require=off|rolled-back` 现在还要求 `runtimeActivationCurrent=false`。manifest 已回滚或审批已过期但旧 worker 尚未停止时，loader 对下一次 bootstrap 的决策虽为 off，当前内存 router 仍可能继续拥有 manual；auditor 必须拒绝把这种状态表述为已关闭。无 watcher 的部署必须显式停止/重启后再完成 off/rollback 审计。
10. 本凭据不是跨 UID、共享卷或多写者共识锁。同一 UID 可改写 config root，启动前的 read/inspect/write 也不替代部署系统的单实例约束；共享 config、多主机签名或强互斥需要独立 authority，不能由本地 receipt 推断。

## 被拒绝的替代方案

### 用 enabled manifest 表示 active

拒绝。manifest 可能尚未被当前 worker 读取，reconciliation 可能失败，审批可能过期，回滚后旧进程也可能尚未重启。

### 每秒刷新心跳文件

拒绝。它增加永久 timer、写放大和 flash 磨损，仍需处理 suspend、时钟跳变与调度延迟。进程联合身份提供按需审计，不需要周期写盘。

### 每次启动追加一份不可变 receipt

拒绝。无限历史会在路由设备上持续增长，而且仍需另一个 current pointer。单个有摘要的 observed-state projection 足以表达本切片状态；不可变 selection 与 rollback 链继续由 ADR-0454 保存。

### 非 Linux 使用 `kill(pid, 0)` 宣称 current

拒绝。它不能防 PID 重用，也不能绑定宿主 boot。portable receipt 只证明 bootstrap 曾写入，不提供 current 结论。

## 资源、安全与部署影响

- 默认关闭路径零新增 I/O、timer、watcher、listener、连接和数据库操作。
- 激活写一次，干净停止最多再写两次；常驻内存只有一个小 receipt 对象，不随任务数增长。
- 不新增 workspace package、生产依赖、migration、PostgreSQL/Kubernetes 对象或部署端口。
- receipt 是 owner-private 运维证据，不应发布到公开 artifact；auditor stdout 只输出低敏状态。
- approval expiry 不会在已运行进程内自动卸载 router。该限制是无 watcher 决策的直接结果，必须通过部署系统的显式 restart/stop 收敛。

## 验证

- 聚焦 `25/25` 覆盖 active→stopping→stopped、摘要篡改、live identity 冲突、stale generation 接管、portable identity 不冒充 Linux current、receipt 写失败撤销 ownership、停止顺序、canary `--require=active` 以及 live runtime 阻断 rolled-back。
- `build:back` 与完整 backend 通过：`1,487 pass / 0 fail / 2 conditional skip`。首次沙箱执行仅有 Vault loopback 因 `listen EPERM` 失败；允许 loopback 后原命令完整重跑为上述结果。
- 18-package clean build/test 退出 0。首次沙箱执行仅有 worker-runtime 三个 TLS/mTLS loopback contract 因相同 `listen EPERM` 失败；允许 loopback 后完整 clean 原命令重跑通过。
- Edge import、cluster dependency、package boundary、service-manager bridge 四项架构审计零 finding；package boundary 仍为精确 18，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。
- `14/14` Local Profile artifact audit 全部通过且字节与 D-361 基线一致：基础 Edge/Standalone `2589998/2590076`、adopted `2809293/2809416`、application `3632877/3632997`、application-api `3800430/3800574`、AI `3069251/3069341`、application+AI `4493151/4493283`、MCP `7315930/7316038`。
- 隔离 frozen-dependency Linux arm64 Node 24 Docker 门通过：128 MiB router stress peak `87,339,008` bytes，256 MiB Edge release peak `145,506,304` bytes，`memory.events max/oom/oom_kill` 增量均为 0；所有 workload 通过。该证据不是物理路由或 flash/断电证明。
- 本 ADR 不修改依赖树、PostgreSQL schema/migration 或 Kubernetes 拓扑，因此 PostgreSQL HA 不因本切片重复执行。

## 后续

仍需在真实 Edge/Standalone 目标实例执行 prepare→真实 manual cohort→qualify→approve→restart→`--require=active`→rollback→restart→`--require=rolled-back` 完整仪式。物理 flash/断电、PID namespace、同 UID 恶意并发、共享配置目录和签名式多写者 authority 继续作为独立 Gate。
