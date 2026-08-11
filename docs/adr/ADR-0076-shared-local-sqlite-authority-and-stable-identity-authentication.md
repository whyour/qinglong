# ADR-0076：共享本机 SQLite 操作权与稳定 Identity Credential 认证

- 状态：Proposed（认证增量已实现，provisioning/首 Owner 由 ADR-0077 补齐）
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-62、D-66、D-73、D-74、D-75
- 关联 ADR：ADR-0049、ADR-0050、ADR-0063、ADR-0074、ADR-0075、ADR-0077、ADR-0078

## 上下文

ADR-0075 要求首 Owner 的 subject 必须来自稳定 Identity authenticator，而不是 CLI/HTTP/UI 传入的 `userId`、username 或 JWT payload。现有本机 3.0 数据库只有 Run、执行、Secret、Project/Policy 与 audit 事实；cluster 已有通用 API credential contract，但本机没有稳定 Identity/credential catalog，也没有真实认证器。

同时，原 `LocalSqliteRunRepository` 自己持有 `DatabaseSync`、串行队列和 close fence。若 Identity repository 再开连接，会破坏 edge/standalone 的单连接资源边界；若把 Identity 查询继续塞进 Run repository，又会把它扩张为跨领域 god repository。

## 决策

### 1. 抽出唯一 SQLite Operation Authority，不扩张 Run Repository

新增 `LocalSqliteOperationAuthority`，唯一拥有 `DatabaseSync`、最多 256 个 pending operation 的串行队列、acceptance fence 与 idempotent close。Run、API credential 及后续 bootstrap repository 只能在其上提交短操作，不能自行取得 client、开启第二连接或建立旁路队列。

各 repository 保留自己的领域错误映射；共享 authority 只提供调度、关闭和资源所有权，不成为包含所有 SQL 的 god object。runtime close 等待已接收操作完成，关闭后所有 repository 一致 fail closed。

### 2. capability v6 增加 ownerless Identity 与 append-only credential

`0011-local-identity-credential` 增加：

- `QingLong3IdentitySubjects`：稳定 `(subject_type, subject_id)`、`active|disabled`、version 与时间事实；
- `QingLong3ApiCredentials`：append-only `(credential_id, version)`、`active|revoked`、subject 外键、domain-separated secret digest 和有效期。

`0012-capability-v6` 声明 `local_identity` 与 `local_api_credential`。migration、manifest、typed schema、readiness 与真实 catalog 必须 lockstep。migration 不创建 Identity、credential、Owner 或默认密码；空库迁移后仍不可认证、仍保持 ownerless。

### 3. 本机 authenticator 复用 Runtime Kernel contract

独立 `@qinglong/local-identity` 生产只依赖 `@qinglong/runtime-core`，复用通用 `ApiCredentialRepository`、token grammar、digest 与 `SecurityPrincipal`，不复制 legacy login、Sequelize、Express 或 cluster adapter。

credential token 使用固定 `ql3c_<credentialId>_<secret>` 语法；secret 至少 32 bytes，服务端 pepper 至少 32 bytes。认证器先做有界语法解析和 point lookup，再 timing-safe 比较 digest，并验证 latest credential、Identity 状态、not-before/expiry 与时钟。成功只产生最多五分钟的 principal；本机 User credential 当前为 `single_factor`，不能单独满足 local-secret-admin 的 `multi_factor|hardware|local_console` 门槛。

### 4. 认证能力暂不进入默认 application

`@qinglong/local-identity` 是后续短生命周期 owner-bootstrap/provisioning 组合根的叶子依赖，当前禁止其他既有 3.0 package 反向导入。它不进入 edge/standalone application tarball，不增加 timer、watcher、sidecar、常驻 cache 或第二 SQLite connection。

本增量自身只有“验证已存在 credential”的能力，不提供创建首个 Identity/credential 的产品入口。ADR-0077 已用独立短生命周期组合根补齐一次性 provisioning 与原子首 Owner 安全核心，但可信本机 console 平台入口仍未完成，不能声称 fresh install 已有可发布 CLI/API。

## 被否决的替代方案

1. **把 Identity SQL 加进 `LocalSqliteRunRepository`**：扩大跨领域 god repository，拒绝。
2. **Identity repository 独立打开 SQLite**：破坏单连接队列、close fence 与路由设备预算，拒绝。
3. **复用 2.x 用户名/密码/JWT 登录**：把 legacy 可变身份和 session 结构带入 3.0 身份根，拒绝。
4. **migration 自动 seed admin/default password**：绕过本机 possession ceremony 并制造公开默认凭证，拒绝。
5. **把单因素本机 credential 直接当强认证**：绕过 Secret 管理与 Owner bootstrap 的 assurance 门槛，拒绝。
6. **在常驻 application 中暴露 credential lookup/provisioning**：提前扩大远程攻击面与路由器常驻闭包，拒绝。

## 影响与未完成项

本 ADR 完成了 ADR-0075 实施顺序中的稳定 Identity schema、credential catalog、共享 repository authority 与真实认证器前置条件，并修正了“共享数据库就必须共享 god repository”的错误设计。ADR-0077 已补齐默认不可达的 provisioning、challenge repository/service 与原子首 Owner claim，ADR-0078/0079/0080/0081/0082 补齐 POSIX proof、staged secret delivery/recovery、pepper provision/backup/restore、摘要绑定消费确认与 SQLite acknowledgement ledger，ADR-0083 已补齐跨方言 credential key provenance、exact-ID fence、受审 keyring/active CAS、ack-first credential rollover/revoke、bounded reference inspection 与版本化双材料 GC 核心，ADR-0084 已补齐可恢复 acknowledgement tombstone retention/GC；当前仍缺最终 CLI、legacy adapter 与完整 Linux/容器/物理设备证据。

## 验收证据

1. Node 24 SQLite capability v6 为十二条 reviewed migration、十六张 owned table，manifest/schema/readiness/catalog lockstep；
2. Run 与 API credential repository 共享一个 operation authority 和 close fence，原有 SQLite 23 项 contract 全部通过；
3. 真实迁移库上的本机认证、错误 token、撤销/禁用/过期、存储/时钟失败与关闭后查询共 5 项测试通过；
4. 第 23 个 3.0 importer 的 manifest/lock/source boundary 已登记，生产依赖只包含 runtime-core；
5. edge/standalone application 闭包仍为十二个 package，均不包含 local-identity 或 local-secret-admin，并继续满足 4 MiB/512 files/16 MiB RSS 门禁。
