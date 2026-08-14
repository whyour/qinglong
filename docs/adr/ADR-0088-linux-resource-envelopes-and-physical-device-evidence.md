# ADR-0088：Linux 资源档位与物理设备证据边界

- 状态：Accepted（原生 x64/arm64 CI 门禁，以及物理候选、idle/故障/TaskDefinition/Compose storage/native application start 补充协议已定义；固定设备报告与集群容量证据仍待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-14、D-16、D-37、D-62、D-86、D-87、D-88
- 关联 ADR：ADR-0006、ADR-0040、ADR-0042、ADR-0062、ADR-0063、ADR-0066、ADR-0087

## 上下文

QingLong 同时部署在资源很小的路由设备、普通 NAS/单机和集群节点。单一“最低内存”数字会混合至少三种不同问题：代码在极限预算下是否出现明显回退、某类真实设备是否可被产品支持、集群控制面在给定负载下需要多少容量。

旧 CI 只在 1 CPU、256 MiB memory+swap、128 PID 的容器内运行 Edge Executor。它没有从容器内部证明 cgroup 实际值、swap、OOM、只读挂载、非 root、seccomp 或 `NoNewPrivs`，也在 Node 20/24 × x64/arm64 backend matrix 中重复运行。`os.totalmem()` 在容器内还可能返回宿主机内存而不是 cgroup 限额，因此不能作为容器资源证据。

反方向上，把路由器预算强加给 cluster-control 也不合理。Cluster 需要独立验证控制面 import/disabled activation 不会意外打开 PostgreSQL 或装配本地任务栈，但 512 MiB 的空载 CI 门禁不能回答生产副本数、连接池、claim 吞吐、故障转移或队列容量。

## 决策

### 1. 三种 CI 资源档位

Node.js 固定为 `24.18.0`，只在原生 Linux x64/arm64 runner 上运行，不用 QEMU 生成资源数字。容器使用 Debian slim 基线，并从容器内部严格验证 cgroup v2 与运行边界。

| 档位 | 容器限额 | 执行内容 | 证据语义 |
| --- | --- | --- | --- |
| `router-stress-ci` | 0.5 CPU、128 MiB、0 swap、64 PID | Edge Executor、Node SQLite 小批量、真实两步 Workflow、active Package Prompt execute/replay、16 次 Workflow admission 写锁、两组各 16 点 Workflow crash、14 点 ModelInvocation crash 与 20 点 Prompt 外层事务 crash | 仅证明极限余量，`supportedMinimum=false` |
| `edge-release-ci` | 1 CPU、256 MiB、0 swap、128 PID | Edge Executor、10000 行输出、取消、Node SQLite、真实两步 Workflow、active Package Prompt execute/replay、32 次 Workflow admission 写锁、两组各 16 点 Workflow crash、14 点 ModelInvocation crash 与 20 点 Prompt 外层事务 crash | 发布回归门禁，仍不是物理设备支持证据 |
| `cluster-control-ci` | 2 CPU、512 MiB、0 swap、256 PID | cluster-control 模块加载与 disabled activation | 控制面空载/禁用路径门禁，不是集群容量规划 |

三个档位都必须证明：

- 进程为非 root，根文件系统和 `/workspace` 只读，只有有界 `/tmp` tmpfs 可写；
- `NoNewPrivs=1`、seccomp filter 生效；
- `memory.max`、`memory.swap.max`、`cpu.max`、`pids.max` 与档位精确相等；
- 工作前后 `memory.events` 的 `max/oom/oom_kill/oom_group_kill` 增量为零；
- 架构与原生 runner matrix 声明一致。

门禁失败必须 fail closed。Docker CLI 参数、`os.totalmem()`、宿主机规格或“进程退出码为零”均不能替代上述容器内证据。

