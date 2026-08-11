# ADR-0206：直连 Init-managed Release 与有界启动凭据

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-86、D-87、D-175、D-194、D-195、D-196
- 关联 ADR：ADR-0088、ADR-0178、ADR-0194、ADR-0204、ADR-0205、ADR-0362、ADR-0363

## 背景

ADR-0205 用 Node 前 POSIX wrapper 把 Linux kernel uptime、systemd/OpenRC 和正式
application `active` 事件放进同一个新 boot。它诚实地保留了
`direct_release_unit_without_evidence_wrapper`：wrapper 改变了 production
descriptor 的主进程和进程树，不能证明最终直连 Node unit 具有等价行为。

只依赖 stdout/journal 不能同时覆盖 systemd 与 OpenRC，也会受日志持久化、轮转和
墙钟影响。给低配路由器增加日志 daemon、watcher 或 append-only readiness journal
又会增加常驻内存、唤醒和闪存写入。

## 决策

### 1. 启动凭据属于现有 Local Application 组合层

不新增 workspace package。`@qinglong/local-application` 在 Linux 返回正式
`active` 后、输出 active JSON event 前发布：

```text
<absolute-config-path>.active.json
```

该文件是 `qinglong/local-application-startup-receipt@v1`，只包含：

- instance/Profile/AI deployment status；
- 当前 boot ID 与 active 时的 `/proc/uptime` 毫秒值；
- 当前 PID、`/proc/<pid>/stat` start ticks；
- `/proc/<pid>/exe` 的 canonical Node path 与 Node version；
- domain-separated SHA-256。

它不包含配置内容、Secret、数据库路径、Project/User/Run 数据或插件材料。非 Linux
进程不发布该文件。

### 2. 状态文件有界且每次激活只替换一次

凭据最大 4 KiB、mode `0600`、single-link。publisher 要求 config parent 为当前
UID 控制且 group/other 不可写，使用同目录唯一 deterministic `.stage`：

1. stage 不存在时以 `O_EXCL|O_NOFOLLOW` 创建；
2. crash 遗留 stage 只有在 owner/mode/link/inode 精确可信时才复用；
3. 完整写入后 `fsync` stage；
4. 重新核对 parent identity；
5. 以 rename 原子替换 current receipt，并复验 final inode/mode/link/size；
6. directory fsync 在不支持的文件系统上保持 best effort。

因此每次成功激活最多产生一次小文件重写，不扫描目录、不追加历史、不启动 timer、
watcher、listener 或后台清理。它适用于 128 MiB Edge，也可被 Standalone/Cluster
节点的宿主采集；whole-device/FTL 写放大仍必须由物理门测量，不能从 4 KiB logical
上限推导。

Linux 上凭据发布失败会阻止正式 active event 并让进程失败关闭。旧凭据在新进程
启动期间可能暂时存在，所以消费者必须同时核验 boot ID、PID、start ticks 和实时
进程，不能把“文件存在”当 readiness。

### 3. D-196 使用完全直连的 production descriptor

非 package 命令 `evidence:physical-edge-direct-service-start` 提供：

- `inspect`：复用 exact 10-package AI-excluded release closure inventory；
- `prepare`：通过正式 `prepareLocalDeployment` 生成 fresh Edge
  systemd/OpenRC descriptor，`ExecStart`/`command` 直接为 exact Node binary +
  正式 local-application CLI + production config；
- `resume`：新 boot 内复验 receipt、init、实时进程、artifact 和预算。

2026-08-11 起，prepare 不再输出可绕过产品权限模型的 root install/enable plan。
它以当前 Owner UID 通过正式 `prepareLocalServiceManagerIntent` 发布
`install-enable-start + fresh` intent，并把 action ID、intent digest、Owner
intent/outcome path 与固定 root controller root 写入 session。stdout 只提供固定
shape 的 root bridge command；operator 必须把该 command 写成 root-owned `0600`
私有文件并显式运行独立 `ql3-service-bridge`，recorder 自身仍绝不取得 root、安装、
enable、start、reboot、stop、disable 或清理 authority。

service name 与产品 bridge 一致固定为 `qinglong3`，不再为证据生成另一套随机 unit。
resume 在新 boot 采集 init/receipt 前，先以原 Owner UID 调用正式
`consumeLocalServiceManagerOutcome`，重新验证 intent、outcome、descriptor/config、
UID/GID 与 manager observation，并要求 outcome 为 `active`。最终 report 同时绑定
bridge action/intent/outcome/observation digest，qualification 增加
`owner_intent_root_service_bridge_owner_outcome`；仅有 root manager exit code、已安装
unit 或当前 receipt 均不能替代该链路。

