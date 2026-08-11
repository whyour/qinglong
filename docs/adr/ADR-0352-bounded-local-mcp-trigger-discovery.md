# ADR-0352：有界、低敏的本机 MCP Trigger 发现

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-259、D-260、D-261、D-262、D-263、D-264
- 关联 ADR：ADR-0303、ADR-0346、ADR-0347、ADR-0348、ADR-0349、ADR-0350、ADR-0351

## 背景

Local MCP 已能发现当前 Project 的 Task 和最近 Run，却不能说明 Task 与当前调度入口之间的绑定。AI Client 只能让用户
手工复制 Trigger ID，或要求暴露完整调度配置；前者缺少可用性，后者会泄露 cron expression、timezone、misfire 策略、
content digest 等不必要事实。

Runtime Core 已定义 Profile-neutral `TriggerSource.listTriggers`，SQLite 与 PostgreSQL 均有按 `triggerId ASC`、最多读取
`limit + 1` 行的 current-head keyset 实现，Policy 也已有 `trigger.read`。因此缺口是一个 MCP-only 低敏 projection 和本机
composition，不是新的领域模型、存储仓库或 workspace package。

## 决策

1. Local MCP 新增只读 Tool `qinglong.trigger.list@1.0.0`。输入只能包含可选的
   `after: { triggerId }` 和 `limit`；默认页 32、最大页 64，Project ID 只来自私有进程配置。
2. 响应按 `triggerId` 严格递增，只返回 current Trigger 的
   `triggerId/revision/taskId/taskRevision/specSchema/enabled/updatedAtMs`、`hasMore` 与服务端 `next`。
3. cron expression、timezone、misfire/config、Project ID、mutation/content/task digest、创建时间、Secret reference 与
   持久化 row 不得返回。disabled Trigger 保留并显式返回 `enabled=false`；禁止 projection 为筛选 enabled 而无界补读。
4. 每次调用必须依次经过 API Credential authentication、exact `tool.call:qinglong.trigger.list` 与 `trigger.read`
   Policy、durable Security Audit、credential confirm，最后才调用 Project-scoped `TriggerSource.listTriggers`。
5. 输入、跨 Project row、乱序/超量 page、非法 spec schema 和不一致 continuation 必须失败关闭；存储异常对外只暴露稳定的
   unavailable 错误。
6. projection 归 `@qinglong/local-mcp-server/src/tool-projection/`，不公开 package subpath；SQLite 使用 MCP 已持有的唯一
   connection、operation queue 与 close fence。不得新增 package、production dependency、migration、连接、缓存、timer、
   listener、management 或写 authority。
7. 该 Tool 只属于可选 `edge-mcp`/`standalone-mcp` 制品。默认 Edge/Standalone application 不导入 MCP SDK，也不加载
   Trigger projection。Cluster 保持复用同一 `TriggerSource`/PostgreSQL current-head 契约，但本 ADR 不新增集群 MCP 进程。

## 被否决方案

1. 返回完整 Trigger spec：方便 Agent 解释 cron，但扩大了配置和运行习惯的披露面；诊断配置应另立精确授权 Tool。
2. 只列 enabled Trigger：投影层必须越过 disabled row 补读才能填满页面，破坏固定 I/O 成本和游标语义。
3. 允许客户端指定 Project：把本机私有配置的租户边界降级为不可信参数，扩大跨 Project 探测面。
4. 为 Trigger projection 新建 package：只有 Local MCP 一个消费者，没有独立部署、authority 或依赖隔离收益。
5. 在本批加入 Trigger enable/disable、Task start 或任意写 Tool：当前 MCP 尚未具备完整 Policy/Approval/Audit 产品门；只读发现
   不能被当作执行授权。

## 验证

- Local MCP 27/27、Local SQLite 204/204；真实 stdio/API Credential/SQLite E2E 覆盖五 Tool discovery、权限、审计与低敏输出。
- PostgreSQL adapter 286 pass/1 条件 skip，覆盖既有 Trigger current-head source 与原子管理边界。
- package boundary/dependency 59/59；workspace 仍为 17 package、994 source，其中 968 nested、26 root（97.4%）；无单文件或
  浅层 package。
- 十二档 artifact 全部 compatible。Standalone Application AI 为 6,245,092 bytes/635 files，距 6 MiB 上限 46,364 bytes；
  Standalone MCP 为 9,818,337 bytes/943 files、197 loaded modules，RSS 增量 37,093,376 bytes。
- PostgreSQL 18.4 arm64 HA Docker gate `gates.passed=true`，覆盖 `remote_apply`、复制链分区与 promotion guard、旧主 fence、
  timeline 1→2、`pg_rewind` 只读重入、双 control replica、Trigger 管理 inspection 和领域 COMMIT-response-loss；结束后临时
  容器、卷、网络为零。

## 后续约束

新增 `trigger.get`、调度解释或搜索能力必须单独定义字段和索引预算；不能通过扩大 `trigger.list` 响应偷渡配置。任何 MCP
写操作必须先具备完整 Approval 产品路径、可恢复幂等协议、原子审计与低配设备资源证据，并另立 ADR。第二个独立产品消费者
出现前，Trigger projection 继续留在 MCP package 内部。