Edge 两档的 `/tmp` 使用 64 MiB bounded tmpfs，以满足正式 Edge Artifact policy
要求的 32 MiB free reserve + 4 MiB single-Attempt quota。该数字是 tmpfs 上限，
不是预留或已占用内存；实际占用仍计入同一 cgroup。资源门直接运行
`local-application` 的两步 Workflow product test，避免额外 wrapper 重复驻留模块；
product test 发布自身进程 peak RSS，顶层同时以 `memory.peak` 和
`memory.events` 约束整个进程树。SQLite 写锁门只调用正式 Workflow admission
Repository，并验证每个 Workflow 恰好一个 `BEGIN IMMEDIATE`、一个 commit、零
rollback；crash 门在 Edge `DELETE/FULL` 与 Standalone `WAL/FULL` 下分别执行
admission COMMIT 和 conclusive-stop/control-terminal 两组独立的 8 点/profile
`SIGKILL → reopen → exact replay` 矩阵，共 32 个场景。

同一 Edge 门还直接运行 Local AI production composition 的 active Package Prompt：从正式
Package install/materialized revision/automation publication 启动，创建一个 Run、一个
`StepRun.kind=model`、零 RunAttempt，经同一 SQLite ModelInvocation authority 调用一次
进程内假 provider，并证明 exact replay 返回 content-free receipt 而不再次调用 provider。
报告同时发布进程 peak RSS、数据库 logical/allocated growth、SQLite integrity 和数据库文件
私有输入/输出排除结果。ModelInvocation start/completion 的 7 点/profile、14 场景
`SIGKILL → reopen → exact replay` 也进入两档资源门。Prompt admission/finalization 又按
每 profile 各 5 点覆盖事务开始、Run/Event/Mutation/fact 写入与 COMMIT，共 20 场景；16 个
COMMIT 前 crash 必须全回滚，4 个 COMMIT 后 crash 必须 durable exact replay，并持续证明
content-free、integrity 与 foreign key。物理断电仍明确为未证明。

这组 crash evidence 只证明进程在 COMMIT 前后被内核 `SIGKILL` 后的 SQLite
原子性、完整性和重放语义，报告固定
`physicalPowerLossProven=false`。它不证明电源瞬断、存储控制器 cache、文件系统
barrier、NAND/FTL 或整机重启，不能关闭物理断电 Gate。

### 2. Profile 预算不能互相推导

- `router-stress-ci` 的 128 MiB 是 regression stress，不是 QingLong 3.0 的最低支持内存，也不能写入安装器的兼容判断。
- `edge-release-ci` 的 256 MiB 只是模拟发布门禁。当前 Edge 产品候选目标仍是 1 CPU、256 MiB RAM、1 GiB 可用持久空间，推荐 512 MiB；只有物理设备证据完成后才能接受或修改该目标。
- `cluster-control-ci` 只证明 disabled Profile 不打开数据库、不装配 runtime stack，并约束模块加载 RSS/启动时间。不得据此宣称 512 MiB 可以承载生产集群。
- standalone、worker 后续必须拥有自己的工作负载与证据，不能借用 Edge 或 Cluster 的通过结果。

### 3. 物理 Edge 发布证据

Edge 支持声明必须来自固定设备清单，至少覆盖目标 CPU/SoC、架构、RAM、存储介质、文件系统、内核、libc 与发行版。每份证据记录：

1. 冷启动、首次 ready、空闲 RSS、CPU 唤醒和后台写入；
2. migration 时间、额外磁盘峰值、100/1000/10000 TaskDefinition 开销；
3. 单任务启动、持续日志、输出截断、取消与重启恢复；
4. 低磁盘、真实 `ENOSPC`、只读文件系统、进程崩溃、断电重启和时钟跳变；
5. 原始命令、版本/commit、配置摘要、内核/cgroup/挂载事实和结果摘要。

证据必须版本化归档并能关联 release candidate。共享 CI、Docker Desktop、虚拟机或 QEMU 只能作为前置回归证据，不得标记 physical-device evidence。

