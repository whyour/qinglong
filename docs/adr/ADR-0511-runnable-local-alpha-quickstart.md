# ADR-0511：可直接试运行的 Local Alpha Quickstart

- 状态：Accepted（当前 v5 headless/Console 双变体 milestone 已交付）
- 日期：2026-08-28
- 决策：D-416
- 关联：ADR-0193、ADR-0503、ADR-0504、ADR-0506、ADR-0508、ADR-0510

## 背景

开发约二十天后，Local Alpha Trial Kit 已经能够闭合 Application/operator 镜像、SBOM、workflow evidence、manifest 和 checksum，并由双架构 milestone 与跨 Profile stage index 导航。但下载者仍需从长篇运维文档手工拼装 setup、首 Owner ceremony、Application config 和受限 `docker run`。现有 artifact 证明“镜像可验证”，还没有把已在 CI 通过的 fresh 用户旅程变成部署者拿到即可执行的阶段产物。

这对两类部署者都不合理：低配路由/NAS 不应为了试运行先安装 Node.js 24 或理解完整生产 deployment ceremony；普通单节点用户也不应复制多份含 mutation、UID/GID、resource limit 和 authority path 的 JSON。继续增加索引或证据而不关闭最后一公里，会把工程完整性误报为产品可用性。

## 决策

### 1. Local Trial Kit v3 必须携带 canonical quickstart

bundle schema 升为 `qinglong/alpha-local-trial-kit@v3`，闭合目录新增 `quickstart.sh`。materializer 从仓库内唯一模板写入当前 archive 名、Application/operator reference、exact image ID、source revision 和 architecture；manifest 增加 `quickstart` 文件记录，脚本同时进入 `SHA256SUMS`。

离线 auditor 不只检查脚本 byte/SHA-256，还根据 manifest 重新渲染 canonical journey 并逐字比较。因此本地重写脚本后即使同时重算 manifest 和 checksum，也不能通过源代码对应版本的 auditor。

### 2. 目标机只依赖 POSIX shell、sha256sum 和 Docker

quickstart 接受 `edge|standalone`、一个尚不存在的 canonical absolute data root，以及可选容器名。它按固定顺序执行：

1. 校验整个 bundle 的 `SHA256SUMS`，加载单一双镜像 archive；
2. 重新核对两个镜像的 ID、architecture、numeric user、source revision 和 operator lifecycle/network label；
3. 以当前宿主 UID:GID、无网络、只读 rootfs、drop-all capability、no-new-privileges 和 128 MiB operator 上限完成 fresh setup；
4. 通过短生命周期 operator 建立首个 Owner，敏感 delivery 只保存在新建 `0700` data root；
5. 以 Edge `128 MiB/64 PID` 或 Standalone `256 MiB/256 PID` 上限启动 Application，等待结构化 `active` 事件后才报告成功；
6. 输出 logs、graceful stop、container removal 和保留 data root 的明确命令。

脚本不需要宿主 Node.js、jq、Compose、网络访问或 root。operator 仍然每次只处理一个 command file 后退出，不成为 daemon 或 sidecar。

### 3. quickstart 本身必须经过 exact native artifact 门

显式 `workflow_dispatch + produce_alpha_artifacts=true` 的每个 Local architecture job 在 `create → audit` 后，必须从将要上传的目录执行生成出的 `quickstart.sh`，确认 SQLite、Owner delivery、Application active 与 graceful stop，再允许 upload。原有 Edge/Standalone live journey 继续保留；新增门证明的是“下载目录里的 exact 脚本可以驱动 exact 镜像”，不是另一个源码等价测试。

### 4. 阶段可用边界保持诚实

该 quickstart 只允许 fresh、隔离的新目录，不接受既有目录，不触碰 2.x 数据，不执行 migration/cutover，也不宣称生产升级、HA、公开签名或 LTS。当前 Application 是无外部 listener 的 headless runtime，能验证 3.0 SQLite、Owner authority、调度/插件运行基础和生命周期；它不是 2.x Web UI 的替代品，AI deployment 仍明确 excluded。

Cluster 节点继续使用 Cluster Integration Candidate 和 Kubernetes/CloudNativePG 路径，不能复用 Local quickstart。

## 被拒绝的替代方案

### 只在 README 增加更多手工命令

拒绝。文档无法保证 image identity、资源限制、authority path 和初始化顺序不漂移，也不能由 CI 执行下载者实际拿到的 journey。

### 只提供 Compose 文件

拒绝。Compose 可以描述常驻 Application，但不能安全替代短生命周期 setup 与首 Owner ceremony；把 operator 设为常驻 sidecar会扩大管理 authority。

### 提供 Node.js quickstart

拒绝。它会要求低配目标机额外安装与维护 Node.js，而镜像交付本来只要求容器运行时。

### 自动迁移现有 2.x 目录

拒绝。Alpha quickstart 没有 reconciliation、review、cutover 和 rollback authority，自动接管既有目录会越过已经冻结的迁移边界。

## 影响

- Local Alpha 从“可下载、可验真”前进到“可在 fresh 设备目录一条命令完成初始化并启动”；
- bundle 从七个文件增加为八个小文件，不新增镜像 layer、workspace package、runtime dependency、端口、后台 timer 或稳态 RSS；
- Edge/Standalone 继续共用同一镜像，差异只体现在 quickstart 的 memory/PID limit；
- `@v2` 仍是历史 verification-evidence 阶段格式，首份面向部署者的实际下载物必须使用 `@v3`；
- 真实 amd64/arm64 Trial Kit 仍需维护者显式授权 artifact workflow，普通 push 不生成大归档；当前严格 v5 的 Console 与 headless 已分别形成双架构 Local milestone，跨 Profile stage index 仍需独立 `all` scope run。

## 验证

- 单元测试覆盖 v3 八文件物化、POSIX shell 语法、exact image reference 注入、脚本/manifest/checksum 篡改，以及重算全部摘要后的非 canonical 脚本拒绝；
- Local milestone 与 Alpha stage index 回归证明 schema 升级没有放宽跨架构、跨 run/attempt 和跨 Profile 闭合；
- Local operator workflow 静态审计要求 `create → audit → quickstart → stop → upload` 顺序；
- 聚焦门为 `26/26`，完整 backend 为 `1636 total / 1634 pass / 2 conditional skip / 0 fail`，18-package clean build/test、package/dependency/Edge import、镜像/版本和 14 档 Local artifact audit 全部通过；
- 历史同源 arm64 Application/operator 已物化为 184,648,192-byte v3 开发 bundle并通过 checksum、canonical audit、load 与 exact identity；Docker Desktop 在 Owner POSIX directory ownership 处按已知不等价失败关闭，未被记录为 native quickstart 成功；
- 手动 artifact job 在原生 amd64/arm64 runner 上执行将要上传的 exact quickstart；Console v5 run `33252179178` 与 headless v5 run `33258604609` 均已生成双架构 milestone，下载后三件套 checksum/auditor 返回 `compatible=true`。
