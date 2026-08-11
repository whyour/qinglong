# ADR-0170：Durable Model Usage Ledger 与有界 Project Accounting

- 状态：Accepted
- 日期：2026-07-26
- 关联：RFC D-12、D-13、D-156、D-157、D-158、D-160；ADR-0167、ADR-0168、ADR-0169

## 背景

ADR-0168 已把每次模型调用固定为既有 `StepRun.kind=model` 的 Start/Completion
receipt。Completion JSON 虽然包含 token 与可选费用，但它不适合直接承担 Project
账本：

- SQLite/PostgreSQL 只能对 JSON 做高成本扫描，无法使用 Project/时间索引；
- Provider 可能在 Gateway 最终失败、超时或结果未知时仍产生 token/费用；
- “没有费用值”和“费用为零”是两种不同事实；
- Completion 已提交但账本缺失会让 replay、配额和报表产生不一致；
- 低配路由设备不能因为 AI 未启用而创建表，也不能让一次汇总扫描无限行；
- Cluster 多副本需要与 Completion 相同的事务、复制和 promotion 语义。

该能力没有新的部署边界，不应再拆一个只有少量文件的 workspace package，也不能进入
默认 edge/standalone 的主 migration。

## 决策

### 1. Usage Ledger 是 Completion 的不可变派生事实

新增 `qinglong/model-invocation-usage-ledger@v1`，留在既有
`@qinglong/ai/usage-ledger` subpath。每行以 `invocationId` 唯一绑定：

- Project、Run、StepRun、Trace；
- Provider、model、policy revision；
- Completion digest、outcome、settled time；
- input/output bytes；
- input/output/total tokens；
- nullable `costMicros`；
- domain-separated ledger digest。

Ledger 不保存 Prompt、输出正文、SecretRef、credential、authorization header 或错误
正文。`totalTokens` 必须精确等于 input 与 output token 之和。

只要 Completion 携带 usage，就必须创建 ledger，不以 `outcome=succeeded` 为前提；
Provider 已计费但 Gateway 因预算、协议或后处理失败时仍保留事实。Completion 的 usage
为 null 时不创建 ledger，也绝不能合成 token=0、cost=0 的伪记录。

### 2. Completion 与 Ledger 必须同事务提交

SQLite/PostgreSQL repository 在规范化 Start 和 Completion 后确定性派生 ledger：

- 新 Completion 与非空 ledger 在同一事务插入；
- 任一数据库约束、StepRun/Run fence 或 ledger 写入失败时整体回滚；
- exact Completion replay 必须同时看到 exact ledger；
- 预期有 ledger 但缺失/损坏，或预期无 ledger 却存在行，均以 conflict fail closed；
- 不允许异步事件消费者、后台补写、timer 或 best-effort reconciliation。

这不会建立新的 invocation 状态机。Ledger 只是原 Completion 的一对一不可变投影，
StepRun 仍是唯一执行状态权威。

### 3. Feature migration 继续独立且 append-only

不改写已验收的 9001 migration 或 checksum。新增：

- SQLite `9002-ai-model-usage-ledger`；
- PostgreSQL `pg-9002-ai-model-usage-ledger`；
- SQLite `ModelInvocationUsageLedger`；
- PostgreSQL `ql3_ai.model_invocation_usage_ledger`。

表以复合外键绑定 `(invocationId, completionDigest)`，mirrored columns 与 exact JSON
由数据库 CHECK 绑定，并建立 `(projectId, settledAtMs, invocationId)` keyset 索引。
PostgreSQL `ql3_runtime` 只取得 `SELECT, INSERT`，没有 `UPDATE, DELETE`；PUBLIC 和
其它业务角色不获得权限。

AI 未启用时不执行 9001/9002、不创建 `ql3_ai` 或 SQLite feature 表、不增加默认
edge/standalone packlist。没有新增 workspace package或第三方依赖。

### 4. 查询必须同时限制窗口、页和扫描行数

账本公开三种读取：

- invocationId 精确查找；
- Project + `[from, to)` + `(settledAtMs, invocationId)` keyset 分页；
- Project + 时间窗口聚合。

