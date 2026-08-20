# ADR-0467：通用 Worker Management 产品入口与兼容路径

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-374、D-14、D-16、D-107
- 关联 ADR：ADR-0059、ADR-0465、ADR-0466
- Amends：ADR-0466 的 Beta 前命名债务与产品入口

## 上下文

ADR-0466 已提供 `worker-session.inspect|list`，但 alpha 期间它仍挂在
`/api/v3/worker-credentials/management` 与 `ql3-worker-credential-client` 下。这个入口可以验证底层权限、配额、数据库
投影和响应边界，却不是清晰的通用 Worker 产品面：只想判断 Worker 在线、兼容性或剩余 slot 的 operator 不应接触可提交
credential mutation command file 的客户端。

直接新增服务、listener、Deployment 或 workspace package 会复制 TLS/OIDC、连接池、quota 和运维生命周期，也会让低资源
路由设备与集群控制节点承担空闲开销。直接把旧入口改名则会破坏已经部署的 credential client、Job 和配置文件。

## 决策

1. `/api/v3/workers/management` 成为通用 Worker management canonical path；历史
   `/api/v3/worker-credentials/management` 保留为精确兼容 alias。两个路径由同一个 HTTPS server、端口、transport、身份、
   rate limiter、并发计数和连接集合处理，不创建第二个 listener 或进程。
2. 共享 HTTP host 不接受任意 alias。只有 canonical Worker path 可以同时声明且只能声明一个 legacy credential path；把 Run、
   Automation、Approval、Package 或未知路径拼入 alias 列表必须在监听前失败。
3. 新增 `worker` 管理客户端策略，固定 canonical path 和 required mTLS；既有 `worker-credential` 策略继续固定 legacy path。
   旧 binary、export、Kubernetes Job 与配置保持可用，不要求原子迁移。
4. `ql3-worker-client` 与 `ql3-cluster-admin worker` 只提供：
   - `inspect --project=PROJECT --worker=WORKER`；
   - `list --project=PROJECT [--after=WORKER]`。
   客户端不接受 command file、credential operation、caller limit、filter、自动翻页、重试、轮询、cache 或后台刷新。每次调用
   只产生一个内部 inspection ID 和一次 POST。
5. 产品输出使用 `qinglong/worker-session-inspection@v1` 与 `qinglong/worker-session-list@v1` 固定 schema。它复用 ADR-0466
   的严格 transport validator，再执行独立投影；不返回 HTTP request ID、inspection ID、assertion、credential、Secret、
   raw capability 或可扩展任意字段。文本卡片与 JSON 均由同一投影生成。
6. generic client 与 credential-compatible client 位于现有 `@qinglong/cluster-admin` 内。`worker-management/` 以 client、product、
   CLI 三个职责形成内聚目录，不新增 workspace package，也不把单文件边界放进 `packages/`。
7. operator context 可以同时声明 `worker` 和 `worker-credential` 配置。前者用于只读日常观察，后者只在显式凭据管理 ceremony
   中使用；context 仍只持有 owner-private 配置路径，assertion 每次调用显式提供。
8. 该切片不修改 PostgreSQL schema、role、Session、Scheduler 或 Worker ingress。Edge/Standalone 与未启用 Cluster Worker
   manager 的部署不会加载 Cluster Admin 客户端；小设备没有新 timer、socket、数据库连接、常驻模块或磁盘写入。

## 升级与回滚

- 先发布同时接受 canonical/legacy path 的 manager，再分发 generic client 配置；旧客户端可以在整个兼容窗口继续工作。
- generic 配置必须精确指向 `/api/v3/workers/management`，legacy credential 配置不能被 generic client 接受。这样可防止一次配置
  漂移重新暴露 mutation surface。
- 回滚客户端不会影响 manager；回滚 manager 到 ADR-0466 时 generic path 暂不可用，但 legacy credential path 与数据库语义保持。
  因本切片没有 schema/ACL 变化，不需要数据库降级或 HA promotion。

## 被拒绝的替代方案

### 新建 Worker observability 服务或 package

拒绝。它会复制安全边界、增加镜像/部署/连接池和路由设备供应链成本，而底层只有两个 caller-driven read operation。

### 直接重命名旧 path 与 binary

拒绝。已部署 Job、config 和 operator automation 会被无收益破坏。canonical-first 加精确 alias 能提供可迁移产品入口，同时保持
旧 ceremony 的明确语义。

### 让新 CLI 继续接受任意 command file

拒绝。即使 TypeScript 类型写成只读，JavaScript caller 仍可构造 credential mutation；generic boundary 必须在 runtime
normalizer 和 CLI parser 两层拒绝该词汇。

### 自动轮询或自动翻完所有 Worker

拒绝。它会把一次低成本诊断变成不可预测数据库和网络负载。固定 16 项页面与显式 `--after` 让低配 manager 和 operator 都能
控制每次成本。

## 验证与证据

- 聚焦实现门 `87/87`，覆盖 canonical/legacy 同 listener、mTLS/CRL、cross-plane alias 拒绝、通用策略、只读 normalizer、严格
  产品投影、CLI 真进程单请求、mutation 词汇拒绝、产品 catalog/context、部署审计和 package 内部布局。
- `@qinglong/cluster-admin` TypeScript build/check 通过；全量为
  `427 total / 424 pass / 3 conditional skip / 0 fail`。完整 backend 为
  `1,503 total / 1,501 pass / 2 conditional skip / 0 fail`（包含一条不进入本阶段提交的既有用户测试）。
- 18-package clean build/逐包测试单次退出 0；package boundary、Cluster dependency、Edge import、Cluster deployment 与
  Worker deployment 审计全部 compatible。workspace 保持 18 packages、`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`；Cluster Admin 为 `128 source / 127 nested`，没有新增外部 dependency。
- 14 档 Local artifact audit 全部 compatible；基础 Edge/Standalone 为 `2,598,669 / 2,598,747` bytes、57 loaded modules，
  Application+AI 为 `4,501,822 / 4,501,954` bytes，MCP 为 `7,324,601 / 7,324,709` bytes、227 loaded modules，证明
  generic Worker 客户端没有进入低配设备常驻闭包。
- 本切片不触及 PostgreSQL schema、ACL、repository、role、Pool、连接或 failover 语义，因此不重跑和不重新占有物理 HA
  证明；复用 ADR-0466 的 PostgreSQL 18.6 arm64 HA `146/146`、timeline `1→2` 相邻基线。后续若改变数据库语义必须重新运行
  HA，不能沿用该豁免。

## 后续边界

- legacy credential path/binary 的移除必须另立版本化弃用 ADR、发布遥测与至少一个兼容窗口；本 ADR 不授权删除。
- Console/UI 若接入只能显式点击读取，不得静默轮询、自动翻页或把 assertion 存入浏览器持久存储。
- Worker 历史、指标、label/filter 或跨 Project inventory 仍需独立 ownership、索引、retention、隐私和资源预算决策。
