# ADR-0119：受审的生产 Cluster Control 路由组合

- 状态：Accepted（Cluster Control 生产业务路由组合已实现；Worker execution composition 已由 ADR-0121 实现，独立 ingress 与完整产品部署仍默认关闭）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-43、D-46、D-48、D-117、D-118
- 关联 ADR：ADR-0048、ADR-0049、ADR-0051、ADR-0052、ADR-0105、ADR-0118

## 背景

Cluster Control 已分别具备 readiness-first HTTP surface、reviewed route registry、Bearer
认证、Project Policy、耐久安全审计、Run 低敏读取和用户取消 mutation，但生产 application
仍要求部署调用方自行拼装 registry、authorizer 与 admission pipeline。这样会产生两个问题：

1. 已实现的 `run.cancel` 可能没有注册，形成“协议与存储已完成、生产入口不可达”；
2. 调用方可以无意中构造不同的路由集合，使副本之间的权限面和审计 operation 漂移。

该缺口属于组合根责任，不需要新 package、schema、数据库连接或后台 lifecycle。

## 决策

### 1. 生产路由表是代码级精确白名单

`@qinglong/cluster-control/production` 提供唯一受审的生产业务组合。当前白名单固定为：

- `GET /api/v3/projects/{projectId}/runs/{runId}` → `run.get` / `run.read`；
- `POST /api/v3/projects/{projectId}/runs/{runId}/cancellation` → `run.cancel` / `run.stop`。

组合根不接受额外 route definition 或 registry 注入。未知路径继续在认证和读取 body 前返回
`404 route_not_found`。新增生产业务路由必须修改该白名单、补协议/权限/审计测试并更新 RFC，不能
由部署配置动态扩权。

### 2. 复用同一认证、Policy 与审计 authority

组合根只消费 `bootstrapClusterControlRuntime()` 在 PostgreSQL readiness 后交付的受限
`ClusterControlAssemblyInput`：

- API credential authenticator；
- Project Policy repository；
- Run reader 与 cancellation repository；
- write-only security audit sink。

路由仍通过既有两阶段 admission；authentication、Project Policy 与 durable audit 全部在 body
读取和 repository mutation 前完成。取消 Event ID 默认由进程内 CSPRNG 生成，测试可注入工厂；
调用方不能提交 Event ID 或系统 cancellation reason。

### 3. 生产 wrapper 不复制资源 ownership

`startProductionClusterControlApplication()` 复用既有 application/HTTP/bootstrap 顺序。它只接受
`EnabledClusterControlConfig`，并从同一 config 原子创建 runtime Pool 与 one-way availability fence；
调用方不能分别传入两个可能错配的 authority。PostgreSQL、startup recovery、Scheduler、取消
convergence、admission drain 和 listener shutdown 继续由原组合根拥有；新增 production stack 只拥有
路由表和 admission pipeline，其 reconcile/start/stop 是无资源边界。disabled/profile gate 由 config
loader 在调用 production 入口前完成；低层 application 的 disabled 路径仍不绑定端口或打开 PostgreSQL。

本决策不打开 Worker ingress，不装配 Worker headless lifecycle，也不绕过“缺少共享 Artifact store
则 Remote completion 保持关闭”的门禁。

### 4. 设备与集群边界

本实现留在既有 `cluster-control` package，未新增 workspace importer、timer、socket、连接、队列或
schema。Edge/Standalone 发布闭包不导入该 subpath；Cluster Control 副本共享同一静态白名单，可按
副本水平扩展而不复制权限定义。该切片完成时 workspace 为 23 个 importer、292 个 TypeScript
source file；后续包粒度收敛与 availability 实现后当前为 21 个 importer、307 个 TypeScript source
file，production Pool/fence 绑定仍留在既有 cluster-control package。

## 被否决的替代方案

1. **继续让部署脚本手工拼 registry**：无法保证副本间路由与权限一致，也无法证明取消入口已开放。
2. **从环境变量或插件动态加载生产路由**：把安全边界降级为部署文本，绕过 reviewed registry。
3. **在 route factory 内自行打开 PostgreSQL**：复制 Pool ownership，并破坏 readiness/recovery 顺序。
4. **把 Worker ingress 合并到同一 listener**：混合 API credential 与 mTLS/`ql3w` authority，扩大故障域。
5. **为两个路由新建 package**：没有独立部署或权限责任，只增加依赖和发布成本。

## 验收证据

1. production subpath 编译并导出固定 `run.get|run.cancel` operation 白名单。
2. 读取和取消均经过认证、Project Policy 与 durable audit；取消使用服务端 Event ID。
3. 未审查路径在认证/body/repository 前 fail closed。
4. config loader 的 disabled gate 不调用 production wrapper；production wrapper 对 disabled config 在取得任何数据库或 listener 前同步拒绝。
5. cluster-control 目标测试、全 workspace build、cluster/edge dependency audit 均通过；当前 package 数为 21。
