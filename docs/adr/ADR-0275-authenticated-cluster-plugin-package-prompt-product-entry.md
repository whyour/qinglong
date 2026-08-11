# ADR-0275：受认证的 Cluster Plugin Package Prompt 产品入口

- 状态：Accepted
- 日期：2026-08-04
- 关联：D-157、D-207、D-243、D-252、D-255、ADR-0260、ADR-0261、ADR-0271、ADR-0274

## 上下文

Cluster AI composition 已能显式挂载 Prompt execution route、PostgreSQL admission/finalization、
Model Gateway、projected Secret 和可选加密输出；但现有 v1 transport 仍要求 caller 提供
`publicationDigest`，并把 API admission 得到的 Subject/Policy fence 带入 AI repository。Prompt
admission snapshot 会复验 publication 与 RoleBinding fence，却没有在同一 SERIALIZABLE transaction
重新锁定 API credential、完整 `run.start + model.invoke + secret.use` 语义和 allowed SecurityAudit。

这意味着 route 已“认证”，但尚未成为完整产品 authority：caller 仍选择 generation，credential 可在
HTTP authorization 与 Run commit 之间撤销，transport allowed audit 与产生外部模型费用的 admission
不是同一个提交事实。另建 Prompt service、listener 或 Pool 会增加集群运维面，也会诱导本机 Profile
复用错误依赖。

## 决策

1. 保留既有 AI-enabled `cluster-control` process、TLS listener、authentication shield、route registry 和
   AI PostgreSQL Pool；不新增 package、service、port、Pool、table、timer、watcher 或 scheduler。
   AI migration stream 只追加 `pg-9017`，建立 runtime-only 的窄 SECURITY DEFINER admission
   authorization function，不授予 runtime 对 credential、Identity、Project、RoleBinding 或 audit 表的
   直接读写权。默认 control image/entrypoint 继续不加载 AI，Edge/Standalone closure 零变化。
2. Prompt execution transport 升级为 server-derived request：body 只允许 request/trace、parameters、
   provider/model、token/temperature/timeout 与显式 output intent；禁止 publication/generation/digest、
   Subject、Policy fence、credential identity、planned/deadline、Run/StepRun/invocation identity。
3. 首次请求由 PostgreSQL current automation head 派生 exact publication；exact replay 必须先按 durable
   request plan 找到 immutable historical publication，再验证 caller request digest。Package 后续
   upgrade/withdraw/quarantine 不会让已完成请求再次调用 Provider，也不能把旧 plan 用于新 request。
4. Route 仍先经过共享 bearer authentication、overload shield 和 Project Policy；AI admission 事务再以
   `authenticationId` 解析 exact API credential version，取得 credential/Identity advisory lock，验证
   credential/Identity active 与数据库时钟有效期，再锁定 active Project/latest RoleBinding exact fence。
5. admission 事务必须用共享 Project Policy 角色语义确认 `run.start`、`model.invoke`、`secret.use` 均为
   allow；Agent 的 `require_approval` 不得在此被降级为 allow。新 admission 在同一 SERIALIZABLE
   transaction 原子写 allowed `prompt.execute` SecurityAudit、Run、StepRun、Events 和 admission receipt；
   credential/RoleBinding/permission/audit 任一失败时零 Provider I/O 和零部分 Run。
6. exact replay 仍重新验证 current credential、Identity、Project/RoleBinding 与三权限，但不重复写
   allowed audit、不重新执行 current Package start guard、不再次调用 Provider。replay 只返回既有
   content-free receipt；live result 只返回第一次仍连接的 caller。
7. Provider authority 保持 projected read-only manifest + durable Provider binding + projected Secret
   material；route/body/env 不成为 credential authority。`durable_artifact` 只有在 ADR-0261 output
   keyring/read/retention authority 已显式装配时可达，`live_only` 不把正文写入 PostgreSQL、audit 或日志。
8. 该切片复用 `@qinglong/ai` 与 `@qinglong/cluster-control` 既有 subpath。包边界继续按部署制品、
   权限域、可选依赖和消费者裁决；workspace 保持 19 包，不能因本次多出 guard/adapter 文件拆新包。

## 被拒绝的方案

