# ADR-0030：Legacy Panel 认证与稳定 User Identity

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0028、ADR-0029

## 上下文

QingLong 2.x 是单用户面板，但没有稳定的 User ID。`Auths` 的 `authConfig` JSON 保存可修改 username、密码和当前 token；JWT payload 只有随机 `data`、`iat`、`exp`，不包含 subject。Express 先验证 HS384 JWT，再按 desktop/mobile 到当前 token 列表中查找。仅把 username 当 3.0 ActorRef 会在改名后漂移；仅验证 JWT 签名会让已经 logout、被 token 列表移除的 credential 重新获得权限；把 system App token 当 User 则会混淆 API App 与交互用户。

ADR-0029 的 owner claim 只接受 `AuthenticatedPrincipal`，因此必须先建立一个不复制 credential、不自动授予角色、能够在 edge 上点查并在 cluster 中替换 adapter 的稳定身份映射。

同时，当前部署并不存在可靠的在线“本机管理员”边界。Alpine 镜像和大量存量部署让控制面与用户脚本以同一 UID、同一文件系统运行；即使 Debian 镜像使用 `qinglong` 用户，控制面和脚本通常仍共享该用户。TTY、loopback、0600 文件、环境变量或 Unix peer UID 都可能被同权限任务读取或调用，不能直接产生 `assurance=local_console`。

## 决策

### 1. Legacy 单用户映射为固定内部 User，不使用 username

`0019-identity-directory` 新增：

- `IdentitySubjects`：稳定 subject、`active|disabled`、version 和时间；
- `IdentityAuthenticationBindings`：`(provider,provider_subject,version)` append-only binding，状态为 `active|revoked`；
- current 和 subject 反向索引均为有界点查。

baseline 固定为：

```text
IdentitySubject: user/usr_legacy_primary
AuthenticationBinding: legacy_panel/singleton@1 -> usr_legacy_primary
```

`usr_legacy_primary` 是实例内 opaque identifier，不是用户名、数据库行号、JWT data、IP 或设备名。migration 不读取或复制 username、password、two-factor secret、JWT、system App credential 或 token list，也不创建任何 Project RoleBinding。改名只改变 2.x 显示/登录字段，不改变 3.0 ActorRef。

未来原生多用户可以创建新的 opaque User ID 和 provider binding，但不得重用 username 作为主键。cluster-control 必须提供保持相同 current-version、disable/revoke 和 fail-closed 语义的 PostgreSQL adapter。

### 2. Legacy session authority 是三个条件的交集

`LegacyPanelAuthenticationService` 只有同时满足以下条件才返回 principal：

1. token 是有界 canonical JWT，签名算法精确为 HS384；
2. payload 精确包含 `data/iat/exp`，签名、`iat <= now < exp` 均有效；
3. token 仍存在于当前 2.x primary token 或请求 platform 对应的 token list；
4. `legacy_panel/singleton` 最新 binding active；
5. 对应 IdentitySubject 为 active user。

签名有效但已 logout、platform 错位、binding revoked、subject disabled 或 identity 损坏都 fail closed。JWT/request 不得自报 subject、role、scope、assurance 或 Project。`authenticationId` 是 `legacy_panel:` 加 token SHA-256，只用于非 Secret 关联；原 token 不进入 identity 表、RoleBinding、错误或审计字段。

session source 兼容 2.x primary string、platform string 和 `TokenInfo[]` 三种现存格式；候选数量和单 token 字节数有硬上限，损坏/超载返回 unavailable，不能降级成“只要签名正确”。比较使用 SHA-256 后的 constant-time equality。

### 3. Legacy assurance 永远是 single_factor

2.x token 没有不可篡改的 `amr/acr` 或“本次签发已完成 TOTP”声明。当前 `twoFactorActivated=true` 只描述账号现在启用了 TOTP，不能证明一个较早签发且尚未 logout 的 token 完成过第二因素。

因此所有 legacy panel principal 固定为 `assurance=single_factor`。未来只有新认证协议在 credential 内绑定并验证 factor evidence 后，才能返回 `multi_factor`；不得根据当前设置、UI 路径或调用者参数推导。

### 4. Identity disable 与 authentication binding revoke 分离

- disable IdentitySubject：停止该 User 的所有 provider authentication；
- revoke AuthenticationBinding：只停止某 provider/external subject 的映射；
- logout/token removal：只停止对应 session；
- RoleBinding revoke：只撤销某 Project 权限，不改变身份认证。

四者不得互相替代。当前切片只实现 baseline、current resolve 和认证读取，不开放 identity mutation API；未来 mutation 必须 append binding version、使用 subject CAS 并追加低敏审计。

### 5. 不提供伪安全的在线 local-console issuer

