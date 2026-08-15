# ADR-0413：默认关闭的 Cluster Copilot 故障诊断产品 API

- 状态：Accepted
- 日期：2026-08-15
- 关联 RFC：QL-RFC-0001 D-321、Phase 2
- 关联 ADR：ADR-0087、ADR-0407、ADR-0408、ADR-0409、ADR-0411、ADR-0412

## 问题

ADR-0412 已使 Copilot failure diagnosis 的成功、Tool/日志失败和 Model unknown
路径都能耐久收敛，但 capability 仍没有产品入口。直接增加独立 AI HTTP 服务、让 CLI/UI/MCP
调用 application service，或允许调用者提交 Model、Tool、Attempt、日志范围和 outcome，都会绕过
Cluster Control 已有的认证、Project Policy、同步安全审计、资源预算或 source fence。

路由器上的低配 Edge/Standalone 与集群节点还必须保持不同部署闭包：默认部署不能因为一个可选
Copilot API 增加 AI 依赖、进程、监听器、连接池、队列或常驻任务；集群多副本则必须依靠耐久
request identity 和数据库 fence 收敛，而不是依靠单进程锁。

## 决策

1. 唯一产品写入口为
   `POST /api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses`，operation 是
   `copilot.failure_diagnosis.execute`，Project permission 是 `model.invoke`。它只注入既有
   Cluster Control route registry，完整复用同一认证器、Project Policy 和 fail-closed 同步安全
   审计；内部受信 Tool 仍独立复验其精确 `tool.call:*` permission。
2. 路由只在显式 AI 进程且 `QL3_CLUSTER_AI_COPILOT_ENABLED=true` 时注入。普通
   `ql3-cluster-control`、Edge、Standalone 和未启用 Copilot 的 AI 进程都返回 `404`，并且不
   import/构造 Copilot capability。
3. HTTP `x-request-id` 是耐久 diagnosis request identity；缺省时由既有 HTTP surface 生成并
   回传。客户端重试必须复用它。JSON body 采用 exact-key schema，只包含
   `schema=qinglong/cluster-copilot-failure-diagnosis-request@v1` 与 `traceId`。调用者不能提交
   project、source Attempt、日志 Artifact/range、Tool、provider、model、预算、deadline、输出
   key、reason 或 outcome。
4. `projectId` 与 `sourceRunId` 只从已匹配的 canonical path 获取，principal 只从认证结果获取。
   application service 再从当前 Run、latest Attempt、Project Tool snapshot、配置投影和数据库时间
   派生 exact source fence、Tool plan、Model intent 与 deadline。HTTP Policy fence 负责产品入口
   admission；耐久执行计划仍记录 application 内部重新读取的当前 Policy fence，不能信任调用者
   提交的 fence。
5. 响应是 content-free 投影，只返回 schema、request identity、created/existing replay 状态、
   source/diagnosis Run identity、终态 outcome/stage/reason，以及成功时的加密输出 Artifact
   `artifactId/artifactDigest`。不得返回日志、Tool output、Model plaintext、prompt、provider、
   model、密钥材料、内部异常、Policy reasons 或数据库细节。
6. 请求体错误返回稳定 `400`；source/idempotency/durable conflict 返回 `409`；Tool approval/
   policy deny 返回低敏 `403`；容量耗尽返回 `429`；Model budget/egress policy 拒绝返回 `422`；
   caller abort 返回 `408`，deadline 返回 `504`；其余依赖和存储错误统一为 `503`。任何响应都
   不透传内部 message。
7. 路由是 caller-driven 的薄 transport adapter，不增加 package。实现放入既有
   `cluster-control/src/copilot/failure-diagnosis` 领域目录；AI composition 只把已经创建的同一个
   application capability 注入 control composition。不得增加进程、监听器、数据库 Pool/连接、
   timer、watcher、队列、cache、Pod、Service 或 Kubernetes API 权限。
8. 多副本并发继续以 application request coalescing 加 PostgreSQL exact replay 收敛。进程内
   coalescing 仅降低同实例重复工作，不是正确性边界；不同实例对同一 `x-request-id` 的相同请求
   必须得到 `created|existing` 同一 diagnosis Run，对不同 source/trace 的复用必须 conflict。