- **继续让 caller 提供 publication digest**：把 current generation 选择权留在 transport，并使 replay
  与首次执行无法采用同一 durable-plan-first 规则。
- **只依赖 admission pipeline 的一次 `model.invoke`**：不能关闭 credential revoke TOCTOU，也没有
  与 Run commit 原子的 allowed audit；三权限当前碰巧落在同一角色集合也不能替代显式契约。
- **先提交 Run，再异步补 audit 或 credential check**：会产生无当前授权或无审计的外部费用。
- **为 Prompt 建独立 API/AI service 或第二 Pool**：增加端口、证书、连接预算和故障域，没有新的
  deployment authority 价值。
- **把 Cluster Prompt 入口复用 Local `ql3-prompt`**：POSIX UID/command-file proof 不能替代多副本
  bearer identity、PostgreSQL fencing 与 HA durability。

## 接受门

- v2 exact body 拒绝 caller-supplied publication/identity/fence/credential/clock/Run 字段；
- current publication server derivation、historical exact replay、request drift conflict 和 Provider
  exactly-once；
- credential/Identity/Project/RoleBinding revoke race 与三权限/Agent approval 在 admission transaction
  内失败，零 Provider I/O、零 Run、零 allowed mutation audit；
- allowed audit 与 admission 原子提交，COMMIT response loss 以同 request 收敛且不重复计费；
- projected Provider binding/Secret、live-only redaction、durable output explicit gate；
- Cluster Control、AI、PostgreSQL 真库与完整 package/back/dependency 门；
- PostgreSQL 18.4 physical HA 证明 admission/audit 在 promotion 前同步复制、promotion 后 exact replay、
  credential/RoleBinding fence 和 content-free facts 均保持；
- Edge/Standalone 十档 artifact closure 与 workspace 19 包不增长。

## 实施证据

- Cluster Prompt route 已升级为 v2 exact body；publication digest、Principal、Policy fence、credential、
  server clock 与 Run identity 均不能由 caller 提供。route 使用进程内 UUID v4 factory 生成 mutation
  audit identity，并复用现有 authentication shield、route registry、AI composition 与 PostgreSQL Pool。
- `PostgresPluginPackagePromptExecutionService` 首次请求从 current automation publication head 派生
  publication；exact replay 先读取 immutable admission plan，再解析历史 publication。admission
  repository 的 guard 在同一 SERIALIZABLE transaction 中执行，首次写入 Run facts 前和 exact replay
  返回前都重新验证 current authority。
- `pg-9017-ai-plugin-package-prompt-product-authorization` 建立仅授予 `ql3_runtime` EXECUTE 的
  SECURITY DEFINER function；函数以数据库时钟和 advisory/row locks 验证 exact API credential
  version、active Identity、Project 与 latest RoleBinding fence，拒绝 Agent approval 语义，并在首次
  admission 同事务插入一条 content-free `prompt.execute` allowed audit。readiness 同时冻结 migration
  history、runtime role、snapshot function 与 authorization function 的精确权限。
- 定向与完整门：AI 199 pass/3 条件 skip、Cluster Control 175 pass/2 条件 skip；完整 19-package 门
  退出 0，后端 1,096 pass/2 条件 skip/0 fail。cluster dependency、Edge import、package boundary 与
  local-image audit 全部 compatible，workspace 保持 19。
- 十档 Edge/Standalone artifact closure 全部 compatible：最小 Edge 3,519,580 bytes/324 files，Edge
  Application 4,600,461 bytes/418 files，最大 Standalone Application AI 5,930,722 bytes/475 files；
  非 AI closure 不加载 AI/Cluster Prompt 产品面。
- PostgreSQL 18.4 arm64 physical HA 报告最终 `gates.passed=true`。首次 Cluster Prompt 请求只有 1 条
  allowed audit，exact replay 未重复写；RoleBinding 撤销后的新 request 为 0 条 allowed audit且零
  Provider 重打。audit/admission/finalization/content-free facts 在 promotion 前同步复制，timeline 1→2
  后完全一致；旧主 fenced、rewind 后只读重入，两控制副本恢复。隔离 HA 资源零残留，既有 CNPG
  evidence control-plane ID 未变、running、restart count 0。
