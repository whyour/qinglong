# ADR-0469：Copilot Console 显式可选 Package Installation 只读观察

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-376、D-14、D-16、D-107
- 关联 ADR：ADR-0142、ADR-0191、ADR-0462、ADR-0468

## 上下文

Cluster Plugin Package management 已提供经过认证的 canonical HTTPS/client 边界和有界 installation inventory。运维人员需要在现有
Copilot Console 中把 Run、Worker 与 Package 安装状态放在同一个只读现场账本中观察，但浏览器不能持有 Package assertion、选择上游
command/path，也不能把管理生命周期变成持续轮询或默认常驻能力。

新建 Package Console 服务或 workspace package 会复制 session、TLS、镜像、分发和资源生命周期；把完整 Package management command
file 暴露给 Console 又会把 propose、decide、install、upgrade、rollback 和 lifecycle mutation 带入只读诊断面。低配路由设备也不应因
Cluster 工作站能力增加任何 importer、常驻内存或连接成本。

## 决策

1. 在既有 `@qinglong/cluster-admin/copilot-console` 增加 `package_list` 与 `package_inspect`，分别只接受固定 BFF route
   `/api/v1/package-management/installations` 与 `/api/v1/package-management/installation`。浏览器不能提供上游 path、method、command
   file 或 caller limit。
2. Package authority 使用独立 `--package-management-config` 与 `--package-management-assertion`；二者必须成对存在，config 必须指向
   canonical `/api/v3/plugin-packages/management`。它不复用 Project、Run 或 Worker credential/assertion。
3. 未提供该 authority 时原有 Console 行为不变并报告 `packageManagementAuthority=disabled`。宿主 launcher 只有在
   `QL3_COPILOT_CONSOLE_PACKAGE_MANAGEMENT=enabled` 时添加这对 owner-private 文件；三个可选 management authority 互不隐式启用。
4. `package_list` 固定最多 16 项，只接受 nullable `afterPackageName`，下一页必须由用户点击。`package_inspect` 只读取用户明确选择的
   canonical Package。禁止自动翻页、批量 inspect、poller、retry、queue、cache、watcher、WebSocket/SSE 和后台 timer。
5. BFF 复用现有严格 Plugin Package management client validator，并增加 in-memory one-shot command 入口；一次点击只产生一次上游 POST。
   caller request ID 只作为 inspection identity，management transport request ID 不返回浏览器。
6. 产品投影只包含 Package name/version、install operation/state、target generation、availability、recovery/failure/quarantine code、record
   version 和时间。installation ID、active/previous lock digest、record digest、assertion、authentication 与 transport identity 均不进入产品响应。
7. 浏览器证据包对 Project、Package、request 与 digest 使用 bundle-local typed alias，只保留固定枚举、数字、布尔和容器字段；未知字段与
   free text 继续删除，且不声明 server signature、durable audit 或 action authority。
8. 本切片不新增 workspace package、external dependency、binary、监听端口、Kubernetes workload、Ingress、数据库 schema/role/Pool 或
   持久状态。实现留在现有 `plugin-package/management` 与 `copilot-console` 内聚目录；Edge/Standalone 不导入 Cluster Admin。

## 被拒绝的替代方案

### 新建 Package Console package 或服务

拒绝。两个 caller-driven 只读操作没有独立部署、版本或资源生命周期，不足以承担新的 package/daemon。复用现有工作站 Console 可保持包数、
镜像和 session 边界稳定。

### 将完整 Package command file 暴露给浏览器

拒绝。现有 command vocabulary 同时包含高风险 mutation。固定 list/inspect command builder 和固定 BFF route 才能从结构上证明只读，而不是
依赖 UI 隐藏按钮。

### 默认启用 Package authority

拒绝。Project observation 与 `package.manage` 是不同权限域。默认 disabled、成对私有文件和独立 launcher switch 让未启用部署不读取 assertion
也不打开 Package connection。

### 自动刷新或自动遍历全部 installations

拒绝。持续 inventory 会隐藏数据库和网络负载，在小型管理节点上尤其不合适。固定 16 项与点击翻页使每次 authority use 都可见、可限界。

## 升级与回滚

- 旧启动方式不传 Package 参数时行为不变。启用者先安装 canonical config、CA 与短期 assertion，再显式打开 launcher switch。
- 回滚到 ADR-0468 只移除 Package tab、两条 BFF route 和可选参数；canonical manager/client、installation repository 与数据均不变化，无迁移。
- 未来若加入 install/upgrade/rollback、跨 Project inventory、历史指标或实时流，必须另立 mutation authority、审计、配额、retention 和资源预算
  ADR，不能在本只读 BFF 上渐进扩大。

## 验证与证据

- Console/CLI/product/evidence/launcher 专项回归 `56/56`，覆盖 exact route、固定 16 项、click-only cursor、canonical TLS 1.3 request、独立
  authority 默认关闭、transport/durable identity 隔离、证据脱敏和 mutation/remote-listener/ambient-authority 拒绝。
- `@qinglong/cluster-admin` 全量 `438 total / 435 pass / 3 conditional skip / 0 fail`；legacy backend 当前工作树全量与 18-package clean
  build/逐包测试均单次退出 0。
- package boundary、Cluster dependency、Edge import、Cluster/Worker deployment、Console 与 distribution 七项审计全部 compatible/passed。
  workspace 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Cluster Admin 为 `129 source / 128 nested`，无新增依赖。
- 14 档 Local artifact audit 全部 compatible。基础 Edge/Standalone 为 `2,598,669 / 2,598,747` bytes、57 loaded modules；
  Application+AI 为 `4,501,822 / 4,501,954` bytes；MCP 为 `7,324,601 / 7,324,709` bytes。Package Console authority 未进入低配制品。
- 本切片没有 PostgreSQL schema、ACL、repository、role、Pool、连接或 failover 变化，不重跑也不重新占有物理 HA 证明；仅引用 D-373/D-374
  PostgreSQL 18.6 arm64 HA `146/146`、timeline `1→2` 相邻基线。数据库语义变化时必须重跑。
