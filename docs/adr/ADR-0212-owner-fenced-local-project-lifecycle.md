# ADR-0212：Owner 围栏化 Local Project 生命周期

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-198、D-201、D-202
- 关联 ADR：ADR-0028、ADR-0074、ADR-0086、ADR-0185、ADR-0207、
  ADR-0208、ADR-0211

## 背景

ADR-0208 让既有 Project 的 RoleBinding 有了强认证产品入口，但 Project 本身仍只能
通过迁移、测试 fixture 或直接 SQL 建立。部署者无法用受支持方式：

- 创建第二个业务 Project；
- 原子建立首个可接管 Owner；
- 暂停一个 Project 的全部业务授权；
- 在保留历史、RoleBinding 和资源的前提下恢复 Project。

Project lifecycle 是实例级管理动作，不应由任意 secondary Project Owner 执行。
如果创建 Project 与创建首 Owner 分成两个事务，进程在中间崩溃会留下无人可管理的
active Project。若直接覆盖 Project 行，又会失去响应丢失重放和审计事实。

## 决策

### 1. 扩展既有 `ql3-policy`，不新增 workspace package

继续使用以下既有边界：

- `@qinglong/runtime-core/local-project-policy-administration`：命令、结果和错误契约；
- `@qinglong/local-sqlite/project-policy-administration`：最终事务 authority；
- `@qinglong/local-admin/project-policy-administration`：强认证 Owner 服务；
- `@qinglong/local-owner-cli/project-policy-command`：私有 command file 与低敏输出；
- `ql3-policy`：一次命令、一次进程的产品 binary。

新增三个 operation：

- `policy.project.create`；
- `policy.project.archive`；
- `policy.project.restore`。

workspace 仍为 22 个 package。该领域与 RoleBinding 共享认证、Policy、SQLite
authority、CLI 和部署消费者，不满足 ADR-0185 的新交付/进程/依赖隔离条件；把它
拆成单文件 package 只会增加 importer、lockfile 和供应链维护成本。

### 2. 只有实例 authority Project 的当前强认证 Owner 可以变更生命周期

command 同时携带 `authorityProjectId` 和目标 `projectId`。服务层先要求调用者在
authority Project 上通过 Owner-only `project.manage`。SQLite 在 `BEGIN IMMEDIATE`
取得写锁后再次复验：

1. authenticated credential、Identity、有效期、pepper binding/catalog/material；
2. ADR-0211 的实例 authority anchor；
3. authority Project active/version；
4. actor 最新 RoleBinding version/state/owner role。

secondary Project Owner 即使能通过自己 Project 的 policy，也会在最终 authority
anchor 检查失败关闭。直接调用 repository 不能绕过。

### 3. Project create 与首 Owner、审计、mutation ledger 原子提交

`policy.project.create` 要求：

- `expectedCurrentVersion = 0`；
- 唯一且规范的 Project ID、name、slug；
- UUIDv4 mutation 和独立 failure-audit UUID；
- Profile 容量仍有余量。

同一事务插入：

1. version 1、active 的 Project；
2. actor 自身 version 1、active/owner 的 RoleBinding；
3. allowed security audit；
4. immutable Project administration mutation。

任一步失败全部回滚。成功输出只含 Project ID、name、slug、status、version 和
`inserted|existing`。

### 4. archive/restore 是版本化状态转换，不删除历史

- archive：`active@N → archived@(N+1)`；
- restore：`archived@N → active@(N+1)`；
- 两者都使用 expected-version CAS；
- authority Project 禁止 archive；
- archived Project 由现有 Project Policy 默认拒绝业务权限；
- RoleBinding、Task、Run、Secret、Package 和审计历史不删除；
- restore 后沿用既有 RoleBinding，重新进入正常 Policy 判定。

本切片不提供 hard delete。需要资源清理时必须另建引用感知、可恢复的 retention
协议，不能把 archive 冒充删除。

### 5. mutation ledger 提供精确响应丢失重放

SQLite v37 新增 `QingLong3ProjectAdministrationMutations`，冻结 operation、
authority Project、目标 Project 快照、前后版本、actor、首 Owner version、audit 和
时间。相同 mutation 且语义完全一致返回 `existing`；相同 mutation 用于不同操作、
Project、metadata、版本、actor 或 audit 时返回 mutation conflict。

Project 当前行是可变 head；mutation ledger 是不可变历史，两者不能合并成同一事实。

### 6. Profile 容量是硬上限

- Edge：最多 16 个 Project；
- Standalone：最多 128 个 Project。

容量在最终写事务内计数，达到上限时不写 Project、Owner、allowed audit 或 mutation。
archive 不释放名额，因为对象和引用仍然存在。容量仅影响人工管理命令，不增加
daemon、timer、watcher、listener、缓存或空闲写入。

## 不采用方案

### 为 Project lifecycle 新建 package

拒绝。它与 RoleBinding 共用同一产品、authority 和交付闭包，没有独立消费者或进程
权限，违反 ADR-0185 的 package budget。

### 允许任意 Project Owner 创建其他 Project

拒绝。Project-scoped RBAC 不能隐式授予实例拓扑 authority，否则 secondary Owner
可无限扩展实例作用域。

### 先创建 Project，再单独授予 Owner

拒绝。崩溃窗口会留下 active 但无人可管理的 Project。

### archive 时删除 RoleBinding 或业务数据

拒绝。删除会破坏审计、历史 Run 可解释性和可恢复性，也无法安全判断所有引用。

### 只更新 Project 当前行，不保存 mutation ledger

拒绝。COMMIT response loss 后无法区分未执行、已执行和被其他命令覆盖。

## 影响

正向影响：

- 本机部署首次具备受支持的多 Project 创建、暂停和恢复路径；
- 创建后立即存在可登录、可交接的 Owner；
- archived Project 自动复用既有默认拒绝 Policy；
- secondary Project Owner 与 direct repository caller 均不能扩大实例拓扑；
- Edge/Standalone 资源上限明确，空闲成本为零；
- workspace 保持 22 包，没有新增第三方依赖。

代价与限制：

- Local SQLite contract 从 v36 提升到 v37，镜像和 rollout 写契约必须同步升级；
- Project list/inspect 由 ADR-0213 补齐；当前仍没有 rename、authority transfer 或
  hard-delete 产品命令；
- authority Project 无法 archive；恢复该根对象需要未来独立 break-glass ceremony；
- Cluster 仍使用 PostgreSQL/RBAC 管理面，不能复用本机 command file。

## 验证

- GitNexus 对共享 SQLite readiness 入口评估为 CRITICAL：15 个直接调用者、35 个上游
  符号；v37 必须跑迁移、冷启动、rollout 和既有安全回归；
- `ql3-policy` 真实 SQLite/CLI 10/10：
  - create/exact replay；
  - 首 Owner、audit、mutation 原子事实；
  - archive 后业务 policy 拒绝、restore 后恢复；
  - mutation drift、ID/slug 冲突；
  - authority Project archive 拒绝；
  - secondary Project Owner 越权拒绝；
  - Edge 第 17 个 Project 在零部分写入下拒绝；
  - 既有 RoleBinding、防锁死和 credential fence 回归；
- SQLite database 13/13、rollout safety 7/7、Identity/Credential 聚焦 4/4；
- local-admin 与 local-owner-cli strict TypeScript 通过；
- Local image/OCI labels、CI image contract 和 deployment evidence 必须固定为 v37；
- 完整 workspace、制品/RSS 和 PostgreSQL HA 门在锁定依赖恢复后重跑。