时间窗口最长 366 天，明细页最多 128 条。聚合不能只依赖时间窗口；双方言先按同一
索引最多读取 `100001` 行，超过 100,000 行返回稳定
`MODEL_INVOCATION_USAGE_SUMMARY_LIMIT_EXCEEDED`，不返回不完整总额。大规模 Cluster
需要后续不可变 rollup，而不是放宽单次扫描。

Summary 分开返回 `knownCostMicros` 与 `unknownCostInvocations`。unknown cost 不能
解释为零；未来启用费用配额时，只要目标窗口不完整或存在 unknown cost，费用准入就
必须 fail closed，除非受审策略明确只约束 token 而不约束费用。

### 5. Retention 不能直接删除原始事实

首版保持 append-only，不实现 raw row deletion。未来 retention 必须先定义：

1. 与原始 ledger digest 范围绑定的不可变 Project/time rollup；
2. 可证明完整覆盖的 retention receipt/tombstone；
3. SQLite 断电恢复、PostgreSQL promotion/backup restore 和审计导出的共同语义。

在这些事实存在前，不能为了节省空间直接删除 ledger、Completion 或 Start。路由设备
可通过不启用 AI、缩短产品允许的历史窗口和显式存储容量门控制成本，但不能静默丢账。

## 被否决方案

1. 直接扫描 Completion JSON：没有稳定索引，路由设备和 Cluster 都会获得不可控查询。
2. 只为 succeeded 建账：Provider 已产生费用但 Gateway 后续失败时会漏账。
3. 无 cost 记为 0：会把未知事实伪装成免费调用并绕过费用配额。
4. 异步写 ledger：崩溃和 COMMIT response loss 会产生 Completion/ledger 裂缝。
5. 把账本拆成新 package：没有独立部署、依赖或权限边界，只会继续细化 package。
6. 把账本加入默认 storage migration：禁用 AI 的路由设备也会承担 schema、备份和写放大。
7. 直接删除旧行：会破坏 Completion 对账、审计与未知结果人工裁决的证据链。

## 当前验证

- `@qinglong/ai`：50 pass、1 条 PostgreSQL 条件 skip；真实 PostgreSQL 另 1 pass；
- SQLite 覆盖 Completion+ledger 原子提交、整体 rollback、exact replay、缺行
  fail closed、Project 查询/summary 与无 usage 不建行；
- PostgreSQL 18.4 migration/runtime 双角色真库覆盖 9002 DDL、append-only ACL、
  原子提交、查询和 recovery；
- 9001 checksum 保持
  `69f72286fba2988ba372f006eb894a7f8b89f4b1acd9da68dc1cdafc3ca96ea7`，
  9002 checksum 为
  `95ad6f46163b0bbc2583dddf492f91f767a00554683186f244d3f6a22a2ad00c`；
- PostgreSQL 18.4 arm64 HA 门在 timeline 1→2 前后精确比对四张 `ql3_ai`
  invocation 表、9001/9002 history/checksum 与四表 runtime append-only ACL；
  physical streaming、`remote_apply`、fence-before-promote、`pg_rewind`、双 fresh
  control 和总 `passed=true`；
- dependency audit 覆盖 22 importer、AI 14 个源码文件，`findings=[]`；
- disabled AI 只加载 1 个模块，storage/provider loader 零调用，RSS 增量
  409,600 bytes；
- 默认 edge 保持 3,902,728 bytes/478 files/40 modules；edge-ai 为
  4,212,508 bytes/508 files/41 modules，standalone-ai 为
  4,212,580 bytes/508 files/41 modules，均低于 5 MiB/640 files；
- 22-package 全量 build/test 退出 0。

## 后续门禁

1. 基于不可变 ledger/rollup 的原子 Project token/cost quota admission；
2. price catalog、计价 revision、币种和 provider-reported/derived cost 来源契约；
3. retention rollup、coverage receipt、导出、备份恢复与实机磁盘耗尽证据；
4. 产品 read-only usage API/CLI/UI、认证、Policy、rate limit 与低敏审计；
5. AI invocation 数据行级 partition/COMMIT-response-loss HA fault，而不只 schema
   promotion；
6. 在上述门禁完成前保持产品 AI route 和费用配额默认关闭。
