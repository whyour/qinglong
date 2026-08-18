# ADR-0453：Origin-scoped Legacy Shadow 捕获权威与 Primary 门禁

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-02、D-360、PR-4、PR-5
- 关联 ADR：ADR-0002、ADR-0449、ADR-0450、ADR-0451
- Amends：ADR-0002 的 Shadow→Primary 门禁、ADR-0451 的 Legacy→Shadow capture 缺口

## 上下文

ADR-0450 能证明已存在的 legacy-owned Shadow Run 与 Legacy 终态一致，但它明确不测量没有 Shadow Run 的 Legacy execution。ADR-0451 又证明
资源预算和 enabled→off 回滚，却仍不能把“看到的 Shadow 都正确”推导成“每个 Legacy admission 都被捕获”。旧
`shadowBridgeFailureSnapshot()` 只有进程累计失败 key，没有 admission 分母、pending 守恒、测量窗口或可供 rollout loader 重放的权威文件。

Primary manifest v1 还只要求维护者填写五个 `"passed"`。即使审批和文件摘要有效，运行时也无法重算这些字符串背后的 capture、terminal agreement、
startup convergence 与 rollback evidence；把字符串替换为一份只声明 `eligible` 的 receipt 同样不构成门禁。

## 决策

1. 已配置 origin 进入默认 Legacy Shadow bridge 后、构造 fact 前，必须取得一次 process-local admission token。token 只能结算为
   `captured | failed | pending`；`captured + failed + pending = admitted`，failure 进一步固定为 `fact | observer | initialization | accept` 四类并守恒。
   Legacy spawn、返回值和失败开放语义不变；测试 override 不构成生产 capture authority。
2. `LegacyShadowRunObserver` 暴露只读异步 `captureSettled()`：只有真实 `LegacyShadowRunWriter.accept()` 成功才结算 captured。初始化失败、fact 构造失败、
   observer begin 失败或 accept 失败分别结算到固定失败类；后续 spawned/running/terminal 写入仍由 ADR-0450 终态审计裁决，不能用 accept 成功替代终态一致。
3. snapshot schema 为 `qinglong/legacy-shadow-capture-snapshot@v1`，用随机 process epoch、时间和最多七行 origin 固定计数表达，不含 PID、Run、Attempt、Cron、
   task、command、path、用户或错误消息。window report schema 为 `qinglong/legacy-shadow-capture-report@v1`；起始 snapshot 必须零 pending，同 epoch 前后差分、
   origin exact coverage 和计数单调必须成立。
4. HTTP worker 在 Legacy normalization 和 ADR-0449 startup reconciliation 之后、Primary bootstrap/listen 之前装配一次性 exporter。只有显式设置
   `QL3_SHADOW_CAPTURE_EVIDENCE_FILE=<basename>.json` 才开启；文件固定写入既有 config root，basename 禁止路径、`.` 前缀和 `..`。exporter 无 timer、watcher、
   listener、重试队列或数据库连接，只在干净 shutdown 写一次 `0600`、`wx` no-replace JSON；失败只形成低敏审计，不改变 Legacy shutdown。
5. capture evidence schema 为 `qinglong/legacy-shadow-capture-evidence@v1`，同时嵌入同进程启动时的 ADR-0449 report。只有 startup `converged`、Profile 与
   origin 顺序精确一致、capture assessment 为 `captured` 才 qualified；crash、非干净退出、partial/no-replace 写失败、empty、pending 或任一失败都不能产生
   Primary eligibility。
6. `gate:legacy-shadow-primary:ql3` 组合三份低敏输入：capture/startup evidence、ADR-0450 closed terminal report、ADR-0451 compiled-backend full rollback/resource
   report。当前只允许 `manual`：edge 必须精确 8 个 admission；standalone 为 32–128 个。terminal window 必须与 capture window 逐值相等，scanned/matched 必须
   等于 captured，closed、evidence complete、无 remaining，terminal agreement 与 fully comparable 都必须为 1000/1000。资源报告必须同 Profile、full、
   compiled backend、qualified，并证明 Legacy continued、Shadow stopped 与 SQLite integrity `ok`。
7. Primary gate bundle schema 为 `qinglong/legacy-shadow-primary-gate@v1`。它嵌入三份 source report、各自 canonical JSON SHA-256、固定计数、window、结论与固定
   violation code；不嵌入原文件路径。CLI 用 `O_NOFOLLOW`、1 MiB 上限读取输入，并以 `0600`、no-replace 写 bundle；ineligible 时不写输出。
8. Rollout manifest 升为 schema v2。enabled manifest 必须增加 `primaryGate` reference，只允许 `manual`、同 config 目录 basename 和 64-hex bundle digest。
   loader 以 no-follow、64 KiB 上限读取 bundle，验证 manifest digest，重新计算 embedded source canonical digests，并从 source reports 重新执行完整 Primary gate；
   它不信任 CLI 写入的 `assessment`。bundle 必须 eligible、生成时间不晚于审批时间且 Profile 与实际 Local deployment 相同，之后才可惰性加载 Primary stack。
9. v1 enabled manifest 失败关闭，不自动补写或猜测 gate。disabled/missing/rejected 仍保持零 Primary stack、router、timer 和连接。`defaultMode=off`、manual-only、
   最长 30 天审批、rollback plan 和既有 durable cancellation/atomic projection gates 保留。

## 被拒绝的替代方案

### 给 RunningInstances 增加 origin 后直接当分母

