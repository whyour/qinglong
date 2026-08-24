# ADR-0496：Cluster 不透明环境 Bundle 的有界交付与 Worker 内存展开

- 状态：Accepted（D-401 的安全执行数据面前置切片；Cluster Task/Trigger mutation 与 migration receipt 仍未完成）
- 日期：2026-08-24
- 决策：D-401 前置切片
- 关联：ADR-0091、ADR-0092、ADR-0104、ADR-0113、ADR-0114、ADR-0491、ADR-0494、ADR-0495

## 背景

ADR-0495 的 Cluster plan 只保存一个同 Project、固定 version 的 SecretRef，并明确禁止把
Legacy Env 名称、值、密文或 key ID 写入 PostgreSQL。现有 `command@v1` 环境模型却要求
每个 Secret binding 同时保存 `{name,secretRef}`；如果 D-401 直接把 Legacy Env 逐项追加到
Task revision，`task_definition_revisions.spec_json` 和
`task_execution_revisions.plan_json` 会永久保存全部 Legacy Env 名称，违反 ADR-0491。

现有 Remote Worker Secret delivery 还假设一个 SecretRef 对应一个最多 16 KiB 的普通值。
Legacy active environment 的合法上限是 256 项、单值 16 KiB、最终 name+value 总计 64 KiB，
因此不能把一个最多约 96 KiB 的 JSON carrier 冒充普通 Secret，也不能在 Worker 启动前写
ConfigMap、Pod environment、临时 export 文件或 command。

## 决策

### 1. Task 与执行修订只保存一个固定版本引用

`qinglong/command@v1` 增加可选 `environmentBundleRef`。它必须是 canonical、同 Project 且
显式固定 version 的 `qlsecret:v1` reference。Task semantic registry、profile-neutral compiler、
Cluster execution revision digest 和 PostgreSQL plan JSON 都只携带这个引用；不携带 bundle
schema、Env 名称、值、行数、key ID 或 provider path。

这是 `command@v1` 与 `qinglong/command-execution@v1` 的严格可选扩展：没有该字段的历史
revision 按原字节与原摘要解释，不执行回填或静默重写。Local execution compiler 当前拒绝带
bundle 的 Task；现有 Local D-397 继续使用逐 Secret SQLite 原子绑定，不能意外获得 Cluster
external-custody authority。

### 2. Bundle 是独立、纯数据、严格有界的 carrier

`qinglong/environment-bundle@v1` 固定为：

```json
{"schema":"qinglong/environment-bundle@v1","entries":[{"name":"NAME","value":"opaque"}]}
```

- entry 为 exact `{name,value}`，按 name canonical 排序；
- 1～256 项，名称符合 shell 共同子集、不得使用 `QL3_`、不得重复；
- 单值最多 16 KiB，最终 name+value 总计最多 64 KiB；
- UTF-8 JSON carrier 最多 96 KiB，拒绝 NUL、accessor、symbol、未知字段和无效 JSON；
- parser 是 profile-neutral 纯函数，不读取文件、网络、数据库、时钟或 Secret provider。

ADR-0495 的 `effectiveBindingCount` 实现上限同时从错误复用的 100,000 source-row cap 修正为
256，使 plan contract 与 ADR-0491 的真实执行预算一致。

### 3. Secret delivery v2 把普通 Secret 与 bundle 分权

wire 升级为 `qinglong/remote-secret-delivery@v2`。请求与数据库 authority 分别携带：

- `secretRefs`：最多 64 个普通 SecretRef；
- `environmentBundleRefs`：最多 1 个 bundle SecretRef；
- 两组不得重叠，合计不得为空。

response 分别返回 `values` 与 `environmentBundles`。普通值继续保持单项 16 KiB、总计
64 KiB；bundle carrier 最多 96 KiB；response cap 从 128 KiB 提升到 256 KiB，request cap
仍为 64 KiB。Run、Attempt、Session、Lease、offer、execution digest 和完整有序的两组 ref
仍在同一个 PostgreSQL authority transaction 中复验，bundle 不获得更弱的授权路径。

mounted-files provider 对普通 Secret 继续执行 16 KiB 上限，只对 authority 明确标记的唯一
bundle ref 允许 96 KiB。它仍逐请求重读 projection、无缓存、timer、watcher 或 Kubernetes API
权限；provider 不解析或记录 Env 内容。