本 ADR 明确拒绝在当前同 UID 执行模型中用下列信号直接构造 `system/owner-bootstrap + local_console`：

- 请求来自 loopback；
- CLI 进程有 TTY；
- capability 文件模式为 0600；
- 调用者 Unix UID 与控制面相同；
- 某个环境变量或命令行 flag 存在。

这些条件同样可能被用户脚本满足。可接受的后续实现必须选择并验证至少一种真实隔离：

当前 2.x 启动顺序也不存在可直接复用的 HTTP claim 安全窗口：cluster master 完成 migration 后先 fork gRPC worker，再 fork HTTP worker；HTTP worker 在 `listen` 前执行 `initData()` 和 `initTask()`，其中 system token task 可 `runImmediately=true`，已有 Cron 也会在 loader 阶段注册/启动。也就是说，在首个 HTTP 请求到达前，同 UID 任务已经可能运行。可信首装 ceremony 必须移动到 cluster master 的任何 worker pre-fork gate，或先完成 Executor 独立 UID 隔离；不能只新增一个“仅首次启动可访问”的 HTTP route。

1. 在任何用户任务/Executor 启用前完成一次性安装 ceremony，并在启用任务前销毁 issuer capability；
2. 使用用户任务不可达的独立 UID/host agent，通过 peer credential 提供一次性签发；
3. 服务完全停止且持有可验证的 offline maintenance lease，保证没有任务进程和控制面竞争；
4. deployment orchestrator 注入硬件/平台证明，且该证明不暴露给 Executor。

在上述边界落地前，owner bootstrap issue 继续 production unreachable。legacy panel authentication core 只能为未来 claim/wire adapter提供稳定 user，不能自行签发 challenge。

### 6. 当前切片保持 production unreachable

本切片实现 `0019`、schema ownership、Identity Directory SQLite resolver、legacy Auth snapshot parser 和 authentication service，但没有：

- `shareStore`/Express 到 session source 的生产装配；
- `/api/v3` middleware 或 bootstrap claim route；
- local-console issuer、安装向导或 offline maintenance lease；
- identity disable/revoke 管理 API 和审计事件；
- PostgreSQL adapter 与跨方言 contract suite；
- 原生多用户、MCP/API App/Agent authentication adapter。

因此现有 `/api/*` 行为不变，`default` Project 仍没有 owner。新增 baseline identity 只是稳定映射候选，不产生任何权限或外部可达能力。

## 影响

正面影响：

- legacy 用户改名不会改变 3.0 审计主体；
- logout、token platform 和 identity revoke/disable 都能独立 fail closed；
- 不复制 credential，edge 只增加两张小表和一次有界点查；
- 2FA assurance 不会被当前设置错误提升；
- 明确暴露同 UID 部署的信任限制，避免不安全 CLI 进入生产。

代价与风险：

- 所有 2.x panel session 暂时映射到同一 singleton User，无法区分共享账号背后的自然人；
- 每次 3.0 认证在现有 session 检查外增加一次 identity 点查；
- 当前 core 不接路由，用户仍不能完成 owner claim；
- 真正 local-console ceremony 可能要求启动顺序、UID 隔离或停机运维变化。

## 未选择的方案

1. **username 作为 User ID**：可修改、可能复用，审计漂移，拒绝。
2. **JWT `data` 作为 User ID**：每次登录随机变化且属于 credential，拒绝。
3. **只验证 HS384 签名**：logout 后 token 仍可能在到期前通过，拒绝。
4. **system App 映射为 User**：把机器 credential 提升成交互用户，拒绝。
5. **`twoFactorActivated` 推导 MFA**：不能证明 token 签发时完成过 TOTP，拒绝。
6. **migration 自动创建 owner binding**：身份迁移不等于授权同意，拒绝。
7. **同 UID 在线 CLI 视为 local console**：用户任务具有相同能力，拒绝。

## 验证要求

- migration baseline 与 username/token/password/TOTP 完全无关，不创建 RoleBinding；
- username 变化不改变 `user/usr_legacy_primary`；
- HS384、精确 payload、毫秒级 active window 和 current-session membership 全部验证；
- logout、platform drift、wrong signature/algorithm、extensible JWT/request 在 identity 副作用前拒绝；
- legacy primary string、platform string 和 `TokenInfo[]` 兼容且有硬上限；
- authentication ID 只包含 token digest，错误不泄漏 token；
- binding revoke、subject disable、损坏 storage/session source fail closed；
- assurance 始终为 `single_factor`；
- Node 22/24 全量测试、类型检查、schema audit 和 GitNexus reachability 通过；
- app/loaders/api/services/shared/data 不得导入或装配本切片。
