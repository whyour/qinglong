# ADR-0075：本机稳定 Identity 与首 Owner Bootstrap Ceremony

- 状态：Proposed（Identity/credential/bootstrap、POSIX proof 与 staged Secret 交付安全核心已实现，最终 CLI 尚未实现）
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-27、D-28、D-48、D-73、D-74
- 关联 ADR：ADR-0028、ADR-0029、ADR-0030、ADR-0049、ADR-0050、ADR-0074、ADR-0076、ADR-0077、ADR-0078

## 上下文

ADR-0074 已建立 ownerless Project、RoleBinding、security audit 和受授权的 Secret mutation，但默认 Project 没有 owner。旧的 ADR-0029/`0018` challenge core 依赖 legacy Sequelize、`0017` 表和外部注入的 `AuthenticatedPrincipal`；直接复制到 Node 24 SQLite 只能迁移 SQL，不能回答“这个 User principal 由谁认证”。

若本机 CLI 接受 `--user-id` 并直接创建 owner，字符串会被错误提升为身份事实；若自动采用 legacy username、默认密码或当前 JWT data，又会把可变展示名和 2.x session 结构固化进 3.0。对 fresh install 来说，先有可信稳定 Identity，再允许一次性 owner claim，是不可交换的顺序。

## 决策

### 1. 首 Owner 只能绑定稳定 Identity authority 产生的 User

bootstrap claim 只接受 `LocalIdentityAuthenticator` 输出的 active `SecurityPrincipal`，subject 必须为稳定 `user` identity。CLI/HTTP/UI 请求不得携带可决定 subject 的 `userId`、username、JWT payload 或任意 ActorRef；transport 只能携带 credential/challenge material，identity 必须由认证 adapter 解析。

legacy panel 兼容只能通过显式 anti-corruption adapter 把“有效 HS384 session + 当前 token membership + 已持久化 stable identity binding”映射为 User；fresh install 使用独立本机 Identity/credential authority。两者都实现同一 authenticator port，bootstrap core 不导入 legacy User/Sequelize/Express。

### 2. Issuer 是短生命周期本机控制台能力，不是可伪造 JSON

challenge issue 由独立、短生命周期 local-console entry 拥有。`system:owner-bootstrap` + `local_console` principal 只能由该组合根在验证本机部署边界后构造，不作为 HTTP body、CLI JSON 或公共 DTO 接受。

“进程运行在 localhost”或 `stdin.isTTY` 本身不等于认证。正式入口至少要验证数据库/keyring 路径所有者与私有权限、调用用户/容器管理边界、非网络调用方式，并将具体平台证明记录在部署文档与测试矩阵；无法证明时不得 issue。

### 3. Challenge 只存 digest，token 只显示一次

challenge token 至少 32 bytes CSPRNG，使用 domain-separated digest 持久化，默认 10 分钟、硬范围 1–30 分钟。每个 Project 同时最多一个 active challenge；过期后才允许 append 新 version。数据库、日志、audit、错误和重放响应都不保存/返回 token。

issue mutation 可幂等重放，但只有首次成功响应包含 token；提交后响应丢失时重放返回 `token: null`，必须等待旧 challenge 过期或由受审本机入口显式作废后重新 issue，不能从 digest 恢复 secret。

### 4. Claim 消费、首 binding 与 allowed audit 必须原子

Node 24 SQLite authority 以 `BEGIN IMMEDIATE` 在一个事务中完成：锁定 Project/challenge 事实、timing-safe 比较 digest、验证未过期/未消费、确认 Project 历史上不存在任何 RoleBinding、消费 challenge、追加该 User 的 `owner@v1` binding，并写低敏 allowed security audit。

任意一步失败全部回滚；并发 claimant 只有一个 winner。Project 只要出现过任何 binding，即使后来 revoked，也永久关闭 bootstrap。exact replay 只允许同一 challenge、claim mutation、User、request/audit 语义返回 existing；不同 User 或漂移参数一律 generic rejection。

### 5. 拒绝也要审计，但不能成为探测 oracle

无效/过期 token、已消费、Project 非 pristine、Identity 不可用和 mutation collision 对外使用低基数结果，不透露哪一项失败。已认证 claimant 的拒绝写低敏 audit；audit 不可用时 fail closed。认证前失败不得伪造 subject。

