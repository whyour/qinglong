# ADR-0470：Console 会话级能力发现与服务端操作围栏

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-377、D-376、D-375、D-107
- 关联 ADR：ADR-0419、ADR-0468、ADR-0469

## 上下文

Copilot Console 的 Run、Worker 与 Package management 观察权限默认关闭并分别由启动进程显式提供，但 D-376 页面在会话解锁后仍展示全部
二十个操作。用户只能在点击后从失败响应推断 authority 未启用；仅隐藏前端按钮也无法证明手工构造固定 route 不会到达 executor。

能力发现不能变成新的 Cluster inventory、轮询器或状态服务。它必须只反映当前 Console 进程已经验证的静态启动边界，不访问上游、不生成证据、
不增加常驻任务，并继续适用于资源有限的工作站与管理节点。Edge/Standalone 路由设备不得因此装入 Cluster Admin。

## 决策

1. `startClusterCopilotConsoleServer` 必须显式接收 `allowedOperations`。十三个 Project/Copilot 基础只读操作必须完整存在；Run、Worker、Package
   三组可选操作分别只能整组启用或整组关闭。未知、重复、缺失基础操作或部分可选组均在监听前 fail closed。
2. CLI 只把已经完成私有文件和 authority 校验的 `availableOperations` 注入服务端。preflight、started event、能力响应和执行围栏共享同一有序操作集，
   不再存在 UI 声明与实际启动权限的第二份配置。
3. 增加认证后的同源 `POST /api/v1/session/capabilities`，请求只接受固定 schema-only body 并复用 Origin、media type、长度和并发上限。响应固定为
   `qinglong/cluster-copilot-console-capabilities@v1`，只包含有序操作、四个低敏 authority 状态、`mutation: false` 与 `upstreamReads: 0`。
   未认证、Host/Origin/session 不匹配仍统一返回掩码 `404`。
4. 能力读取是本进程内存配置读取，不调用 Cluster client、management client、executor、repository 或数据库，不写浏览器证据账本，也不增加
   poller、retry、queue、cache、watcher、WebSocket/SSE 或 timer。
5. 服务端在解析 read body 和调用 executor 之前检查固定 route 对应操作是否属于 immutable allowed set。禁用操作返回掩码 `404` 并丢弃请求，
   即使调用者绕过页面手工构造 route 也不能获得上游 authority。
6. 浏览器只有在 session 格式校验和 capability 请求成功后才解锁。它拒绝未知、重复或非固定 route 的能力响应，隐藏无可用操作的可选 tab，
   禁用未授权按钮，并在每次执行前再次检查本页 allowed set。session 与 allowed set 只存在当前页面内存，pagehide 时清空。
7. 本切片不新增 workspace package、dependency、binary、端口、服务、数据库对象、Kubernetes workload 或后台资源。能力发现只增加一次解锁请求，
   不进入 Edge/Standalone artifact closure。

## 被拒绝的替代方案

### 继续展示全部操作并在点击后报错

拒绝。它把部署配置问题推迟成运行时失败，也误导用户认为可选 authority 已存在；对低性能管理设备还会产生无意义请求。

### 只在 HTML/JavaScript 中按部署模板隐藏 tab

拒绝。静态资产无法知道当前进程实际验证了哪些私有文件，而且浏览器隐藏不构成授权边界，手工请求仍可能到达 executor。

### 从每个上游 manager 动态探测能力

拒绝。它会把一次页面解锁扩展成多次 Cluster 网络请求，制造额外延迟、故障耦合和隐式负载。启动进程已经拥有经过校验的唯一事实源。

### 允许任意操作子集

拒绝。当前产品权限是十三个基础读与三个完整可选 authority 组。任意子集会制造未定义的半启用部署和更多测试组合；更细粒度授权需要独立 RFC。

## 升级与回滚

- 现有 CLI 自动注入与 preflight 相同的操作集；默认部署解锁后只显示十三个基础操作。显式启用某个 management authority 时相应 tab 整组出现。
- 直接调用导出的 server factory 必须提供合法 `allowedOperations`，这是有意的 fail-closed API 收紧；无隐式“全部允许”兼容默认值。
- 回滚到 ADR-0469 可移除 capability endpoint、浏览器发现流程和 server option，不涉及数据迁移或 Cluster 配置变更。

## 验证与证据

- Console server、CLI、证据生成与离线校验聚焦门 `38/38`，覆盖认证能力读取、零上游读取声明、基础操作强制存在、可选组完整性、重复操作拒绝、
  禁用 route 在 executor 前掩码拒绝，以及原有二十个 read contract。
- `@qinglong/cluster-admin` 全量 `440 total / 437 pass / 3 conditional skip / 0 fail`；完整 backend
  `1,505 total / 1,503 pass / 2 conditional skip / 0 fail`。D-376 新增内聚源文件后遗留的 package boundary 期望已从 `128/127` 修正为
  实际且 RFC 已声明的 `129 source / 128 nested`。
- 18-package clean build 与逐包测试单次退出 0。package boundary、Cluster dependency、Edge import、Cluster/Worker deployment、Console 与
  Console distribution 七项审计全部 compatible/passed；workspace 仍为 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`，
  未新增依赖。
- 14 档 Local artifact audit 全部 compatible。基础 Edge/Standalone 仍为 `2,598,669 / 2,598,747` bytes、57 loaded modules；
  Application+AI 为 `4,501,822 / 4,501,954` bytes；MCP 为 `7,324,601 / 7,324,709` bytes。Console capability discovery 未进入低配闭包。
- 本切片不改变 PostgreSQL schema、ACL、repository、role、Pool、连接或 failover 语义，因此不重跑且不重新占有 HA 证明；D-373/D-374 的
  PostgreSQL 18.6 arm64 HA `146/146`、timeline `1→2` 只作为相邻既有基线，数据库语义变化时必须重跑。
