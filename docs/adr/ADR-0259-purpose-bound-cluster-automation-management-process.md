# ADR-0259：用途隔离的 Cluster Automation Management 进程

- 状态：Accepted
- 日期：2026-08-01
- 关联：D-207、D-208、D-239、D-241、D-242、ADR-0104、ADR-0105、ADR-0244、ADR-0258

## 上下文

Fresh Edge/Standalone 已有短生命周期 `ql3-task` 与 `ql3-trigger`，但 Cluster 仍没有受支持的
Task/Trigger 写入口。把 PostgreSQL administration repository 暴露给通用 `cluster-admin` 根组合、
复用 `ql3_admin`，或让 runtime 直接写 Task/Trigger，都会让常驻调度/执行进程获得人类管理权限。
另建只含少量文件的 workspace package 又会增加发布、SBOM、依赖审计和低配设备 importer 成本。

部署跨度也不能被一个默认值掩盖：低配路由器应保持零管理 listener、零 PostgreSQL Pool；生产集群
需要可滚动升级的双副本、持久身份防回滚与独立数据库角色。开发单节点可以选择非 HA 形态，但不能
把它声明成生产基线。

## 决策

1. Cluster Task/Trigger 管理由独立 `ql3-automation-manage` 进程持有。实现作为既有
   `@qinglong/cluster-admin` 与 `@qinglong/cluster-postgres` 子入口交付，不新增 workspace package；
   通用 `bootstrapClusterAdmin` 不再持有原始 Task/Trigger repository port。
2. PostgreSQL 新增唯一 `ql3_automation_manager` 登录角色。它只取得 Project Policy、Task/Trigger
   administration、低敏 security audit 与 `automation-management` 身份账本所需的精确权限；
   `ql3_admin`、runtime、Package manager 和 Worker manager 均不能读写该管理面。
3. `task.publish` 与 `trigger.publish` 只接受 strong User（`multi_factor|hardware`），分别要求
   Project Policy 的 `task.create|task.update` 与 `trigger.create|trigger.update`，并在 PostgreSQL
   SERIALIZABLE 事务中原子写 immutable revision、current head、allowed audit 与 exact replay。
   Trigger 必须固定 current enabled Task；scheduler 候选与最终 Run admission 继续重验 current fence。
4. 网络边界固定为 TLS 1.3 + 双向 TLS + 用途绑定的 OIDC 断言。断言必须同时使用
   `aud=qinglong3-automation-management`、`typ=ql3-automation-management+jwt`、
   `ql3_purpose=automation-management`；Plugin Package/Worker 管理断言即使共享 issuer/key 也拒绝。
5. public keyset 仍使用共享的 management identity ledger 存储结构，但 authority 行严格分为
   `plugin-package-management`、`worker-credential-management`、`automation-management`。
   PostgreSQL contract v51 允许 automation manager 精确维护自己的行，并拒绝 generation 回滚、
   同代改写、隐式删除 key 与跨用途读取。
6. Kubernetes operation 默认显式 opt-in，使用两个副本、required pod anti-affinity、PDB=1、
   无 ServiceAccount token、non-root/read-only rootfs、ClusterIP 8445。base 仅允许 DNS egress；
   CloudNativePG overlay 仅增加 `cnpg.io/cluster=ql3-postgres` TCP 5432，并绑定独立数据库 Secret、
   operator CA 与 fail-closed Admin image digest。
7. Operator 产品调用复用共享 authenticated management client 的私有文件、TLS 1.3、mTLS、响应上限
   与低敏错误实现，但使用 automation 专属 path/command/result validator。`ql3-automation-client` 对
   返回的 Project、Task/Trigger ID、Task revision/content digest 重新绑定原请求；Kubernetes
   `automation-management-client` 是 `backoffLimit=0`、无 RBAC/token 的 caller-driven Job。Task body
   可能敏感，因此 request 使用 immutable Secret，而不是 Worker client 的 ConfigMap 模式。
