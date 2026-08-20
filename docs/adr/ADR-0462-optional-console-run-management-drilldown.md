# ADR-0462：Copilot Console 显式可选 Run Management Drill-down

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-369、PR-5、PR-7
- 关联 ADR：ADR-0322、ADR-0323、ADR-0329、ADR-0330、ADR-0458、ADR-0459、ADR-0460、ADR-0461
- Amends：ADR-0461 的 Console 可选接入边界

## 上下文

QingLong 3.0 已有一次性 `ql3 run status`、固定 16 项 blocked page 和单 Run cancellation inspect，但 operator 在图形 Console 中仍要切换 CLI 才能完成 `status → blocked → inspect`。既有 Console 只持有 Project API credential；直接把 Run management mTLS/OIDC authority 设为默认，会让每次普通 Run/Task/Workflow/Copilot 观察都无条件携带更高价值的 User assertion，也会扩大 operator workstation、容器 launcher 和低资源部署的默认攻击面。

Console 仍必须是按需启动的 Cluster operator 工具，而不是 QingLong 常驻服务。Edge/Standalone 和小型路由设备不能为该能力增加 package、依赖、进程、端口、timer、连接、schema 或安装字节；Cluster 节点也不能把一次人工诊断变成轮询、自动翻页或批量 N+1。

## 决策

1. 在既有 `@qinglong/cluster-admin` Copilot Console 增加 `run_cancellation_status`、`run_cancellation_blocked_list`、`run_cancellation_inspect` 三个固定只读操作。不新增 workspace package、binary、服务、Ingress、Kubernetes workload、数据库 migration、连接池、timer、queue 或 cache。
2. Run management authority 默认 `disabled`。只有启动参数同时提供 `--run-management-config` 与 `--run-management-assertion` 时才启用；缺一项在监听或网络 I/O 前失败。配置必须是独立的 Run 专用 TLS 1.3/mTLS 文件，assertion 必须是 canonical、owner-private `0600` JWT 文件。两者不复用或替代 Project API credential 与浏览器 session key。
3. preflight 只在本机验证 Run config、client certificate/private key 和 assertion 格式，不消耗 assertion，也不冒充 authorization 或 management endpoint readiness。serve 时每次用户点击重新读取 assertion 文件，因此短期凭据可以原位轮换或删除；路径、JWT、证书和 endpoint 不进入 stdout、浏览器或失败事实。
4. 浏览器只提交精确 schema、Project、请求 ID、可选 opaque cursor 或单一 Run ID；BFF 只接受三个固定同源 POST route，并在服务端构造既有规范 Run management command。浏览器不能提交 URL、HTTP method、limit、排序、filter、audit ID、mutation ID、expected version、retry delay 或任意 management operation。
5. 导航完全由用户触发：status 返回 `attention_required/inspect` 时才显示“读取 Blocked Runs”；blocked page 中每个 Run 提供独立 inspect 点击；下一页也必须显式点击。没有启动时读取、后台轮询、自动翻页、自动逐 Run inspect、隐藏重试或浏览器缓存。
6. Console 永远不路由 `run.cancellation.rearm`、`run.stop`、`run.retry` 或其他 mutation。即使 operator 给了更宽的 User assertion，浏览器 vocabulary、request normalizer、route table 与 executor 分支仍无法表达 mutation；处置继续使用独立 CLI 的 exact-CAS rearm。
7. status、blocked 和 inspect 复用既有 Run management result validator，再投影为固定产品事实。blocked cursor 在网络请求中保持版本化 canonical token；写入浏览器脱敏 evidence bundle 时只变成 per-bundle `cursor-NNN` alias，不泄露原 continuation。离线 verifier 同步验证 16 种固定 read operation 和相同 alias/allowlist。
8. native 模式继续只监听 ephemeral `127.0.0.1`。镜像 launcher 继续以 host-loopback publication、只读 root、非 root UID、无 capability、no-new-privileges、固定 memory/CPU/PID 和两并发/无队列运行；只有显式 `QL3_COPILOT_CONSOLE_RUN_MANAGEMENT=enabled` 才把容器私有只读 mount 中的 Run config/assertion 路径传给进程，未知值失败关闭。
9. Console 资产仍由包内 SHA-256 精确绑定，CSP、Host/Origin/session、4 KiB request、约 2 MiB response、2 in-flight、16 connection 与 no-store 边界不变。新增 UI 不引入 framework、第三方依赖、browser storage、worker、WebSocket、EventSource、clipboard/share API 或 timer。
10. 实现保留在已有 `cluster-admin/copilot-console` 与 `cluster-admin/run-management` 子域。新增 inspection projection 是现有 package 内的实质职责文件，不是新 package 或根目录平铺；workspace 仍维持 18 个职责包，Edge/Standalone artifact closure 不得导入 `cluster-admin`。

