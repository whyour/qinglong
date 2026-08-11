# ADR-0371：有界、Project-scoped 的 Run StepRun HTTP 与 MCP API

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-279、D-280、D-281、D-282、D-283，ADR-0367、ADR-0368、ADR-0369、ADR-0370

## 背景

D-282 已让 Local、Cluster 与 MCP 观察 RunEvent 时间线，但事件只能解释聚合状态变化，不能给出 Workflow DAG 中每个 Step 的当前状态、重试次数和父子关系。Cluster 的 Plugin Package Workflow 专用管理路由已有 StepRun 查询语义，通用 Run API 与本机 MCP 却仍缺少同一能力。直接复用专用管理模块会把 Package/Workflow identity、管理审计与更大的闭包带入基础诊断面；在三个产品面复制投影则会产生字段和分页漂移。

## 决策

1. Local 与 Cluster 增加同构 `GET /api/v3/projects/{projectId}/runs/{runId}/steps`，固定 operation `run.steps.list`、permission `run.read`。不得接受 body；query 只允许 canonical `after_step_key`、`after_step_run_id` 与 `limit`，cursor 必须成对，默认 32、最大 64。
2. Runtime Core 在既有 `run/projection/` 中拥有唯一 `boundedRunStepListProjection`。它先用 `RunRepositoryReader.findRunById` 验证 Project 归属，再调用只读 `StepRunRepository.listByRun`；不存在与跨 Project 返回同一 `found=false`，repository、shape、cursor、identity、state 或 order 异常失败关闭。
3. 成功响应只包含 `steps`、`hasMore`、`next`。每项只公开 `id`、`parentStepRunId`、`stepKey`、`kind`、`required`、`status`、`version`、`attemptCount`、`readyAtMs`、`startedAtMs`、`finishedAtMs`、`resultCode`、`createdAtMs`、`updatedAtMs`。禁止 `definitionRef`、`definitionDigest`、`inputRef`、`outputRef`、`approvalRequestId`、`errorSummary`、`lastMutationId` 与 `stepRunDigest` 越过投影。
4. 顺序固定为 `(stepKey ASC, id ASC)` keyset；`next` 只在 `hasMore=true` 时返回最后一条已返回记录的 `{stepKey, stepRunId}`。该 API 是每页重新认证、授权和审计的 forward-only 当前视图，不宣称跨页快照。
5. HTTP 的不存在和跨 Project 统一映射为 404 `run_not_found`。Local 复用 loopback listener、Edge 4/Standalone 32 并发、Bearer、Project Policy、持久 Audit、credential/Pepper confirm 与唯一 SQLite authority；Cluster 复用 route registry、两阶段 admission、持久 Audit 与既有 PostgreSQL Pool。
6. 本机 MCP 增加低风险只读 `qinglong.run.steps.list` Tool，输入输出语义与共享投影一致。MCP read database 只暴露 `StepRunRepository.listByRun`；HTTP 不导入 MCP/Tool Registry，MCP 不取得 StepRun `apply` mutation authority。
7. Local Application product-surface contract 把 Run 与 StepRun 能力收窄为所需只读方法：Run 只允许 `findRunById/listRunsByProject/listEvents`，StepRun 只允许 `listByRun`。底层仍复用同一已打开 storage authority，不新增连接或第二个 repository owner。
8. 不新增 workspace package、第三方依赖、migration、index、repository method、数据库连接、listener、sidecar、timer、watcher、cache 或 authority。实现必须落在既有 Runtime Core、Local API、Local MCP、Local SQLite 与 Cluster Control 领域目录。
9. D-281 的全部文件、flash、module 与 RSS 门不得放宽。完整 backend/packages、14 artifact、默认 Local image、package/dependency boundary、Local Edge/Standalone live contract 与 PostgreSQL HA Docker 门必须通过。

## 不采用方案

