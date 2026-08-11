# ADR-0077：短生命周期本机 Identity Provisioning 与首 Owner 原子建权

- 状态：Proposed（默认不可达安全核心、POSIX proof、staged Secret 交付与 Owner ceremony CLI 已实现；fresh setup 和实机门禁待完成）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-62、D-73、D-74、D-75、D-76、D-78
- 关联 ADR：ADR-0028、ADR-0074、ADR-0075、ADR-0076、ADR-0078、ADR-0079

> ADR-0087 现行增量：原 `@qinglong/local-owner-bootstrap` 与 `@qinglong/local-owner-credential-recovery` 已物理合并为无聚合根入口的 `@qinglong/local-owner-ceremony/bootstrap` 与 `/credential-recovery`；本文中的旧包名保留为当时实现证据，现行依赖与权限门禁以新 subpath 为准。

## 上下文

ADR-0076 已提供稳定 Identity、digest-only API credential、共享 SQLite operation authority 与真实认证器，但 fresh install 仍没有安全方式产生第一个 User 和 Owner。若让默认 application、HTTP body 或 CLI 参数直接提交 `userId`/principal，3.0 会把 transport 字符串提升为身份事实；若 provisioning、challenge 与 Policy 分别打开连接，又会破坏 edge 路由设备的单连接预算和统一 close fence。

## 决策

### 1. 专用 bootstrap 子入口，不扩张默认 runtime

`@qinglong/local-sqlite/bootstrap` 是唯一组合 SQLite bootstrap repository 与 API credential repository 的入口。它打开一个 `DatabaseSync`，创建一个 `LocalSqliteOperationAuthority`，让两个窄 repository 共享同一 256 上限串行队列和 close fence。根入口与 `runtime` 子入口不导出 bootstrap，默认 local-profile/application 不依赖 `@qinglong/local-owner-bootstrap`。

### 2. 身份和 secret 只能由内部熵源产生

`provision` 请求只接受 mutation/request identity、受信 local-console issuer 和有界 credential TTL；不能携带 User ID、username、principal、credential ID 或 secret。服务内部生成稳定 opaque User/credential identity 与 32-byte secret，数据库只保存 peppered domain-separated digest。未配置 delivery 的内部能力仅在首次事务成功返回完整 credential token；配置 ADR-0079 staged delivery 的生产组合根始终返回 `credentialToken: null`。

`issue` 同样内部生成 16-byte challenge ID 和 32-byte challenge token，只持久化绑定 Project/challenge identity 的 domain-separated digest。未配置 delivery 时仅首次返回 token；生产组合根始终返回 `challengeToken: null`，由 staged outbox 交付且不提供 digest 反向恢复。

### 3. 一个事务建立首 Owner

`claim` 公开请求只携带 Project、mutation/request、challenge ID/token 与 credential token，不接受 principal。LocalIdentityAuthenticator 解析 latest credential version 并产生短时 `single_factor` User principal；SQLite repository 在 `BEGIN IMMEDIATE` 内再次验证：

- active Project 与 exact project-version audit fence；
- 历史上不存在任何 RoleBinding；
- 最新 challenge identity/digest、未消费、已生效且未过期；
- latest credential version、active state、active Identity、subject 与有效期；
- mutation/audit identity 未被不同语义占用。

随后同事务插入 `owner@v1` binding、allowed security audit 并消费 challenge。任何失败全部回滚。历史出现过 binding 后旁路永久关闭；两个独立连接竞争时只有一个 winner。

### 4. 拒绝审计占用 mutation，错误保持低敏

credential 失败产生无 subject 的 `authentication_rejected`；已认证但 challenge/Project/pristine 检查失败产生低敏 `denied`。failure audit 成功后，同一 mutation ID 不得再变为 allowed；audit/storage 不可用时 fail closed。对外只暴露 rejected、mutation conflict 或 unavailable，不泄漏 token、credential 状态和 challenge 具体失败项。

