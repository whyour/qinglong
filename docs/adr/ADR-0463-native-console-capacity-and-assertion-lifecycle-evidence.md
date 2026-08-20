# ADR-0463：原生双架构 Console 容量与 Assertion 生命周期证据

- 状态：Accepted（证据协议、原生采集与 CI 聚合门已实现；首份 GitHub Actions 双架构报告待实际运行产生）
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-370、PR-5、PR-7
- 关联 ADR：ADR-0088、ADR-0281、ADR-0322、ADR-0329、ADR-0462
- Amends：ADR-0462 中尚未取得的 compact Console Linux x64/arm64 实测边界

## 上下文

D-369 已把 Run cancellation status、blocked page 与 inspect 作为显式可选、用户驱动的只读纵切接入
Cluster Copilot Console，并继续声明 compact workstation 容器预算为 `192 MiB / 0.25 CPU / 32 PIDs`。
静态 limit、macOS Docker Desktop 或单架构开发机都不能证明生产镜像在原生 Linux x64 与 arm64 上确实满足该
envelope，也不能证明 Console 在不重启时会为每次点击重新读取轮换后的短期 assertion，并低敏拒绝过期凭据。

部署用户跨度很大：Edge/Standalone 可能运行在小型路由设备，而 Cluster operator workstation 与集群节点有
完全不同的资源和可用性要求。因此本门只能回答“按需启动的 Cluster Admin Console 是否在固定 CI 容器预算内
完成四次有界管理读取”，不能把结果外推为物理 Edge 最低配置、Cluster 节点吞吐或多节点容量规划。

## 决策

1. 新增单一 CI/审核脚本 `scripts/ql3-cluster-copilot-console-capacity-evidence.cjs`，提供 `capture`、`merge`、
   `audit` 三种模式。它不新增 workspace package、生产 dependency、binary、服务、数据库对象或部署 workload；
   证据职责不足以成立独立 package，避免再次制造只有一个文件的微包。
2. `capture` 只允许 Node `v24.18.0` 的原生 Linux `x64` 或 `arm64`，并要求显式
   `QL3_CLUSTER_COPILOT_CONSOLE_CAPACITY_LIVE=1`。镜像必须是当前 matrix 刚构建的独立 Admin image，
   architecture、content ID、size 和 `10001:10001` runtime user 均从 Docker inspect 取得。
3. Console 使用精确 compact envelope：`192 MiB` memory、memory-swap 与 memory 相同从而使 cgroup v2
   `memory.swap.max=0`、`0.25 CPU`、`32 PIDs`、只读 root、cap-drop ALL、no-new-privileges、默认 seccomp、
   `8 MiB` noexec/nosuid/nodev tmpfs、非 root user 和仅 `127.0.0.1` 发布端口。authority volume 只读挂载，
   management fixture 只存在于隔离 Docker network 且不发布宿主端口。
4. 在四次请求前后从 Console 自身 cgroup v2 读取 `memory.max`、`memory.peak`、`memory.swap.max`、
   `memory.events`、`cpu.max`、`pids.max/current`，并从 `/proc/self/status` 读取 NoNewPrivs/seccomp。peak 必须至少
   保留 `32 MiB` headroom；`max/oom/oom_kill/oom_group_kill` 不能增加。container start identity 前后相同，
   因而不能通过重启掩盖累积峰值或 assertion reload 缺陷。
5. synthetic management verifier 只接受 TLS 1.3 和受信 client certificate，固定 service SAN 与
   `/api/v3/runs/management`，且只记录 label、TLS、method、path、operation、mutation 等低敏事实。它不是外部
   IdP 或生产 authorization attestation。
6. 用户驱动序列固定为 `initial_accepted → rotated_accepted → expired_rejected → rotated_recovered`。Assertion
   通过同一只读 volume 内的 `write wx → chown → atomic rename` 原位轮换；Console 每次 POST 重新读取文件，
   不能重启、轮询、重试、缓存或触发 mutation。过期 assertion 必须由上游 401 被 BFF 投影为 502 和
   `assertion_expired`，响应与日志不能泄露 assertion、authority path 或 service identity。
7. 每个原生 matrix job 生成 exact-shape、source-bound 架构报告，绑定 repository、40 位 revision、workflow、
   run ID 与 run attempt。输入为有大小上限、nofollow 的普通 JSON；输出只以 `wx/0600` 新建。内容使用固定
   domain separator 的 canonical SHA-256，未知字段、非有限数字、过深或过多节点均失败关闭。
8. Artifact 名精确包含 run ID、attempt 与 architecture，upload/download action 固定到完整 commit，禁止
   overwrite。独立只读 job 必须等待完整 `cluster-image` matrix，分别下载 x64/arm64，不使用 pattern 或
   merge-multiple；merge 重验同源与不同 image ID，随后在同一 job 离线 audit 合并报告。
