# ADR-0205：物理 Edge Init-managed Service 首次 Active 候选证据

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-86、D-87、D-175、D-194、D-195
- 关联 ADR：ADR-0088、ADR-0193、ADR-0194、ADR-0204

## 背景

ADR-0204 已证明不同 Linux boot 中，最终 AI-excluded native application closure
可以从 recorder `spawn()` 到唯一正式 `active`，但 recorder 本身已经加载 Node，
也没有经过 systemd/OpenRC。它因此仍把
`power_on_cold_node_and_service_manager_start_to_first_ready` 保留为 broad Gate。

完整 firmware 上电时间不能从 Linux 用户态可靠取得。`/proc/uptime` 从 Linux
内核时钟开始，不包含 bootloader/firmware；安全实现必须拆开这一边界，而不是把
kernel uptime 改名为 power-on latency。

## 决策

### 1. 新增非 package、无自动整机 authority 的三阶段记录器

根命令 `evidence:physical-edge-service-start` 提供：

- `inspect`：复用 ADR-0204 的 exact 12-package artifact 与 Node inventory；
- `prepare`：创建 fresh Edge deployment、证据 wrapper、FIFO 和 digest-bound
  session；
- `resume`：只读核验新 boot、init 状态、进程身份和正式 active 后发布 report。

记录器不新增 workspace package、生产依赖、daemon、timer、watcher、端口或
Cluster import。它绝不执行 `install`、`systemctl enable/start`、`rc-update`、
`rc-service start`、reboot、poweroff、stop、disable 或文件清理。

### 2. Operator 必须显式安装并启用 exact descriptor

prepare 使用正式 `prepareLocalDeployment`：

- Profile 固定为 Edge；
- service kind 由 manifest 固定为 `systemd|openrc`；
- 仍使用 production renderer 的 User/Group、WorkingDirectory、resource limit、
  SIGTERM、restart 和 hardening contract；
- systemd 的 probe 目录位于 deployment root 内，满足
  `ProtectSystem=strict + ReadWritePaths=<deploymentRoot>`。

prepare 输出而不执行：

- descriptor source/destination 与 SHA-256；
- `/usr/bin/install` 的逐参数 invocation；
- `systemctl enable <unit>` 或 `rc-update add <service> default` 的逐参数
  invocation。

session 精确绑定这些参数、目标 mode、service name、status manager 与 enable
executable/hash、wrapper hash、artifact/Node、UID、prepare boot 和所有 scratch
path。systemd 两者都是 `systemctl`；OpenRC 分别是 `rc-service` 与 `rc-update`。
operator 审查后以 root 安装/enable，再在工具外正常重启。resume 要求目标
descriptor 为 root-owned、single-link、exact mode/content。

### 3. POSIX wrapper 在 Node 之前建立时间锚点

证据 wrapper 是私有 `0700` POSIX shell 文件。它在执行 Node 之前：

1. 复验 exact `node --config <path>` 参数和已准备 FIFO；
2. 从 `/proc/sys/kernel/random/boot_id` 与 `/proc/uptime` 读取 boot/start；
3. 以 noclobber 创建 `0600` start/event/stderr 文件；
4. 才启动 exact Node binary、正式 `@qinglong/local-application/dist/cli.js` 和
   production config。

wrapper 逐行复制 application stdout。遇到同时包含正式 component/event/Profile/
AI status 的候选行时，立即读取同一 `/proc/uptime`，以 event ordinal 发布一次性
active record。resume 使用 Node exact JSON parser 重新验证整个 event log、唯一
active 和 ordinal；shell substring 不能自行形成通过结论。第二个 active、已有
record、partial JSON、非零 stderr 或 boot/monotonic 逆序均失败关闭。

wrapper 不是旁路 daemon：它就是 evidence service 的 main process，转发终止信号，
并等待唯一 Node child。systemd 必须把 wrapper PID 报为 `MainPID`；OpenRC 必须由
`rc-service status` 和 default runlevel 同时证明 active/enabled。

### 4. Resume 必须复验实时 service 与进程树

resume 在读取报告文件前要求：

- 与 prepare 不同且与 wrapper record 相同的 boot ID；
- 当前 boot age、架构、文件系统、UID、Node 和 manifest 一致；
- `virtualizationIndicators` 为空，容器/VM 直接拒绝；
- artifact metadata、wrapper、manager 和 installed descriptor 未漂移；
- systemd `loaded/active/running/enabled`、exact FragmentPath/MainPID，或 OpenRC
  active + default runlevel；
- wrapper/node PID 仍存活，Node PPid 为 wrapper，UID、`/proc/exe` 与完整 cmdline
  精确匹配。

最后重算完整 artifact content。报告记录：

- `serviceStartBootAgeMs`；
- `activeBootAgeMs` / `bootToActiveMs`；
- `serviceStartToActiveMs`；
- active event ordinal 和 live process start ticks。

所有三项时延都必须落在 manifest 的显式预算内。report 与统一 importer 都重新
计算 qualification，不能信任报告自带 `passed:true`。

### 5. 结论继续保持候选与窄作用域

通过的报告增加：

`kernel_boot_to_init_managed_native_application_active`

并把 broad Gate 细化为仍未完成的：

- `firmware_and_bootloader_power_on_to_linux_kernel_clock`；
- `direct_release_unit_without_evidence_wrapper`。

报告永久 `supported:false`，并明确不证明 exclusive cold page cache/dynamic
linker provenance、active 前 RSS/I/O、service stop/disable、突然断电、Compose、
Standalone/Cluster 或 release attestation。证据 wrapper 将测得时延作为安全上界，
但它不是最终直连 Node 的 release unit；必须保留 equivalence Gate。

## 验收证据

- Linux recorder manifest/CLI/wrapper/session/record/init/report/POSIX
  syntax/OpenRC executable split/virtualization/FIFO-child 契约 13/13；
- importer same-device/current-boot/qualification 再裁决与 remaining Gate 细化
  3/3；
- importer 3/3，Linux 专项合计 16/16；macOS 为 12 pass/1 条件 skip；
- exact Node 24.18.0 bookworm-slim digest 在只读 rootfs、无网络、cap-drop、
  no-new-privileges、128 MiB/64 PID 下完成真实 FIFO、active ordinal 和 SIGTERM
  wrapper smoke；该容器只证明脚本兼容，不是物理/init 报告；
- wrapper 静态门不含 reboot/poweroff/systemctl/rc-service/rc-update/sudo；
- 实现不新增 workspace package、生产依赖或常驻采集资源。

macOS 开发机不能运行 Linux PID 1、`/proc` 和真实 enable/reboot，所以没有产生
物理报告。Accepted 只表示协议、采集器和失败关闭门已实现；固定 systemd/OpenRC
设备的 operator install/reboot/resume 仍是发布候选 Gate。

## 被拒绝的替代方案

- **使用 `Date.now()` 作为 power-on 时间**：墙钟可跳变，也没有 firmware 起点。
- **由 Node recorder 在 reboot 后启动 Node**：Node 已被 recorder 自己预热。
- **自动安装/enable/reboot**：扩大整机破坏 authority，且不能保留人工审查边界。
- **只读取 journal 文本时间**：日志持久化、clock domain 和旧 boot 过滤不稳定。
- **把 wrapper descriptor 称为最终 release unit**：证据 shim 改变了进程树。
- **新增 boot-agent package/daemon**：增加低配 Edge 的交付和常驻成本。
