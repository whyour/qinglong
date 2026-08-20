# ADR-0468：Copilot Console 显式可选 Worker 只读观察

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-375、D-14、D-16、D-107
- 关联 ADR：ADR-0462、ADR-0463、ADR-0466、ADR-0467

## 上下文

ADR-0466/0467 已在现有 Worker management authority 上提供通用 `worker-session.inspect|list` 产品入口。集群运维仍需要在
Copilot Console 中把 Run 异常与 Worker 在线状态、兼容性和剩余 slot 放在同一个只读工作台观察，但这不能让浏览器持有 mTLS
key/OIDC assertion，也不能把 Cluster 诊断能力带入低配 Edge/Standalone 常驻闭包。

新建 Worker UI 服务或 workspace package 会复制 Console session、TLS、分发、端口和生命周期边界。把 Worker authority 默认并入
Console 又会让普通 Project API 观察面静默获得更强的管理身份，并可能诱发自动轮询和不可控分页负载。

## 决策

1. 在既有 `@qinglong/cluster-admin/copilot-console` 增加 `worker_list` 与 `worker_inspect`，分别只接受固定 BFF route
   `/api/v1/worker-management/workers` 与 `/api/v1/worker-management/worker`。浏览器不能提供上游 path、method 或任意 command。
2. Worker authority 使用独立的 `--worker-management-config` 与 `--worker-management-assertion`，两者必须成对存在且 config 必须指向
   canonical `/api/v3/workers/management`。它不复用普通 Cluster credential，也不接受 legacy credential mutation path。
3. 未提供 Worker authority 时，Console 正常提供原有操作并报告 `workerManagementAuthority=disabled`。宿主容器启动器仅在
   `QL3_COPILOT_CONSOLE_WORKER_MANAGEMENT=enabled` 时挂载两份 owner-private 文件并添加参数；Run 与 Worker 两个可选 authority
   独立开关，不能互相隐式启用。
4. `worker_list` 每次固定最多 16 项，只接受 nullable `afterWorkerId`；下一页必须由用户点击。`worker_inspect` 只观察用户明确选中的
   canonical Worker ID。禁止 caller limit/filter、自动翻页、poller、retry、queue、cache、watcher、WebSocket/SSE 和后台 timer。
5. BFF 复用 ADR-0467 的 generic Worker client、严格 transport validator 与产品投影。一次浏览器请求只产生一次上游 POST；Console
   使用 caller request ID 作为关联身份，不向浏览器返回 management transport request ID、inspection ID、assertion 或 credential。
6. UI 只展示有界 Session、lifecycle、compatibility、support tier、architecture、OS、runtime、capacity 与下一页事实；所有文本继续以
   data/textContent 渲染。证据 bundle 对 Worker、Project 和 request identity 使用 bundle-local 域内 alias，且不声明服务器签名或
   action authority。
7. 本切片不新增 workspace package、external dependency、binary、监听端口、Kubernetes workload、Ingress、数据库 schema/role/Pool
   或持久化状态。Console 仍只在受信 operator workstation 回环生命周期运行，Edge/Standalone 不导入 Cluster Admin。

## 被拒绝的替代方案

### 独立 Worker Console 服务或 package

拒绝。两个 caller-driven 只读操作不足以承担第二套 session、TLS、镜像、发布和运维生命周期；代码应留在已有 Console 与
Worker management 内聚目录。

### 默认启用 Worker authority

拒绝。普通 Project 观察与 Worker management mTLS/OIDC 是不同权限域。显式成对文件与独立启动开关让部署者可以证明未启用路径
不会读取 assertion、打开额外连接或展示 Worker 操作。

### 自动刷新、自动翻页或实时 Worker dashboard

拒绝。它会把一次诊断变成持续数据库、网络和浏览器成本，并掩盖低配管理节点上的真实压力。固定 16 项页面与用户驱动 inspect/
next 是本阶段唯一接受的负载模型。

### 把 assertion 或 transport identity 发给浏览器

拒绝。浏览器只应持有短期 Console session；上游身份、私钥和传输关联信息必须留在 BFF authority 内。

## 升级与回滚

- 旧启动方式不传 Worker 参数时行为不变。需要观察 Worker 的部署者先提供 canonical generic config 与专用 assertion，再显式启用
  launcher switch。
- 回滚到 ADR-0467 时只失去 Console 中两个 Worker tab/route；generic CLI、manager、数据库与 Worker Session 不变，无数据迁移。
- 若未来增加 Worker mutation、历史指标、label/filter、跨 Project inventory 或实时流，必须另立 authority、索引、retention、隐私和
  资源预算 ADR，不能在本只读 BFF 上渐进偷渡。

## 验证与证据

- Console/CLI/evidence/launcher 专项门 `48/48`；覆盖 exact route、固定分页、mTLS canonical read、authority 默认关闭、独立开关、
  transport identity 隔离、证据脱敏和 mutation/remote-listener/ambient-authority 拒绝。
- `@qinglong/cluster-admin` 全量 `431 total / 428 pass / 3 conditional skip / 0 fail`；backend
  `1,504 total / 1,502 pass / 2 conditional skip / 0 fail`；18-package clean build/逐包测试单次退出 0。
- package boundary、Cluster dependency、Edge import、Cluster/Worker deployment、Console 与 distribution 审计全部 compatible。
  workspace 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Cluster Admin 为
  `128 source / 127 nested`，没有新增 dependency。
- 14 档 Local artifact audit 全部 compatible。基础 Edge/Standalone 为 `2,598,669 / 2,598,747` bytes、57 loaded modules，RSS
  增量 `11,272,192 / 11,223,040` bytes；Application+AI 为 `4,501,822 / 4,501,954` bytes；MCP 为
  `7,324,601 / 7,324,709` bytes。Console/Worker authority 未进入低配路由设备制品。
- 本切片没有 PostgreSQL schema、ACL、repository、role、Pool、连接或 failover 变化，因此不重跑并不重新占有物理 HA 证明；仅引用
  D-373/D-374 PostgreSQL 18.6 arm64 HA `146/146`、timeline `1→2` 相邻基线。数据库语义一旦改变必须重新运行 HA 门。