## 被拒绝的替代方案

### 默认把 Run management assertion 塞进 Console

拒绝。普通观察不需要 strong User authority；默认持有会扩大凭据暴露时长和部署准备成本，也让“只读 Project Console”与“高价值管理身份”无法独立撤销。

### 让浏览器直接访问 management endpoint

拒绝。浏览器将获得 assertion、mTLS capability 或可变 endpoint，并需要扩大 CSP/CORS；这破坏 server-only credential、固定 route 和同源 session fence。

### status 后自动获取 blocked page 并逐项 inspect

拒绝。一次点击会变成隐藏的多请求 fan-out，成本随 blocked 数增长；并发状态变化也会让自动链难以审计。每一步显式点击让请求次数、快照 cursor 和 operator 意图可见。

### 在只读 Console 中增加 rearm 按钮

拒绝。rearm 需要 `run.stop`、expected dispatch version/result 和明确 mutation ceremony。把它放进当前 evidence ledger 会混淆观察与处置，并让浏览器页面获得 mutation authority。

### 新建 Console Run-management package 或常驻 sidecar

拒绝。能力只组合现有 client、command codec 和 projection，不存在独立依赖、发布责任或生命周期；拆包会重新制造单职责过细的 workspace。常驻 sidecar则会增加 Cluster 资源和凭据驻留时间。

## 资源、安全与部署影响

- 默认关闭与 Edge/Standalone 路径均为零新增运行时 I/O、连接、timer、listener、内存状态、安装依赖和数据库成本。
- 显式启用只增加本机已存在 Console 进程中的常数级配置状态；每次点击仍是一条短 TLS 请求，最多两个并发且不排队。blocked page 固定 16 项，不自动读取下一页或详情。
- compact/standard 容器预算保持 `192 MiB / 0.25 CPU / 32 PIDs` 与 `512 MiB / 1 CPU / 64 PIDs`；本切片不据此宣称生产容量，Linux x64/arm64 实测仍是独立发布证据。
- assertion 是短期强 User 凭据，只在 BFF 进程按调用读取并由通用 management client 清零 buffer；浏览器 session 不能直接认证 Cluster，Project credential 也不能替代 Run authority。
- 本切片不改 PostgreSQL schema、repository、Run service、management server 或 HA 拓扑，因此不重新占有 PostgreSQL HA 证明；D-368 的 v67 `146/146` 只作为相邻既有证据，不冒充 D-369 新执行结果。

## 验证

- 包级类型构建和聚焦门 `46/46`，覆盖默认关闭、参数成对约束、私有配置预检、三条固定 route、非法 cursor、无任意 path、浏览器 session/Host/Origin、并发上限、脱敏 cursor alias、16-operation 离线复核、launcher opt-in 和 mutation vocabulary 拒绝。
- 真实 loopback/TLS 纵切从浏览器风格 status POST 经 Console BFF、独立 Run mTLS client 到 management endpoint，验证只发送一条 `run.cancellation.summary`、请求 ID 绑定、Bearer assertion、低敏 status projection 和无 mutation。
- Cluster Admin 全量为 `420 total / 417 pass / 3 conditional skip / 0 fail`；backend 宿主门为 `1,491 total / 1,489 pass / 2 conditional skip / 0 fail`；18-package clean build/顺序测试退出 0。
- package/dependency/Edge import/Cluster deployment/Console/Console distribution 六项审计全部 compatible、零 finding；workspace 保持 18 package，Cluster Admin 为 `125 source / 124 nested` 且只有一个受审根入口。
- 14 档 Local artifact audit 全部 compatible；Edge/Standalone 为 `2,589,998 / 2,590,076` bytes，Application+AI 为 `4,493,151 / 4,493,283` bytes，MCP 为 `7,315,930 / 7,316,038` bytes。
- 本切片未改数据库或 HA ownership，未重跑 PostgreSQL HA；D-368 的 `146/146` 仅作为相邻基线。

## 后续

D-370 应优先取得固定 Linux x64/arm64 Cluster Admin Console 容量与 assertion rotation/expiry 现场证据，或继续推进 CloudNativePG live failover 发布门；不得把 workstation compact/standard limit 冒充生产容量，也不得为了监控便利引入 Console polling、常驻 authority 或 Edge 依赖。