拒绝。2.x 多条 Node/Shell 路径只在 spawn/callback 后写 RunningInstances，缺失行本身不可见，无法证明 admission capture；为兼容观测改成数据库
fail-closed 还会改变 Legacy 可用性。

### 每次 Legacy execution 同步写一条新 admission ledger

拒绝作为本阶段方案。它会让 Shadow 数据库写参与 Legacy spawn 前置路径，并在低配 flash 上形成第二份逐执行持久化权威。若未来需要跨 crash 的在线连续窗口，必须以
独立 migration、retention、写放大和故障语义重新评审，不能暗中加入兼容桥。

### 只在日志里输出累计 counter

拒绝。日志片段没有同 epoch 起止、pending baseline、startup report binding、no-replace 文件或 loader 重放；丢日志时也不能 fail-closed。

### Loader 只验证 `eligible` receipt 的摘要

拒绝。摘要只能证明文件没变，不能证明内容真实执行 gate。v2 bundle 必须携带低敏 source reports，loader 必须独立重算 digest 和结论。

## 资源、安全与部署影响

- 每个已启用 Legacy admission 增加一个常数 token 和四个固定 counter 更新；最多七行 origin，没有按执行身份保存集合，不增加 timer、watcher、listener、线程、连接或
  schema。未配置 Shadow origins 时仍在 fact factory、observer/Repository import 和 capture authority admission 前返回。
- 正常运行不写 capture 文件；只有显式证据 canary 的干净 shutdown 写一个有界文件。edge/standalone runtime 不需要 Prometheus、OTel、外部数据库、对象存储或
  Cluster 组件。
- bundle 是本机 config-root trust domain 内的 rollout evidence，不是签名供应链 attestation。拥有 config root 写权限的 operator 仍是本机信任根；公开分发或跨主机
  delegation 需另加签名 ceremony。
- 本 Gate 只开放 manual eligibility 的判定能力，不自动写 manifest、不启用 Primary、不接管 scheduled/system/boot/gRPC origin，也不证明物理 flash、断电或生产任务内容。

## 验证

- 纯 authority 覆盖成功、四类失败、pending、跨 epoch、非零 pending baseline、origin coverage 和脱敏守恒。
- exporter 覆盖 armed→exported、clean shutdown、`0600`、no-replace、重复 close、缺失 startup、未配置和失败开放。
- gate/CLI 覆盖 exact edge cohort、样本不足、terminal 漂移、audit-only rollback、symlink、no-replace、embedded source 篡改和 canonical digest 重算。
- rollout v2 覆盖 missing/tampered/ineligible bundle、审批时间、Profile mismatch、unknown field/path traversal 和 disabled lazy path。
- 真实 compiled backend 的 `ScheduleService.runTask` enabled child 已通过默认 observer/Repository 产生一个 `system` capture：admitted/captured 为 1/1，failed/pending 为
  0/0；它只证明 bridge 真实结算链，不冒充 manual Primary 的 8/32 条正式 canary。
- 阶段门已从 clean package artifacts 重跑：D-360 聚焦测试 `48/48`、Legacy/Shadow 串行扩展 `117/117`、资源/回滚专项 `4/4`、`build:back`、
  完整 backend `1,469 pass / 0 fail / 2 conditional skip`、18-package clean build/test、四项可执行架构审计与 `14/14` Local Profile artifact audit
  全部通过。产物字节保持 D-358 基线：base `2,589,998 / 2,590,076`、adopted `2,809,293 / 2,809,416`、application
  `3,632,877 / 3,632,997`、application-api `3,800,430 / 3,800,574`、AI `3,069,251 / 3,069,341`、application+AI
  `4,493,151 / 4,493,283`、MCP `7,315,930 / 7,316,038`。
- Linux arm64 Docker 资源门再次通过：router stress 保持 `128 MiB / 0.5 CPU / 0 swap / 64 PID`，cgroup peak `95,113,216` bytes；Edge release
  保持 `256 MiB / 1 CPU / 0 swap / 128 PID`，13 个 workload 全部通过，cgroup peak `144,740,352` bytes，`memory.events` 的
  `max/oom/oom_kill` 增量均为 0。Edge full rollback 中默认 `system` bridge 的真实 capture 为 `1/1`，terminal audit p95 `5.236 ms`、RSS delta
  `2,621,440` bytes、数据库存储前后稳定。Docker arm64 仍不是物理路由、flash wear 或断电证据。
- D-360 未修改 PostgreSQL schema、migration、依赖树或 Kubernetes 拓扑，因此不重跑 PostgreSQL HA；相邻 D-359 的 PostgreSQL HA `142/142` 与
  timeline `1→2` 只作为未被本阶段触碰的既有证据，不冒充本阶段新结果。

## 后续

ADR-0454 已把目标实例的 prepare、observe、resource、qualify、显式短期 approve、只读 audit 与 crash-replay rollback 固化为一次性状态机，并明确
`primary_selected` 不等于运行态 activated。正式启用 manual Primary 前，维护者仍必须在目标 edge/standalone 实例实际执行该仪式并保留 bootstrap activated audit；
仓库内 synthetic fixture 或 compiled resource child 不能替代真实产品入口的八/三十二条 admission。固定物理路由、flash 写放大、断电、非干净退出和 config-root
签名/备份仍是独立发布证据；其他 origin 必须分别建立自己的 admission authority、样本预算和 rollback gate，不能复用 manual receipt。