- **复用 Plugin Package Workflow administration**：它绑定 Package/Workflow identity 和管理事务，不是通用 Run 低敏查询叶。
- **直接返回完整 StepRunRecord**：definition、input/output、approval 和 error 字段可能是 secret-adjacent 或内部恢复事实。
- **只实现 HTTP 或只实现 MCP**：会让人在面板与 AI 排障时观察到不同的 Run 事实。
- **offset、无界列表或按更新时间排序**：DAG Step identity 天然由稳定 `(stepKey,id)` 排序，offset 会随变化和规模放大。
- **新增 Step/timeline package**：共享纯投影没有独立 deployment、authority 或版本边界，不足以承担第 19 个 package 成本。
- **新增表或索引**：双方言现有 `StepRunRepository.listByRun` 与 `(run_id,step_key,id)` keyset 已满足查询。

## 完成门

- Runtime Core 覆盖默认/最大 page、cursor、严格 order、duplicate、状态时间不变量、低敏字段、缺失/跨 Project 与 repository failure；
- Local route、transport、admission、product-surface contract 与真实 SQLite HTTP 覆盖同一 storage authority、安全 admission、404 遮蔽和最大响应；
- Cluster route、registry 与 production composition 复用既有 runtime `runs/stepRuns`；
- MCP Tool definition、adapter、admission 与真实 SQLite MCP composition 证明只读能力且不加载 mutation authority；
- 完整源码、制品、真实 Local image 与 PostgreSQL HA 门全绿，并记录最终 package/source、artifact、module、RSS 与 Docker 证据。

## 实现与验证证据

- Runtime Core 已提供唯一 `boundedRunStepListProjection`，Local/Cluster HTTP 与 `qinglong.run.steps.list` MCP Tool 均只做协议适配。Runtime Core 476/476、Local API 27/27、Local MCP 41/41、Cluster Control 196 pass/2 环境条件 skip、Local Application 45 pass/4 平台条件 skip、Local SQLite 209/209。
- 真实 SQLite HTTP 覆盖 Bearer、Project Policy、持久审计、跨 Project 遮蔽、成对 cursor 与同一 storage authority。构造全部低敏字段上界的 64 条 StepRun 响应为 48,895 bytes，低于固定 64 KiB transport 门。
- 完整 18-package clean build/test 退出 0，backend 1,160 pass/2 skip/0 fail。workspace 为 18 package/1,026 source，其中 1,008 nested、18 个 `src/` 根文件全部是登记的 public/binary entry；package boundary 与 cluster dependency audit 均为 `compatible=true`、`findings=[]`，没有 single-source 或 shallow-source package。
- 14 个 Edge/Standalone artifact 全部 compatible。最紧 Edge/Standalone Application+AI 分别为 6,269,636/6,269,768 bytes、646 files、133 loaded modules，距 6 MiB 尚余 21,820/21,688 bytes；RSS 分别为 21,233,664/21,364,736 bytes，未放宽 D-281 门。Edge/Standalone MCP 分别为 9,878,070/9,878,178 bytes、955 files、210 modules。
- AI-excluded arm64 Local image（`sha256:8e1b1852ef101f4bb6ad900109dec7d700ece3fcf44ba7db9e958bbe3609cebc`）为 477 files/4,705,667 bytes、精确 10-package closure；同一镜像在 Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs 的 read-only、network-none 门均 graceful stop 且 SQLite integrity `ok`。
- PostgreSQL 18.4 arm64 HA 合同通过 112 gates，timeline 1→2；私有报告 SHA-256 为 `c83fb5eb49fccbb6e5a6b3bdcd8a86c9fea88e73b995624d82b9c4b71b9f0d97`，离线证据审计 `compatible=true`、`findings=[]`，测试容器、卷与网络清理后均无残留。
- 本切片只增加既有领域内的投影、route/adapter、只读 composition 与测试；没有新增 package、第三方依赖、migration、index、连接、listener、sidecar、timer、watcher、cache 或写 authority。
