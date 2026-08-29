# ADR-0513：可选择的 Local Console Trial Kit

- 状态：Accepted
- 日期：2026-08-28
- 决策：D-418
- 关联：ADR-0503、ADR-0506、ADR-0508、ADR-0510、ADR-0511、ADR-0512

## 背景

D-416 已形成可执行的 headless Local Alpha Trial Kit，D-417 已形成有界、离线、loopback-only 的 Local Web Console，但部署用户仍不能下载一套同时包含 Console、短生命周期管理 authority 和 canonical quickstart 的闭合产物。开发约二十天后，阶段成果必须能够由 amd64/arm64 的路由器、NAS 或单节点用户下载、验真、启动和回退，而不能只停留在源码包或单元测试。

同时，Console 不应增加默认低配设备的镜像体积、listener 或稳态资源成本；也不能为了容器访问而把 Local API 从 `127.0.0.1` 放宽为 LAN/public listener。

## 决策

### 1. Local Trial Kit 提供两个互斥变体

显式 artifact run 新增 `local_alpha_variant=headless|console`，默认 `headless`。一次授权运行只生成所选变体的 amd64/arm64 Trial Kit 和对应 Local milestone，不把两套 Application 镜像塞入同一个 archive：

- `headless`：沿用最小 Local Application，稳态无 listener，适合低配路由器/NAS；
- `console`：使用独立 `runtime-console` image target，携带 `@qinglong/local-api` 与 `@qinglong/local-owner-console`，适合需要浏览器操作面的 Linux 单节点。

两者共享同一个短生命周期 Local operator。默认 Docker build 仍落在 headless runtime，Console 不进入 2.x、Cluster 或基础 Edge/Standalone 闭包。

### 2. Console 保持 loopback-only

Console quickstart 只允许 Linux Docker host，Application 使用 host network，但进程配置仍严格绑定 `127.0.0.1:5700`。这样宿主浏览器可访问 loopback，同时没有把 API 改为 `0.0.0.0`。远程设备必须由操作者建立 SSH tunnel，不得直接向 LAN 或公网暴露端口。

### 3. 产物协议显式升级并绑定变体

- Trial Kit：`qinglong/alpha-local-trial-kit@v4`，manifest schemaVersion 5；
- verification evidence：`qinglong/alpha-local-trial-kit-verification@v2`；
- Local milestone：`qinglong/alpha-local-milestone@v2`；
- Alpha stage index：`qinglong/alpha-stage-index@v2`。

manifest、verification、SBOM、archive 名、artifact 名、milestone 和 stage deployment selection 都必须记录同一个 `variant`。Headless archive 保留兼容文件名；Console 使用 `qinglong3-local-console-trial-kit-<arch>.docker.tar`。跨变体复制、混合双架构或用 headless SBOM 冒充 Console 一律失败关闭。

### 4. 阶段可用必须有真实运行证据

普通 push/PR 构建并扫描两个 image target，复核 exact package inventory/SBOM，并在原生 amd64/arm64 Linux 上执行：

- headless Edge 与 Standalone fresh setup、首 Owner、active、SIGTERM drain；
- Console Edge fresh setup、首 Owner、loopback 首页 HTTP 200、未认证 API HTTP 401、SIGTERM drain；
- 128 MiB/64 PID Edge 入口约束和 AI-excluded closure。

只有显式 `produce_alpha_artifacts=true` 的 workflow 才能生成大 archive；上传前必须从即将上传的目录运行 exact `quickstart.sh`。没有同 run/attempt 的双架构 Local milestone 时，单个 archive 仍只是中间产物。

## 被拒绝的替代方案

### 一个 archive 同时携带 headless 与 Console

拒绝。低配用户会为未选择的 UI 支付下载和存储成本，部署选择也难以从 SBOM 和 image identity 中可靠判定。

### Console 取代默认 Local Application

拒绝。它会让所有路由设备承担额外 package、静态资产和 listener，违背按能力付费与默认最小运行时原则。

### 将 Local API 改为 `0.0.0.0`

拒绝。Alpha 尚未关闭 TLS、可信代理、CSRF 和远程会话门；容器便利性不能扩大网络 authority。

### 每个变体一次生成两套 artifact

拒绝。单次显式授权只产生被维护者选择的变体，避免大 archive 存储翻倍，并保持 milestone 语义单一。

## 影响

- 低配设备默认仍下载和运行 headless Application，Console 对其为零成本；
- Console image 有独立 12-package、6 MiB/640-file 上限、SBOM、OS vulnerability policy 与双架构 live gate；
- Local milestone 和 stage index 升级 schema，旧 v1/v3 索引不会被新 auditor 静默接受；
- 该决策提供 Alpha/Linux 试运行产物，不等于 public release、生产 ingress、HA、签名或 LTS；
- 真实可下载双架构产物仍需维护者显式授权 workflow，普通 CI 成功只证明产物链可生成；当前 Console v5 run `33252179178` 与 headless v5 run `33258604609` 已分别形成独立 Local milestone，没有跨变体复用 archive。

## 验证

- Trial Kit materializer/auditor 覆盖 headless 与 Console 的 archive、SBOM、quickstart 和 mutation 拒绝；
- Local milestone 与 stage index 覆盖变体绑定、双架构隔离和 Console deployment selection；
- Dockerfile audit 固定 headless/Console 两套精确 package closure、Console asset 保留与 loopback label；
- 原生 Linux CI 对两个架构运行 Console HTTP 200/401 和生命周期门；
- 本地聚焦门为 `70/70`，完整 backend 为 `1646 total / 1644 pass / 2 conditional skip / 0 fail`，18-package clean build/test 退出 0，14 档 Local artifact audit 全部 `compatible=true`；
- 本机实际镜像库存为 headless `10 packages / 425 files / 3,638,399 bytes`、Console `12 packages / 455 files / 3,831,208 bytes`，两者均在 128 MiB/64 PID entrypoint 门内且排除 AI；
- macOS Docker Desktop 的 bind mount 不能提供与原生 Linux 等价的 POSIX Owner UID/mode 证据，Console fresh lifecycle 因此在 owner-private directory 门失败关闭；不得把该宿主限制冒充应用通过，最终双架构证据由推送后的原生 Linux CI 关闭；
- GitNexus 变更审计、镜像静态门和 Docker 实物门在提交前执行。
- 当前两个变体的下载后三件套均通过 checksum、双架构 Trial Kit auditor 与 milestone auditor；headless 明确不含 listener、Console、示例 Task 或 Console 管理 package。
