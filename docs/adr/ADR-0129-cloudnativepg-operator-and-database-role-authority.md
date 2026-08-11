# ADR-0129：CloudNativePG Operator 与数据库角色权威

- 状态：Accepted（operator/operand digest lock、三实例 HA 清单、十二角色
  DatabaseRole、独立 Database owner、runtime/migration 离散凭据、CA/主节点
  endpoint 绑定、静态负向门及显式 opt-in 的四节点 Kind/CNPG live contract
  已完成；成功的远端 live 记录、CA 轮换和备份恢复仍是 Release Gate）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-06、D-34、D-105、D-123、D-124、D-125、D-127
- 关联 ADR：ADR-0104、ADR-0105、ADR-0124、ADR-0125、ADR-0126、ADR-0127

## 背景

ADR-0125 已用 PostgreSQL 18.4 Docker fixture 证明物理流复制、
`remote_apply`、fence-before-promote、timeline 1→2、旧主 `pg_rewind`
只读重入，以及 scheduler、credential delivery、completion 和 cancellation
在不确定提交后的收敛。但测试专用 TCP endpoint 和 promotion guard 不是生产
operator，也没有定义 Kubernetes 中谁创建数据库、角色、证书与 primary service。

QingLong 不能在应用进程内复制数据库选主；同时也不能让 operator 通过
superuser 或应用启动钩子接管 QL3 schema GRANT。部署需要一条明确分界：

- operator 管理 PostgreSQL 实例、复制、promotion、证书、Service、Database 和
  LOGIN role 生命周期；
- QingLong reviewed migration stream 管理 schema、table、capability 与对象权限；
- Secret manager 管理密码和 runtime pepper；
- runtime、admin、worker-ingress 只消费各自最小权限身份。

## 决策

### 1. Cluster Profile 默认使用 CloudNativePG 1.30.0

生产 Cluster Profile 选择 CloudNativePG，而不是在 QingLong 中实现选主，也不把
Crunchy PGO 或 Zalando operator 同时引入默认发行物。原因是当前需求可以直接映射
到其稳定 read-write Service、Lease promotion gate、实例隔离、声明式
`DatabaseRole`、operator CA 和 `pg_rewind` 恢复路径；只保留一个 operator 可避免
三套 CRD、Secret 命名和故障语义进入支持矩阵。

operator 只属于 `cluster-control` 部署档位。edge、standalone 和普通 worker
产物不得依赖 Kubernetes client、CRD 或 operator 包；本决策不增加 workspace
package 和 npm importer。

供应链锁记录：

- CloudNativePG `1.30.0`：
  `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb`；
- PostgreSQL `18.4-minimal-trixie`：
  `ghcr.io/cloudnative-pg/postgresql:18.4-minimal-trixie@sha256:24d229d801663f95b584416f8ebdfad4849b1a3fa4cfcf95a7f026df7aa6e22d`；
- 两个 index 均锁定已观察的 `linux/amd64` 和 `linux/arm64` 子 manifest。

`operator-lock.json` 还记录 release manifest、Sigstore bundle 和 certificate
identity。当前本地只核验了 OCI index/platform digest；尚未保存 release asset
下载、签名验证或真实 operator 安装记录，因此不能把 lock 文件解释为部署完成。

### 2. 生产数据库固定为三实例同步 HA

`ql3-postgres` Cluster 固定：

- `instances: 3`，required hostname anti-affinity；
- `enableSuperuserAccess: false`；
- `synchronous_commit=remote_apply`；
- synchronous `ANY 1`、`dataDurability: required`、`failoverQuorum: true`；
- 只保留 primary-tracking `ql3-postgres-rw` 默认 Service，禁用 `-r`、`-ro`；
- CPU、memory、data PVC 与 WAL PVC 都有显式请求/上限。

该配置优先保证已确认写入在一个同步副本 remote apply。代价是只剩一个可写实例且
没有合格同步副本时，mutation 可用性会停止；不得通过改成异步提交来“恢复健康”。
required anti-affinity 也意味着生产至少需要三个合格节点。单节点开发环境可以用
私有 overlay 放宽拓扑，但不能作为 HA 证据。

### 3. Operator 管理 LOGIN role，migration 管理对象 GRANT

