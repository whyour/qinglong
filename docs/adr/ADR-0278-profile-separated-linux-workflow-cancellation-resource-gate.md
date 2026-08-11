# ADR-0278：Profile 分层的 Linux Workflow 取消资源发布门

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-05、D-07、D-87、D-213、D-251、D-257、ADR-0088、ADR-0228、ADR-0270、ADR-0277

## 上下文

ADR-0277 已让本机用户能够通过受认证的 `workflow.cancel` 产品命令提交取消意图，既有 Local
Application Linux 条件测试也能启动真实进程并观察 `/proc/<pid>`。但是测试仍用 SQL 直接注入
`cancel_requested_at_ms`，因此没有证明产品命令、Policy、durable audit、application control、进程停止与
Workflow parent terminalization 是同一条可工作的链路。

把这条链路加入 128 MiB 路由压力门时还暴露出另一个问题：该门同时运行可选 AI Prompt、AI Model
Invocation crash matrix 与核心调度/执行 workload，虽然没有 OOM，cgroup `memory.events.max` 已出现非零
命中。把可选 AI 的瞬时峰值解释成所有路由用户的核心最低配置，或通过忽略 `max` 事件来让门变绿，都会
破坏 D-07 的 Profile 隔离。

## 决策

1. Linux Application 条件测试必须通过真实 `ql3-workflow` schema v1 `workflow.cancel` command file
   请求取消，不再用 SQL 注入 cancel intent。测试凭据、pepper、User、API credential 与 Owner
   RoleBinding 只作为私有测试 fixture 创建；生产 package closure 不增加 Owner CLI/Console。
2. Workflow、Run、StepRun、Attempt、mutation、event 与 audit fixture 使用产品可接受的 UUID v4。命令
   首次返回 `accepted`，同一命令重放返回 `existing`；持久层必须只有一个
   `run.cancel_requested` 与一个 allowed `workflow.cancel` audit。
3. 测试必须先观察 `/proc/<pid>` 存在，再验证进程退出、Attempt cancelled、两个 StepRun cancelled、
   parent Workflow cancelled。该证据只证明受控 Linux 容器里的进程停止链，不宣称固定路由器断电、闪存
   持久性或不受控 side effect 已被证明。
4. 资源发布门按产品 Profile 分层：128 MiB `router-stress-ci` 是 `supportedMinimum=false` 的核心压力档，
   只运行 Edge executor、Node SQLite、Workflow success、SQLite lock、admission crash 与 control crash；
   256 MiB `edge-release-ci` 运行完整核心链、受认证 Workflow cancel，以及可选 AI Prompt/Model
   Invocation crash matrix。
5. Workflow success 与 cancellation 在同一个 Node test process 中执行，避免重复装载完整 Application
   graph。报告解析所有 `QL3_RESOURCE_EVIDENCE`，逐条检查 RSS，并对 success/cancel 两组 durable fact
   fail closed；缺一条、计数漂移、进程未退出或超过预算都拒绝发布。
6. `@qinglong/local-owner-cli` 与 `@qinglong/local-owner-console` 只能是
   `@qinglong/local-application` 的 `devDependencies`。cluster dependency audit 同时精确约束 manifest
   `workspace:*` 与 lockfile `link:`；local image 与十档 artifact 必须继续证明二者不进入生产制品。

## 被拒绝的方案

- **继续用 SQL 触发取消**：只能证明底层 convergence，不能证明认证、Policy、命令幂等与审计产品链。
- **给 128 MiB 档加内存或忽略 `memory.events.max`**：隐藏了可选 AI 与核心路由运行时的资源边界。
- **让 128 MiB 路由档承担全部 AI crash matrix**：把 optional feature 变成基础 Profile 的隐性依赖。
- **为成功与取消各启动一个 Application test process**：重复模块装载会放大监督进程峰值，不代表真实单
  Application cadence。
- **把容器 `/proc` 证据称为物理设备发布证据**：容器不能代替固定型号路由器的断电、闪存与热环境门。
- **为测试适配再拆 workspace package**：没有独立部署或生产依赖价值，并会违反既有 package 硬上限。

## 接受证据

- Linux arm64、non-root、read-only root/workspace、`no-new-privileges` 的真实 Application cancellation
  测试返回 `accepted`/exact `existing`，观察到 PID 存在后退出；parent/Attempt 均 cancelled，两个
  StepRun cancelled，cancel event/audit 各一条，cancel workload peak RSS 94,715,904 bytes。
- 128 MiB/0.5 CPU/64 PIDs 路由核心档 6 个 workload 全通过：`memory.peak=119,615,488`，
  `memory.events max/oom/oom_kill=0/0/0`；该档明确不是受支持最低配置声明。
- 256 MiB Edge 完整档 10 个 workload 全通过：`memory.peak=137,867,264`，memory event 全零；Workflow
  success/cancel peak RSS 为 88,555,520/94,715,904，AI Prompt edge/standalone 为
  120,373,248/117,379,072 bytes。
- Local Application 39 pass/3 Linux 条件 skip；完整 19-package 门退出 0；后端 1,101 tests、1,099
  pass/2 skip/0 fail。Edge import、cluster dependency、package boundary、cluster deployment、worker
  deployment 与 local image 六项审计全部 compatible。
- 十档 artifact 全 compatible：Edge/Standalone 3,547,572/3,547,620 bytes，Adopted
  4,146,274/4,146,358，Application 4,633,747/4,633,891，AI 4,882,494/4,882,554，Application AI
  5,968,741/5,968,897；最大档距 6 MiB 仍有 322,559 bytes。Application production closure 不含
  Owner CLI/Console。
- PostgreSQL 18.4 arm64 physical-streaming HA `passed=true`：`remote_apply`、timeline 1→2、旧主
  fencing、`pg_rewind` 只读同步重入、两个 fresh control activation 与 remote Workflow cancellation
  promotion gate 全绿；`ql3-ha-*` container/network/volume 零残留。
- 刷新后 GitNexus 为 42,509 nodes/96,471 edges/1,672 clusters/261 flows；五个修改符号全部 LOW，最多
  1 direct/0 affected process。`detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与
  14/34，均 low/0 affected process。

## 剩余边界

- 仍需在明确型号、内存、存储与文件系统的物理路由设备上执行断电、闪存持久性、热重启和长时间 soak；
- 仍需 x64 CI/发布 runner 的同构资源门证据；
- Cluster Workflow-specific 产品入口、远程 Worker stop acknowledgement 与物理基础设施 fencing 继续由
  各自的独立发布门负责，不能由本 ADR 的本机 `/proc` 证据替代；
- 联网 production dependency vulnerability audit 因依赖元数据外发权限未获批准，本轮不重跑。