### 4. Cluster 容量证据

Cluster 容量报告独立记录副本数、PostgreSQL 版本与角色、连接池、数据库延迟、候选/claim/ACK/completion 吞吐、重复率、queue depth、failover 与恢复时间。控制面空载 RSS 门禁不能替代这些负载结果，路由器物理设备结果也不能限制 Cluster 的合理资源申请。

## 被否决的替代方案

1. **把 128 MiB 作为最低支持配置**：压力测试没有证明真实闪存、内核、libc、后台服务与断电语义，拒绝。
2. **继续只执行 256 MiB Executor 容器**：没有验证实际隔离，也遗漏 SQLite 与 Cluster，拒绝。
3. **所有 Profile 使用同一资源预算**：把低资源优化与集群容量规划混为一谈，拒绝。
4. **使用 QEMU 扩大资源数字覆盖**：仿真开销和原生 I/O/调度不可比，只保留功能 smoke，不作为性能证据。
5. **以 `os.totalmem()` 判断容器内存**：它可能返回宿主机可见值，拒绝。

## 验收证据

1. `scripts/ql3-linux-resource-gate.cjs` 定义三个固定档位，并从 cgroup v2、`/proc` 与 mount table 读取实际证据；未知参数、非 Linux、非原生目标架构、root、宽松限额或安全边界缺失均拒绝。
2. `scripts/ql3-local-workflow-resource-benchmark.cjs` 使用正式 Repository 记录
   Workflow admission 写锁；product/crash tests 由顶层门直接执行，避免 128 MiB
   档重复 Node wrapper。
3. `scripts/ql3-cluster-control-benchmark.cjs` 验证 disabled activation 的数据库打开次数和 runtime assembly 次数均为零，且 stop 收敛。
4. `test/back/ql3LinuxResourceGate.test.cjs` 与 `ql3LinuxResourceWorkflow.test.cjs` 固定档位、解析、失败关闭、原生双架构矩阵和精确 Docker 限额。
5. 本地 arm64 Node 24.18.0 的最新实测中，128 MiB/0.5 CPU 档
   `memory.peak=128229376`、Workflow process peak RSS `85725184`、active Prompt
   process peak RSS `92282880`、Prompt SQLite file/allocated growth 均为 `0`，16 次
   admission 写锁 p95 `57.325 ms`；256 MiB/1 CPU 档 `memory.peak=129253376`、
   Workflow process peak RSS `85499904`、active Prompt process peak RSS `90951680`、
   Prompt SQLite file/allocated growth 均为 `0`，32 次 admission 写锁 p95
   `1.372 ms`。两档都证明 Prompt provider 恰好一次、exact replay、content-free durable
   facts、零 RunAttempt；Workflow admission 与 conclusive-stop/control-terminal 两组各
   16 点、ModelInvocation start/completion 14 点，以及 Prompt admission/finalization 外层
   20 点 crash matrix、数据库
   integrity/foreign-key 检查和所有 gate 均通过，`memory.events` 的
   `max/oom/oom_kill/oom_group_kill` 增量为零。
   这些 Docker 数字仍不是物理设备支持声明；x64 由同一 GitHub Actions matrix
   生成独立证据。

## 物理设备记录协议

物理 Edge 节点先准备一个只含设备声明的 exact-shape manifest：

```json
{
  "schemaVersion": 1,
  "evidenceClass": "physical_edge_candidate",
  "profile": "edge",
  "deviceId": "router-a1",
  "deviceModel": "Example Router A1",
  "soc": "Example SoC",
  "storageMedium": "emmc",
  "expectedArchitecture": "arm64",
  "memoryBytes": {
    "minimum": 251658240,
    "maximum": 335544320
  },
  "expectedFilesystem": "ext4"
}
```

在 Node 24 构建完成后，以真实数据盘中的专用目录运行：

