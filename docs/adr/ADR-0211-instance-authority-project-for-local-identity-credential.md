# ADR-0211：Local Identity/Credential 的实例 Authority Project

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-198、D-199、D-200、D-201
- 关联 ADR：ADR-0028、ADR-0074、ADR-0086、ADR-0185、ADR-0208、
  ADR-0209、ADR-0210

## 背景

Project RoleBinding 是 Project-scoped policy；Identity 与 API credential 则没有
`project_id`，是实例级全局安全对象。ADR-0209/0210 最初要求调用者是请求 Project
的 Owner，但未证明该 Project 对全局 Identity/Credential 拥有 authority。

当实例包含多个 Project 时，这会允许 Project A 的 Owner：

- 禁用也被 Project B 使用的全局 Identity；
- 撤销或轮换该 Identity 的 API credential；
- 查询任意已知 credential ID 的状态和时间窗；
- 通过直接调用 authorized repository 绕过只放在 CLI/service 的限制。

Project 内 `project.manage` 不能隐式等同于实例 root credential issuer。

## 决策

### 1. 实例 Authority 锚定首个成功 Owner bootstrap claim

Local Identity/Credential authority Project 定义为：

1. 在 `QingLong3LocalOwnerBootstrapChallenges` 中选择
   `consumed_at_ms IS NOT NULL` 的全库最早记录；
2. 以 `consumed_at_ms ASC, project_id ASC, version ASC` 提供确定性排序；
3. 该记录的 `project_id` 是实例 authority Project。

成功 claim 是已有的 durable、append-once bootstrap 事实，不随后续 RoleBinding
grant/revoke 或当前 Owner 人员变化。challenge delivery acknowledgement GC 不删除
challenge source，因此 anchor 可恢复。

为兼容在该协议前创建或通过 adoption/manual fixture 建立的数据库，仅当全库没有任何
consumed bootstrap challenge 时，若迁移内建 `default` Project 存在，则将其作为
fallback authority。存在任一 consumed challenge 后禁止回退。

### 2. 服务层先验证 Project Owner，再验证实例 authority

local-admin 的顺序固定为：

1. 对 command 指定 Project 请求 Owner-only `project.manage`；
2. deny/approval/unavailable 按既有低敏语义审计；
3. 解析实例 authority Project；
4. 若不匹配，写 `denied` +
   `instance_authority_project_required` audit；
5. 只有匹配后才能解析 replay、Identity 或 credential 状态。

这样 foreign Project Owner 不能利用 found/not-found、version conflict 或 replay
差异枚举全局对象。

### 3. SQLite 最终事务必须重复 authority fence

服务层不是最终 authority。所有以下 repository operation 在 `BEGIN IMMEDIATE`
取得写锁并复验当前认证 credential 后，必须重新解析 authority anchor：

- `inspectAuthorizedIdentity`；
- `appendAuthorizedIdentity`；
- `inspectAuthorizedCredential`；
- `appendAuthorizedCredential`；
- `appendAuthorizedDeliveryAcknowledgement`。

只有 `authorization.projectId` 等于 anchor，才继续验证 Project version、actor 最新
Owner RoleBinding 和领域 CAS。否则抛出统一 authorization fence conflict 并回滚。
因此 direct repository 调用和 authorization→transaction 间的 anchor 漂移都失败
关闭。

### 4. 不改变 Project Policy 产品边界

`ql3-policy` 仍管理各 Project 自己的 RoleBinding。授予 secondary Project Owner
只授予该 Project 的业务权限，不授予全局 Identity/Credential issuer 权限。

本决策不增加数据库迁移、第 23 个 package、第三方依赖、daemon、timer、watcher、
listener 或远程 API。Cluster 继续使用独立 PostgreSQL/RBAC authority。

## 替代方案

### 任意 Project Owner 都可管理全局 Identity

拒绝。Project RBAC 与实例 credential issuer 的作用域不同，会形成横向越权。

### 永久硬编码 `default`

拒绝作为唯一规则。它能兼容当前默认部署，却会否定合法地在其他 Project 完成首次
Owner bootstrap 的数据库。

### 选择“当前拥有最多权限的 Owner”或最新 Owner

拒绝。authority 会随日常 RoleBinding 变更漂移，产生静默 takeover，并使旧 command
不可重放。

### 新增 InstanceRole/GlobalRole 表

暂不采用。首个 Owner claim 已提供足够的不可变实例根事实；新增全局 RBAC 需要独立
迁移、恢复和管理 ceremony，超出当前最小修复。

### 只在 CLI 校验 authority Project

拒绝。local-admin 或 repository 仍可被其他 adapter 直接调用，无法形成 authority
边界。

## 影响

正向影响：

- secondary Project Owner 无法修改、查询或确认全局 credential delivery；
- authority 不随 Project Owner 交接漂移；
- 自定义首次 bootstrap Project 可被识别；
- 旧库在没有 claim 事实时继续使用既有 `default` 行；
- 低配设备只增加每次管理命令的两个有界索引查询，无常驻成本。

代价与限制：

- 多 Project 部署的 Identity/Credential 管理必须由 authority Project Owner 发起；
- 当前没有受审的 authority Project 转移 ceremony；
- fallback 数据库应在后续 adoption evidence 中明确标记“无 bootstrap anchor”；
- InstanceRole 若未来引入，必须用新 ADR supersede 本决策。

## 验证

- GitNexus 对最终事务 helper 的影响分析为 HIGH：5 个 direct repository operation、
  1 个 `changeCredential` execution flow；必须运行全部相关回归；
- service 测试证明 secondary Project 的 Owner 即使通过自身 Project policy，也收到
  统一 denied audit；
- 真实 SQLite/CLI fixture 同时创建 default 与 secondary Owner，secondary
  `credential.inspect` 必须被拒绝；
- 直接以 secondary Project Owner fence 调用 authorized SQLite repository，必须在
  transaction 内抛出 authorization fence conflict；
- default authority 的 register → inspect → issue → exact replay → acknowledge →
  revoke → disable 流程保持通过；
- strict targeted TypeScript、local image/dependency audit 与 GitNexus
  `detect_changes` 必须重跑；
- 完整 workspace、artifact/RSS 和 PostgreSQL HA 门在锁定依赖恢复后重跑。