9. 后续 CLI、UI、MCP 只能调用该 HTTP API，不得直接导入 Copilot application/composition，
   也不得各自定义更宽的请求契约。

## 被否决方案

1. **独立 Copilot HTTP 进程或端口**：复制认证、审计、TLS、限流和生命周期，增加低配与集群
   运维成本。
2. **把路由放进默认 Cluster Control**：即使运行时返回 disabled，也会扩大默认制品和依赖闭包。
3. **body 自带 requestId 且与 HTTP requestId 分离**：会产生两个重试/审计身份，难以可靠关联。
4. **调用者选择 provider/model/Tool/日志范围**：扩大数据外发和权限边界，破坏 canonical config
   与 source fence。
5. **只检查 `model.invoke`，跳过内部 Tool Policy**：把组合 capability 变成 Tool 权限旁路。
6. **同步返回诊断正文**：使重放、响应大小、日志泄露和生命周期依赖于一次 HTTP 连接。
7. **新增 Copilot API package**：没有独立部署或复用边界，只会制造薄 package。

## 验证标准

1. 路由单元测试覆盖 exact body、HTTP request identity 绑定、path-derived project/source Run、
   principal 传递、created/existing replay、成功/非成功 content-free projection、错误低敏映射和
   非法输入零 capability call。
2. production composition 测试证明默认 route 不存在；显式 capability 注入后只增加一个 exact
   route，并先完成 authentication、`model.invoke` Policy 和同步 `allowed` audit 才读取 body/
   调 capability。拒绝路径不得调用 capability。
3. AI composition 测试证明只有显式 Copilot 配置才注入同一个 capability；Prompt 与 Copilot
   仍共享原 Pool/Gateway，stop 顺序和 availability ownership 不变。
4. package/dependency/import/deployment 审计证明 package 数、默认 Edge/Standalone 闭包、进程、
   端口、Pool、Pod、Service 与 Kubernetes 权限无增长。
5. 18-package clean build/test、完整 backend、Local artifact、PostgreSQL 18 physical HA 与
   GitNexus staged/change detection 全通过后才允许阶段性提交。

## 当前验证

1. 路由与 composition 新增测试覆盖 HTTP request identity、path-derived Project/source Run、认证
   principal、exact body、created/existing replay、成功和 pre-Model content-free projection、内部
   错误低敏映射、默认 route absence、`model.invoke` deny 零 capability call，以及 AI composition
   的同一 capability 注入。Cluster Control 全包 250 pass/2 条件 skip/0 fail；受影响测试格式化后
   独立复跑 27/27。
2. 18 个 QL3 package 从清空全部 `dist` 开始完成拓扑构建和全包测试；backend 1,207 pass/2 条件
   skip/0 fail。Edge import、Cluster dependency、package boundary 与 Cluster deployment 四项审计
   全部兼容且零 finding。
3. workspace 仍为 18 个 package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。Cluster
   Control 60 个源码中 58 个位于嵌套领域目录；唯一新增源码位于既有
   `copilot/failure-diagnosis`，没有增加 package 或根部平铺文件。
4. 14 档 Local artifact 全部 `compatible=true`；默认 Edge/Standalone 分别保持
   2,589,890/2,589,968 bytes，Edge/Standalone AI 为 3,069,143/3,069,233 bytes，证明
   Cluster-only 产品路由未进入路由设备或 Local AI 闭包。
5. PostgreSQL 18.6 arm64 physical HA 137/137、timeline `1→2`；既有成功、pre-Model
   terminalization、unknown resolution 和晋升后 exact replay 全部通过。私有报告 SHA-256 为
   `0a12b5c1102555823d43b5a93dd7868b98b194b491840a5242bab6fa2da26123`，独立离线审计
   `compatible=true`、零 finding。本 Gate 未改 migration、schema、role、SQL 或 HA 拓扑。

## 后续门禁

本 Gate 不开放诊断正文读取、列表、取消、unknown resolution、CLI、UI 或 MCP。下一 Gate 应优先
提供同一 Project Policy 下的加密输出 Artifact 读取与费用/取消可观测性；真实外部 Provider 和
多副本并发证据完成前，Copilot 继续保持默认关闭。