### 4. Worker 只在进程上下文准备阶段展开

Worker 从 durable inbox 重建 exact Offer，由同一个 mTLS client 获取 v2 response。materializer
先解析普通 bindings，再在内存中解析唯一 bundle，并拒绝 bundle 内重复名称、与 Task 原有
environment 名称冲突、畸形 response、超过 256 项或最终 64 KiB 的环境。全部验证完成后才
分配 Artifact，随后把扁平 `{name,value}` 交给 Executor；失败时释放 provider material，且不
spawn。

Bundle 明文不得进入 inbox、Offer、PostgreSQL、Artifact、日志、audit、diagnostic、错误消息或
临时文件。JavaScript string 不能可靠清零，因此实现不缓存 bundle；transport Buffer 在解析后
清零，并在 execution context dispose 后释放引用。

### 5. Profile 与部署成本

实现复用 `runtime-core`、`worker-runtime`、`cluster-control` 和 `cluster-postgres`，不新增 workspace
package、生产依赖、数据库 migration、表、role grant、daemon、线程、timer 或 watcher。
Edge/Standalone 默认 import graph 不导入 Cluster provider/transport；纯 bundle parser 只在
实际调用时按 96 KiB carrier 上限付费。Cluster 可继续通过 mounted Secret、CSI、Vault/KMS
sidecar 或后续 direct adapter 横向扩展。

## 被拒绝的替代方案

### 把每个 Env 名称写入 Cluster Task environment

拒绝。Secret 值虽不在数据库，名称仍会进入 Task 历史、execution revision、备份与 HA 副本。

### 使用保留名称的普通 Secret binding 并让 Worker 猜 JSON

拒绝。payload sniffing 会让普通 Secret 意外获得 bundle 语义，也无法在 authority 层区分
16 KiB 与 96 KiB 的不同预算。

### 把 bundle 放进 ConfigMap、Pod env 或 Job command

拒绝。它把 Secret material 交给 Kubernetes API、etcd、进程元数据或命令审计面，并破坏
一次性、Attempt-bound 的 remote delivery fence。

### 为 bundle 单独新增服务或 workspace package

拒绝。它没有独立部署责任；新 endpoint/package 会增加低配设备与集群的维护面，现有 Secret
delivery authority 已能安全承载 typed payload。

## 当前验证与后续门禁

当前实现已完成纯 bundle contract、Task/Cluster execution optional ref、v2 wire、PostgreSQL
exact ref-set authority、mounted-files typed budget、Worker HTTPS transport 与内存展开；测试覆盖
canonicalization、跨 Project/未固定 version、普通/bundle role overlap、bundle-only Offer、名称冲突、
最终环境预算及普通 Secret 仍为 16 KiB。Runtime Core `586/586`、Worker `135/135`、Cluster Control
`273 total / 271 pass / 2 conditional skip / 0 fail`、Cluster PostgreSQL
`359 total / 356 pass / 3 conditional skip / 0 fail`，18-package clean build/test 退出 0；完整 backend
为 `1568 total / 1566 pass / 2 conditional skip / 0 fail`。

package boundary、精确 Cluster dependency、122-module Edge import、service-manager bridge import、
Local image 与基础 Edge/Standalone artifact audit 全部 compatible；workspace 保持 18 packages、
`singleSourcePackages=[]`、`shallowSourcePackages=[]`。基础 Edge/Standalone 制品为
`2,650,564 / 2,650,642 bytes`、324 files、58 loaded modules，峰值 RSS 增量分别为
`11,190,272 / 11,173,888 bytes`，没有把 Cluster provider/transport 带入低配设备默认闭包。
PostgreSQL 18.6 arm64 physical HA 通过 146 gates，timeline `1→2`，报告 SHA-256 为
`0ee2199d0a52a02025bff017a07477d707353d12aefc3811f474e3775f2bb86b`。

本 ADR 只关闭 D-401 的执行数据面前置条件，不声明 Legacy Env migration 已完成。下一切片仍须
在同一个 Automation Manager SERIALIZABLE transaction 中逐项复验 Task/Trigger current head，
追加只含 `environmentBundleRef` 的 Task revision、重定向 Trigger revision，并写 content-free
receipt；随后补 direct external custody 和 PostgreSQL promotion 后 exact replay。
