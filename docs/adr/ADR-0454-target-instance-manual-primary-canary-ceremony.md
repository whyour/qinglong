# ADR-0454：目标实例 Manual Primary Canary 与显式回滚仪式

- 状态：Accepted（仪式实现完成；首次真实用户目标实例执行仍待运维）
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-361、PR-4、PR-5
- 关联 ADR：ADR-0002、ADR-0449、ADR-0450、ADR-0451、ADR-0453
- Amends：ADR-0453 的首次目标实例 canary 操作缺口
- Amended by：ADR-0455 的 Profile-bounded durable runtime activation receipt

## 上下文

ADR-0453 已提供 process-epoch capture authority、clean-shutdown evidence、closed terminal audit、compiled-backend rollback/resource report、Primary gate bundle 与
rollout manifest v2 loader，但维护者仍需手工拼接多个命令、文件名、时间窗口和摘要。只提供底层 gate 会留下四类运维缺口：

1. canary 开始前没有不可变计划绑定 Profile、精确样本数和当时的 live rollout 基线；
2. terminal/resource/gate 输出容易经 shell 重定向得到宽权限、部分写入或互相不属于同一 session 的文件；
3. qualification 与写入 live manifest 之间没有显式人工边界，配置选择又容易被误报成“当前进程已经激活”；
4. rollback 没有绑定被替换 manifest 的摘要，也没有 crash-replay intent/completion 链。

Edge 可能是 128 MiB 路由设备，不能为 canary 新增 daemon、watcher、遥测栈或第二数据库；Standalone 可能运行在集群节点上，但本仪式仍只裁决本机
`edge|standalone` Profile，不得借宿主机形态伪装成 `cluster-control|worker` Primary 证据。

## 决策

1. 新增 `qinglong/manual-primary-canary-plan@v1`。`prepare` 只接受受控 session ID、`edge|standalone`、Edge 精确 8 条或 Standalone 32–128 条中由
   operator 选定的精确 admission 数；它记录当前 `qinglong3-rollout.json` 为 absent 或 disabled+SHA-256。已有 enabled manifest 时拒绝准备。
2. plan 固定派生全部 basename，不接受调用方提供输出路径。config root 必须是当前 UID 拥有、非 symlink、group/world 不可写的真实目录；所有 artifact 均以
   `0600`、同目录临时 inode、file fsync、hard-link no-replace 与 directory fsync 发布。重复调用只接受逐字节相同文件。
3. `prepare` 只输出三项部署环境：实际 Profile、`QL3_SHADOW_ORIGINS=manual` 与唯一 capture basename；它不写 enabled manifest、不启动任务、不重启服务。
   operator 必须在隔离窗口中通过既有 Legacy 产品入口精确执行计划数量的 manual admission，并干净关闭同一 worker；任何额外 manual execution 都使样本不相等。
4. `observe` 只有在 capture qualified、单一 manual origin、计数精确且窗口结束至少五分钟后，才以固定参数启动 Node 24 terminal auditor。数据库必须为非 symlink、
   group/world 不可写的普通文件；auditor 只读打开 SQLite。调用方不能注入 origin、window、settling、child script 或 shell。
5. `resource` 用固定 `full + require-compiled + 8 samples` 启动 ADR-0451 runner。它使用自身临时 SQLite，不接触生产数据库；低配设备必须在应用停止后运行，不能把
   与常驻 workload 争用内存后的失败解释为产品回归。
6. `qualify` 复用 ADR-0453 gate，但额外绑定 plan 文件摘要、三份 source 的原始文件摘要、三份 canonical JSON 摘要、精确 admission target 与 gate 文件摘要。
   现有 gate、partial qualification 或 response loss 只能通过原文件重放；source 在 qualification 后被替换时，mutating CLI 与独立 auditor 都失败关闭。
7. `approve` 是唯一写 live manifest 的操作。它要求显式 `approvedBy`，审批最短一分钟、最长 24 小时；先复核 plan 时的 absent/disabled 基线，disabled 基线先
   no-replace 归档，再以同目录 fsync 临时文件和最终摘要复核发布 schema v2 manifest。结果状态固定为 `activation_approved`/`primary_selected`，并明确
   `requiresRestart=true`、`runtimeActivationObserved=false`；配置选择不得冒充 HTTP worker 已完成 startup reconciliation 和 router activation。
8. 应用重启后，实际运行态由 bootstrap 的 `selected → reconciled → durable active receipt → activated` 证明。ADR-0455 已让独立 auditor 复核 receipt 与 Linux
   boot/PID/start-time 联合身份，并新增 `active` 要求；`off|rolled-back` 同时要求不存在仍 current 的 runtime。非 Linux portable receipt 不能获得 current 结论。
