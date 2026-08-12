# ADR-0387：Local API Cancellation Linux 组合实证门

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-299
- 前置决策：ADR-0364、ADR-0366、ADR-0367、ADR-0372、ADR-0373、ADR-0376、ADR-0380

## 上下文

ADR-0372 已分别证明认证 HTTP 写入 SQLite durable cancellation intent、execution-control 收敛和 Linux `/proc` 子进程退出，但不同测试之间仍存在组合缝隙：HTTP 使用的 Run 可能不是 runtime 实际拉起的 Run，进程 stop 也可能来自命令文件或测试内直接调用，而非同一个 API mutation。

部署用户同时包含 128 MiB 路由设备和 Standalone 主机。默认 Local image 刻意排除 API，不能为了取证把 HTTP listener、认证依赖与 Owner Pepper provider 强塞进所有低配部署；但可选 `edge-application-api | standalone-application-api` 制品已经定义了单进程产品闭包。因此组合门应验证可选 API 制品，同时保持默认 Edge/Standalone 零增量。

## 决策

1. 新增 opt-in `ql3-local-api-cancellation-live-contract`。它只接受 fresh absolute `0600` report path，并要求显式 `QL3_LOCAL_API_CANCELLATION_LIVE=1` 后才允许调用 Docker。
2. live gate 复用 `ql3-local-profile-artifact-audit` 的离线 pack、精确 import closure 与 runtime JavaScript pruning；auditor 新增 `--output-directory`，只允许复制一个此前不存在的 absolute 目录，不改变默认 stdout schema、预算或已有 14 个 profile 行为。
3. 每个 profile 在 `node:24.18.0-bookworm-slim` 锁定镜像内以当前非 root UID、read-only root、network none、capabilities none、no-new-privileges、0.5 CPU、16 MiB noexec tmpfs 运行；Edge 固定 128 MiB/64 PIDs，Standalone 固定 256 MiB/256 PIDs。
4. 同一 Local API 进程经真实 loopback HTTP `task.start` 创建并调度一个长期 command Run。gate 从 SQLite 读取 runtime 持久化的 PID，并从 `/proc/<pid>/stat` 绑定 start ticks；随后真实 HTTP `run.cancel` 必须得到 `accepted → already_requested`。
5. gate 必须观察唯一 `run.cancel_requested`、唯一 `run.cancelled`、两条 allowed audit、Run/Attempt 均 cancelled、精确 PID/start identity 消失、SQLite integrity `ok`；Local API 有序停止并重启后，同一 Run 仍必须通过 HTTP 观察为 cancelled。
6. 私有 report 只保存 profile、平台、resource envelope、artifact size/files/modules 和低敏布尔/计数事实；不保存 token、Pepper、路径、命令、Run ID、PID 或业务内容。独立 audit 对缺失 replay、PID exit、durability、资源预算或 qualification 的报告失败关闭。
7. report 的资格固定为 `linux_virtualized_live_contract`、`physicalDevice:false`。它关闭自动化组合缝隙，但不伪装成固定型号路由器证据，不能单独把 ADR-0372 转为 Accepted。
8. 不新增 workspace package、生产依赖、migration、表、索引、listener、timer、watcher、连接、cache、sidecar 或默认产品能力。代码放在现有 `scripts/` live/audit 分层中，不制造只有一个文件的微包。

## Package 与低配影响

workspace 仍为 18 个领域 package。新增文件都是发布/证据脚本，不进入任何 runtime artifact；默认 Edge/Standalone image 仍不包含 API。可选 API 制品的 Edge/Standalone 实测为 3,668,052/3,668,196 bytes、429 files、85 loaded modules，分别距 6 MiB 上限保留 2,623,404/2,623,260 bytes。真实运行 API RSS 为 80,736,256/78,868,480 bytes，均低于对应 128/256 MiB envelope。

## 验收状态

- report validator 与 opt-in/no-overwrite 失败关闭测试 3/3 通过；脚本均通过 Node syntax check。
- 完整 backend 回归 1,180 tests、1,178 pass/2 conditional skip/0 fail；完整 18-package clean build/test 退出 0。
- package boundary 保持 18 个 workspace package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；dependency 与 Local image static audit 均为 `compatible:true/findings:[]`。
- 14 个 Edge/Standalone Profile artifact 全部 compatible。最小 Edge 为 2,467,343 bytes/295 files/53 loaded modules，RSS delta 11,157,504 bytes；最重 Standalone MCP 为 7,168,978 bytes/778 files/213 loaded modules，RSS delta 38,158,336 bytes，均低于各自预算。
- arm64 Linux Edge 组合门通过：task start/cancellation/exact replay、durable intent/cancelled Event、两条 allowed audit、PID/start identity exit、重启观察、SQLite integrity 全绿；私有报告权限 `0600`，SHA-256 `056f8f1c07f0c5dfe4552fcb605d6b55b194cd826dbf1c720b21fdba4bd55e53`，离线审计零 finding。
- arm64 Linux Standalone 组合门同样通过；私有报告权限 `0600`，SHA-256 `223b7241ec3af8edea824dd802f24d573d0987c2ec55fd82b380c95acdf46ba7`，离线审计零 finding。
- PostgreSQL 18.4 arm64 HA 干净重跑通过 123 gates、timeline `1→2`；报告 SHA-256 `4bf01be43b6eaa0bb6b2d5a2510e6a701c7d02a0fe4a0f246e207cc2c63dc003`。
- CI 在 local image 的 amd64/arm64 matrix 中分别执行 Edge 与 Standalone gate；live 资源为短生命周期，完成后 artifact/evidence 临时目录和容器被清理。
- 固定型号物理 Edge 设备尚未产生 `physicalDevice:true` 的独立资格报告；ADR-0372 因此继续保持 Proposed。

## 后果

Local cancellation 的自动化证据不再依赖“两个相邻测试看起来可以拼接”的推断，路由器与 Standalone profile 都有同构、可复现的真实 Linux 子进程门。代价是 local-image CI 每个架构额外组装两次可选 API 制品；这是 release evidence 成本，不进入产品常驻面。后续物理 recorder 应复用相同低敏事实和 PID/start identity 语义，但必须增加设备 manifest、反虚拟化检查与签名/导入流程，不能修改本报告的 `physicalDevice:false`。
