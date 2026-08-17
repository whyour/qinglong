# ADR-0447：Boot Shadow 准入与非 Origin 边界

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-02、D-355、PR-4
- 关联 ADR：ADR-0001、ADR-0002、ADR-0445、ADR-0446
- Amends：ADR-0002 的 Alpha Shadow allowlist 与 `once/boot/grpc` 裁决

## 上下文

Run domain 为未来触发协议保留了 `once`、`boot` 和 `grpc` execution origin，但 2.x 代码里的相似名称并不都代表独立的执行所有权边界：

- `CronService.bootTask` 在启动后筛选启用的 `@boot` Crontab，并显式调用 `runSingle(id, 'boot')`；这是一条真实、独立且由 Legacy Node worker
  创建 ChildProcess 的触发路径。
- `@once` 当前只被 `isSpecialSchedule` 排除出 system/node 自动调度，没有独立自动触发器。用户从 HTTP 或 gRPC API 运行这类 Crontab 时仍进入
  `CronService.run`，语义是 manual。
- gRPC `runCrons` 只是传输适配器，委托同一个 `CronService.run(ids)`；transport 不能替代 actor、trigger 与 execution owner。

如果仅因为领域枚举或 schedule/transport 名称存在就同时开放三类 origin，会把同一次 manual 执行错误分类，污染 Shadow 完整率和未来 Primary 门禁。

## 决策

1. `QL3_SHADOW_ORIGINS` 增加 `boot`。默认仍为 off，只有显式列出 `boot` 时才构造事实、加载 Shadow Repository 或增加 ChildProcess listener。
2. 复用现有 `runSingle` 的唯一 ChildProcess，不调用 Executor、不再次 spawn；Run 固定 `executionOwner=legacy`、`origin/triggerType=boot`、
   `triggeredBy=legacy:boot` 与 `legacy-cron:<id>` task identity。
3. `bootTask` 只准入启用的 `@boot` 条目；disabled、`@once` 与普通 cron 表达式不进入 boot 路径。一次进程启动中的每个匹配条目只调用一次
   `runSingle(id, 'boot')`，现有并发限制和 Legacy 状态仍是执行事实源。
4. 不把 `@once` schedule 推导为 `once` origin。当前没有独立 once trigger/admission identity；由用户 API 发起的 `@once` Crontab 仍是 manual。
5. 不把 gRPC transport 推导为 `grpc` origin。现有 `runCrons` 与 HTTP `/crons/run` 共用 `CronService.run`；未来只有出现具备独立认证 actor、
   accepted identity 和 owner 决策的 gRPC trigger 时，才可另提准入 Gate。
6. `once`、`grpc` 保留在共享 domain/schema vocabulary 中，避免破坏持久化兼容和未来协议，但 Legacy Shadow allowlist 拒绝它们并产生有界、低敏配置告警。

## 资源与部署影响

- 不新增 package、生产依赖、schema、migration、表、索引、timer、watcher、线程、端口或部署对象。
- 默认关闭时只多一个缓存 Set 成员，没有数据库读取、任务摘要、listener 或写入。
- 启用时只为本来就会执行的 boot ChildProcess 写现有 Run/Attempt/Event；不扫描历史 Crontab，不产生后台对账循环。
- 路由设备与 standalone 使用相同的惰性进程内路径；cluster 节点不会因此获得新的本机 owner，也不会把 transport 当作跨节点 authority。

## 被拒绝的替代方案

### 同时开放 once、boot、grpc

拒绝。只有 boot 有独立的真实触发路径；其余两个名称不能证明 execution origin。

### 根据 `cron.schedule === '@once'` 改写 origin

拒绝。schedule 描述任务定义，不描述本次触发者；用户手动执行 `@once` 任务仍是 manual。

### 根据请求来自 gRPC 改写 origin

拒绝。传输协议不是 owner。HTTP 与 gRPC 当前调用同一 service 方法，按 transport 分裂会让相同行为产生不同 Run 语义。

### 为 boot 另建 Executor 或 scheduler

拒绝。Shadow 只能观察 Legacy 已创建的进程；第二个执行器会违反单 owner 和零双跑约束。

## 验证

- 环境边界验证 boot 可显式启用，而 once/grpc 继续拒绝；未知配置只产生有界告警。
- `bootTask` 合同验证只选择 enabled `@boot`，并以固定 `boot` origin 单次派发。
- 真实 ChildProcess + SQLite 集成验证一个 legacy-owned boot Run/Attempt、成功终态与八个顺序 Event，且不保存原始 command/credential 文本。
- `@once` 真实执行验证继续产生 manual fact；gRPC `runCrons` 验证只委托 `CronService.run`，没有传入或推导 grpc origin。
- Legacy Shadow 聚焦测试 42/42、`build:back`、完整 backend 1,419 pass + 2 条条件 skip/0 fail、18-package clean
  build/test、14/14 静态审计与 14/14 artifact 档位全部通过；artifact 字节与 D-354 一致。
- 本阶段没有修改数据库 schema/adapter、容器或 Kubernetes 拓扑，因此不重跑物理 PostgreSQL HA/K3s 门；完整证据与各档位字节记录在
  QL-RFC-0001 D-355。