```bash
pnpm build:back
pnpm run build:packages:ql3
pnpm evidence:physical-edge -- \
  --manifest=/etc/qinglong/device-evidence.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --output=/opt/qinglong/evidence/edge-rc1.json \
  --json
```

记录器拒绝 macOS、容器/VM 指示、架构/内存/文件系统漂移、symlink、根目录数据路径、已有输出和非 canonical 路径；SQLite 基准的临时库实际位于声明的数据文件系统。输出以 `0600`、no-replace、fsync 发布，并绑定 SHA-256。`storageMedium`、设备型号和 SoC 仍是 operator-declared provenance，SHA-256 也不是签名，因此报告始终为 `supported=false`。

基础记录器现在还在同一真实数据文件系统的私有 scratch 中运行
`plugin_package_failed_upgrade_edge_candidate`：在 fresh production migration SQLite
上先激活 generation 1，再持久化一个包含循环 Workflow 的 generation 2 staged
升级，并通过正式 recovery coordinator、正式候选资源物化 prerequisite 和正式 SQLite
repositories 恢复。报告只有在 generation 2 精确进入
`failed(activation_fact_conflict)`、旧 `activeLockDigest` 与
`previousActiveLockDigest` 均保留、activation publisher 零调用、候选 materialized
revision 零行、SQLite `integrity_check=ok`，且耗时、RSS delta、logical/allocated
数据库增长均处于固定上限内时才通过。相同 workload 同时进入 128 MiB router stress
与 256 MiB Edge release cgroup 门，前者仍只是 CI stress；只有由本记录器在无虚拟化
指示的固定设备和声明数据盘上生成时，才属于物理候选证据。两条路径都明确保留
`physical_power_loss_not_proven`，不能推出断电安全或正式最低配置。

### 补充 idle 证据

idle sampler 只观察一个已经启动的 QingLong Node 进程，采样窗口为 30 至 3600 秒，间隔为 1 至 60 秒且必须整除窗口。manifest 必须绑定 device、PID 与期望 executable；采样期间 PID、boot ID、进程 start ticks、UID、executable 或命令摘要任一漂移都失败关闭：

```json
{
  "schemaVersion": 1,
  "evidenceClass": "physical_edge_idle_candidate",
  "profile": "edge",
  "deviceId": "router-a1",
  "processId": 1234,
  "expectedExecutable": "/usr/local/bin/node",
  "durationSeconds": 300,
  "sampleIntervalMs": 5000
}
```

```bash
pnpm evidence:physical-edge-idle -- \
  --manifest=/etc/qinglong/idle-evidence.json \
  --output=/opt/qinglong/evidence/edge-rc1-idle.json \
  --json
```

报告只证明该进程的 RSS 分位数、CPU ticks、page faults、context switches 和 `/proc/<pid>/io` 字节/系统调用增量。它不证明整机 CPU wakeups、整机闪存写放大、冷启动或首次 ready；不得从进程计数推导这些结论。

### 专用文件系统故障证据

故障探针接受 `enospc_filesystem` 或 `read_only_filesystem`，但探针路径必须是非根、无 symlink、文件系统类型精确匹配且总容量不超过 256 MiB 的专用 mountpoint。脚本不会写满文件系统：operator 必须预先准备已满的专用挂载或只读挂载，探针只执行一次 no-replace 小文件写入并要求得到精确 `ENOSPC` 或 `EROFS`，随后验证探针项不存在。

```json
{
  "schemaVersion": 1,
  "evidenceClass": "physical_edge_fault_candidate",
  "profile": "edge",
  "deviceId": "router-a1",
  "fault": "read_only_filesystem",
  "probePath": "/mnt/ql3-fault-ro",
  "expectedFilesystem": "ext4",
  "maximumFilesystemBytes": 268435456
}
```

```bash
pnpm evidence:physical-edge-fault -- \
  --manifest=/etc/qinglong/fault-ro-evidence.json \
  --output=/opt/qinglong/evidence/edge-rc1-fault-ro.json \
  --json
```

