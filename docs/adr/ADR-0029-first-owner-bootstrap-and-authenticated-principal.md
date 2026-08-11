# ADR-0029：首 Owner 一次性 Bootstrap 与认证主体边界

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0028

## 上下文

ADR-0028 故意让 `0017-project-policy` 创建 ownerless `default` Project，以免把可变 username、默认密码、legacy system App 或任意旧 token 静默提升为 3.0 owner。但如果没有一个明确且可恢复的首次建权协议，部署者只能修改数据库或让生产 API 临时绕过 Policy，两种做法都会破坏默认拒绝和审计边界。

首 owner 建立还跨越三个不同事实：credential 已被某个 Authentication adapter 验证、一次性 challenge 未过期且未被使用、Project 仍没有任何 RoleBinding。只在 application service 中依次执行“消费 challenge”和“写 owner”会留下崩溃窗口；只用内存 token 又无法跨控制面重启。edge 设备不能为这一步常驻 sidecar、timer 或全量缓存，cluster 多副本则不能共享 SQLite 文件锁语义。

## 决策

### 1. Authentication adapter 只交付严格认证主体

认证边界输出：

```ts
interface AuthenticatedPrincipal {
  subject: PolicySubject;
  authenticationId: string;
  authenticatedAtMs: number;
  expiresAtMs: number;
  assurance:
    | 'single_factor'
    | 'multi_factor'
    | 'service'
    | 'hardware'
    | 'local_console';
}
```

对象拒绝未知字段，`authenticationId` 是有界、非 Secret 的认证相关标识，时间必须为安全整数且 `expiresAtMs > authenticatedAtMs`。调用发生时还必须满足 `authenticatedAtMs <= now < expiresAtMs`。

该对象证明“谁在何种认证上下文中发起本次请求”，不携带 role、scope 或 permission。Policy 和 bootstrap 不读取 cookie、Authorization header、legacy username 或请求体自报 subject；具体 session/token/mTLS/本机控制台适配器必须在边界外验证 credential，再构造该对象。

### 2. Issue 只接受本机显式 bootstrap authority

首版 issue 只接受以下仍有效的认证主体：

```ts
{
  subject: { type: 'system', id: 'owner-bootstrap' },
  assurance: 'local_console'
}
```

这不是一个可由 HTTP 请求自行声明的角色。未来 CLI 或本机安装向导必须通过独立的本地控制台证明创建它；当前切片不提供该 production adapter，因此不会因为 service 存在就开放远程 bootstrap。

每次 issue 使用 CSPRNG 生成 16-byte challenge ID 和 32-byte token，分别编码为 canonical base64url。token 仅向本机调用者返回一次；原始随机字节编码后清零，数据库只保存带 domain、Project ID 和 challenge ID 隔离的 SHA-256 digest。默认 TTL 为 10 分钟，调用方只能在 1～30 分钟内选择。错误、日志、审计字段和数据库均不得包含明文 token。

同一 Project 有未过期 challenge 时拒绝重新 issue，不重新显示旧 token；过期后可以追加新版本，旧 challenge 不删除。Project 不存在、已归档或已有任意 RoleBinding 时拒绝 issue。

### 3. Challenge 版本化持久化，不依赖 timer

`0018-project-owner-bootstrap` 新增 `ProjectOwnerBootstrapChallenges`：

- `(project_id, version)` 为复合主键，`challenge_id` 全局唯一；
- 保存 token digest、签发时间和到期时间；
- claim 后保存消费时间和稳定 subject；
- `(project_id, version DESC)` 支持读取当前 challenge；
- 历史行不覆盖、不后台扫描，也不为每个 challenge 创建 timer。

状态由字段和当前时间派生：未消费且 `now < expiresAt` 为 pending；未消费且已到期为 expired；消费三元组完整时为 claimed。损坏、半空 claimed tuple、非法 digest 或 identity 一律 unavailable 并 fail closed。

该模型在 edge 上只增加一次 issue 写、一次 claim 事务和有界点查。cluster-control 必须提供保持相同 contract 的 PostgreSQL row-lock/CAS adapter；禁止多个控制面副本共享 SQLite adapter。

### 4. Claim 与首 owner RoleBinding 在同一事务提交

claim 只接受当前仍有效且 `subject.type === 'user'` 的 `AuthenticatedPrincipal`，不接受额外 raw subject。SQLite adapter 使用短 `IMMEDIATE` transaction，并在事务内依次复验：

1. Project 存在且 active；
2. 指定 challenge 是该 Project 最新版本；
3. digest 以 constant-time 比较完全匹配；
4. `issuedAt <= now < expiresAt`；
5. Project 仍没有任何 RoleBinding；
6. challenge consume UPDATE 恰好影响一行；
7. 插入 version 1、role owner 的 RoleBinding。

challenge 的 `consumed_at/claimed_subject` 更新与 owner binding insert 必须在同一事务。任意 constraint、trigger、连接或插入失败都整体回滚；不能留下“challenge 已消费但无 owner”，也不能留下“有 owner 但 challenge 未消费”。RoleBinding mutation ID 为 `owner-bootstrap:{challengeId}`，`changedBy` 固定为 `system/owner-bootstrap`，不伪造最终用户自授予。