9. 合并报告显式保留四条 limitation：192 MiB workstation envelope 不是 Cluster 吞吐/容量规划；native CI
   不是物理 Edge 最低配置、断电、闪存、热环境或 soak 证明；synthetic mTLS verifier 不是外部 IdP 证明；
   workflow source binding 不是密码学硬件 attestation。

## 被拒绝的替代方案

### 在 macOS arm64 上用 QEMU 生成双架构结果

拒绝。标签与模拟执行不能代替两个原生 Linux runner；本地只能验证协议、负向门禁和工作流装配。

### 把容量采集拆成多个 workspace package

拒绝。capture、merge、audit 只服务一个 CI evidence contract，没有独立生产依赖、版本、入口或运行时生命周期。
拆分会扩大 package 数和维护面，并重现 `packages/*/src` 只有一个平铺文件的问题。

### 把 192 MiB 写成路由设备最低配置

拒绝。Console 是显式按需的 Cluster operator workstation 工具，Edge/Standalone artifact closure 不包含它；
固定路由器仍需明确硬件、内核、文件系统、断电、闪存、热环境和长时间 soak 证据。

### 把空载 Console 峰值写成 Cluster 容量

拒绝。该门只有四次串行读，没有副本、数据库延迟、并发 operator、Worker、queue、failover 或恢复负载。
Cluster 容量规划必须由独立多节点负载与故障恢复门完成。

### 为 assertion 轮换加入 watcher、polling 或重启

拒绝。既有 server 的每次点击读取已经提供最小、可审计的 reload 语义；watcher/timer 会增加 idle 成本，重启会
破坏 session 并掩盖实际 reload 行为。

## 验证与当前证据状态

- D-370 证据协议与 CI 发布审计聚焦门为 `108/108`；原生 `cluster-image` 聚焦集合连同 SBOM 为 `120/120`。覆盖双架构正向 merge/audit、headroom、swap、OOM、PID、
  schema widening、assertion sequence/TLS/mTLS/mutation、digest 篡改、跨 run、重复 image、symlink、overwrite、
  live opt-in，以及 capture、matrix dependency、offline audit 的负向 workflow drift。
- 本机 Docker inspect 探针确认 SecurityOpt 为 `no-new-privileges`，tmpfs 保留精确 `size=8m` 表示；探针容器已
  删除。该探针只用于修正静态 inspect 契约，不冒充 native Linux x64/arm64 容量证据。
- CI 脚本与 workflow 已实现，但当前提交尚未在 GitHub Actions 产生同一 run 的两个原生 architecture artifact。
  因此本 ADR 接受的是实现和门禁设计，不能宣称已经取得最终 memory peak、image ID、artifact digest 或 run URL。
- 该变化不改 package/dependency tree、Edge/Standalone runtime closure、PostgreSQL schema/role/Pool 或 HA 拓扑，
  不重新占有数据库 HA 证据。
- 18-package clean build 与逐包测试在允许 loopback listener 的宿主环境退出 0；Worker Runtime 独立复核为
  `133/133`。当前完整 backend 工作区门为 `1,503 total / 1,501 pass / 2 conditional skip / 0 fail`；其中包含一项
  与本切片无关、保持未跟踪且不会提交的用户测试，因此 D-370 提交范围对应 `1,502 total / 1,500 pass / 2 skip`。package boundary、dependency、Edge import、Cluster deployment、
  Console 与 Console distribution 六项审计均 compatible、零 finding，workspace 仍为 18 packages、无 single/shallow
  package，Cluster Admin 为 `125 source / 124 nested`。
- 14 档 Local artifact audit 全部 compatible；基础 Edge/Standalone 精确为 `2,589,998 / 2,590,076` bytes，
  Application+AI 为 `4,493,151 / 4,493,283` bytes，MCP 为 `7,315,930 / 7,316,038` bytes，证明 CI-only evidence
  没有进入低配部署闭包。

## 后续边界

- 推送后记录首个成功 workflow run、x64/arm64 bundle digest、cross-architecture release digest、各架构 image ID/
  size/memory peak/headroom 与 artifact retention；若任何架构超过 envelope，必须修实现或调整经过 RFC 评审的
  budget，不能放宽 validator 伪造成功。
- 物理 Edge 支持下限继续由 ADR-0088 类型的固定设备矩阵证明；Cluster 节点容量继续由多节点数据库、Worker、
  queue、failover 与恢复负载证明。
- 后续若 Console 引入新的 read operation 或生产 dependency，必须重新采集双架构报告并证明仍无 mutation、
  polling、authority leak 和 Edge closure 变化。