失败 mutation identity 不能随后复用为成功 claim，必须生成新 identity，避免一个 audit event 同时表示 deny 和 allow。

### 6. 路由设备与集群保持不同 authority

edge/standalone 复用唯一 Node 24 DatabaseSync、既有 256 operation 队列和 close fence，不增加常驻连接、timer、watcher、sidecar 或 challenge scanner；expiry 在请求时按时间事实判断。

cluster-control 继续使用独立 PostgreSQL/cluster-admin/Identity credential ceremony，不共享 SQLite challenge 表或本机 console capability。local owner bootstrap package 不得进入默认 application tarball。

## 实施顺序

1. 先定义 Profile-neutral `LocalIdentityAuthenticator` 与稳定 User record/credential contract（ADR-0076 已完成）；
2. 为 fresh install 选择并审查本机 credential 形态、恢复与撤销语义（固定 token/digest、认证与 provisioning 已完成，rotation/revoke/recovery 尚未完成）；
3. 增加 Node 24 SQLite challenge migration、typed schema、readiness 与 repository；
4. 实现独立 local-owner-bootstrap service 和并发/崩溃/audit rollback 测试；
5. 最后实现不回显 local-console CLI，并接 legacy anti-corruption adapter；
6. 在认证、速率限制、CSRF/origin 和 TLS 边界完成前不开放 HTTP/UI claim。

第 1–4 步的默认不可达安全核心已由 ADR-0076/0077 完成，ADR-0078/0079/0080/0081 又补齐 POSIX 私有文件证明组合根、staged secret delivery/recovery、pepper provision/独立备份/restore 与摘要绑定消费确认；最终 CLI、pepper/credential 在线 rotation/recovery、acknowledgement retention 与 legacy adapter 尚未完成，仍不得用临时 `userId` 参数、JSON 伪造 local-console 或手工 SQL 抢跑产品入口。

## 被否决的替代方案

1. **CLI 直接接收 userId/username 写 owner**：把调用方字符串提升为身份事实，拒绝。
2. **migration 或 application 启动时自动建 owner**：绕过 challenge 和强认证，拒绝。
3. **复用默认密码或当前 legacy JWT payload**：可变、可重放且无法证明稳定 identity，拒绝。
4. **把 token 明文存库以支持响应重放**：数据库泄漏即可夺取首次建权，拒绝。
5. **定时扫描并删除过期 challenge**：expiry 可请求时判断，给 edge 增加无必要 timer/写放大，拒绝。
6. **让 local-secret-admin 自行创建 owner**：业务权限管理不能兼任身份根与首次建权，拒绝。

## 影响与未完成项

本 ADR 修正了“有 RoleBinding 表就等于可安全建立首 owner”的错误假设，并给 fresh install、legacy 兼容和未来 UI 划定同一 Identity 边界。ADR-0076/0077 已增加 ownerless Identity/credential、共享 SQLite authority、独立 authenticator、一次性 provisioning、digest-only challenge 与原子 owner claim；默认 application 仍不导入该 authority。

credential-version `pepper_key_id` provenance、SQLite capability v13 catalog/active generation CAS、独立有界 keyring、Runtime exact-key authentication、同 key material recovery、ack-first credential rollover、bounded pepper reference inspection 与版本化双材料 GC 核心已由 ADR-0083 实现，可恢复 acknowledgement tombstone retention/GC 已由 ADR-0084 实现；仍需最终 CLI、legacy adapter、Linux/容器/物理路由器权限证据以及产品级恢复演练。ready secret 显式摘要确认和 SQLite 账本已由 ADR-0081/0082 实现。完成前 ADR-0074 的 Secret 管理核心仍保持产品不可达。

## 验收条件

1. 请求 DTO 无法指定 owner subject；测试必须证明 forged userId 被边界拒绝。
2. token 只在首次 issue 返回，数据库/重放/audit/错误均无明文。
3. challenge consume、owner binding 与 allowed audit 同成同败。
4. 双连接并发 claim 只有一个 owner；任何历史 binding 永久关闭 bootstrap。
5. Identity/authentication/audit 不可用全部 fail closed，错误不泄漏 challenge 状态。
6. edge/standalone 无新增常驻 timer/连接，默认 application 产物不包含 bootstrap authority。
