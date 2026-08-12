# ADR-0393：按 Generation 固定的 Plugin Package Secret 绑定账本

- 状态：Accepted
- 日期：2026-08-13
- 关联 RFC：QL-RFC-0001 D-305
- 关联 ADR：ADR-0216、ADR-0221、ADR-0392

## 问题

Plugin Package Manifest 已能声明逻辑 Secret 需求，但 materialization 仍会拒绝任何 Secret requirement。仅把 Secret 名称传入执行器会留下三类不确定性：Secret rotation 会让同一 generation 在不同时间解析到不同值，跨 Project 引用可能越权，安装确认与实际执行也缺少可审计的同一事实。

QingLong 3.0 同时面向低配路由设备与集群节点。解决方案不能为 Local/Edge 引入 Secret watcher、常驻缓存、额外数据库连接或独立 daemon，也不能在集群数据库中向宽权限角色暴露 Secret 绑定事实。

## 决策

1. 引入 `qinglong/plugin-package-secret-binding@v1`。一个不可变 binding 精确绑定一个 Package resource generation、Manifest digest 与 lock digest，并完整覆盖 Manifest 声明的所有 Secret requirement。
2. binding 只保存 `qlsecret://` 引用，不保存 Secret 明文。引用必须与 Package installation 位于同一 Project，并固定显式 version；required requirement 不允许为空，optional requirement 可以显式记录 `null`。
3. binding 必须携带 `approved-action-execution` 或 `local-owner-confirmation` authority kind 及其 evidence digest。D-305 只定义并持久化 authority 事实，不新增绕过既有审批或 owner-confirmation 的入口。
4. 发布时必须证明目标仍是当前 active installation head，且 installation、Project、Package、lock、generation 与 Manifest digest 全部一致。相同 generation 的完全相同内容幂等返回 existing；不同内容冲突并失败关闭。
5. binding 使用 domain-separated SHA-256 摘要，持久 JSON 上限 64 KiB，最多沿用 Manifest 的 64 个 Secret requirement 上限。SQLite 与 PostgreSQL 分别追加同构 ledger，不改写历史 migration。
6. Local 使用既有单写者 SQLite authority；Cluster 仅向 `ql3_package_executor` 授予 ledger 的 `SELECT, INSERT`，runtime、admin、package manager 与 worker ingress 均无权限。实现不新增 package、进程、timer、watcher、连接或常驻缓存。
7. ledger 是历史事实，不直接成为 Package lifecycle 的 active-consumer blocker。D-306 在消费 binding 并产生实际 materialization/执行依赖时，再定义 Secret resolution、撤回与 rebinding 的生命周期规则。

## 方言映射

| 项目 | Local / Edge / Standalone | Cluster |
| --- | --- | --- |
| migration | `0091-plugin-package-secret-bindings` + `0092-capability-v46` | `pg-0059-plugin-package-secret-bindings` |
| capability | `plugin_package_secret_binding@1`，contract v46 | `plugin_package_secret_binding@1`，contract v58 |
| 写入串行化 | 既有 SQLite 单写者 authority | PostgreSQL 唯一约束与 active-head 条件写入 |
| 资源增量 | 一个有界 append-only 表、三个索引 | 一个有界 append-only 表、三个索引 |
| 常驻开销 | 无新增进程、连接、timer、watcher、cache | 无新增 Pod、worker、连接、timer、watcher、cache |

## 明确不在 D-305 中完成

- 不读取或解密 Secret 明文，不把 Secret 注入 Task 环境。
- 不提供面向用户的 bind/rebind 命令或远程管理 API。
- 不声明 Secret rotation 自动改变既有 generation；新版本必须由后续显式授权和新事实消费。
- 不改变现有“Manifest 含 Secret requirement 时 materialization 拒绝”的执行边界。

## 替代方案

### 执行时解析浮动 Secret 名称

拒绝。它让同一 generation 的行为随 rotation 漂移，无法复现，也无法把授权证据与实际版本绑定。

### 把加密 Secret 值复制进 Package ledger

拒绝。它扩大密文托管面、备份恢复面与轮换复杂度，也不必要地增加路由设备存储和集群权限面。

### 只在产品层保存临时绑定

拒绝。崩溃、重启或主库切换后无法证明执行消费的是安装时确认的同一绑定。

## 影响

- 相同 Package generation 的 Secret 选择成为可复现、可摘要、可审计的不可变事实。
- Secret 明文仍留在既有 Secret custody 边界内；ledger 泄露只暴露有界引用元数据，不暴露值。
- D-305 建立的是消费前置条件，不代表 Secret-aware Package 已可运行；产品授权与 runtime consumption 仍属于 D-306。
- Local 与 Cluster 保持同一领域契约、不同存储 authority，低配设备不承担集群组件成本。

## 验证

- core contract：精确 Manifest coverage、required/optional、同 Project、固定 version、canonical order、authority/digest/shape drift 与 generation/Manifest 重校验。
- SQLite：幂等、冲突、active generation fencing、tamper fail-closed、migration checksum、typed schema、readiness 与 rollout safety。
- PostgreSQL：同构 repository contract、migration checksum、schema/readiness 与 package-executor 最小权限。
- 阶段完成前运行完整 18-package build/test、backend 回归、package/dependency boundary 审计和 PostgreSQL 18 physical-streaming HA gate。

## 当前证据

- runtime-core 全量 509/509；local-sqlite 全量 232/232。
- cluster-postgres 317 项：316 pass、1 条仅在未提供独立测试数据库 URL 时条件 skip、0 fail。
- 完整 18-package clean build/test 退出 0；Worker 133/133，AI 209 pass/3 条件 skip，Cluster Admin 302 pass/2 条件 skip，Local Owner 163 pass/5 条件 skip，其余 package 同样 0 fail。
- backend 1,190 项：1,188 pass、2 条件 skip、0 fail。package boundary、cluster dependency boundary、edge import、service bridge import 与 local image 五项审计均为 0 finding；workspace 仍为 18 package、无 single-source/shallow-source package，PostgreSQL 60 个与 SQLite 93 个 migration 文件继续作为显式 `ordered_ledger` 管理。
- PostgreSQL 18.4 arm64 physical-streaming HA 125 项 gate 全绿，timeline `1→2`，旧主完成 fence 与 `pg_rewind` 只读重入；报告 SHA-256 为 `acf0fea7ca7699989dfe70f5dd0061cdf5fb1968c691094331fea06ce01b96dc`。
