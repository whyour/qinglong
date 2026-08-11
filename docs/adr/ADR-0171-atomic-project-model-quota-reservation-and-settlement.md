# ADR-0171：原子 Project Model Quota Reservation 与 Settlement

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-12、D-13、D-157、D-158、D-160、D-161；ADR-0167、ADR-0168、ADR-0170

## 背景

ADR-0170 的不可变 UsageLedger 能回答“已经发生了多少用量”，但单独在 provider
调用前读取 summary 不能构成安全配额：

- 两个 Cluster 副本可能同时读到剩余额度并共同超卖；
- provider 返回前不知道精确 token/费用，不能只在完成后扣减；
- crash、caller abort 或 provider outcome unknown 时释放额度会允许重试绕过预算；
- 只按 token 汇总会遗漏 invocation 数量和 nullable cost 的不确定性；
- Router 设备不能获得后台 rollup、timer 或常驻 quota service；
- 配额准入若与 `StepRun ready → running` 分事务，会产生有调用权但无预留，或有预留
  但无执行权的裂缝。

配额没有独立部署、依赖或权限边界，因此不新增 workspace package。它继续属于已有
`@qinglong/ai` 可选能力。

## 决策

### 1. 固定窗口策略与最坏情况预留

`ModelInvocationPolicy` 可选携带 Project quota：

- 独立 quota policy revision；
- 固定、epoch 对齐的 `1 minute | 1 hour | 1 day` 窗口；
- `maxInvocations`、`maxTokens`；
- nullable `maxCostMicros`。

准入按单次 model policy 的 `maxTotalTokens` 和 nullable `maxCostMicros` 预留，而不是按
请求方估计值预留。Project 开启费用配额但单次调用没有费用上限时，配置失败关闭；
不能把 unknown cost 当成零。

窗口边界由数据库时钟决定。Gateway 的 `occurredAtMs`、HTTP 时间或 Worker 时间不能
选择计费窗口。

### 2. Reservation 与 Settlement 都是不可变 receipt

新增：

- `qinglong/model-invocation-quota-admission@v1`；
- `qinglong/model-invocation-quota-reservation@v1`；
- `qinglong/model-invocation-quota-settlement@v1`。

Reservation 一对一绑定 invocation、Project、model/quota policy revision、窗口、窗口
预算、单次预留与独立 digest。Settlement 一对一绑定 Reservation digest 和 Completion
digest。

Completion 有精确 usage 时，Settlement 使用实际 token；仅在已经建立费用预留时使用
实际费用并释放未用预留。未启用费用配额时 quota settlement 的费用保持 null，真实
billing cost 仍由 UsageLedger 保存。usage 为 null 时保留全部 token 预留；费用有配额
但实际费用未知时保留全部费用预留。实际值超过预留属于 durable contract 破坏并失败
关闭。

Reservation/Settlement 不是第二执行状态机。StepRun 仍是执行状态权威，二者只解释
窗口内的有效占用。

### 3. 准入与完成必须分别原子提交

SQLite `BEGIN IMMEDIATE` 在同一事务中完成：

1. 数据库时钟窗口计算；
2. 当前窗口有效占用聚合；
3. quota fence；
4. StepRun/Run/Event/Mutation；
5. ModelInvocationStart；
6. QuotaReservation。

PostgreSQL 在相同事务流程前，对
`JSON.stringify([projectId, windowStartMs, windowMs])` 的稳定 hash 获取 transaction
advisory lock。同一 Project/窗口的不同实例因此串行化；hash collision 最多扩大串行
范围，不能导致少算。没有可变 quota bucket，也不需要给 runtime `UPDATE` 权限。

Completion、UsageLedger 和 QuotaSettlement 与 StepRun terminal mutation 同事务写入。
exact replay 必须同时复验 Start/Completion、Ledger、Reservation、Settlement；任一
预期 receipt 缺失、意外存在或 digest 漂移都 conflict fail closed。Recovery 发现已有
Reservation 时必须通过 quota-aware completion，unknown outcome 保留预留。

### 4. 9003 仍是可选 append-only feature migration

不改写 9001/9002。新增：

- SQLite `9003-ai-model-usage-quota`；
- PostgreSQL `pg-9003-ai-model-usage-quota`；
- Reservation/Settlement 两张双方言表及 Project/window 索引。

