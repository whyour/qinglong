# ADR-0209：Owner 围栏化 Local Identity/Credential 管理与私有交付

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-197、D-198、D-199
- 关联 ADR：ADR-0074、ADR-0075、ADR-0077、ADR-0086、ADR-0185、
  ADR-0193、ADR-0207、ADR-0208

## 背景

ADR-0208 已允许 Owner 管理既有 Identity 的 Project RoleBinding，但目标 Identity
和 API credential 仍主要由首 Owner bootstrap/recovery ceremony 创建。部署者缺少
一个受支持的产品入口来：

- 注册、启用或禁用 User/API App/MCP Client/Agent Identity；
- 为这些 Identity 签发、轮换或撤销 API credential；
- 在 CLI 返回丢失、进程崩溃或数据库已经提交时安全重放；
- 不经 stdout、argv、普通 audit 或数据库明文列交付新 token。

直接复用 cluster-admin 的“一次响应返回 token”协议不适合本机产品。数据库提交后
若响应丢失，重放只能看到 mutation 已存在，却无法恢复原 secret；重新生成 secret
又会与已提交 digest 冲突。

## 决策

### 1. 保持 22 个 package，不按文件数拆包或合包

本能力使用现有边界：

- `@qinglong/runtime-core/local-identity-credential-administration`：原子 repository
  contract、delivery acknowledgement 与低敏错误；
- `@qinglong/local-sqlite/identity-credential-administration`：一次命令、一个连接的
  SQLite composition；
- `@qinglong/local-admin/identity-credential-administration`：Owner-only Policy
  service；
- `@qinglong/local-owner-console/credential-administration-delivery`：私有 staged
  delivery；
- `@qinglong/local-owner-cli/identity-credential-command` 与 `ql3-identity`：
  private command-file 产品入口。

不新增第 23 个 package。`local-owner-console` 已是短生命周期、本机敏感交付边界；
交付实现放在其精确 subpath。`local-admin` 与 `local-sqlite` 分别保留领域授权和
事务存储责任。不能因为其中某个实现当前只有一个文件，就把高权限代码合并进常驻
application/Profile。

### 2. v1 操作与输出

`ql3-identity` 只接受 current UID、`0600`、bounded private command file，开放：

- `identity.register|enable|disable`；
- `credential.issue|rotate|revoke`；
- `credential.delivery.acknowledge`。

每个 mutation 使用 expected-current-version CAS、UUIDv4 mutation ID、request ID
和独立 failure-audit UUID。签发/轮换请求传入稳定 `lifetimeMs`，而不是把 secret、
token 或 pepper 放入 command。

成功输出只含 Project、target、version/state、`inserted|existing`，以及签发/轮换
时的 ready file name 和 delivery digest。输出不得包含 token、secret、pepper、
数据库路径或交付目录绝对路径。

### 3. 只有当前强认证 Owner 可以管理 Identity/Credential

CLI 复用 Owner credential presentation、pepper provenance 与 POSIX proof 生成
`local_console` User Principal。服务固定请求 Owner-only `project.manage`：

- admin/operator/viewer 不能注册 Identity 或签发 credential；
- deny/approval/unavailable 只记录低敏 audit；
- transport 不能直接调用普通 Identity/Credential repository 绕过 Policy。

SQLite `BEGIN IMMEDIATE` 取得写锁后再次验证：

1. actor credential version/state、User status、有效期、pepper state/material digest；
2. Project active/version；
3. actor 最新 RoleBinding version/state/owner role；
4. target Identity/credential expected version 与 mutation replay；
5. Owner 连续性。

Identity/Credential revision、管理 mutation、delivery digest 与 allowed audit 同成同败。

### 4. Owner 连续性是数据库不变量

- 仍有任一 Project 最新 active Owner binding 的 User Identity 不能被禁用；
- 撤销 active Owner 的 credential 时，必须存在该 User 的另一把当前有效 credential；
- 有效 credential 必须同时满足 active revision、时间窗、pepper binding 和
  active/retired catalog provenance；
- Issue/rotate 只能指向 active Identity 和当前 active pepper。

因此 operator 必须先签发并验证替代 credential，再撤销旧 credential；不能通过
禁用 Identity 或撤销最后凭据把部署锁死。

### 5. 凭据交付使用 prepare → commit → publish → acknowledge

交付目录必须是规范化、非 symlink、current UID、`0700` 目录，最多 64 个受审条目。
文件必须是 current UID `0600` regular file，并经过 `lstat → O_NOFOLLOW open →
fstat` 身份复核、file fsync 和 directory fsync。

协议顺序：

1. `prepare` 先以 no-replace 方式写 durable pending record；其中包含新 secret，
   但不进入数据库；
