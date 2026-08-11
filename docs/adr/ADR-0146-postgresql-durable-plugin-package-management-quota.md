# ADR-0146：PostgreSQL Durable Plugin Package 管理配额

- 状态：Accepted
- 日期：2026-07-25
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-49、D-50、D-123、D-142、D-143
- 关联 ADR：ADR-0051、ADR-0125、ADR-0142、ADR-0144、ADR-0145

## 上下文

ADR-0145 的 fixed-memory peer/global shield 位于认证前，只能保护单个进程的连接、
body 和认证成本。双副本部署会把该预算按副本数放大；它既不知道 User/Project，也
不能在 Pod 重启或切换后保留业务公平性。把匿名入口请求写入 PostgreSQL 又会让攻击
流量消耗要保护的连接池。

管理写入已经使用稳定 `actionRef` 和 `decisionId`，但公开 `inspect` 原先既没有独立
幂等身份，也直接调用内部只读方法。后者会允许任意强认证 User 按 ID 探测其他
Project 的 proposal/Approval，且无法形成正确的
`Project + subject + operation` 配额键。

## 决策

### 1. 配额是认证和 Project Policy 之后的领域端口

`@qinglong/runtime-core/plugin-package-management` 增加可选
`PluginPackageManagementQuotaPort`，不新增 workspace package或第三方依赖。

- `propose` 在 action 规范化、当前 `package.manage` Policy 允许之后消费额度，幂等
  身份为 `actionRef`；
- `decide` 在读取 durable Approval、当前 `approval.decide` Policy 允许之后消费，
  幂等身份为 `decisionId`；
- quota 拒绝发生在 proposal/Approval mutation 前；
- 未授权请求不得创建或消耗其他 Project 的 bucket；
- local/edge composition 不注入该 port，因此没有 PostgreSQL、timer 或常驻成本。

Cluster 公开 `inspect` 增加显式 `inspectionId`。manager service 先读取 proposal 与
Approval，复验两者的 Project/action/digest 绑定，再要求当前 User 具有
`package.manage` 或 `approval.decide` 权限，最后消费 inspect quota。不存在的对象
返回统一 conflict，未授权对象返回 forbidden，不再通过公开 transport 调用无授权
内部 inspect。

### 2. 单行、固定窗口、数据库时钟

`pg-0023-plugin-package-management-quota` 将 `control-core` 推进至 capability v22，
新增一张表：

```text
plugin_package_management_quota_buckets
  PK(project_id, subject_type, subject_id, operation)
  window_started_at_ms
  consumed_count
  receipt_ids
  updated_at_ms
```

裁决使用 PostgreSQL `clock_timestamp()`；调用方时间和 Pod 本机时间不参与窗口。一个
SQL statement 使用 `INSERT ... ON CONFLICT DO UPDATE` 锁定 bucket：

1. 过期窗口按数据库时间重置 count 和 receipt；
2. 当前窗口已经存在相同 receipt 时返回成功但不递增；
3. 未重放且 count 未到 limit 时原子递增并追加 receipt；
4. 已满且不是重放时不更新，随后只读当前 bucket 计算 `Retry-After`。

receipt 与 count 同行、同窗重置，`jsonb_array_length(receipt_ids)` 必须等于
`consumed_count`。单 bucket 最大 1000 项、JSON 最大 256 KiB，不创建逐请求永久表、
cleanup timer 或后台 GC。主体固定为 User，operation 只允许
`plugin-package.propose | decide | inspect`。

这不是滑动窗口，也不是计费 ledger。窗口边界附近的两个新请求可能分别落入两个
窗口；这是固定窗口的明确语义。write replay 还由 proposal/Approval durable identity
约束，quota receipt 只负责当前窗口内不重复扣减。

### 3. 最小权限与资源档位

仅 `ql3_package_manager` 获得 quota 表 `SELECT/INSERT/UPDATE`。`ql3_admin`、
`ql3_package_executor`、`ql3_runtime` 与 `ql3_worker_ingress` 均无权限，所有角色都
无 DELETE、owner 或 schema CREATE。

默认窗口 60 秒，默认 limit：

- propose：30；
- decide：60；
- inspect：600。

窗口硬上限 5 分钟，单 operation limit 硬上限 1000。Kubernetes base 与
CloudNativePG overlay 显式冻结上述值；每副本仍最多 2 条 manager 连接。认证前
process-local shield 保留，不能用 durable quota 取代 TLS connection、并发、body
或 ingress/WAF 容量保护。

### 4. 响应和故障语义

quota exhausted 映射为低敏 HTTP 429、`error.code=quota_exceeded` 和向上取整的
`Retry-After`，不返回 Project、subject、计数行或数据库诊断。数据库不可用、返回行
损坏或无法确定裁决时映射 503，失败关闭并保留现有 readiness fence。

裁决 SQL 是单 statement 的隐式事务。若 PostgreSQL 已提交而客户端未收到响应，
相同幂等身份重放会命中 receipt 并返回成功，不额外消耗额度；不得生成新 identity
后盲重试。

## 验证

已完成：

1. runtime-core 证明 quota 只在 Policy allow 后调用，quota 拒绝发生在任何
   proposal/Approval mutation 前；
2. PostgreSQL repository 证明 SQL 使用 `clock_timestamp()`、单语句 UPSERT、
   bounded receipt、exact replay、429 reset delay 和低敏 unavailable；
3. migration/schema/readiness 证明 v22、36 张表、Drizzle/catalog/CHECK/FK lockstep
   与 manager-only SELECT/INSERT/UPDATE；
4. cluster transport 证明公开 inspect 只走 authorized/quota-aware path，HTTP 证明
   429 与 `Retry-After`；
5. PostgreSQL 18.4 arm64 physical HA 门使用两个独立 manager instance 同时提交
   16 个不同 inspection：精确 8 allow、8 quota reject；已放行 identity 重放不再
   扣减；
6. 同一 HA 门在服务端自动提交成功后注入客户端响应丢失，重放后 durable count 仍为
   1；人工推进旧窗口后下一请求由数据库时钟重置为 count 1；
7. HA 总门增加为 23 个具体 gate，并继续通过 timeline 1→2、`remote_apply`、
   fence-before-promote、旧主 `pg_rewind` 只读同步重入与双 fresh control activation；
   运行后没有残留 `ql3-ha-*` container、volume 或 network。

## 后果

优点是双 Pod 共享同一业务裁决，Pod 数量和本机时钟不再放大认证后额度；单行状态使
低额度管理 API 的空间和锁竞争可预测，也不增加 Redis。代价是同一
Project/User/operation 的请求串行于一个 PostgreSQL 行锁，且固定窗口不是全局严格
平滑速率。当前默认上限和管理流量规模接受该取舍；若未来需要高吞吐或计费语义，应
新增独立 ADR，而不能扩张本表为无界逐请求日志。

本 ADR 关闭 durable management quota 阻断项，但不开放生产 ingress。全副本重启
后的 keyset anti-rollback、真实 IdP 两名 User 四眼、双 Pod live NetworkPolicy/
certificate rotation、production ingress/WAF 与告警仍必须完成。

ADR-0147 已在后续 `pg-0024`/capability v23 中关闭全副本重启 keyset
anti-rollback；其余真实 IdP/live ingress 前置保持不变。