9. `rollback` 只接受四个固定 reason 与有界 operator。它先 no-replace 发布 intent，绑定当前 enabled manifest SHA-256 和目标 disabled SHA-256，再复核当前摘要并原子替换
   live manifest，最后发布 completion；intent 或 completion response loss 可用相同参数重放。disabled 已有效但不同于本 session 的目标时拒绝覆盖。
10. 审批过期后，loader 对下一次 bootstrap 必须 fail-closed 为 off；状态/auditor 报 `approvalExpired=true` 和 `rolloutMode=off`。无 watcher 的既有进程不会仅因磁盘
    审批过期而自动卸载 router，故 `off` 审计会在 current receipt 仍存活时失败。operator 必须显式 rollback 并停止/重启应用；过期不能被当作自动续期、自动删除或已停止证明。

## 被拒绝的替代方案

### 常驻 watcher 自动检测 capture 并启用 Primary

拒绝。它把一次性证据变成后台控制面，增加路由设备 timer/文件监控成本，并绕过独立人工审批。

### Canary CLI 自动触发八个用户任务

拒绝。工具没有用户会话、Task Policy、脚本内容或副作用 authority；synthetic spawn 不能证明真实 Legacy 产品入口的 admission capture。

### 用 enabled manifest 存在表示 Primary 已运行

拒绝。manifest 只在下次 bootstrap 被读取；进程可能尚未重启、startup reconciliation 可能失败或审批已经过期。selection 与 runtime activation 必须分开陈述。

### 原地覆盖证据和 rollout 文件以方便重试

拒绝。覆盖会丢失冲突和 crash window。证据采用 no-replace；live rollout 只在摘要复核后原子替换，并由 previous/intent/completion 文件保留恢复链。

## 资源、安全与部署影响

- 正常 QingLong runtime 不新增 import、timer、watcher、listener、数据库连接、schema、migration、package 或生产依赖。全部动作由 operator 一次性调用。
- plan/qualification/selection/rollback 报告不包含数据库路径、命令、Task、Run、Cron、PID、日志、用户输出、错误正文或 Secret；stdout 只返回 stage、Profile、样本数和布尔状态。
- `observe` 只读生产 SQLite；`resource` 只使用 runner 的临时 SQLite。Edge 应在应用停止后运行 resource，Standalone 也不得与同机生产 canary 并发争用。
- POSIX owner 是本机信任根。摘要复核能防止误覆盖和非协作漂移，但不能防御同一 UID 在最后复核与 rename 之间的恶意并发；共享 config root 或远程 delegation 需要
  另行引入签名/锁服务，不得把本仪式描述成多写者共识。
- 本仪式不适用于 `cluster-control|worker`，也不证明物理路由、flash wear、断电、跨主机签名或真实生产任务安全。

## 验证

- domain/CLI 聚焦矩阵覆盖 Edge/Standalone 样本预算、exact shape、短期审批、prepare 重放、unsafe root、disabled baseline drift、source replacement、partial
  qualification、selection receipt response loss、审批过期、rollback intent/completion response loss及独立审计。
- 真实 compiled backend 已通过 D361 `prepare → resource`：Edge plan 保持 automatic activation false；resource 阶段产生 qualified full rollback evidence，
  enabled/off 进程 peak RSS 分别为 `109,953,024 / 102,383,616` bytes，真实 Legacy child 均 exit 0，Shadow Run delta 从 1 收敛为 0。
- 阶段门已重跑：聚焦 `24/24`、`build:back`、完整 backend `1,481 pass / 0 fail / 2 conditional skip`、18-package clean build/test、四项架构审计与
  `14/14` artifact audit 全部通过；产物字节与 D-360 一致。隔离 frozen-lockfile Linux arm64 Docker 的 128 MiB router/256 MiB Edge release peak 分别为
  `81,887,232 / 148,840,448` bytes，`memory.events max/oom/oom_kill` 增量均为 0。
- D361 不修改 PostgreSQL schema/migration、依赖树或 Kubernetes 拓扑，因此不重跑 PostgreSQL HA；任何仓库 synthetic fixture、compiled resource child 或 Docker
  arm64 结果都不沿用、也不冒充尚未执行的真实目标实例 manual capture/activation。

## 后续

维护者仍需在一台真实目标 Edge 或 Standalone 实例执行 [Manual Primary Canary 操作手册](../operations/ql3-manual-primary-canary.md)，并保留 capture、terminal、resource、
gate、qualification、selection、bootstrap activated audit 与 rollback completion。其他 origin 必须建立自己的 admission authority 与 gate；固定物理路由/flash/断电、
多写者 config authority 仍是独立后续工作；运行态 durable activation receipt 已由 ADR-0455 补齐，但首次真实目标实例执行仍待运维。