### 4. 同一 Linux 单调时钟域决定时延

resume 直接从 Linux `/proc/self/auxv` 读取 `AT_CLKTCK`，把 receipt 的 Node
start ticks 转换为 `serviceStartBootAgeMs`，并以 receipt 的 uptime 得到：

- `activeBootAgeMs` / `bootToActiveMs`；
- `serviceStartToActiveMs`。

systemd 还必须满足 loaded/active/running/enabled、exact FragmentPath/MainPID，
并让 `ExecMainStartTimestampMonotonic` 与 `/proc` start ticks 在 50 ms 内一致。
OpenRC 必须 active、属于 default runlevel，且 Node 的实时父进程 executable/hash
是 prepare 时绑定的 `supervise-daemon`。两者都必须复验 Node UID、PID/start
ticks、`/proc/exe` 和完整 argv。

receipt/report/importer 都重新计算 exact shape 与 digest。相同 UID 或 root 仍可
伪造本地事实，所以该协议还要求 root-owned exact installed descriptor、不同 boot、
零虚拟化指标和实时 init/process identity；它不是远程证明或签名 attestation。

### 5. 结论保持候选且只关闭 wrapper 等价缺口

通过的报告增加：

`kernel_boot_to_direct_init_managed_release_application_active`

统一 importer 此时移除
`direct_release_unit_without_evidence_wrapper`，但继续保留：

`firmware_and_bootloader_power_on_to_linux_kernel_clock`

报告永久 `supported:false`。它仍不证明 exclusive cold cache、active 前 RSS/I/O、
stdout active event 的后续交付、突然断电、Compose、
Standalone/Cluster 或 release archive signature。

ADR-0363 后续增加与 start report 精确配对的独立 direct service stop report：它要求
Application SIGTERM shutdown receipt、Owner stopped outcome、旧 PID/start identity
消失以及 init inactive/still-enabled。只有导入该独立报告才关闭
`init_managed_graceful_application_stop`；direct start 本身仍不能冒充 stop 证据，service
disable 也继续不在本 ADR 范围内。

## 验收证据

- startup receipt package 专项：macOS 3 pass/1 Linux 条件 skip；
- 只读、无网络、cap-drop、no-new-privileges、128 MiB/64 PID 的 Node 24.18 Linux
  容器：receipt `/proc`、真实 `AT_CLKTCK` 与 direct report 13/13；
- 同一隔离 Linux 容器中的完整 local application process：10/10，覆盖 real
  headless runtime、CLI active、receipt PID 与 SIGTERM；
- direct recorder manifest/CLI/init clock/receipt/session/report/importer：
  macOS 9 pass/1 条 Linux 条件 skip；D-195 聚合回归 3/3，合计 12 pass/1 skip；
- D-274 升级回归要求 session 固定 `qinglong3`、绑定 Owner intent/root bridge
  outcome，report/importer 对缺失或漂移的 bridge digest/active outcome 失败关闭；
- 当前 Edge application artifact 仍为 exact 10 packages，5,066,155 bytes、
  629 files、91 loaded modules，低于 8 MiB/640 files/96 modules 门；
- PostgreSQL 18.4 arm64 HA 回归的 35 个具体 gate 与总 `passed` 全为 true；
- workspace 保持 17 个 package，无新增生产依赖或常驻资源。

开发机没有真实 systemd/OpenRC PID 1，也没有执行 operator
root bridge/reboot/resume，因此尚未产生物理设备 direct report。Accepted 表示
协议与失败关闭实现完成；固定 systemd/OpenRC 路由设备采集仍是 release Gate。

## 被拒绝的替代方案

- **继续使用 wrapper 并称为等价**：主进程和进程树不同。
- **只解析 journal/syslog**：不能稳定覆盖 OpenRC、持久化策略和单调时钟。
- **append-only active log**：重启次数会变成无界闪存历史。
- **独立 readiness daemon/socket**：增加低配节点常驻内存、端口和 authority。
- **新增 startup-receipt package**：只有现有 application 一个生产者/消费者边界，
  会重新制造单文件 package。
- **自动安装、enable 或重启**：扩大宿主机破坏 authority并绕过人工审查。
- **保留旧 recorder 的直接 root install/enable plan**：会让物理发布门绕过
  D-274，得到一份启动成功但无法证明由产品 bridge 安装的报告。