该报告只证明独立小文件写入在专用故障挂载上返回目标 errno；它不证明主数据文件系统已经经历故障、不证明 QingLong application recovery，也不证明断电恢复。

### TaskDefinition 规模证据

规模记录器要求 TaskDefinition 正式 schema、Repository 和读取路径已构建。它在真实数据文件系统内创建私有 scratch database，运行 28 条 reviewed migration，并且只通过正式 Repository 追加 100、1000、10000 条定义；每档使用最多 40 页、每页 256 条的稳定 cursor 完整扫描，同时记录追加/扫描耗时、RSS/peak RSS 和数据库/journal/WAL/SHM 的 logical/allocated bytes。

```json
{
  "schemaVersion": 1,
  "evidenceClass": "physical_edge_task_scale_candidate",
  "profile": "edge",
  "deviceId": "router-a1",
  "expectedArchitecture": "arm64",
  "expectedFilesystem": "ext4",
  "sampleCounts": [100, 1000, 10000]
}
```

```bash
pnpm evidence:physical-edge-task-scale -- \
  --manifest=/etc/qinglong/task-scale-evidence.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --output=/opt/qinglong/evidence/edge-rc1-task-scale.json \
  --json
```

该报告只证明 fresh SQLite v14 上正式 TaskDefinition Repository、内建 `qinglong/command@v1` 写入语义门禁的三档存储/读取成本，不证明 Trigger/Run scheduler 吞吐、2.x adopted migration 峰值、整机闪存写放大、非 command spec 语义或 TaskDefinition→execution compilation。

基础记录器可导入一份 idle 报告、一份 TaskDefinition 规模报告和最多两份不同 fault 类型报告：

```bash
pnpm evidence:physical-edge -- \
  --manifest=/etc/qinglong/device-evidence.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --idle-evidence=/opt/qinglong/evidence/edge-rc1-idle.json \
  --task-scale-evidence=/opt/qinglong/evidence/edge-rc1-task-scale.json \
  --fault-evidence=/opt/qinglong/evidence/edge-rc1-fault-enospc.json \
  --fault-evidence=/opt/qinglong/evidence/edge-rc1-fault-ro.json \
  --output=/opt/qinglong/evidence/edge-rc1.json \
  --json
```

导入要求所有报告为当前用户拥有的私有 `0600` 普通文件，摘要有效，且 device、Profile、boot ID、Linux、架构和文件系统与基础记录完全一致；规模报告还必须绑定相同 data path。重复 fault 类型、缺少任一规模档位或跨启动周期拼接一律拒绝。导入后基础报告仍为 candidate；只有被导入且通过的精确条目才从 remaining evidence 中移除。

### Compose storage 跨启动候选证据

ADR-0203 增加独立的两阶段 recorder。它要求同一 data path 是专用、`0700`、真实
`/dev/*` block device 的 mountpoint；prepare 在脚本自己的可丢弃 Edge scratch
deployment 内创建 3 份真实 rollout backup，把最老候选留在 durable collection
stage，然后由 operator 在脚本外重启。resume 只接受不同 boot ID 和同一
UID/device/architecture/filesystem，使用 production collection commit 与 exact
replay 验证 tombstone、SQLite 完整性、保留底线和 allocated bytes 回收：

```bash
pnpm evidence:physical-edge-compose-storage -- prepare \
  --manifest=/mnt/ql3-evidence/manifests/compose-storage.json \
  --data-path=/mnt/ql3-evidence \
  --session=/mnt/ql3-evidence/reports/compose-storage-session.json \
  --json

# 由 operator 在工具之外执行正常设备重启；不要在同一 boot 运行 resume。

pnpm evidence:physical-edge-compose-storage -- resume \
  --manifest=/mnt/ql3-evidence/manifests/compose-storage.json \
  --session=/mnt/ql3-evidence/reports/compose-storage-session.json \
  --output=/mnt/ql3-evidence/reports/compose-storage-report.json \
  --json
```

