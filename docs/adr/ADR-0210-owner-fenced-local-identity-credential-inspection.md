# ADR-0210：Owner 围栏化 Local Identity/Credential 查询

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-197、D-198、D-199、D-200
- 关联 ADR：ADR-0074、ADR-0075、ADR-0077、ADR-0086、ADR-0185、
  ADR-0207、ADR-0208、ADR-0209

## 背景

ADR-0209 已提供 Identity/Credential mutation 的产品入口，但每次 mutation 都要求
`expectedCurrentVersion`。部署者若只能直接查询 SQLite 才能取得该版本，会产生三个
问题：

- 运维流程必须知道存储表结构，产品契约与实现泄漏；
- 普通 credential 行包含 secret digest 和 pepper provenance，直接查询扩大敏感面；
- 查询没有复用 Owner authorization、credential fence 与 Security Audit。

单纯在服务层 authorize 后调用普通 `resolve` 也不安全。actor credential 或 Owner
RoleBinding 可能在 authorization 与读取之间变化，造成已撤权主体继续读取管理状态。

## 决策

### 1. 扩展既有边界，不新增 package 或 migration

能力分别进入既有精确 subpath：

- runtime-core 定义 authorized inspection repository contract；
- local-admin 提供 Owner-only inspection service；
- local-sqlite 实现事务围栏读取与 audit；
- local-owner-cli 在既有 `ql3-identity` 增加产品命令。

不新增第 23 个 package、数据库表、第三方依赖、daemon、timer、watcher、listener 或
远程管理 API。Edge/Standalone 常驻 application closure 不导入该 authority。

### 2. v1 只提供精确查询

开放：

- `identity.inspect`：按 exact `{subject.type, subject.id}` 查询；
- `credential.inspect`：按 exact credential ID 查询。

command 使用 current UID `0600` private file。request 只包含 `projectId`、target 或
credential ID、`requestId` 和 UUIDv4 `auditEventId`。查询不是 mutation，不接受
mutation ID、failure-audit ID 或 expected version。

本切片不提供 list/search/pagination。精确查询足以获得后续 CAS 所需版本，同时避免
为低配设备引入目录扫描、游标状态或大结果集。

### 3. Owner authorization 与读取在最终事务重新围栏

服务要求 strong User Principal，并固定申请 `project.manage`。deny、
approval-required 和 policy-unavailable 先写低敏 audit，再返回统一错误。

SQLite 使用 `BEGIN IMMEDIATE`，在读取前重新验证：

1. 本命令认证 credential 的 version/state、Identity、时间窗与 pepper provenance；
2. Project active 状态和 Policy fence project version；
3. actor 最新 RoleBinding 的 version/state/Owner role。

随后读取最新 Identity 或 credential revision、写入 allowed audit，并一次提交。任一
围栏漂移都回滚读取对应的 allowed audit，并失败关闭。

### 4. 不存在语义和输出必须低敏

只有完成 Owner authorization 与事务围栏后，精确对象不存在才返回 `found:false`。
未授权请求不得根据对象是否存在返回不同结果。

允许输出：

- Identity：subject、status、version、created/updated time；
- credential：ID、subject、subject status、state、version、created/not-before/
  expires time。

禁止输出 secret digest、pepper key ID、token、credential presentation、数据库路径、
绝对交付路径或内部 mutation/audit 行。

## 替代方案

### 直接提供 SQLite 查询文档

拒绝。它把 schema 变成产品 API，绕过权限与 audit，并暴露本来无需展示的敏感列。

### authorize 后调用普通 repository resolve

拒绝。authorization 与读取不共享最终数据库 transaction，存在 credential revoke
或 Owner demotion TOCTOU。

### 新建只读管理 daemon 或 HTTP API

拒绝。当前需求是本机短生命周期运维；常驻进程会增加路由设备内存、端口和攻击面，
Cluster 也有独立 transport/authority。

### 立即提供 Identity/Credential list

暂不采用。list 需要分页、稳定 cursor、容量与枚举策略；精确 inspect 已解决 CAS
版本发现，不应扩大本切片。

## 影响

正向影响：

- 部署者不再直接访问 SQLite 即可完成 inspect → CAS mutation；
- 查询与 mutation 使用相同 Owner、credential 和 Policy fence；
- 已授权 not-found 有明确机器可读语义，输出不暴露 credential 验证材料；
- 低配设备没有新增常驻成本，workspace 保持 22 package。

代价与限制：

- 每次 inspect 都是短写事务，因为 allowed audit 必须与读取 authority 同事务；
- 相同 `auditEventId` 不作为可重复消费的查询 cursor，重复人工执行应生成新 command；
- v1 不支持批量列表，operator 必须知道 exact subject 或 credential ID；
- Cluster 仍需独立实现 PostgreSQL/RBAC 查询 transport。

## 验证

- strict targeted TypeScript 编译覆盖 runtime contract、local-admin、local-sqlite 与 CLI；
- service 测试证明 Owner allow、admin/non-Owner deny 与 deny audit；
- 真实 SQLite/CLI 测试证明 Identity/Credential 当前 version、已授权
  `found:false`、allowed audit 与低敏 JSON；
- TOCTOU 测试在 policy authorize 后追加较新 non-Owner binding，最终 transaction
  必须抛出 authorization fence conflict；
- dependency audit 继续证明能力没有进入 Edge/Standalone 常驻 closure；
- 完整 workspace、artifact/RSS 与 PostgreSQL HA 门在锁定依赖恢复后重跑。
