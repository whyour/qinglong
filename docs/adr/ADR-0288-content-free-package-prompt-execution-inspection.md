# ADR-0288：按调用方 Request ID 精确读取 Content-free Package Prompt 执行状态

- 状态：Accepted
- 日期：2026-08-08
- 关联：D-85、D-87、D-156、D-157、D-213、D-244、D-257、ADR-0260、ADR-0261、ADR-0263、ADR-0267、ADR-0274、ADR-0275、ADR-0276、ADR-0287

## 上下文

QingLong 3.0 的 Package Prompt execution 已以调用方提供的 `requestId` 原子准入并持久化 Run、StepRun、
ModelInvocation 与 finalization。成功响应丢失、客户端超时或 409 不确定结果时，调用方虽然仍持有原
`requestId`，却只能重发执行请求；existing 响应为避免泄漏与重复传输不会返回正文，也没有独立只读入口确认
执行是否已准入、正在运行或已经结束。

复用通用 Run 查询要求调用方先知道服务端生成的 `runId`；复用 Prompt output read 又要求 Artifact identity，
而且会取得加密输出 authority。新增按 Package 或 Prompt 扫描的历史列表则需要独立索引、分页、可见性和枚举
策略。恢复一个已知请求不应让路由设备增加表、索引、缓存、后台扫描、Provider 或 Secret 成本。

## 决策

1. 新增共享 schema `qinglong/plugin-package-prompt-execution-inspection@v1`。调用目标固定为
   `projectId/packageName/promptId/executionRequestId`；其中 `executionRequestId` 是原 Prompt execute 的
   caller-known `requestId`，不是服务端 Run ID。
2. 成功结果只允许返回 `invocationId/runId/stepRunId`、Run status/version/eventSequence、StepRun
   status/version，以及 admitted/started/finished/finalized 时间。Prompt template、参数、输入、输出、错误正文、
   Provider、Model、usage、价格、digest、SecretRef、ArtifactRef、credential 和内部审计字段一律排除。
3. Local 在既有 `ql3-prompt` command-file schema v1 增加 `prompt.execution.inspect`。产品权限固定为
   `run.read`，allowed audit operation 固定为 `prompt.execution.read`。同一 command-file 重放复用同一 audit
   event 并返回完全相同结果；查询不激活 AI feature，不加载 Provider、Secret、Gateway 或网络 authority。
4. Cluster 显式 AI composition 增加
   `GET /api/v3/projects/{projectId}/packages/{packageName}/prompts/{promptId}/executions/{executionRequestId}`。
   operation 为 `prompt.execution.read`，permission 为 `run.read`；默认 AI-free cluster-control 不注册该路由。
5. SQLite 在同一 `BEGIN IMMEDIATE`、PostgreSQL 在同一 serializable read-write transaction 中重新确认
   credential、主体、active Project exact version 与 latest active RoleBinding exact version，再完成精确查询和
   allowed audit。授权 fence 漂移必须回滚查询审计并返回 conflict。
6. PostgreSQL 使用现有 `model_invocation_prompt_admissions.request_id` 主键，精确 join Run、StepRun 与可选
   finalization，固定 `LIMIT 2`；SQLite 使用对应本机主键和相同绑定。零行或 cross-target 均返回 `found=false`，
   Cluster 统一映射为 404，避免 Package/Prompt/Request 枚举差异。
7. 本增量不新增 workspace package、生产 dependency、migration、表、索引、Pool、端口、listener、timer、
   watcher、cache、队列、状态机或部署单元。Local 仍按一次短命令付费；Cluster 复用显式 AI 进程已有 Pool。
8. v1 只解决调用方已知 request 的单条恢复。Prompt execution history、按状态筛选、分页、output reference recovery
   和跨 Package 搜索必须分别定义索引、权限和内容边界，不得扩宽本 schema。

## 被拒绝的方案

- **只要求调用者重发 Prompt execute**：能防止重复 Provider 调用，但 existing 响应不能确认最终状态，也会把只读
  恢复错误地绑定到 Provider/Secret authority。
- **要求调用者保存 `runId`**：首次响应丢失时调用者没有服务端 Run identity，无法恢复。
- **直接复用通用 Run route**：没有同时绑定 Package、Prompt 与 execution request，且扩大枚举面。
- **从 Prompt output API 推断执行状态**：`live_only` 没有 Artifact，失败和 running 也不能由输出存在性表达。
- **新增 execution projection 表或 requestId 索引**：admission 主键已经提供精确定位，额外持久化会制造双写与迁移
  成本。