### 5. edge 与 standalone 零常驻成本

bootstrap 没有 timer、watcher、scanner、cache 或 sidecar；TTL 仅在请求时判断。短生命周期调用结束后幂等关闭唯一 connection。cluster-control 不复用该 SQLite authority，继续使用独立 PostgreSQL/cluster-admin ceremony。

## 数据与 capability

`0013-local-owner-bootstrap` 增加 singleton provisioning fact 与 append-only challenge/claim fact；`0014-capability-v7` 宣告 `local_identity_provisioning` 和 `local_owner_bootstrap`。当前 Node 24 SQLite 为 14 条 reviewed migration、18 张 owned table、capability v7，manifest、typed schema、readiness、CHECK/FK/index 与实际 catalog lockstep。

## 被否决的替代方案

1. **默认 runtime 暴露 bootstrap repository**：把一次性 root authority 留给常驻进程，拒绝。
2. **请求提交 userId/username/principal**：自报身份，拒绝。
3. **数据库保存 token 明文以支持重放**：数据库泄漏即取得首 Owner，拒绝。
4. **独立 repository 各开 SQLite 连接**：破坏路由设备预算和统一关闭语义，拒绝。
5. **后台 timer 清理过期 challenge**：无必要常驻成本和写放大，拒绝。
6. **migration seed admin 或默认密码**：绕过 possession ceremony，拒绝。

## 验收证据

1. `@qinglong/local-owner-bootstrap` 8 项真实 SQLite 测试通过：摘要落库/首次回显、身份字段拒绝、失败审计占用 mutation、双连接单 winner、历史 binding 永久关闭旁路、audit 故障原子回滚、close fence/默认入口不可达，以及 fresh authentication timestamp 的跨进程 exact replay 与 authentication identity 冲突。
2. runtime-core 86 项测试通过，其中 Owner bootstrap/pepper contract 证明 digest domain binding、`single_factor` User fence、生产毫秒时间戳与 widened identity shape 拒绝。
3. local-identity 9 项测试通过，并返回 credential ID/version/key fence；真实 SQLite Runtime + POSIX keyring 覆盖 active/retired exact-key authentication 与 `recovery_required` material recovery，缺失 provenance、非法状态或摘要不一致会 fail closed。
4. dependency audit 当前登记 32 个 QL3 package importer，禁止其他 package 直接导入 bootstrap authority；`@qinglong/local-owner-cli` 只能经 console facade 到达 ceremony，独立 `local-owner-keyring` 只依赖 runtime-core，破坏性 keyring 子入口只允许短生命周期 pepper GC authority 导入。
5. 当前 local-sqlite schema/readiness contract 已推进到 capability v10、20 条 migration 与 21 张 owned table，并保留本 ADR 的 provisioning contract。
6. edge/standalone application 制品仍只有既有 12 个生产包、495 个文件和 58 个加载模块；分别为 2,389,654/2,389,798 bytes，RSS 增量 11,583,488/11,829,248 bytes，未包含 local-owner authority 或 CLI，满足 4 MiB/512 files/16 MiB 门禁。
7. 32 个 QL3 production importer 当前均为 0 advisory（含 high/critical 为 0）；legacy 根的 3 low/9 moderate/2 high 继续独立可见，不污染 Profile 裁决。

## 未完成项

ADR-0086 已提供私有 durable command file 驱动的 `ql3-owner`，内部消费 staged delivery 完成首 Owner claim，并在 ready 文件删除后从数据库事实精确重放；credential recovery 也已进入同一短生命周期入口。但它假设数据库 migration 与 pepper catalog register/activate 已完成，因此仍需 fresh setup CLI、恢复码、legacy identity adapter，以及真实 Linux/rootless-root 容器与低配路由器权限/RSS/闪存证据。完成前不得开放 HTTP/UI，也不得由 JSON 构造 `local_console` principal。