它只报告 prepare/resume 各自 boot 内的 partition sectors-written 操作上界。计数
不得跨 boot 相减，报告不证明 reboot 本身的写入、真实突发断电、NAND/FTL 写放大
或闪存寿命，也不覆盖 MTD/UBI/UBIFS。后者必须使用独立设备计量适配器。基础
recorder 可用
`--compose-storage-evidence=/mnt/ql3-evidence/reports/compose-storage-report.json`
导入；导入后 `power_loss_restart` 和 whole-device flash evidence 仍保持未完成。

### Native application 跨启动首次 Active 候选证据

ADR-0204 针对没有 Docker 的低配 Edge 节点增加 native recorder。先对最终
AI-excluded production installation root 执行 `inspect`，用输出的 artifact
digest/files/bytes 与 Node digest 填充 manifest；prepare 使用正式 deployment API
创建 fresh OpenRC-compatible scratch deployment，随后由 operator 外部重启并在
manifest boot-age 窗口内 resume：

```bash
pnpm evidence:physical-edge-application-start -- inspect \
  --artifact-root=/opt/qinglong3-release \
  --json

pnpm evidence:physical-edge-application-start -- prepare \
  --manifest=/opt/qinglong/evidence/application-start-manifest.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --artifact-root=/opt/qinglong3-release \
  --session=/opt/qinglong/evidence-scratch/application-start-session.json \
  --json

# operator 在工具外重启，并在 manifest maximumBootAgeMs 内执行：

pnpm evidence:physical-edge-application-start -- resume \
  --manifest=/opt/qinglong/evidence/application-start-manifest.json \
  --session=/opt/qinglong/evidence-scratch/application-start-session.json \
  --output=/opt/qinglong/evidence-scratch/application-start-report.json \
  --json
```

该报告只裁决 warm Node runtime 下正式 native application closure 到唯一 active
事件的 monotonic 上界，以及 sampled RSS/`proc` I/O、SIGTERM graceful stop 和
SQLite v35。它不证明 cold Node/dynamic linker、cold artifact metadata、exclusive
page cache、firmware/service-manager latency、Compose 或 release signature。
基础 recorder 用 `--application-start-evidence=<absolute-report>` 导入后，仍保留
`power_on_cold_node_and_service_manager_start_to_first_ready`。

### Init-managed application 首次 Active 候选证据

ADR-0205 继续拆解上述 broad Gate。它使用 systemd/OpenRC 正式 deployment
renderer，但将 evidence-only POSIX wrapper 作为 service main process。wrapper
在 Node 加载前从 `/proc/uptime` 记录 kernel clock 起点，在同一进程中逐行保留
application JSON，并把 active uptime 绑定到 event ordinal。prepare 只生成 exact
descriptor/install/enable plan；operator 必须在工具外安装、enable 和正常重启：

```bash
pnpm evidence:physical-edge-service-start -- inspect \
  --artifact-root=/opt/qinglong3-release \
  --json

pnpm evidence:physical-edge-service-start -- prepare \
  --manifest=/opt/qinglong/evidence/service-start-manifest.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --artifact-root=/opt/qinglong3-release \
  --session=/opt/qinglong/evidence-scratch/service-start-session.json \
  --json

# operator 审查并安装 exact descriptor、enable 随机 service，再正常重启。

pnpm evidence:physical-edge-service-start -- resume \
  --manifest=/opt/qinglong/evidence/service-start-manifest.json \
  --session=/opt/qinglong/evidence-scratch/service-start-session.json \
  --output=/opt/qinglong/evidence-scratch/service-start-report.json \
  --json
```

