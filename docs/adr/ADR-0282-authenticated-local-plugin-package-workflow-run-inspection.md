# ADR-0282：受认证的本机 Plugin Package Workflow Run 查询

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-85、D-87、D-213、D-257、ADR-0223、ADR-0224、ADR-0270、ADR-0277、ADR-0280

## 上下文

QingLong 3.0 的本机 `ql3-workflow` 产品入口已经可以列出当前 Package Workflow、启动一次
generation-bound Workflow，并请求取消已准入 Run。但是启动返回后没有面向部署 User 的 Run 查询；用户只能
直接读取 SQLite、依赖内部 repository，或把启动成功误当成执行成功。

复用通用 Run 查询并不足够：Workflow 产品面必须同时绑定 Project、Package、Workflow 与 Run，避免只凭
`runId` 读取另一个 Package/Workflow 的状态；输出也不能泄露 plan、definition digest、Task 输入输出引用、
错误摘要、Secret、Attempt 或 executor handle。查询仍然属于受认证产品操作，不能在 Project Policy precheck
后脱离 credential、Project 与最新 RoleBinding fence 读取存储。

## 决策

1. 在既有 Workflow administration 明确 subpath 中增加独立
   `PluginPackageWorkflowRunInspectionRepository`。不修改同时承载准入写入的
   `PluginPackageWorkflowAdministrationRepository`，避免把只读能力并入高影响写接口。
2. 返回固定 schema `qinglong/plugin-package-workflow-run-inspection@v1`，只包含目标身份、`found`、Run
   status/version/event sequence、创建/排队/开始/完成/取消时间、取消原因，以及全部十种 StepRun 状态的精确
   计数。禁止返回计划、定义摘要、Artifact/Secret 引用、输入输出、错误摘要、Attempt、租约或执行句柄。
3. `workflow.run.inspect` 私有 command-file 只接受 schema v1、既有部署路径配置，以及 Project、Package、
   Workflow、Run、request/audit identity。Local Admin 要求强 User，并以 `workflow.run.read`/`run.read`
   执行 Project Policy 授权。
4. SQLite adapter 在同一个 `BEGIN IMMEDIATE` 中重新验证当前 credential、active Project exact version、最新
   active RoleBinding exact version，并以一条 admission/Run join 同时匹配 Project、Package、Workflow 与
   Run。查询结果必须有且只有一个 admission，StepRun 分组计数总和必须等于 admission 的 `step_count`。
5. allowed audit 与读取在同一事务内提交；同一 event ID 只允许语义完全相同的重放。缺失 Run 或任一目标
   身份不匹配统一返回 `found=false`，不得用错误类型暴露哪个身份不匹配。
6. CLI 投影保留全部十种状态的零值，使路由器上的 shell/JQ 用户不需要推断缺失字段；CLI 不回显内部 schema
   digest、数据库路径、认证标识或安全 fence。
7. 本能力不新增 workspace package、生产 dependency、migration、表、连接、timer、listener、watcher、
   HTTP route 或 Cluster authority。Cluster 继续使用已有受认证通用 Run route，是否增加同构 Package-bound
   产品路由另行决策。

## 被拒绝的方案

- **让用户直接查询 SQLite**：绕过 credential、Project Policy、RoleBinding fence 与低敏输出 contract。
- **仅按 `runId` 查询通用 Run**：无法证明 Run 属于请求中的 Package 与 Workflow。
- **把查询方法加入既有写管理接口**：扩大高影响接口的实现与消费者，不符合 capability-oriented 端口边界。
- **只返回非零 StepRun 状态**：调用方需要猜测完整状态枚举，协议升级时容易把未知状态误判为零。
- **返回 plan、Task、Attempt 或错误详情方便排障**：把运维查询升级成内容/执行 authority，扩大泄露面。
- **为一个查询再建 workspace package**：没有新的部署、依赖、平台或故障域边界，只会增加 importer 成本。

## 接受证据

- Runtime Core contract 测试覆盖 allowed audit/fence/target 绑定、完整低敏投影、missing target、未知字段、
  StepRun 总数漂移和取消事实漂移。
- 真实 Owner CLI 产品测试在迁移后的 Edge SQLite 上完成 Workflow inspect→start→Run inspect→exact replay→
  cross-target `found=false`→cancel，并证明 viewer 的 `run.read` 可查询但 `run.stop` 仍被拒绝。
- 产品输出断言不包含 `planDigest`、`definitionDigest`、`inputRef` 或 `errorSummary`；同一查询审计重放不增加
  audit 行，cross-target 查询仍记录独立的 allowed `workflow.run.read` 审计。
- Runtime Core 439/439、Local SQLite 192/192、Local Admin 83/83、Local Owner CLI 101/101 与
  Workflow 产品纵切面 3/3 全部通过；完整 19-package clean build/test 门退出 0。后端总门为 1,110 tests、
  1,108 pass/2 skip/0 fail；Edge import、cluster dependency、package boundary、cluster deployment、
  worker deployment 与 local image 六项审计全部 compatible，workspace 仍为 19 个 package。
- 十档本机制品的 package/file/module closure 不变且全部 compatible；最大 Standalone Application AI 为
  5,989,074 bytes，距 6 MiB 仍有 302,382 bytes，RSS 低于分档预算。相对上一批增加 18,710 bytes，来源为
  已有 runtime-core/local-sqlite/local-admin 中的显式只读契约与实现，不包含 Owner CLI package。
- PostgreSQL 18.4 arm64 physical-streaming HA `gates.passed=true`：timeline 1→2、旧主先 fencing、
  `pg_rewind` 只读同步 rejoin、两个 fresh control replica 与全部既有业务门全绿；执行后 `ql3-ha-*`
  container/network/volume 零残留。
- 格式门覆盖全部修改代码和文档。刷新后 GitNexus 为 42,629 nodes/96,784 edges/1,672 clusters/261 flows；
  新 inspection interface、两个 normalizer、SQLite repository、Local Admin factory 与 Owner CLI runner 均为
  LOW、0 affected process，最大 runner 为 1 direct/3 total。`detect_changes` all 与 compare `develop`
  分别为 12 files/31 symbols、14/34，均 low/0 affected process；QL3 孵化树仍未 stage，因此新增文件风险
  以刷新后逐符号 impact 为准。

## 后续边界

- 增加 Run 事件时间线、Step 详情或失败诊断前必须单独定义分页、脱敏、Artifact 权限与审计协议，不能扩宽
  本 schema。
- Cluster 若增加 Package-bound Run inspection，必须在 PostgreSQL transaction 内绑定 immutable Workflow
  admission，不能只在 route 层拼接通用 Run 结果。
- UI 可以消费该低敏 schema，但 UI、WebSocket 推送、轮询 cadence 与通知机制不由本 ADR 自动授权。
- 联网 production dependency vulnerability audit 仍因依赖元数据外发权限未获批准而不重跑。
