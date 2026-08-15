# ADR-0415：受围栏的 Copilot 故障诊断取消入口

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-323、Phase 2

## 背景

D-321 已提供受认证的故障诊断执行入口，D-322 已提供 request-keyed 状态与密文输出读取，但用户还不能按原始诊断 `requestId` 停止不再需要的诊断。直接要求调用者取消内部 diagnosis Run 会泄露实现 identity；直接复用普通 Run cancellation route 又无法验证 source Run、原始 request 与 diagnosis Run 的三方绑定。

现有 durable authority 已经足够：admission plan/receipt 唯一绑定 Project、source Run、request 与 diagnosis Run；通用 Run cancellation transaction 会重验当前 Project/RoleBinding Policy fence，并以数据库时间写唯一 cancellation intent/Event；pre-Model terminalizer 能在 Model start 不存在时原子终结 Tool/Model Step、父 Run 与 receipt。Model start 之后目前没有 Provider abort acknowledgement，因而不能把“已写停止意图”伪装成“Provider 已停止”。

## 决策

1. Cluster AI profile 新增：
   `POST /api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses/{requestId}/cancellation`，固定 operation `copilot.failure_diagnosis.cancel`、permission `run.stop`，不接受 query。
2. 请求复用 profile-neutral exact body `qinglong/run-cancellation@v1`，仅含 `schema` 与调用方生成的 `mutationId`。调用方不能提交 diagnosis Run、Event ID、取消原因、Model invocation、Provider 或终态；Event ID 由服务端生成。
3. admission plan 与 receipt 必须同时存在，并 exact 绑定 path 中的 Project、source Run 和 request。服务端只使用 plan 中的 diagnosis Run ID 调用既有 PostgreSQL Run cancellation repository；不存在、跨 Project、跨 source Run 或漂移统一返回 404。
4. route admission 负责 Bearer authentication、`run.stop` 当前 Policy 判定与 durable audit；Run cancellation transaction 在写 intent/Event 的同一 SERIALIZABLE 事务中再次锁定并验证当前 Project/RoleBinding fence。撤权竞态返回 409，存储或 durable evidence 冲突返回 503。
5. Model start 尚不存在时，取消 intent 提交后立即调用既有 pre-Model terminalizer。terminalizer 与 Model start 通过 PostgreSQL Run/Step/version fence 竞争：terminalizer 获胜则 Run/未完成 Step 原子进入 `cancelled`；Model start 获胜则进入 `model_in_flight`。
6. Model 已开始时只承诺 durable cancellation intent，不伪造 Provider abort、usage、cost 或终态。真实 Provider completion 可以成为最终结果；`outcome_unknown` 仍必须走既有强 User resolution。后续若增加 Provider abort，必须另立包含 abort acknowledgement、late completion 与计费语义的 ADR。
7. 响应 schema 为 `qinglong/cluster-copilot-failure-diagnosis-cancellation-response@v1`，投影 `accepted|already_requested|already_terminal`、`terminal|model_in_flight`、exact target、diagnosis Run、当前/终态 outcome 与 cancellation fact。首次 intent 为 202，其余幂等重放为 200。
8. 相同 mutation 的响应丢失重放不得追加 Event 或再次递增版本；不同 mutation 也不得覆盖已有 reason/time。取消与 Model start/finalization 的任一竞态只能有一个合法 durable winner。
9. 实现留在既有 `@qinglong/ai` 和 `@qinglong/cluster-control` 的嵌套 Copilot 领域目录，复用同一 AI PostgreSQL Pool、repositories、Policy pipeline 与进程；不新增 package、schema、Pool、连接、timer、watcher、队列、cache、端口、Pod、Service 或 Kubernetes 权限。普通 Cluster Control、Edge 与 Standalone 不注册该 route。

## 不选择

- **让客户端直接调用 diagnosis Run 的通用 cancellation route**：暴露内部 Run identity，且无法证明 source/request binding。
- **Model start 后直接写 cancelled**：没有 Provider abort acknowledgement，会伪造外部副作用与计费事实，并允许迟到 completion 覆盖假终态。
- **为 Copilot cancellation 新建 package、表或 supervisor**：现有 admission、Run intent、terminalization 与 Model recovery ledger 已覆盖所需 authority；新资源只会复制状态机并增加低配设备成本。
- **在 MCP/UI/CLI 中同时实现写入口**：客户端需要独立的强认证、确认交互与错误展示门，不能与服务端 authority 混成一个不可审计改动。

## 验收

1. 单元/集成测试覆盖 invalid body、权限、跨 Project/source/request、Policy 撤权、首次/相同 mutation/不同 mutation、终态重放、pre-Model 原子 terminalization、Model-start winner、finalization race 与故障映射。
2. PostgreSQL HA 覆盖 intent/Event/terminal receipt 复制、promotion 后 exact replay、pre-Model winner 和 in-flight 不伪造终态。
3. `@qinglong/ai`、`@qinglong/cluster-control`、18-package clean build/test、backend、四项架构审计、14 档 Local artifact 与离线 HA 报告审计全部通过后才允许 D-323 阶段提交。

最终验收（2026-08-16）：AI 254 pass/3 条件 skip，Cluster Control 261 pass/2 条件 skip，18-package clean build/test 退出 0，backend 1,207 pass/2 条件 skip/0 fail；workspace 保持 18 package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。目录密度门拒绝新增的第 12 个 failure-diagnosis 直属文件后，删除了仅做 re-export 的单文件 façade，公开 subpath 直接指向内聚的 `cancellation/service`，未新增 package 或放宽目录阈值。四项架构审计、14 档 Edge/Standalone artifact 与 PostgreSQL HA 离线证据审计均通过；PostgreSQL 18.6 arm64 physical HA 为 142/142、timeline `1→2`，报告 SHA-256 为 `5dbcffb74a3181aabee66a8f68ecfa7a65e0491a6f2ba24e2bc903c83da9d766`。