operator 声明且只声明十二个非特权 LOGIN role：

| Role | Connection limit | Password Secret | 用途 |
| --- | ---: | --- | --- |
| `ql3_migration` | 2 | `ql3-postgres-migration-auth` | Database owner 与短生命周期 DDL |
| `ql3_ai_maintenance` | 4 | `ql3-postgres-ai-maintenance-auth` | Prompt output retention/rekey 维护 |
| `ql3_ai_credential_manager` | 4 | `ql3-postgres-ai-credential-manager-auth` | AI Provider credential 管理事务 |
| `ql3_ai_credential_tester` | 2 | `ql3-postgres-ai-credential-tester-auth` | 一次性 Provider 连通性测试 |
| `ql3_runtime` | 32 | `ql3-postgres-runtime-auth` | cluster-control runtime |
| `ql3_admin` | 4 | `ql3-postgres-admin-auth` | 短生命周期管理事务 |
| `ql3_package_manager` | 4 | `ql3-postgres-package-manager-auth` | Plugin Package 管理事务 |
| `ql3_package_executor` | 4 | `ql3-postgres-package-executor-auth` | Package 执行/恢复事务 |
| `ql3_automation_manager` | 4 | `ql3-postgres-automation-manager-auth` | Task/Trigger 管理事务 |
| `ql3_worker_credential_manager` | 4 | `ql3-postgres-worker-credential-manager-auth` | Worker credential 管理事务 |
| `ql3_worker_credential_executor` | 4 | `ql3-postgres-worker-credential-executor-auth` | Worker credential 执行事务 |
| `ql3_worker_ingress` | 32 | `ql3-postgres-worker-ingress-auth` | Worker ingress |

十二者均为 `LOGIN`，且显式禁止 `SUPERUSER`、`CREATEDB`、`CREATEROLE`、
`REPLICATION` 和 `BYPASSRLS`；删除 CR 时 role reclaim policy 为 `retain`，防止
operator 删除声明时同时破坏仍被数据库对象引用的身份。`qinglong` Database 的
owner 固定为 `ql3_migration`。

`pg-0017-database-role-grants` 将 PostgreSQL stream 推进到 17 条 migration、
`control-core` capability v16。它先复验四个 role 已存在且属性精确，再撤销
`PUBLIC` 对数据库/schema/table 的默认访问，并安装 runtime/admin/worker-ingress
所需的精确对象 GRANT。CI 和 HA fixture 只预创建 role 与 Database owner，不再
复制一份手工 GRANT。readiness 同时复验当前 role 可登录、无高权限且拥有 Database
`CONNECT`，避免 operator 配置与 schema 权限静默漂移。

ADR-0137 的 `pg-0018-plugin-package-installs` 在上述 role-grant authority 上继续推进
到 18 条 migration、`control-core` capability v17、30 张表。Plugin Package
installation 三表仍只授予 `ql3_admin`；单用途 Project lock function 固定由
`ql3_migration` 拥有、撤销 PUBLIC EXECUTE，并只给 admin 调用。runtime 与
worker-ingress 权限不因该能力扩大。

后续 ADR-0144、ADR-0242 与 ADR-0259 在同一 operator authority 中依次加入
Package manager/executor、Worker credential manager/executor、Automation
manager 与三个 AI 专用身份；当前生产清单的唯一事实源是十二个非特权 LOGIN role、52 条 migration 与
`control-core` capability v51。新增 role 不改变本 ADR 的原则：operator 只管理
登录身份，所有对象 GRANT 仍由 reviewed migration stream 管理。

### 4. 应用不再复制含密码 DSN

CloudNativePG overlay 使用离散配置：

- `HOST=ql3-postgres-rw.qinglong3-system.svc`；
- `PORT=5432`、`DATABASE=qinglong`；
- `USER`/`PASSWORD` 分别读取对应 basic-auth Secret；
- `QL3_POSTGRES_TLS_SERVERNAME` 与 primary Service DNS 完全相同；
- CA 从 operator 管理的 `ql3-postgres-ca` 只读投影。