PostgreSQL `ql3_runtime` 对新表只有 `SELECT, INSERT`，没有 `UPDATE, DELETE`。PUBLIC
和其它业务角色不获得权限。AI 禁用时不执行 9001/9002/9003，不建表、不加载 provider
或 credential，也没有 timer。

代码继续留在 `@qinglong/ai/usage-quota`、现有 Gateway/coordinator/repository/Profile
subpath；没有新增 package 或第三方依赖。这一边界符合“按部署/依赖/权限拆包，而不是按
文件数拆包”的 QL3 package 规则。

### 5. Profile 只公开内部只读能力

Active AI Profile 增加 bounded ledger page、bounded summary 和当前 quota window usage
三种内部读取。它们复用 storage authority 和 drain 计数，不创建后台服务。

本 ADR 不开放 HTTP/MCP/UI route。产品入口仍必须另行完成 Principal、Project Policy、
rate limit、低敏审计和错误屏蔽，不能把内部 capability 等同于已授权 API。

## 被否决方案

1. provider 调用前先读 UsageLedger：多副本存在 TOCTOU，会超卖。
2. provider 完成后才扣额度：预算不能阻止本次外部费用。
3. unknown outcome 立即释放：重试可循环绕过配额。
4. 可变 Project quota bucket：需要 runtime UPDATE、CAS/recovery 与第二套可变权威。
5. 依赖应用时钟选择窗口：调用方可把用量写入其它窗口。
6. 为 quota 新拆 package/service：没有独立部署收益，会增加路由器制品和依赖碎片。
7. 默认迁移 quota 表：未启用 AI 的设备承担无效 schema、备份和写放大。

## 当前验证

- `@qinglong/ai`：60 pass、1 条 PostgreSQL 条件 skip；真实 PostgreSQL 18 另 1 pass；
- SQLite 覆盖 reservation+Start 原子准入、超额整体 rollback、known usage 释放、
  unknown recovery 保留 token/cost 与 Profile 只读组合；
- PostgreSQL 18 双 runtime 连接并发争抢 `maxInvocations=1` 时恰好一笔成功，另一笔稳定
  返回 `MODEL_PROJECT_QUOTA_EXCEEDED`；
- PostgreSQL runtime 对 Reservation/Settlement 只有 SELECT/INSERT；
- 9001/9002 checksum 保持不变；SQLite 9003 checksum 为
  `fa734aac1a3f5affaf69f4fbe53a2c6ca628255ecdcde14c08b87b49d8162012`，
  PostgreSQL 9003 checksum 为
  `13ea1a904eb799bcae1b474d76b164a70748bdcca8e1e6ded9952921a291a855`；
- PostgreSQL 18.4 arm64 physical HA 在 `remote_apply`、timeline 1→2 promotion、
  fence-before-promote、`pg_rewind` 和双 fresh control 下，精确复验六张 `ql3_ai`
  表、9001/9002/9003 history/checksum 与六表 runtime append-only ACL 前后完全一致，
  `optionalAiFeatureSchemaSurvivesPromotion=true` 且总 `passed=true`；
- 22-package build/test 全部退出 0；dependency audit 覆盖 22 importer、AI 15 个源码
  文件且 `findings=[]`；
- 默认 edge 为 3,902,728 bytes/478 files/40 modules；edge-ai 为
  4,288,019 bytes/510 files/41 modules，standalone-ai 为
  4,288,091 bytes/510 files/41 modules，均低于 5 MiB/640 files；disabled AI
  只加载 1 个模块且三个 Profile loader 均为 0；
- 没有新增 workspace package 或第三方依赖。

## 后续门禁

1. 增加 price catalog、币种、计价 revision 和 provider/derived cost 来源契约；
2. 增加不可变 rollup、coverage receipt、retention 与磁盘耗尽证据；
3. 完成受认证、Project Policy-fenced 的 usage/quota API、CLI/UI 和 rate limit；
4. 增加 invocation reservation/settlement COMMIT-response-loss 与 promotion 期间的
   数据行级 fault，而不只验证 schema promotion；
5. 在产品权限与运维门完成前保持 AI route 和 Project quota 默认关闭。
