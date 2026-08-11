# ADR-0204：物理 Edge Native Application 首次 Active 候选证据

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-86、D-87、D-175、D-194
- 关联 ADR：ADR-0088、ADR-0090、ADR-0178、ADR-0193、ADR-0194

## 背景

物理 Edge 基础报告仍缺少 `cold_start_and_first_ready`。现有
`ql3-local-image-live-contract` 会在 Docker 中等待 45 秒内出现 active，但它不记录
物理设备、boot、artifact closure、启动时延或进程资源；模块 import 和 Executor
benchmark 更不能证明完整 application 已开放 admission。

同时，很多低配路由器使用 OpenRC/native Node，并不安装 Docker。把 Compose 容器
作为唯一冷启动证据会排除主要 Edge 用户。另一方面，Node 编写的 recorder 自身已经
加载 Node runtime，安全的 artifact tree preflight 也会预热目录/inode metadata；
该数据不能被命名为完整 power-on cold start。

## 决策

### 1. 三阶段、无常驻资源的 native recorder

根命令 `evidence:physical-edge-application-start` 提供：

- `inspect`：建立 production release closure 与 Node binary inventory；
- `prepare`：准备 fresh native Edge deployment并发布跨 boot session；
- `resume`：在新 boot 启动正式 application CLI、计量并发布 report。

它是 repository script，不新增 workspace package、生产依赖、daemon、timer、
watcher、端口或 service installation。工具不会 reboot/poweroff，也不会指向或修改
生产 deployment。

### 2. 只接受最终 AI-excluded production closure

artifact root 必须是 canonical、无 symlink、无 hard link、只含 trusted owner
（root 或 recorder UID）且 group/other 不可写的 regular tree。上限为 768 files、
256 directories、8 MiB。顶层安装包必须精确等于：

- 10 个受审 `@qinglong/local-*`/`runtime-core` application runtime package；
- `croner`；
- `semver`。

`@qinglong/local-application` 必须是 `3.0.0-alpha.0`，Node engine 为
`>=24.18.0 <25`，bin 精确指向 `dist/cli.js`。inventory digest 覆盖每个相对
path、mode、bytes 和 file SHA-256；manifest 固定 artifact digest/files/bytes 与
Node binary SHA-256。

当前 production packlist 的真实门禁结果为 12 packages、5,045,360 bytes、627
files、90 loaded modules，仍低于既有 application artifact budget。

### 3. Prepare 使用正式 deployment API

prepare 要求 Linux、匹配 device architecture/filesystem、当前 UID 的 canonical
`0700` data path，以及位于其内的 session path。它通过正式
`prepareLocalDeployment` 创建 `.ql3-application-start-<UUID>` fresh Edge
deployment，service descriptor 使用真实 Node 和 artifact entrypoint，kind 为
OpenRC-compatible；application config、SQLite v35、Secret/keyring 和 runtime
directories 均来自产品准备路径。

session 以 `0600`、no-replace、fsync 和 SHA-256 发布，绑定 manifest、artifact、
Node、UID、prepare boot、data/deployment/config/entrypoint 的确定性路径，并绑定
每个 entry 的 device/inode/size/mode/uid/gid/link/mtime/ctime metadata digest。
随后必须由 operator 在工具外重启。

### 4. Resume 只裁决 warm-Node application closure 到 active

resume 要求：

- boot ID 与 prepare 不同；
- boot age 不超过 manifest 的 10 秒至 10 分钟显式上限；
- UID、Node path/version、architecture、filesystem 和全部路径未漂移；
- artifact metadata 在启动前仍无 symlink/不可信 mode，file count 未变化。

计时点从 recorder 调用 `spawn` 前开始，到 stdout 首次收到唯一正式事件：

```json
{
  "schemaVersion": 1,
  "component": "qinglong3-local-application",
  "level": "info",
  "event": "active",
  "profile": "edge",
  "aiStatus": "deployment_excluded"
}
```

manifest 为 first-active latency、sampled RSS 和 10–1000 ms sample interval 设置
显式预算。`/proc/<pid>` identity 必须保持同一 Node executable、UID、PID start
ticks；I/O 只计算首个成功 sample 到 active sample 的非负差值。active 后发送
SIGTERM，要求单一 shutdown/stopped 事件、exit 0、无 signal、零 stderr，再通过
production SQLite snapshot inspector 验证 contract v35。最后才读取并重算完整
artifact/Node content，以避免 application closure 在计时前被 recorder 主动读热。

### 5. 结论必须保持窄作用域

报告永久 `supported:false`，明确不证明：

- Node runtime 或 dynamic linker 的 cold cache；
- artifact directory/inode cold cache或 exclusive page-cache provenance；
- 首个 `/proc` sample 之前的 I/O、采样间 RSS peak；
- firmware power-on 到 service manager、OpenRC/systemd supervisor latency；
- Compose/container cold start、突然断电、整机 wakeup/flash 写放大；
- release archive signature/attestation、Standalone 或 Cluster。

统一 aggregator 成功导入后增加
`post_reboot_warm_node_native_application_start_to_active`，并把
`cold_start_and_first_ready` 细化为仍未完成的
`power_on_cold_node_and_service_manager_start_to_first_ready`。这不是把 broad Gate
标记为完成。

## 验收证据

- recorder manifest/phase/artifact/session/event/report 纯契约 8/8；
- aggregator 私有文件、same-device/current-boot binding 与 remaining Gate 细化；
- recorder + aggregator 专项 21/21；
- production `edge-application` packlist 门通过，精确 12 packages；
- 没有新增 package、生产依赖或常驻资源。

macOS 开发机没有物理 Linux boot/proc 语义，因此未运行真实 prepare/resume。
Accepted 表示协议、采集器和失败关闭门已实现，不表示某个路由器已有启动支持数字。

## 被拒绝的替代方案

- **只记录模块 import 时间**：没有启动 storage/recovery/scheduler/application。
- **只跑 Docker 镜像**：排除没有容器运行时的 Edge 路由器。
- **把 recorder Node 启动算进 cold Node**：recorder 已经预热同一 binary。
- **在启动前重算全部 artifact SHA**：主动读热 application closure。
- **自动 drop caches/reboot**：需要危险的整机 authority，且影响其他服务。
- **把 sampled RSS 称为绝对 peak**：采样间峰值不可见。
- **新增 benchmark package/agent**：没有独立交付边界并增加 Edge 常驻成本。
