# ADR-0096：强认证且有界的 Legacy adoption 决策回执

- 状态：Accepted（纯回执契约、逐项流式验证、source/plan 复核、ADR-0097 私有 HMAC 载体及 ADR-0098 Policy/audit 同事务 publisher 已实现；产品 issuer ceremony 待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-03、D-04、D-08、D-17、D-23、D-62、D-70、D-88、D-90、D-91、D-92、D-93、D-94、D-95、D-96
- 关联 ADR：ADR-0086、ADR-0087、ADR-0088、ADR-0091、ADR-0092、ADR-0093、ADR-0094、ADR-0095、ADR-0097

## 背景

ADR-0095 能把每个 Legacy Crontab 稳定分类并绑定到 plan v2，但分类不是处置。若未来 publisher 只检查 `mutationReady` 或接收一个全局“同意迁移”，它无法证明维护者是否看过 shell compatibility、unsupported、malformed 和显式排除项，也无法防止分页遗漏、重复、顺序错位或 source 更新后重放旧选择。

直接把最多 100,000 个 decision 放进 receipt 又会让路由设备承担无界 JSON/内存峰值，并让含有逐项信息的文件进入 activation 常驻路径。另一方面，仅有普通 SHA-256 不能证明调用方真的完成过认证；回执摘要只能证明内容未漂移，不能凭空创建 issuer authority。

## 决策

### 1. decision 与 classification 锁步，一行且只能一项

每个 decision 只包含 `rowOrdinal/sourceDigest/disposition/reason`。创建和验证回执时，decision iterable 与 classifier 的稳定诊断流同步前进：少一项、多一项、顺序不同、source digest 不同或 extensible shape 都立即失败关闭。classifier 仍执行最多 100,000 行的单遍 iterator scan，不缓存全表。

允许的 disposition 固定为：

- `adopt`：仅用于 `lossless + reviewed_lossless`；
- `adopt_shell_compatibility`：仅用于 `requires_shell_compatibility + reviewed_shell_compatibility`；
- `skip`：lossless/shell 可由 operator 或 security review 排除，manual 只能以 excluded/security/unsupported 跳过，malformed 只能以 `malformed_source` 跳过。

`requires_manual_action` 和 `malformed` 不能通过回执注入新的 command、cron 或 label 映射。要采用这些任务，必须先有受审的新语义或重新生成能 canonicalize 的 plan，不能把 arbitrary override 塞进 adoption authority。

### 2. receipt 只保存聚合证据，不保存 decision 数组

decision-set evidence 保存 row count、三类 disposition count 与域隔离 `decisionDigest`。摘要逐项覆盖 classifier 的 source digest、classification、reason codes、enabled、候选 task/trigger spec digest 以及最终 disposition/reason。receipt 再绑定 profile、plan digest、inventory digest、reviewer、时间和 decision-set evidence，并计算独立的域隔离 `receiptDigest`。

因此 receipt 大小与任务数无关；未来 publisher 必须同时取得 decision stream，并重算同一 digest。receipt 或 decision stream 任一方单独存在都不构成 mutation authority。

### 3. issuer 必须是最近强认证的 User

reviewer 使用共享 `SecurityPrincipal` exact contract。只接受 `user`，assurance 必须是 `local_console`、`multi_factor` 或 `hardware`；认证距 issuance 最多 5 分钟。receipt lifetime 最长 30 分钟，且不能超过 principal expiry。decision ID 必须是 lowercase UUIDv7。

该纯模块只验证受信 composition root 传入的 principal，不能验证 principal 的外部来源，也不把摘要描述成数字签名。ADR-0097 已以专用 key provider、HMAC-SHA-256 和私有 no-replace NDJSON 绑定完整 decision stream，但正式 publisher Gate 仍要求 local console/管理入口完成认证、Policy、撤权 fence 与 durable audit；在该 Gate 完成前，即使持有合法 authorization file 也不能获得写 authority。

### 4. 创建和验证都重新检查当前 source

公开 local-admin API 先以 `expectedPlanDigest` 重建 plan，再以同一 canonical timezone 打开 defensive/query-only source。decision scan 前后检查文件 identity；receipt 的 profile、plan digest 和 inventory digest 必须与当前 reviewed source 完全一致。验证还要求 observation time 落在 receipt 有效期内。

这意味着回执不能跨 plan、跨 Profile、跨 timezone 或跨 Crontab 内容复用。即使 receipt 自身摘要仍正确，source 漂移也会在进入 publisher 前失败。

### 5. review 模块保持短生命周期与 lazy boundary

decision receipt 是 `@qinglong/local-admin` 的内部模块，不新增 workspace package。它只按需加载 classifier 与 `runtime-core/security` subpath；`@qinglong/local-admin/runtime` 不载入 decision/classifier，也不创建 timer、watcher、连接池或 Scheduler。

## 被否决的替代方案

1. **一个全局 approve boolean**：不能证明逐项覆盖，拒绝。
2. **receipt 内嵌全部 decision**：任务数越大，JSON/内存越大，不适合路由设备，拒绝。
3. **manual 项携带任意 replacement command/spec**：绕过冻结 semantic registry 与 plan review，拒绝。
4. **允许单因素或 service principal 审阅 shell**：无法满足本机高风险接管边界，拒绝。
5. **摘要等同于签名或认证**：SHA-256 可由持有内容者重算，不能证明 issuer，拒绝。
6. **receipt 一生成就允许 publisher 写入**：即使 ADR-0097 已补 durable authenticated decision stream，Policy/audit 和共同事务仍未完成，拒绝。
7. **为回执新拆 package**：没有独立部署或供应链边界，拒绝。

## 验收证据

1. local-admin 测试覆盖四类诊断对应的 adopt/shell-adopt/skip 矩阵和低敏输出。
2. 测试覆盖 decision 缺失、额外、source digest 错位、classification 越权、弱认证、receipt tamper、expiry 与 source drift。
3. receipt create→JSON round-trip→verify 产生完全相同的 canonical receipt。
4. runtime import 测试证明 activation subpath不加载 migration SQL、classifier 或 decision receipt。
5. dependency audit 只允许 classifier 访问 Task/Trigger semantic subpath，只允许 decision receipt 访问 security subpath；ADR-0097 的 HMAC 载体另仅访问 local-secret provider contract。

## 后续约束

ADR-0097 已补 durable decision-set carrier 与 key-backed issuer capability；ADR-0098 已实现本机原子 publisher、Project/RoleBinding fence、allowed audit 和 batch ledger。publisher 在 fenced source 与同一 authenticated descriptor 上逐项锁步，并在目标单一 SQLite write transaction 中为每个 `adopt*` 项同成同败地创建 TaskDefinition、context recipe、execution revision 与 Trigger；`skip` 不创建 head。产品 issuer ceremony、Scheduler、Run admission、物理写放大与 legacy process cutover 仍保持独立 Gate。
