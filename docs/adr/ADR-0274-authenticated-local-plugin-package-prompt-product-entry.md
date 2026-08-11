# ADR-0274：受认证的本机 Plugin Package Prompt 产品入口

- 状态：Accepted
- 日期：2026-08-04
- 关联：D-156、D-157、D-159、D-167、D-207、D-243、D-251、D-254、ADR-0260、ADR-0270、ADR-0273

## 上下文

QingLong 3.0 已有 generation-bound、content-free 的 Prompt execution plan、SQLite admission/
finalization、Model Gateway、可选 AI feature head、加密 Local Secret，以及 Project-bound durable
Provider credential binding；但这些仍只通过嵌入式 `loadProviders` 测试组合可达。部署者没有一个可以
在 Edge/Standalone 上直接执行已发布 Prompt 的受支持产品入口。

直接把 executor 暴露为 CLI 仍不安全：caller 可以伪造 publication、Policy fence、Provider→Secret
binding 或 planned time；认证与 admission 分事务还会留下 credential/RoleBinding revoke TOCTOU。
另一方面，为 Prompt 新建 daemon、HTTP listener 或 workspace package 会把空闲内存、连接、供应链与
运维成本推给低配路由器。

## 决策

1. 在既有 `@qinglong/local-owner-cli` 增加一次性 `ql3-prompt`，仅接受 deployment root 内当前 UID
   所有、mode `0600` 的私有 command file。命令固定 current strong User；inspect 需要 `run.read`，
   execute 同时需要 `run.start`、`model.invoke` 与 `secret.use`。
2. caller 只提供 Project/Package/Prompt、request/trace identity、瞬态 parameters、Provider/Model、
   有界 token/temperature/timeout 与显式输出意图。publication、installation/lock/generation/
   materialized revision/digest、requested User、Policy fence、planned/deadline time 和
   Provider credential binding 均由当前 durable authority 派生；command 禁止携带 SecretRef、token、
   authorization header、publication JSON/digest、plan、Run/StepRun/invocation ID 或 Policy fence。
3. 首次执行从 exact current active automation publication 派生 Prompt；exact replay 先读取 durable
   admission plan，再按其 publication digest 读取历史 immutable publication，因此 withdrawal/
   replacement 不会导致已完成请求再次调用 Provider。replay 必须重新通过当前 credential 与 Project
   Policy，并验证相同 caller request 的参数/Provider/Model/output digest。
4. SQLite Prompt admission 在自己的 `BEGIN IMMEDIATE` 内调用受认证 guard：重新验证 API credential、
   active Identity、pepper、active Project、latest RoleBinding 与 exact Project/Binding fence，并原子写
   allowed `prompt.execute` SecurityAudit；首次和 replay 都必须匹配同一 audit semantic。current Package/
   lifecycle/quarantine/publication/Prompt guard、Run/StepRun/Event/admission receipt 与该 audit 同事务。
5. Model Provider authority 由 deployment root 内 canonical、只读 provider/policy manifest 与
   D-254 durable binding 组合。每次请求通过 `BoundModelProviderCredentialProvider` 重新解析 binding，
   再由 `EncryptedLocalSecretService` 从同一个 SQLite authority 和本机 keyring 取得可清零 material；
   Prompt command、provider manifest、环境变量和进程参数都不得成为 credential authority。
6. 产品入口只打开一个 SQLite connection，Model Gateway、Prompt admission、publication、Policy、
   Secret 和 credential repository 共用其有界 operation authority。命令完成后先 drain gateway，再关闭
   authority；不新增 daemon、listener、Pool、timer、watcher、scheduler cadence 或后台恢复循环。
7. 默认 `live_only` 只把模型结果返回当前 CLI caller，durable SQLite 继续只保存摘要与 receipt；exact
   replay 返回 content-free receipt 且不承诺重放正文。`durable_artifact` 只有在显式 key/output product
   authority 装配后才允许，不能静默降级为明文数据库或日志。
8. 能力继续留在既有 AI/Local SQLite/Owner CLI subpath，不新增 workspace package。包是否独立由生产
   制品、权限边界、可选依赖与真实消费者决定，不能按源码文件数机械合并或继续拆分；D-255 保持
   workspace 为 19 包。

