# ADR-0492：兼容 Secret/Config 的 Reconciliation Completion v3

- 状态：Accepted
- 日期：2026-08-24
- 决策：D-397
- 关联：ADR-0487、ADR-0488、ADR-0490、ADR-0491

## 背景

ADR-0488 的 completion v1 只识别 Application 与 Automation，ADR-0490 的 v2 再加入 Run History。ADR-0491 已经让 Secret/Config 形成 signed decision、原子 application receipt、写后 target snapshot、applied head 与可恢复 backup，但旧 completion 无法消费这些证明，也不能在全局完成后回收 Secret/Config 的数据库等量 rollback material。

Application plan 中 `secret_and_config` 的历史 action 是 `manual_external`。这是专用 adapter 获得授权前的正确失败关闭状态，不能改写 sealed plan 为 `adapter_required`。Completion 必须验证后续 plan、signed decision 和 apply 全链路，再在自己的 receipt 中把该域收敛为已证明的 adapter；它仍不能替其他 `manual_external` 域背书。

## 决策

### 1. 保持 v1/v2 精确兼容，新增 v3

`local.deployment.reconciliation.complete|complete.verify` 新增 schema v3。v1/v2 的输入 shape、receipt 语义和验证路径保持不变；只有 receipt 包含 `secret_config_application` 时版本才为 v3。v3 可同时携带 Automation、Secret/Config 与 Run History authority，`adapterCount` 由八域证据实际推导并扩大为 `0|1|2|3`，调用方不能自报。

Secret/Config completion binding 只包含 `secretConfigId`、`decisionId` 与 `expectedApplyDigest`。options 只携带 plan/decision/apply authority roots 和 target SQLite 路径，不重新携带 keyring、credential 或明文 material。所有 authority roots 必须互不重叠；Automation 与 Secret/Config 同时存在时必须指向同一个 target SQLite。

### 2. 证明链必须闭合

Completion 重新验证：

1. sealed Application plan 的 `secret_and_config=manual_external`；
2. 同一 Application 上 ready、无 skip 的 signed Secret/Config decision；
3. exact apply intent、receipt、decision/SecretConfig identity、preparation digest 与 apply digest；
4. 当前 target snapshot 等于 Secret/Config `targetAfter`；
5. apply storage 是合法的 `applied` 或 completion 后 `completed` layout，且不存在 rollback receipt；
6. source head 是 `reconciliation_secret_config_applied` 且绑定 apply digest。

若 Automation 也先写入同一数据库，当前 target 不再等于 Automation 的旧 `targetAfter`。此时链式证明固定为 `Secret/Config backup.sha256 == Automation targetAfter.sha256`，然后再验证当前 target 等于 Secret/Config `targetAfter`；不得把合法的后续写入误判为 Automation drift，也不得跳过两阶段之间的 digest 连续性。

Rolled-back state、target drift、decision/apply 脱离、提前丢失 backup、unknown `Configs`、Identity/Policy/Audit、Unknown 或任意其他未终态域都继续拒绝全局 completion。Secret/Config 已 applied 不代表整个 reconciliation 已完成。

### 3. durable head 先于 rollback material 回收

Instance lineage 新增唯一合法边：

```text
reconciliation_secret_config_applied → reconciliation_completed
```

既有边、generation、source digest 和 CAS 规则不变。Receipt 必须先 no-replace 发布并封存，随后 completed head durable，最后才可删除 Automation 与 Secret/Config backup。两类 storage 都接受 `applied|completed` 重放：head 尚未 completed 时 backup 缺失立即失败；head 已 completed 后允许任一 backup 已回收，并幂等收敛剩余 backup。

Secret/Config completed layout 删除的只有 `backup/before.sqlite`。加密 `materials.ndjson`、intent 与 apply receipt 保留为 `0400` audit evidence，root、backup root 与空 rollback work root 封为 `0500`。该操作不扫描数据库、不创建数据库等量副本、不引入 timer/GC，适合低容量 Edge；真正销毁 ciphertext 或 sealed Legacy source 仍是后续独立 retention ceremony。

### 4. 部署边界不变

实现全部位于既有 `@qinglong/local-owner-cli` 的 cutover、completion 与 Secret/Config application 子域，没有新增 workspace package、production dependency、SQL migration、daemon、listener、watcher、timer、Pool、容器或 Kubernetes workload。Edge/Standalone 常驻闭包不加载该一次性 Owner authority。

Cluster 不复用本机 receipt、POSIX storage 或 instance head。Cluster completion 仍需要 PostgreSQL SERIALIZABLE ledger、外部 Secret provider/KMS、HA timeline 与 promotion 后验证。

## 影响

- completion receipt 的消费者必须按 `schemaVersion` 解析，未知版本继续失败关闭。
- `advanceLocalCutoverInstanceHead` 是 CRITICAL 共享状态机；本 ADR 只增加一条 source-state 边，不改任何旧 transition。
- 完整迁移库当前仍可能因 `identity_policy_audit` 或 `unknown` 保持 manual；这是正确的全局围栏，不应为了演示 v3 成功而放宽。
- v3 verify 要求 completed storage，不能在 head durable 之前充当修复命令。

## 被拒绝的替代方案

### 改写 sealed Application plan

拒绝。历史 `manual_external` 是 adapter 授权前的事实；事后把它改成 `adapter_required` 会破坏签名、digest 与审计语义。

### 只检查 Secret/Config apply receipt

拒绝。孤立 receipt 不能证明 signed decision、当前 target、source head、Automation 前序写入或 rollback 状态。

### completion 前删除 backup

拒绝。receipt/head crash window 仍可能需要显式 rollback；提前删除会让响应丢失不可恢复。

### 为 Edge 增加后台 GC

拒绝。一次性 completion 已能固定内存、幂等回收；常驻 timer 会扩大路由设备资源与生命周期表面。

## 验证

- completion v3 定向：`3/3`，覆盖 exact Secret/Config evidence、其他 manual 域失败关闭、rolled-back、target drift、v3 receipt、lineage 边和 completed-storage 幂等回收；
- completion v1/v2 兼容：no-effect v1、Automation rollback retention 与 Run History v2 均通过；
- Local Owner：受限沙箱 `300 total / 290 pass / 7 skip / 3 loopback EPERM`，对应两个 loopback 文件在沙箱外 `15/15`，有效结果 `300/293/7/0`；
- TypeScript package closure：8 个 Local 依赖包与 Local Owner 全部通过；
- 完整 backend：`1567 total / 1565 pass / 2 conditional skip / 0 fail`；
- 18-package clean build 与逐包顺序测试单次退出 0；package boundary、Cluster dependency、122-module Edge import、service-manager bridge import、本地镜像与 `14/14` Local artifact audit 全部 compatible；
- workspace 保持 18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；基础 Edge/Standalone 为 `2,635,529 / 2,635,607 bytes`、323 files、58 loaded modules。

阶段提交后的远程 CI 仍需重新验证；D-397 的真实 Edge 空间证据和 Cluster Secret provider live gate 仍属于 ADR-0491 后续工作。
