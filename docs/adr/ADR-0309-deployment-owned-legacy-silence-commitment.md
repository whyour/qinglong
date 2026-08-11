# ADR-0309：部署侧 Legacy Silence Commitment 与 adopted v3 启动门

- 状态：Accepted（Docker legacy-stop slice）
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-63、D-64、D-65、D-85、D-87、D-259
- 关联 ADR：ADR-0064、ADR-0065、ADR-0066、ADR-0178、ADR-0194、ADR-0243、ADR-0308

> ADR-0310 已在同一 deployment product 中补齐 Docker target start/restart barrier、
> barrier 后 inspect-only 和 terminal `manual_required`。本 ADR 的 legacy-stop commitment
> 仍是每一代 target controller 的前驱事实。

## 背景

QingLong 3.0 已有旁路 SQLite adoption/activation、独立 Local Application、fresh deployment
与 systemd/OpenRC/Compose 描述符，但 adopted v1 仍可直接启动。source SQLite write fence 只能
证明一个数据库 writer 被阻塞，不能证明 2.x Scheduler、子进程、网络和其他外部副作用已经
静默。因此旧操作手册中的“先自行停止 2.x”不是可执行安全边界，D-64 也一直保持 Proposed。

ADR-0243 删除孤立的 `local-cutover` workspace package 是正确的：它没有 binary、部署消费者或
controller。现在 `@qinglong/local-owner-cli` 已经拥有真实 `ql3-local-deploy` 短生命周期产品、
私有 command-file 协议、Docker socket controller 和 durable file publication primitive，切换
能力应成为其 `src/deployment/cutover/` 内部 domain，而不是恢复第 20 个 package。

## 决策

### 1. 先关闭可证明的 Docker legacy-stop slice

新增 `local.deployment.cutover.legacy-stop` 与
`ql3-local-deploy cutover-legacy-stop`。命令精确绑定：

- deployment root、Docker executable 与 Unix socket；
- cutover ID、Profile、target instance ID；
- 私有 SQLite activation 文件及 reviewed activation digest；
- activation 对应的 canonical legacy source path 与预期容器内 database path；
- 完整 64-hex legacy container ID 和请求时间。

controller 不接受裸 PID、容器名、tag、调用方布尔值或自报“已停止”。它先验证 activation exact
shape/digest/Profile，再对精确 container ID 执行 `update --restart=no`、`stop --time 30` 和
`inspect`。只有 `Running=false`、`Restarting=false`、`Paused=false`、`Pid=0`、状态为
`exited|dead` 且 restart policy 为 `no`，并且唯一 bind mount 把 activation 的 source path
精确映射到预期容器内 database path 时，才承认 database writer 与该容器拥有的外部副作用
已静默。source path 必须先与 activation 的 `sourcePathDigest` 相等；container ID、
created/name/image、mount source/destination/RW 的低敏 identity digest 与 Docker endpoint digest
一并进入 commitment。

当前不接受 systemd/OpenRC legacy 或 Kubernetes/remote cluster evidence。无法证明的 controller
必须失败关闭，不能用人工 assertion 降级。

### 2. journal 有界、不可覆盖且可精确重放

每个 cutover 使用当前 UID 私有 `0700` 目录，最多保留 64 个 cutover：

```text
service/cutovers/<cutoverId>/
├── 0001-legacy-stop-requested.json
└── 0002-legacy-stopped.json
```

记录为 `0600`、最大 64 KiB，由现有 stage→fsync→hard-link no-replace→directory fsync primitive
发布。第一条记录在任何 Docker mutation 前完成；第二条绑定第一条 digest。崩溃发生在 stop 前或
期间时，原命令可幂等重做 legacy 收敛；第二条已存在时只验证 exact identity/digest 并返回
`existing`，不重新打开 socket，也不重复 stop。目录漂移、跨 cutover 重放、activation/endpoint/
container 漂移或 retention 超限全部失败关闭。

