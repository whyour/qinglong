# ADR-0147：PostgreSQL 持久 Plugin Package 身份 keyset ledger

- 状态：Accepted
- 日期：2026-07-25
- 关联：ADR-0144、ADR-0145、ADR-0146、QL-RFC-0001 D-142/D-143

## 背景

ADR-0145 的文件式 keyset 已能在单进程生命周期内拒绝 generation 回退、同代
rewrite、隐式 key 移除和 revocation 撤销。但全部管理 Pod 同时重启后，进程内
monotonic state 会丢失；若部署投影回退到旧 Secret，旧签名 key 可能重新被接受。

不能用 watcher、timer、Redis 或 Pod 本地持久卷补这个缺口：它们分别引入额外常驻
资源、第二事实源或副本不一致，并不能与现有 PostgreSQL HA 故障域共同收敛。

## 决策

### 1. 单一持久 trust ledger

`pg-0024-plugin-package-identity-keyset-ledger` 新增
`ql3.plugin_package_identity_keyset_ledger`，固定只有
`plugin-package-management` 一个 authority。行内保存：

- generation 与完整 keyset SHA-256 base64url digest；
- immutable issuer/audience；
- 最多 8 个 active key ID；
- 最多 64 个 append-only revoked key ID；
- 数据库时钟更新时间。

migration stream 推进至 24 条、`control-core` capability v23、37 张表，并新增
`plugin_package_identity_keyset_ledger:1`。

### 2. 原子单调推进

`PostgresPluginPackageIdentityKeysetLedgerRepository.observe()` 使用同一
package-manager 连接池的短事务：

1. `INSERT ... ON CONFLICT DO NOTHING` 竞争首次建账；
2. `SELECT ... FOR UPDATE` 串行化同一 authority；
3. 同 generation 只接受 digest、trust domain、active/revoked 集合完全一致的重放；
4. 新 generation 必须保持 issuer/audience 不变；
5. 历史 revoked key 必须全部保留；
6. 历史 active key 必须仍 active，或显式进入 revoked；
7. 通过后才以数据库时钟更新并提交。

COMMIT 响应丢失统一返回 unavailable；调用方以同一 snapshot 重试会读取已提交行并
精确收敛，不产生新 generation。

### 3. 认证路径复核

生产 management process 先完成 package-manager schema/role readiness，再创建带
PostgreSQL ledger 的 keyset file provider。首次启动、文件发生变化和文件 digest
未变化的每次认证 reload 都必须调用 ledger：

- 新副本拿到旧文件时在监听前失败关闭；
- 已运行副本在 ledger 被另一副本推进后，不得继续把旧进程内 verifier 当持久事实；
- 文件损坏、数据库不可用、ledger conflict 均映射为 keyset unavailable，不使用
  stale fallback。

基础 file provider 保留可选 ledger port，供纯单元测试或非生产组合使用；正式
cluster process 永远注入 PostgreSQL 实现。

### 4. 权限和资源边界

- 只有 `ql3_package_manager` 可 `SELECT/INSERT/UPDATE` ledger；
- runtime、admin、package-executor、worker-ingress 与 PUBLIC 均无权限；
- 不新增 workspace package、第三方依赖、Redis、timer、watcher 或后台清理；
- edge/standalone 不导入该 repository，仍保持零额外常驻成本；
- 表恒定一行，revocation 列表与 JSON 字节数均有硬上限。

## 验证

- cluster-postgres 全量 141/141；
- cluster-admin 全量 97 通过、1 个真实 Kubernetes API 条件跳过；
- PostgreSQL 18.4 arm64 physical HA 报告新增
  `durableIdentityKeysetLedgerSurvivesReplicaRestart`：
  - 两个独立 package-manager 实例并发观察同一 generation；
  - 新 repository 实例模拟全副本重启，旧 generation 被拒绝；
  - 同代 rewrite、隐式移除和 trust-domain 漂移被拒绝；
  - driver 已确认 COMMIT 后注入响应丢失，再次观察精确收敛到 generation 3；
  - ledger 与既有 quota、physical promotion、`remote_apply`、旧主 fencing/rewind
    一起通过 24 个具体 gate 和总 `passed`。

## 后续非本 ADR 范围

本 ADR 关闭“全副本重启后的 durable keyset anti-rollback”阻断项，但不自动开放公网
管理入口。真实 IdP 两名 User 四眼、双 Pod live NetworkPolicy/ingress、Secret 投影
传播窗口、TLS/keyset 自动轮换和真实 Kubernetes control-plane HA 证据仍是生产前置。

ADR-0148 已冻结这些真实环境事实的低敏 evidence schema，并默认拒绝 management
公网 egress；它不把“审计器存在”当作真实报告已经取得。