runtime 与 migration 的 Secret、环境键和 CA mount 保持分离。兼容用 URL 仍可供
非 operator 部署使用，但 URL 与离散配置混用、部分离散凭据、URL `ssl*` override
以及非法 identifier 全部失败关闭。credential example 只含固定 username 与
占位符，且不进入 Kustomize resources。

### 5. 安装和激活有固定顺序

部署顺序为：

1. 以 cluster-admin authority 安装并验证锁定的 CloudNativePG；
2. 创建 namespace 和由 Secret manager 生成的十二个 role Secret、control runtime
   Secret 与 Worker ingress Secret；
3. 应用 Cluster、DatabaseRole 和 Database；
4. 等待三个实例、`-rw` Service、十二个 role、Database 和 `-ca` Secret ready；
5. 创建固定名称的 one-shot migration Job，等待
   `migration_completed`，随后删除或留给 TTL 清理；
6. 才应用 cluster-control runtime overlay。

应用 readiness 不能替代 operator readiness；operator ready 也不能替代 QL3
schema/role readiness。重新运行 migration Job 前必须确认旧 Job 已删除。

## 备份、TLS 与故障边界

CloudNativePG 自动维护 server/client certificate 不等于完成 CA rollover 证明。
QL3 仍要求 ADR-0127 的 old → overlap → new → rollback contract，每阶段创建新
activation 并重跑可写主库/schema/role/recovery gate。真实 operator endpoint 上的
轮换尚未执行。

ADR-0130 已定义 Barman CNPG-I、私有 ObjectStore、连续 WAL、每日 base backup
与隔离恢复 Cluster 的静态合同，并锁定 Barman v0.13.0 candidate release、
controller/sidecar 及双平台 digest；certificate authority 供应链和真实对象存储
restore evidence 仍未完成。三副本和可渲染清单都不能冒充备份。基础设施
STONITH、Kubernetes control-plane 故障、Pod/节点网络分区、存储故障和 raw
PostgreSQL response loss 仍是独立 Release Gate。

## 替代方案

- **QingLong 内建 Patroni/选主或轮询多个 host**：拒绝。复制数据库控制面并扩大
  split-brain 风险。
- **默认同时支持多个 PostgreSQL operator**：拒绝。3.0 首发会把 CRD、Secret、
  Service、证书和升级矩阵成倍放大；其他 operator 后续只能通过独立 ADR/overlay
  加入。
- **operator role 成为 superuser，由应用启动时自动 GRANT**：拒绝。常驻进程会
  获得 DDL/role authority，副本并发启动还会把 migration 变成隐式副作用。
- **在一个 Secret 中保存 runtime、migration、admin 和 worker-ingress DSN**：
  拒绝。会合并独立 authority，并在 URL 中复制用户名、密码、host 和 TLS 选择。
- **单实例 operator 清单作为生产默认值**：拒绝。它只能证明 CRD 可启动，不能
  支撑 D-123 的 failover/RPO 声明。
- **三副本等同于备份**：拒绝。复制会同步删除和逻辑破坏，不能替代离线恢复点。

## 验证

- `pnpm audit:cloudnativepg:ql3`
- `node --test test/back/ql3CloudNativePgDeploymentAudit.test.cjs`
- `kubectl kustomize deploy/kubernetes/ql3-cluster/operators/cloudnative-pg`
- `kubectl kustomize deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg`
- `kubectl kustomize deploy/kubernetes/ql3-cluster/operations/cloudnative-pg`
- `pnpm --filter @qinglong/cluster-postgres test`
- `pnpm --filter @qinglong/cluster-control test`
- `pnpm test:postgres-ha:ql3`
- `QL3_CLOUDNATIVEPG_LIVE=1 pnpm test:cloudnativepg-live:ql3`

静态负向门必须拒绝单实例、未锁 digest、特权 role、错误 Database owner、把
credential example 加入 Kustomize、runtime/migration Secret 串用、重新引入 DSN、
非 `-rw` endpoint 或错误 CA。live contract 必须保存 operator/operand 实际
platform imageID、三实例跨 worker 调度、migration/runtime ready、主 worker
停止后的 Lease/timeline promotion、旧主回归和最小权限 role 复验；脚本和 CI
定义本身不构成成功证据。发布前还必须保存一次成功记录，并独立完成 CA
轮换/回退和备份恢复证据。