同 token、同 challenge、同稳定 subject 的重放返回 existing；不同 token、旧 challenge、不同 subject、过期或已被他人消费统一拒绝 claim，不暴露哪一项不匹配。两个 SQLite 连接并发 claim 时只允许一个 subject 成为 owner。

### 5. Bootstrap 只适用于完全 pristine 的 Project

只要 Project 已存在任意 RoleBinding，即使该 binding 已 revoked，bootstrap 都永久关闭。后续 owner 增删、全部 owner 丢失和账户恢复必须走受 Policy、Approval 和 Audit 约束的独立管理/恢复协议，不能重新打开 bootstrap 旁路。

本 ADR 不定义恢复码。恢复码需要单独决定生成、展示一次、离线保存、轮换、吊销、多 owner 门槛和丢失处置；把它混入首 owner challenge 会让一次性建权入口长期存在。

### 6. 当前切片保持 production unreachable

本切片实现 `AuthenticatedPrincipal` contract、CSPRNG challenge service、`0018` migration、SQLite 原子 repository 和 schema ownership；ADR-0030 另已实现默认不可达的稳定 legacy User 映射和 session authentication core。但没有：

- 本机控制台 credential/安装向导到 `local_console` principal 的 adapter；
- legacy session authentication core 到 `shareStore`/Express 的生产装配；
- CLI、HTTP、MCP 或 UI issue/claim 入口；
- rate limit、失败审计、安全显示和恢复码；
- PostgreSQL adapter 与跨副本 contract suite；
- typedi/loader/startup 装配。

因此 ownerless `default` Project 在现有产品中仍保持 ownerless，3.0 Policy 仍默认拒绝。任何 Express 路由不得直接构造 `system/owner-bootstrap`，也不得把请求体 username 当成 claim subject。

## 崩溃与重放语义

| 崩溃点 | 恢复结果 |
| --- | --- |
| token 已生成但 challenge 未提交 | 无持久事实；该 token 不可 claim，可重新 issue |
| challenge 已提交但 token 尚未显示 | challenge 保持 pending；不会重新显示 token，需到期后重新 issue |
| consume UPDATE 后、owner insert 前 | 同一事务回滚，challenge 仍未消费且无 owner |
| owner insert 后、事务提交前 | 同一事务回滚，challenge 仍未消费且无 owner |
| 事务已提交但响应丢失 | 同 token、同 subject 重放返回 existing |

## 影响

正面影响：

- 首次建权不依赖默认密码、显示用户名或直接改库；
- challenge 与 RoleBinding 形成可审计的一一关系；
- 明文 token 不落库，错误不回显 token；
- edge 无常驻后台成本，cluster adapter 边界明确；
- 崩溃、重放和多连接竞争有确定结果。

代价与风险：

- token 显示前崩溃时不能恢复原 token，只能等待到期或由未来本机运维入口显式作废；
- 当前没有生产 authentication/console adapter，所以该核心不会立即解决用户升级交互；
- challenge 历史持续增长，需要未来定义保留策略，但不得在 claim 热路径同步清理；
- 单 owner 丢失后的恢复仍未解决，不能复用本入口绕过正常 Policy。

## 未选择的方案

1. **首次登录用户自动成为 owner**：登录主体尚未稳定且会把默认密码风险升级为 Project owner，拒绝。
2. **把明文 bootstrap token 存入数据库**：备份或只读泄漏即可直接建权，拒绝。
3. **challenge 仅保存在进程内存**：重启后无法判定消费和重放，拒绝。
4. **先消费 challenge，再通过普通 Role API 建 owner**：存在永久 ownerless 的崩溃窗口，拒绝。
5. **已有 binding 时允许重新 bootstrap**：会成为长期权限恢复旁路，拒绝。
6. **通过远程 HTTP header 声明 local console**：认证等级可伪造，拒绝。
7. **edge 为过期 challenge 启动清理 timer**：增加常驻成本且过期可在读取时判定，拒绝。

## 验证要求

- principal、issue/claim request、challenge record 的非 canonical 输入在副作用前拒绝；
- 只有 active `system/owner-bootstrap + local_console` 可以 issue，只有 active user principal 可以 claim；
- challenge/token 长度、TTL 边界、digest domain separation 和明文不落库可验证；
- active challenge 不可替换，过期后追加版本且旧 token 不可 claim；
- 错 token、过期、旧版本、不同 subject 和非 pristine Project fail closed；
- 同主体重放 existing，双 SQLite 连接不同主体竞争仅一个成功；
- owner insert 失败或 challenge UPDATE 零行时事务整体回滚；
- archived/missing Project、损坏记录和非 SQLite adapter fail closed；
- Node 22/24 全量测试、类型检查、schema audit 和 GitNexus reachability 通过；
- app/loaders/api/services/shared/data 不得导入或装配本切片。
