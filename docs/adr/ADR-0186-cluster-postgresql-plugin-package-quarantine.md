# ADR-0186：Cluster PostgreSQL Plugin Package 隔离与能力撤出

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-137、D-149、D-152、D-154、D-158、D-174、D-175、D-176；
  ADR-0125、ADR-0137、ADR-0152、ADR-0154、ADR-0158、ADR-0184、ADR-0185

## 背景

D-174 已为 Edge/Standalone 建立 SQLite quarantine overlay，但 Cluster 仍只有 Package
安装、物化、Task reconciliation 与 Tool snapshot 的 PostgreSQL事实。若 Cluster 只在
某个 control replica 内保存 denylist，重启、水平扩容或主备提升都会重新暴露受影响
能力；若只改变 install state，则已发布的 Task revision 和历史 Tool snapshot 仍能被
新的 Run/StepRun 引用。

隔离必须同时满足：

- event、Task disable、Tool source withdrawal 和 receipt 原子提交；
- 多副本、COMMIT 响应丢失、同步复制与主备提升后语义不变；
- runtime 只能获得启动判定，不能读取隔离证据；
- 已经 durable running 的工作保留 completion/recovery，不伪装成安全热杀；
- 不为这一个领域再拆 workspace package，也不把 Cluster 代码带入路由设备 Profile。

## 决策

### 1. control-core v36 使用永久 overlay

`pg-0037-plugin-package-quarantine` 将 capability 从 v35 推进到 v36，并新增：

- `plugin_package_quarantine_events`：绑定 revocation receipt、impact、精确 install
  record、双人或 break-glass 主体、reason、mutation 和事件时间；
- `plugin_package_withdrawal_receipts`：绑定目标、前后 active vector、新 Tool
  snapshot、Task 撤回数量和数据库提交时间；
- `plugin_package_withdrawal_tasks`：绑定每个 Task 的前一 revision 与 disabled
  revision。

事实表只追加，不删除或改写安装历史、旧 Task revision、旧 Tool snapshot、Run、
StepRun、Artifact 与 Completion。

### 2. package-executor 持有唯一提交 authority

`commit_plugin_package_quarantine(jsonb,jsonb,jsonb,jsonb)` 是
`SECURITY DEFINER`，只授予 `ql3_package_executor`：

1. 锁定 Project 和 exact install；
2. 校验 event/receipt target、时间关系、active head 与 materialized revision；
3. 对 Package 当前拥有且仍 enabled 的 Task 追加 disabled revision；
4. 重新计算并校验排除目标 lock 后的完整 active source 集；
5. 发布 immutable Tool snapshot；
6. 写 event、receipt 和 Task withdrawal relation。

任一 identity、source、Task head、snapshot 或 authorization fence 漂移都回滚整个
事务。event digest 与 target 唯一；COMMIT 响应丢失后通过 durable read-after-write
收敛为 exact replay。

### 3. runtime 只获得同 Project 启动栅栏

`ql3_runtime` 对三张隔离表没有 SELECT/INSERT/UPDATE/DELETE，只能执行：

- `plugin_package_run_start_allowed(project,task,revision)`；
- `plugin_package_tool_start_allowed(project,definitionRef,digest)`。

guard 通过 Task reconciliation 或历史 Tool snapshot source 回溯 Package lock，并对
Project 取 `FOR SHARE`；quarantine commit 对同一 Project 取 `FOR UPDATE`。因此新
Run dispatch 与 Tool barrier 不可能越过并发隔离事务。同步副本缺失且
`synchronous_commit=remote_apply` 时，行锁 WAL 会使启动型 mutation fail closed；
不得为提高切换窗口可用性绕过该 fence。

Run 已经 durable 处于 dispatching/running 且 Task revision 未变化时，不重新解释为
新 start，允许既有 completion/recovery 收敛。Package install recovery、Task
reconciliation recovery 和 Tool snapshot recovery 都排除已有 quarantine event 的
target/source，避免重启复活。

### 4. 管理入口是短生命周期 subpath

`@qinglong/cluster-admin/plugin-package-quarantine` 组合 readiness、PostgreSQL
repository 和事务内授权复验：

- 每批 1–128 个 dense、event digest/target 唯一的 event；
- 每个 repository transaction 在写入前和 COMMIT 前调用授权复验；
- 使用独立 package-executor credential，完成后关闭数据库；
- 不进入 cluster-admin root，不新增常驻 HTTP route、listener、timer 或 workspace
  package。

它接收的是已经绑定 `revocationReceiptDigest + impactDigest + exact lock` 的事件。
Cluster 当前安装事实没有保存 OCI publisher signature provenance，因此本 ADR 不允许
从 revoked key、package 名或 registry 路径猜测受影响 lock。自动影响分析与事件生产
必须先在后续 D-177 建立不可变 signer provenance。

## 不采用方案

### 新增 quarantine workspace package

该能力与现有 cluster-postgres storage adapter、cluster-admin 短 authority 同生命周期，
新增包没有独立交付或依赖隔离收益，并违反 22-package hard cap。

### 给 runtime 隔离表读取权限

runtime 只需要布尔启动判定。直接 SELECT 会暴露管理主体、reason、impact 与安装历史，
也会让各消费者自行实现不一致 join。

### 跨多个事务撤出 Task 和 Tool

会出现 Task 已禁用而 Tool 仍可启动、或 event 已存在但 receipt 不完整的可见窗口，
并使 recovery 无法判断 winner。

### 在没有 provenance 时自动按 key 隔离

无法证明某个 install lock 确由该 signer 发布；猜测影响集会产生漏隔离或误隔离，
比显式承认缺口更危险。

## 验收证据

- `@qinglong/cluster-postgres`：190 pass，1 条需要外部 live URL 的 integration 条件
  skip；migration checksum、schema contract、Drizzle、readiness、恢复与 barrier
  单元门通过；
- `@qinglong/cluster-admin`：101 pass，1 条真实 Kubernetes API 条件 skip；新增
  batch service 覆盖双次授权、dense/limit/duplicate target 和显式 subpath；
- PostgreSQL 18.4 Debian arm64 physical-streaming HA Docker contract：
  - 构造一个真实 Task+Tool Package，隔离前 Run/Tool guard 均为 true；
  - COMMIT 响应丢失后 durable replay 收敛，event/receipt 各 1、Task withdrawal 2；
  - 新 Tool snapshot retained source 为 0，runtime 隔离表访问返回 42501；
  - 隔离后及 timeline 1→2 promotion、`pg_rewind`、同步 rejoin 后双 guard 均为 false；
  - 分区提交未被确认、旧主先 fence、同步副本恢复后才重新开放 mutation；
  - 最终 `pluginPackageQuarantine.*` 证据全为 true，`gates.passed=true`。

真库门发现并修复了 JSON 运算符优先级、active install/head join、JSON text 到 UUID
显式转换和 `ECONNRESET` durable retry 四类静态 mock 未覆盖的问题。

## 后续

1. D-177/ADR-0187 已完成 Cluster Package signer provenance、durable revocation
   receipt/impact、receipt-first Run/Tool deny 与有界 quarantine producer；
2. 将 ADR-0187 producer 接入正式双人/break-glass Cluster 管理 transport；在该
   ceremony 完成前保持 subpath 为内部短 authority，不发布“任意请求按 key 隔离”的
   产品能力；
3. 为多 Project 批次补充显式并发/限流策略，但单事务仍只处理一个 Project target，
   不扩大数据库锁范围。