8. 资源分层不能通过自动探测硬件后静默改变安全语义：

   | 形态 | Automation 管理入口 | 常驻管理成本 | 支持边界 |
   |---|---|---:|---|
   | Edge 路由器 | `ql3-task`/`ql3-trigger` 私有 command file | 0 listener、0 Pool | SQLite、本机 Owner、短生命周期 |
   | Standalone | 同 Edge，可由 UI 调同一 local service | 0 独立管理 daemon | 不安装 Cluster authority |
   | 单节点开发集群 | 私有 overlay 可设 1 Pod、Pool 1 | 非 HA | 只用于开发/恢复演练 |
   | Cluster HA | 2 Pod、每 Pod Pool 2、32 connections/16 concurrent requests | requests 合计 200m CPU/256Mi | 当前生产基线 |
   | 更大集群 | 显式 overlay 横向扩展并同步评审 DB role connectionLimit/限流 | 有界配置 | 不提供无界 autoscale 默认值 |

## 被拒绝的方案

1. **新建 `ql3-automation-management` workspace package**：没有独立依赖或发布价值，且现有两个
   Cluster 包已经是部署/权限 owner；子入口足够。
2. **复用 `ql3_admin` 或通用 Admin 进程**：会把临时运维 authority 和持续人类管理 authority 合并。
3. **让 Cluster runtime 直接发布 Task/Trigger**：执行面一旦被利用即可修改未来调度定义。
4. **让路由器也启动 HTTPS manager**：增加空闲 RSS、端口、证书轮换与连接池，且本机已有更小入口。
5. **只靠内存记住 OIDC generation**：全副本重启会接受旧投影；必须由 PostgreSQL ledger 固定历史。
6. **按 CPU/RAM 自动选择安全 Profile**：资源探测可能漂移，部署者必须显式选择并留下配置证据。

## 验证

- `cluster-admin` automation service/transport/HTTPS/process/client 定向测试通过；完整包为 196 pass、
  2 条真实 PostgreSQL/Kubernetes 条件 skip、0 fail；独立进程验证 disabled 不开 authority、Cluster Profile gate、
  Pool/HTTP 上限、TLS 私钥清理和 HTTP→DB 关闭顺序。
- `cluster-postgres` contract v51 完整包为 271 pass、1 条真库条件 skip、0 fail；migration checksum、
  readiness、角色权限、Task/Trigger current-head repository 与三用途 identity ledger 隔离均通过。
- PostgreSQL 18.4 arm64 HA 重跑通过：`remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind`
  只读同步重入；automation ledger 两实例竞争至 generation 3，并拒绝回滚/同代改写/隐式删除，
  COMMIT 响应丢失后收敛，提升后事实不变，总 gate 为 true。
- Kubernetes manager base/CloudNativePG 与一次性 client Kustomize 均成功渲染；Cluster/CloudNativePG
  部署正负向审计 41/41，固定角色集合为 9 个。尚未取得真实 Kubernetes CNI、双 Pod 滚动轮换与
  故障注入证据，
  因此静态部署通过不能替代生产 release ceremony。
- `ql3-automation-client` 的真实本地 TLS 1.3+mTLS 产品链 3/3；一次性 Kubernetes Job Kustomize
  渲染与生命周期、Secret、网络、digest/default-disable 负向门通过。它证明客户端/清单契约，不等价于
  真实 Kubernetes CNI/双 Pod/CloudNativePG 运行证据。
- 真实 PostgreSQL 18 上启动两个独立 TLS 1.3+mTLS automation-manager，并由产品 client 并发提交
  同一 Task：结果精确为 `created + existing`。第三实例在 Task v2 COMMIT 后模拟响应丢失，另一个实例
  以相同请求重放收敛为 `existing`；随后 Trigger 固定 v2、Task 更新 v3、operator 显式 repin v3，最终
  数据库精确为 Task 3 revisions、Trigger 2 revisions、5 条 allowed audit 且无 replay duplicate（1/1）。
  该证据使用测试 identity adapter，不能替代生产 OIDC issuer/keyset ceremony。

## 后续约束

- UI/API gateway 必须调用同一 transport，不得复制 Policy、current-head、audit 或 replay 逻辑。
- 增加 inspect/list 时必须使用独立只读 repository 与 keyset pagination，不能顺带扩大 mutation authority。
- 单节点/大集群 overlay 必须显式提交资源、连接、限流与故障域证据；不得修改 HA base 迎合开发环境。
- 共享 identity ledger 的历史表名可在 3.0 alpha 后续 migration 中泛化，但不能用破坏性 rename 丢失审计历史。