- **把查询放入新 workspace package**：没有独立部署、依赖、权限或故障域价值，会回退到细碎 package。
- **返回 plan/finalization receipt 或 digest**：这些是内部完整性事实，不是恢复执行状态所需的产品信息。

## 当前证据

- `@qinglong/ai` 207 tests：204 pass、3 条外部 PostgreSQL 条件 skip；共享 contract、SQLite repository 与
  PostgreSQL repository 定向 3/3。结果 exact-key normalization 拒绝额外 private 字段，PostgreSQL 查询固定
  `LIMIT 2` 并在同一 serializable transaction append audit。
- `@qinglong/cluster-control` 183 tests：181 pass、2 条外部服务条件 skip；route/composition 定向 16/16，覆盖精确
  读取、GET body 拒绝、404 cross-target 遮蔽、409 fence conflict、AI-only composition 与 production route
  registry。route 使用 Cluster 内部窄 capability port，默认 control source 不直接导入 AI contract；dependency
  audit 没有为新入口放宽白名单。
- `@qinglong/local-owner-cli` 103/103；一次真实 Prompt execution 后按原 request ID 两次读取得到相同结果，
  Provider 只加载一次，inspection 不含私有输入、输出或 digest，allowed audit 精确一条。
- 完整 19-package clean build/test 全绿；backend 1,110 tests 为 1,108 pass、2 条条件 skip、0 fail。Edge import、
  Cluster dependency、package boundary、Cluster deployment、CloudNativePG 与 local image 六项审计均 compatible；
  workspace 仍为 19 包、`singleSourcePackages=[]`，AI 新增的三个文件全部位于既有 `prompt/` domain，根层保持
  4-file hard cap。
- 十档 Local artifact/RSS 门全部 compatible。最小 Edge 为 3,614,826 bytes，最大 Standalone Application AI 为
  6,083,370 bytes，距 6 MiB 上限仍有 208,086 bytes；实测最大 RSS 增量 21,463,040 bytes，低于对应 24 MiB
  预算。
- PostgreSQL 18.4 arm64 physical-streaming HA 已实跑通过：primary 原子读取/allowed audit、standby WAL replay、
  promoted primary runtime-role 再读取、cross-target 遮蔽与 content-free gate 全为 true。evidence helper 使用
  runtime data pool 与独立 audit verification pool，未给 `ql3_runtime` 增加 audit SELECT 权限。timeline 1→2、
  旧主 fencing/rewind/read-only synchronous rejoin、两套 fresh control replica、`gates.passed=true` 与最终
  `ql3-ha-*` 零残留全绿。
- 最终 GitNexus 索引为 43,007 nodes/97,903 edges/1,685 clusters/265 flows。12 个 repository、route、composition、
  CLI 与 HA 关键符号均为 LOW；两个共享 normalization 函数因同时约束 SQLite/PostgreSQL repository 和 Local CLI
  `run` 流被评为 HIGH（各 2 direct/3 total/1 process），已按跨存储公共协议用双方言、产品入口与 exact-key
  正反向测试覆盖，后续修改必须重新执行 HIGH-risk 评审。`detect_changes` all/compare `develop` 分别为
  12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 孵化树大部分仍 untracked，因此该统计不替代本次
  逐符号 impact、完整测试、制品与真实 HA 证据。

## 接受条件

1. `@qinglong/ai`、`@qinglong/local-owner-cli`、`@qinglong/cluster-control` 定向与完整测试全绿；完整 19-package
   clean build/test、backend、六项 package/deployment/image audit 与十档 artifact/RSS 门无回归。
2. PostgreSQL 18.4 arm64 physical-streaming HA 必须证明 primary repository 查询与 allowed audit 原子提交、standby
   精确 WAL replay、promoted primary 使用 runtime role 再查询成功、cross-target 始终遮蔽、响应与审计不含私有正文；
   timeline 1→2、旧主 fencing、`pg_rewind` 同步 rejoin、fresh replicas 和 `ql3-ha-*` 零残留继续全绿。
3. 刷新 GitNexus 后关键修改保持受审影响范围，并运行 `detect_changes` all/compare `develop`。

## 后续边界

- 调用方应持久化自己的 `executionRequestId`；该 ID 是幂等与恢复键，不是秘密，也不能替代授权。
- UI 可以在 execute 超时后轮询这一精确入口，但轮询 cadence、退避和终止预算属于客户端策略，服务端不新增 timer
  或隐藏队列。
- 若要找回 durable output，必须通过独立、授权的 Artifact reference recovery contract；本结果不能加入 outputRef。