resume 重新验证 installed descriptor、manager binary、systemd
loaded/active/running/enabled + MainPID/FragmentPath，或 OpenRC active + default
runlevel，并复验 wrapper→Node PPid、UID、start ticks、exact executable/cmdline、
artifact 和唯一 official active。基础 recorder 用
`--service-start-evidence=<absolute-report>` 导入。

通过只增加 `kernel_boot_to_init_managed_native_application_active`。Linux
`/proc/uptime` 不含 firmware/bootloader，因此仍保留
`firmware_and_bootloader_power_on_to_linux_kernel_clock`；证据 wrapper 也不是最终
直连 Node release unit，因此仍保留
`direct_release_unit_without_evidence_wrapper`。报告始终
`supported=false`，工具不自动安装、enable、重启、stop、disable 或清理 service。

ADR-0206 又增加直连 release unit 候选门：

```sh
pnpm evidence:physical-edge-direct-service-start -- inspect \
  --artifact-root=/opt/qinglong3-release \
  --json

pnpm evidence:physical-edge-direct-service-start -- prepare \
  --manifest=/opt/qinglong/evidence/direct-service-start-manifest.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --artifact-root=/opt/qinglong3-release \
  --session=/opt/qinglong/evidence-scratch/direct-service-start-session.json \
  --json

# operator 审查并安装 exact direct descriptor、enable 随机 service，再正常重启。

pnpm evidence:physical-edge-direct-service-start -- resume \
  --manifest=/opt/qinglong/evidence/direct-service-start-manifest.json \
  --session=/opt/qinglong/evidence-scratch/direct-service-start-session.json \
  --output=/opt/qinglong/evidence-scratch/direct-service-start-report.json \
  --json
```

production local application 在 Linux active 边界发布一个最大 4 KiB 的 current
startup receipt；它每次激活只原子替换一次，不是 append log。resume 将 receipt
boot/PID/start ticks 与实时 `/proc`、exact Node argv、systemd
MainPID/monotonic timestamp 或 OpenRC supervise-daemon parent 交叉核对。基础
recorder 以 `--direct-service-start-evidence=<absolute-report>` 导入；通过后只
移除 `direct_release_unit_without_evidence_wrapper`，firmware/bootloader、
whole-device 写放大、断电、签名和其它未采集门不变。

## 后续约束

物理设备 candidate recorder、进程 idle sampler、专用文件系统 fault probe、正式 TaskDefinition 规模记录、Compose storage、warm-Node native application start、wrapper init-managed 与 direct release init-managed 跨启动候选协议已实现；真实 Local Workflow 也已进入 128/256 MiB CI 资源门，但下一切片仍需补齐 firmware/bootloader clock、整机 wakeup/FTL 写放大、2.x adopted migration、application recovery、受控突发断电和 release archive signature，并在固定设备采集现有协议报告，而不是继续降低容器内存数字。只有固定 x64/arm64 设备矩阵完成后，才能把某一档位从 `ci_*` 提升为产品支持证据；任何阈值调整都必须说明硬件、内核、文件系统、工作负载和历史基线，Cluster 扩容结论继续走独立容量测试。

首次 active recorder 已绑定最终可发布 application artifact 与正式 readiness contract；wrapper init-managed recorder 把 Node 前 kernel uptime、systemd/OpenRC 和 live process tree 纳入同一 boot；direct recorder 再以生产 startup receipt 关闭 wrapper 与最终 release unit 的结构差异。但 Linux uptime 仍不含 firmware，当前所有开发机/Docker 结果也未替代固定物理设备报告，所以仍不能替代完整 power-on Gate。当前 Executor benchmark 或一次模块 import同样不能替代。TaskDefinition 持久化 schema、Repository 与读取路径现已由 ADR-0089 冻结，100/1000/10000 规模记录器也已接入基础报告，但尚未采集固定设备结果。其 fresh schema migration 计时不得替代 2.x adopted database migration，后者仍须记录可审计的额外磁盘峰值采样精度。未完成的边界继续保留在 remaining evidence。
