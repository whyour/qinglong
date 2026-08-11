# ADR-0273：本机 AI Provider Credential 产品 Authority

- 状态：Accepted
- 日期：2026-08-04
- 关联：D-156、D-159、D-166、D-167、D-207、D-243、D-254、ADR-0169、ADR-0177

## 上下文

QingLong 3.0 已有 Project-bound Provider credential contract、可清零 Secret material、Cluster
PostgreSQL catalog，以及完整 Prompt executor；但 Edge/Standalone 仍没有耐久的 Provider→SecretRef
binding、credential-use audit 或受支持管理命令。`ql3-local-app` 的 installed AI 只能由嵌入方注入
provider loader，通用产品入口继续失败关闭。因此直接开放 Prompt CLI/HTTP 会迫使用户把 token 放进
配置、请求或进程环境，或者用测试内存 adapter 冒充生产 authority。

这个缺口不能通过新建 package、常驻管理 daemon 或把 AI migration 塞进所有路由器数据库来解决。
非 AI Edge 必须继续不安装、不加载、不迁移该能力；只有显式安装并激活 AI 的部署承担成本。

## 决策

1. 在既有 `@qinglong/ai` optional migration stream 增加 SQLite `9013`，持久化 immutable
   Provider credential binding、append-only transition 和 content-free use audit。它不进入 QL3 base
   migration/capability，也不改变非 AI Profile 的表集合。
2. 新的 Local repository 留在 `@qinglong/ai/local-model-provider-credential-storage`，实现既有
   catalog、administration、binding-source 与 credential-audit port；不让 `local-sqlite` 依赖 AI，也不
   新建 workspace package。current state 由 `(Project, provider, generation)` append-only transition
   推导，不维护可漂移的第二 head。
3. bind/revoke 必须由当前 strong User 通过 `secret.manage` Policy；同一个 SQLite `BEGIN IMMEDIATE`
   内重新验证 credential/Identity/pepper、active Project 与 latest RoleBinding fence，检查目标
   SecretRef 属于 Project 且 exact pinned/current envelope 存在，然后原子写 binding、transition 与
   allowed security audit。相同 mutation exact replay；命令、audit、actor、fence 或 Secret 事实漂移
   冲突并回滚。
4. 既有 `local-owner-cli` 增加短生命周期 `ql3-model-credential`，只从 deployment root 内当前 UID
   private `0600` command file 接受 `model-credential.bind|revoke|inspect`。inspect 同样在事务内复验
   authority、读取 current transition、写独立 allowed audit；不存在返回 absent，不形成枚举 oracle。
5. 产品输出只包含 Project/provider/generation/state、binding revision/digest 与 transition time/digest；
   禁止输出 SecretRef、Secret name/version、envelope/key/token、authentication ID、数据库路径或原始错误。
6. credential-use audit 固定 operation/Project/provider/request、binding revision/digest 与时间，不保存
   SecretRef 或模型内容；相同 identity 的 exact replay允许，语义漂移失败关闭。每次 provider 请求仍
   重新读取 current binding 和 Secret material，不增加 cache、watcher 或 timer。
7. 本切片只建立本机 provider authority，不提前声称 Prompt 产品入口完成。下一切片必须从这个 durable
   catalog、EncryptedLocalSecretService 与 active AI head 组合 `ql3-prompt`，不得接受 caller-supplied
   binding/publication/Policy fence。

## 被拒绝的方案

- **token 放环境变量或 Prompt command**：无法按 Project 隔离，容易进入日志、诊断和进程快照。
- **把 binding 写入 provider URL/policy manifest**：配置文件会成为无审计 mutation authority，无法
  对 COMMIT response loss 或 revoke 收敛。
- **让 `local-sqlite` 依赖 `@qinglong/ai`**：会把 optional AI 反向带入最小路由器 storage closure。
- **新建 provider-credential package**：没有独立制品或进程价值，违反 19-package 收敛账本。
- **常驻管理 API/watcher**：增加低配设备空闲 RSS、文件描述符和攻击面；短生命周期 CLI 已足够。
- **先开放 Prompt，再补 credential authority**：会把测试 adapter 或静态 token 固化为产品安全边界。

## 接受门

- SQLite 9013 migration/history/readiness 和 fresh/upgrade/partial-schema 失败关闭；
- bind→inspect→rebind→revoke、并发 CAS、exact replay、response-loss convergence；
- non-Owner/无 `secret.manage`、credential/Project/RoleBinding/Secret race 均零部分写入；
- command/output exact-shape 与 SecretRef/token/path/error 脱敏；
- AI、Owner CLI、Local application targeted tests，完整 19-package/back 门；
- dependency/package-boundary/edge-import/local-image 与十档 artifact/RSS 门证明非 AI 路由器零增量；
- PostgreSQL HA 基线保持通过；本机 optional-only 变更不冒充新的 Cluster HA 能力。

## 实施证据

- `@qinglong/ai` 的独立 SQLite AI migration stream 已加入
  `9013-ai-model-provider-credential-catalog`；migration plan digest 为
  `2720c6e45f82adbb03641d1c19e8ff7e1875a763a0b53d4910a46ca308800aa0`。
  三张表只在显式 AI migration/activation 后存在，不进入本机 base schema。
- `LocalModelProviderCredentialRepository` 已实现 immutable binding、append-only transition、
  current-state 推导、Secret envelope 复验、事务内 authorization guard 和 content-free use audit；
  bind/replay、missing Secret、stale CAS、授权重放、inspect、revoke 后使用拒绝均有真实 SQLite 门。
- `ql3-model-credential` 已提供 private command-file-only 的 bind/revoke/inspect。真实 Edge fixture
  已通过 bind→exact replay→inspect→独立 CLI process→revoke；未激活 AI 在认证前失败关闭，无
  `secret.manage` 的 strong User 零 transition。输出不含 SecretRef、token、credential/path 或
  authentication identity。
- 定向完整包门：AI 198 pass/3 条件 skip、Owner CLI 96 pass、Local SQLite 192 pass；完整
  19-package 门退出 0，后端 1,096 pass/2 条件 skip/0 fail。dependency/package-boundary/
  edge-import/local-image audit 全绿，workspace 仍为 19 包。
- 十档本机制品均 `compatible=true`。最小 Edge 为 3,518,660 bytes/324 files/
  10,813,440 bytes RSS；最大 Standalone Application AI 为 5,917,156 bytes/475 files/
  20,480,000 bytes RSS。非 AI Edge 的 package closure 不含 `@qinglong/ai`。
- PostgreSQL 18.4 arm64 physical HA 基线 `gates.passed=true`，完成 `remote_apply`、timeline
  1→2、旧主 fencing、`pg_rewind` read-only 重入与同步复制恢复；本切片没有新增 PostgreSQL
  migration、role、Pool、listener 或 Cluster authority。受保护 CloudNativePG 证据控制面前后保持
  同一 container ID、restart count 0、running。