## 被拒绝的方案

- **继续要求 `loadProviders` 注入**：这是嵌入测试 seam，不是部署者可审计的 credential 产品边界。
- **command 接受 publication/plan/fence/binding**：把服务端 durable authority 外移给 caller。
- **认证后再用无 guard repository admission**：RoleBinding 或 credential 可在事务窗口内被撤销。
- **环境变量或 manifest 内 token**：扩大 Secret 泄漏面，绕过 D-254 binding/audit/revoke 语义。
- **为 Prompt 新建 package/daemon/API**：没有独立常驻价值，并增加路由器空闲 RSS 与攻击面。
- **把 `ql3-local-command-file` 等单文件包按数量机械并入 Owner CLI**：它是多个本机产品共享、零业务依赖
  的私有输入协议；合并会反向引入高权限闭包。单文件只是审计信号，不是合并结论。

## 接受门

- private command exact-shape、路径/权限/owner/symlink 边界，以及禁止 caller-supplied authority 字段；
- active AI head 前置门，non-AI Edge 不加载 Prompt 产品闭包；
- strong User 与三项 Project permission，credential/Identity/pepper/Project/RoleBinding revoke 竞态在
  admission 事务内失败且零 Provider I/O、零部分 Run/audit；
- current publication 服务端派生、withdrawal 后 exact replay、参数/Provider/Model/output drift 冲突，
  Provider 对同一完成请求恰好一次；
- durable binding→EncryptedLocalSecretService→authorization lease 全链路，Secret/token/path/
  authentication identity 不进入 command result、durable evidence或错误；
- 首次 live result、content-free replay、drain/close 次序与 Edge/Standalone 有界 RSS；
- AI、Local SQLite、Owner CLI 定向和完整 19-package/back 门，dependency/package-boundary/
  edge-import/local-image 与十档 artifact/RSS；PostgreSQL HA 仅回归基线，不虚假声明本机能力为 Cluster
  HA 新能力。

## 实施证据

- `@qinglong/local-owner-cli` 已提供 `ql3-prompt` 与受审 command subpath；首次执行从 current
  publication 派生 plan，exact replay 从 durable plan 回查 immutable historical publication。真实
  SQLite 测试证明首次只调用一次 Provider、返回 live result，replay 不再次调用 Provider且只返回
  content-free receipt。
- admission mutation guard 已进入同一 `BEGIN IMMEDIATE`：credential、active Project/latest
  RoleBinding、三项 permission 与 exact fence 在提交前重新验证，allowed SecurityAudit 与
  Run/StepRun/admission 原子提交。测试在 provider authority 装载窗口撤销 RoleBinding，结果为零
  Provider I/O、零 admission、零 Run、零 allowed audit，并留下一个低敏 failure audit。
- 生产 credential 链已通过真实 loopback OpenAI-compatible 请求验证：durable Provider binding →
  `EncryptedLocalSecretService` → private keyring → read-only canonical provider manifest；HTTP
  Authorization 使用解密 material，command/result/durable plan 均不包含 token、SecretRef 或路径。
- 定向门：AI 198 pass/3 skip、Local SQLite 192 pass、Local Application 39 pass/3 skip、Owner CLI
  100 pass；完整 19-package 门退出 0，后端 1,096 pass/2 skip/0 fail。package-boundary、cluster
  dependency、Edge import 与 local-image audit 全部 compatible。
- 十档制品门全部 compatible：最小 Edge 3,519,580 bytes/324 files，Edge Application
  4,600,461 bytes/418 files，最大 Standalone Application AI 5,918,783 bytes/475 files；非 AI
  application closure 不包含 `@qinglong/ai` 或 Prompt Owner CLI。
- PostgreSQL 18.4 arm64 HA 回归总 `gates.passed=true`，Prompt admission/finalization 的 exact
  replay、提升前复制、promotion 后存活、Policy revoke fence 与 content-free durable record 门均为
  true。隔离 HA 资源已清理；受保护 CNPG 控制面 ID、running 状态与 restart count 0 前后不变。