2. 对完整 pending record 计算 domain-separated SHA-256 delivery digest；
3. SQLite transaction 把 credential secret digest、delivery digest、mutation 和
   audit 原子提交；
4. commit 成功后才发布可直接作为 `credentialFilePath` 使用的 ready presentation；
5. consumer 验证/接管 ready presentation 后，执行
   `credential.delivery.acknowledge`；
6. acknowledgement 与 audit 先在数据库原子提交，再删除 ready 和 pending。

pending/ready 名称只由 mutation UUID 派生。acknowledgement 删除具备 exact digest
复核，文件均已不存在时返回 `absent`，支持 response-loss replay。

### 6. 崩溃与重放语义

| 崩溃窗口 | 同一 command 的恢复行为 |
| --- | --- |
| pending 后、数据库前 | 复用 pending 中原 secret 与首次有效期 |
| 数据库 commit 后、ready 前 | exact replay 后发布同一 ready token |
| ready 后、CLI response 前 | 返回同一 file name/digest，不生成新 secret |
| acknowledgement commit 后、删除前 | replay acknowledgement 后继续 exact 删除 |
| 删除后、ack response 前 | 返回 `existing + absent` |

mutation 的首次 durable timestamp 是 replay authority。时间推进、target 后续状态变化
或 CLI 重启不能让一个已经提交的相同 mutation 失去可重放性；但不同 operation、
target、version、lifetime、digest 或 request identity 必须冲突失败。

### 7. SQLite capability v36

`0071-local-identity-credential-administration` 增加：

- `QingLong3IdentityAdministrationMutations`；
- `QingLong3ApiCredentialAdministrationMutations`；
- `QingLong3ApiCredentialDeliveryAcknowledgements`；
- credential/credential-version/pepper-key 的唯一 provenance index。

`0072-capability-v36` 把 `local-control-core` 推进至 36，并声明
`local_identity_credential_administration=1`。read/write contract、Compose image
label、rollout/restore evidence 与物理 Edge contract 同步为 36。readiness 只接受
迁移 authority `0071` 与精确 capability JSON。

## 低配路由器与集群影响

- 命令只在人工调用时加载，结束后关闭 SQLite 和文件 authority；
- 不新增 daemon、timer、watcher、listener、socket、线程或第三方依赖；
- 常驻 Edge/Standalone application closure 不导入 Owner CLI、delivery、
  local-admin mutation service 或 executable migration；
- 新增三张 append-only 小型管理表，但 credential 明文只短暂存在于有界私有交付
  目录，不进入 SQLite；
- Cluster 继续使用 PostgreSQL、Kubernetes/RBAC 和独立远程 credential delivery；
  本地 POSIX 文件协议不能成为 cluster transport。

## 不采用方案

### 在 stdout 返回一次 token

响应丢失后无法恢复已提交 secret，并会把 token 暴露给 shell history、日志采集和
父进程管道。

### 数据库保存可恢复明文 secret

扩大数据库备份、查询和运维面的明文 authority，也让 runtime storage 获得不需要的
secret delivery 权限。

### 提交后重新生成 secret

新 secret 与已提交 digest 不一致；静默覆盖会破坏认证和审计的 mutation identity。

### 新增 identity-admin package 或常驻管理 API

没有新的独立部署、第三方依赖或常驻 Profile 边界，会增加 workspace 碎片和路由设备
攻击面。现有 package 的精确 subpath 已能表达权限。

## 验收证据

- 真实 SQLite/CLI 2/2：完整 register → issue → exact replay → acknowledge →
  revoke → disable，并验证 Owner Identity/最后 credential 防锁死；
- staged delivery 2/2：首次 secret/有效期重放、`0600` ready、digest-bound cleanup、
  symlink 与语义漂移拒绝；
- local-admin replay 1/1：时间推进且 Identity 状态已不可重读时仍以 durable mutation
  exact replay；
- SQLite migration/readiness/rollout 20/20，`PRAGMA foreign_key_check` 为空；
- local deployment/rollout/restore 23/23，local image contract audit 通过；
- runtime-core、SQLite、local-admin、delivery 与 CLI strict targeted TypeScript
  编译通过；
- dependency audit 对新增 source 的 exact-import findings 为零，workspace 仍为
  22 package。

完整 workspace build、production artifact/RSS 和 PostgreSQL HA 仍依赖锁文件依赖
恢复；上述专项证据不能替代这些发布门。

## 后续

- bounded Identity/Credential list/inspect 与低敏 audit 查询；
- 未确认 delivery 的显式过期/回收 ceremony；
- credential 使用验证后再 acknowledge 的产品引导；
- Project create/archive；
- Cluster PostgreSQL 对等 Identity/Credential 管理 transport；
- 固定 Edge 设备上的 CLI peak RSS、SQLite 写入和断电恢复报告。