### 3. adopted application v3 强制消费 commitment

新增 `qinglong/local-application-process@v3`，只允许 `storage.mode=adopted`，并要求：

```text
cutover.cutoverId
cutover.commitmentPath
cutover.expectedCommitmentDigest
```

Application 自己只读取并验证 commitment，不导入 Owner CLI、Docker 或 cutover controller，也不
停止 2.x。commitment 必须精确绑定 config 的 cutover ID、Profile、instance ID 与 activation
digest，并通过 payload digest、私有文件身份和 authority-path 去重。验证发生在 AI 选择、Plugin
Package source、signal subscription、SQLite/Secret/Recovery 和 lifecycle 之前。

fresh v2 不需要 commitment，行为不变。adopted v1 保留离线解析兼容，但生产进程会在取得任何
runtime authority 前返回稳定的 `QL3_LOCAL_APPLICATION_CUTOVER_COMMITMENT_INVALID`，因此不能
成为绕过门。

### 4. 资源与 Profile 边界

本能力不新增 workspace package、依赖、daemon、timer、watcher、listener、数据库连接或历史扫描。
Edge 与 Standalone 只在一次人工 cutover 命令中支付三个 Docker 调用和两个小文件；常驻 Application
只增加一次 16 KiB 上限私有 JSON 读取和 SHA-256。它适用于低配 Docker 路由器/NAS，也不会让本机
文件/Docker authority 进入 Cluster、Worker 或 PostgreSQL 产物。

### 5. D-64 仍未全部关闭

本 ADR 关闭的是“没有 legacy silence evidence 仍可启动 adopted target”的产品旁路，以及
`legacy_stop_requested -> legacy_stopped` 的可恢复前半段。以下仍是独立 Gate：

- `manual_required` 的只读诊断、人工 resolution 与新 cutover ceremony；
- systemd/OpenRC legacy controller；
- systemd/OpenRC target controller 与 target 显式 stop；
- adopted Compose target 的受审 create/config 与真实 Docker live/crash Gate；
- target 产生新 3.0 事实后的数据对账式回退；
- cluster/Kubernetes 独立 cutover authority。

因此 Application active 仍不等于完整 deployment cutover completed，任何路径仍不得自动重启 2.x。

## 否决方案

1. **恢复 `@qinglong/local-cutover` package**：没有新增独立 artifact/dependency/权限或版本责任，只会
   重新制造已删除 importer；拒绝。
2. **只依赖 SQLite `BEGIN IMMEDIATE`**：不能证明 Scheduler、spawn、网络或外部系统静默；拒绝。
3. **接受 operator boolean/PID/container name**：不可稳定绑定 owner，也无法阻止重放和 PID/name
   复用；拒绝。
4. **由 Application 调 Docker 或停止 legacy**：形成稳态 runtime 与部署 authority 循环，并让低配
   设备常驻 socket 权限；拒绝。
5. **一次 shell 串联 stop 后直接 start**：崩溃后无法判断副作用是否发生；拒绝。
6. **把本机 marker 用于 cluster**：本机文件和 Docker endpoint 不是 Kubernetes/PostgreSQL 的租约、
   fencing 或 quorum evidence；拒绝。

## 验收

1. 精确 Docker stopped evidence 发布 commitment，完全相同命令返回 `existing` 且不再调用 Docker。
2. running/restarting/PID/restart-policy/container identity 任一不满足时只保留 intent，不发布
   commitment。
3. v3 commitment 的 shape、digest、cutover/Profile/instance/activation 任一漂移，Application 在
   signal/storage 前失败。
4. adopted v1 不能启动，fresh v2 行为不变。
5. package/dependency/boundary/artifact 审计证明 package 数仍为 19，Owner cutover 不进入 Application
   或 Cluster production closure。
6. Edge/Standalone 常驻路径没有新增 timer、watcher、socket、数据库连接或历史扫描。
