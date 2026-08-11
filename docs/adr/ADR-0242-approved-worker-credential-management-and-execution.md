# ADR-0242：受批 Worker Credential 管理与一次性执行边界

- 状态：Proposed
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-23、D-58、D-175、D-207、D-224、D-225、D-226
- 关联 ADR：ADR-0141、ADR-0142、ADR-0185、ADR-0217、ADR-0234、ADR-0240、ADR-0241
- 承接：ADR-0241 尚未完成的强 User、双人批准与 TokenRequest session 产品组合

## 背景

ADR-0241 已把 Kubernetes delivery capability 收敛为 callback-scoped、内存中的一次性
TokenRequest session，但它只解决“已获得执行授权后如何安全签发和销毁 token”。如果产品入口
直接让调用者构造 delivery 参数，仍会缺少三个关键事实：谁申请、批准的精确目标是什么、执行时
是否仍与批准内容和 Project authority 一致。

该问题也不能通过新增一组细粒度 workspace package 或常驻 credential controller 解决。
QingLong 同时面向低配路由设备与集群节点：前者不应安装 PostgreSQL/Kubernetes SDK、连接池和
后台轮换循环；后者则必须把可被网络调用的管理 authority 与持有 Kubernetes delivery capability
的执行 authority 分开。

## 决策

### 1. 产品链固定为四段持久事实

Cluster Worker credential 的 `issue|rotate` 固定执行：

1. 强 User principal 在 Authority Project 内通过 `worker.manage`，创建最长 15 分钟、不可变且
   不含 token/Secret/kubeconfig 的 management plan；
2. 同一申请者基于 plan digest 发起 `high` risk、`separation_of_duty` ApprovalRequest；
3. 另一名具有 `approval.decide` 的强 User 对 exact action/plan/preview digest 作出决定；
4. caller-driven executor 重新读取 plan/approval/Project fence，原子 consume approval 并取得
   durable dispatch 后，才进入一次性 TokenRequest session 和可恢复 delivery issuer。

approval、dispatch、credential mutation 与 delivery 都使用稳定 identity 和 exact replay。token
只存在于 session callback 内，不能进入 plan、approval、PostgreSQL、结果、日志或审计事件。

### 2. Manager 与 Executor 使用不同数据库角色

`ql3_worker_credential_manager` 只读 Project/RoleBinding/schema facts，可创建 plan、
ApprovalRequest 和 Audit；它不得读写 credential、delivery、stage discard 或 dispatch。

`ql3_worker_credential_executor` 只读 plan 与 Project authority，可 consume ApprovalRequest、追加
dispatch/credential/mutation/delivery/stage-discard/Audit；它不能创建或改写 plan，也不能取得其他
runtime、Package 或 migration authority。两个角色都不是 superuser、owner、createdb、createrole、
replication 或 bypassrls；每个部署连接上限为 4，并只执行 approval policy fence function。

迁移 `pg-0047` 建立 immutable plan 与上述 grant，`control-core` 推进到 v46；`pg-0048` 只调整
credential lifetime check，使批准时刻早于实际创建时刻仍可执行，同时要求 expiry 晚于
`GREATEST(createdAt, notBefore)`，并推进到 v47；`pg-0049` 把 durable execution receipt 的
SELECT/INSERT/UPDATE 仅授予 executor 并推进到 v48；`pg-0050` 再建立使用数据库时钟、
exact replay receipt 的 manager quota bucket，把共享 identity keyset ledger 的 authority 严格扩展为
Plugin Package/Worker Credential 两值，并仅给 Worker manager 相应读写权限，推进到 v49。历史迁移
不原地改写。

共享 `approved_action_executions` 表的 dispatcher 必须把自身注册 handler 的 action types 下推到
repository 查询。没有匹配 handler 的 executor 不得领取、租约或 block 其他 authority 的动作。

### 3. 批准时间与执行时间必须分离

plan 固定批准的 `credentialNotBeforeAtMs` 与 `credentialExpiresAtMs`。执行因人工审批延迟时，
不得把 not-before 改成当前时间，否则批准摘要失效；也不得创建已经到期的 credential。执行端
要求当前时间仍早于 plan、dispatch 和 credential expiry，再按批准的原始时间签发。rotation
还必须确认 predecessor 是同一 Worker 当前有效 credential。

### 4. 不按源码文件拆 workspace package

本能力分别落在既有 package 的显式 subpath：

- `runtime-core/worker-credential-management-plan`：Profile-neutral plan contract；
- `cluster-postgres/worker-credential-manager`：manager-only repository/readiness；
- `cluster-postgres/worker-credential-executor`：executor-only repository/readiness；
- `cluster-admin/worker-credential-management`：强 User 管理 facade；
- `cluster-admin/worker-credential-management-executor`：一次性执行组合。

它们不是新的发布、部署或 dependency root，因此不建立单文件 package。只有出现独立制品、独立
第三方重依赖、必须从常驻闭包排除的 authority，或三个以上 package 需要稳定依赖反转时，才允许
重新评审 package 边界。

### 5. Edge/Standalone 与 Cluster 不共担部署成本

Edge/Standalone 不导入上述 PostgreSQL/Kubernetes 管理 subpath，不创建这两个角色、连接池、
TokenRequest client、timer 或常驻进程；本机身份和 credential ceremony 继续由短生命周期 Owner
CLI 与 SQLite authority 完成。路由设备运行 Worker 时仍使用同一受预算约束的 Worker runtime，
但 Cluster 管理 SDK 不进入其制品闭包。

Cluster 可提供独立认证后的 manager transport，但 executor 必须保持一次一命令/一次 Job 的
caller-driven 生命周期：打开至多一个受限数据库资源，consume durable approval，创建一次
TokenRequest session，执行或重放 delivery，然后销毁 Kubernetes client 并关闭数据库。不得把
executor 变为常驻 controller、轮换 timer、watcher、leader election 或 sidecar。

## 不采用方案

### 把 manager 与 executor 合成一个 admin role/process

拒绝。网络管理入口一旦被利用，就会同时获得 approval 创建和 Kubernetes delivery capability，
separation-of-duty 只剩应用层约定，无法由数据库 grant 和部署凭据证明。

### 每个 plan/repository/service 新建一个 package

拒绝。这些模块没有独立部署、发布或第三方依赖边界，会增加 importer、lock、SBOM、build 和升级
成本，却不能进一步缩小运行时 authority；显式 subpath 已能提供需要的可见性和审计门。

### 常驻 controller 自动签发和轮换

拒绝。它会长期持有 issuer、delivery 与数据库 authority，并增加 timer、重试、leader 和连接
生命周期；低配设备不需要这套成本，Cluster 的低频高风险操作也更适合显式受批执行。

### 批准后把 not-before 重写为执行时间

拒绝。它会改变已批准 plan 的语义与 digest；若不重写 digest 就是越权，若重写 digest 则必须
重新审批。正确做法是保留批准时间并验证执行时尚未过期。

## 影响

- CloudNativePG 数据库角色由六个增至八个，新增两个离散 credential Secret 示例；
- workspace package 数不增加，Edge/Standalone production closure 不增加 Cluster 依赖；
- Cluster Admin 在同一 package 内增加 management transport/HTTP/client/process 显式 subpath、
  manager/client/executor CLI binary、opt-in 双副本 Kubernetes Deployment 与 caller-driven Job；
  不增加 workspace package。
  manager process 使用独立 Worker manager Pool、durable quota 与 authority-scoped identity ledger，
  不取得 executor、Kubernetes API、Secret 或 pepper authority；executor Job 只取得显式 600 秒
  issuer token、exact delivery ServiceAccount 的 TokenRequest 和 executor PostgreSQL role；
- 运维工作站通过独立 opt-in management client Job 发起单条命令；该 Job 无 RBAC/API token，
  只把不可变 request、短期强 User assertion 与受审 CA 分离投影，预检仅重试 TLS 1.3
  `/readyz`，生产 client 主进程不自动重试业务请求；
- executor 在 approval consume 后失败时保留 durable dispatch，后续以同一 identity 恢复，不重新
  请求人工批准，也不重签不同语义的计划；
- executor 对 execution baseline 执行 claim→start→complete；成功回执精确绑定 delivery identity 与
  publication digest，重放只读 durable delivery，不再次进入 TokenRequest session；
- plan 与 PostgreSQL 只持目标、摘要、时间和低敏证据，不持 bearer token。

## 验证

当前实现证据：

1. manager/executor PostgreSQL readiness 正向与越权负向测试通过，两个 package entrypoint 的
   capability 集合互斥；
2. management 的 plan/propose/decide/inspect happy path 已覆盖强 User、Project
   `worker.manage`/`approval.decide`、双人决定、immutable exact replay 与配置收窄；
3. runtime/admin/delivery 已覆盖审批延迟后仍按原 not-before 创建、已过期拒绝与 delivery recovery；
4. PostgreSQL migration/schema/manifest 全量测试通过，`pg-0047`/`pg-0048`/`pg-0049`/`pg-0050`
   有独立 predecessor、capability 和 grant/constraint 契约；control-core 已到 v49；
5. CloudNativePG deployment audit 已验证八角色和 Secret 映射；
6. 真实 K3s `v1.34.3+k3s1` + PostgreSQL 18 纵切面完成两次 plan、职责分离批准、consume、
   TokenRequest、delivery 与 succeeded execution receipt；同一 execution 的精确重放没有再次签发 token；
7. PostgreSQL 18.4 arm64 physical HA 在 v49 上通过 `remote_apply`、timeline 1→2、旧主 fencing、
   未确认分区提交排除、`pg_rewind` 只读同步重入、fresh control replicas 与全部领域 gate。
8. management transport 仅公开 plan/propose/decide/inspect，认证失败、弱 assurance、扩展 shape 与
   内部 execute 均在管理 authority 前拒绝；响应只含 plan/approval 低敏摘要；
9. Worker HTTPS host 复用既有 TLS 1.3、认证前连接/peer/global shield、并发/超时/body/response
   上限，但路径固定为 `/api/v3/worker-credentials/management`，Plugin Package 路径在同一实例返回
   404；Worker/Plugin HTTP 11 项联合回归与原普通/Kubernetes tunnel client 15 项回归通过；
10. Worker client/CLI 复用 canonical 私有文件、CA/servername、TLS 1.3、无 redirect、单请求与
    bounded response 实现，四类结果 exact-validate，附加 authentication ID、secret-bearing shape 或
    内部 execute 结果失败关闭；本能力未新增 package，ADR-0243 删除孤立 cutover 后当前为 19；
11. manager durable quota 在 Project Policy 后、任何 plan/approval state read 前执行，四类 operation
    使用数据库时钟、固定窗口与有界 receipt ledger；精确重放不重复计数，拒绝映射为 HTTP 429；
12. Worker manager process/CLI 已接入专用 role readiness、authority=`worker-credential-management`
    identity ledger、quota、TLS 1.3 HTTP 与有序 drain/close；禁用态只读 enable 开关且零文件/数据库
    副作用。新旧 manager 进程 14/14；caller-driven executor process/CLI 已固定 exact command、私有
    32-byte pepper、单连接 Pool、两次 issuer authorization confirmation、一次 TokenRequest session 与
    失败保真销毁与低敏 CLI 输出，专项 7/7；cluster-admin 全量 174 pass/1 条件 skip；
13. opt-in Kubernetes base/CloudNativePG overlay 已完成双副本、PDB、required anti-affinity、零
    ServiceAccount token、只读 TLS/identity/CA 投影、label-only ingress、DNS/PostgreSQL-only egress、
    manager-only CNPG credential 与 fail-closed image digest；独立 executor base/CNPG operation 采用
    caller-driven Job、`backoffLimit=0`、600 秒投影 issuer token、existing exact TokenRequest RoleBinding、
    command/pepper/CA 分离只读投影、executor-only CNPG credential、无 ingress 与 DNS-only base egress；
    Kubernetes API 必须由私有 overlay 指定 exact CNI destination。独立 management client operation
    固定 `backoffLimit=0`、零 token/RBAC、DNS + manager:8444-only egress、不可变三输入和独立
    fail-closed digest；deployment audit 28/28 变异测试通过；
14. PostgreSQL 18.4 arm64 physical HA 在 v49 再次运行，八角色专用 readiness 在 promotion 前后均
    通过；新增 Worker manager 双数据库实例矩阵以 16 个并发请求证明 8 admitted/8 limited、重放
    零额外计数、autocommit response loss 精确收敛，并把 identity ledger 推进到 generation 3，证明
    restart rollback、same-generation rewrite、implicit removal 拒绝与 COMMIT response loss 收敛。
    `remote_apply`、timeline 1→2、fencing/partition/`pg_rewind`/只读同步重入和总 gate 均继续为 true；
    该证据不冒充真实 Kubernetes Pod、HTTP listener 或外部 IdP 演练。
15. 真实 K3s `v1.34.3+k3s1` + PostgreSQL 18 门已用生产 `cluster-admin` 镜像运行第三次
    caller-driven credential rotation：首次 Job 返回 `published` 且 `tokenRequestUsed=true`，第二个
    独立 Job 精确重放相同 command 时返回 `existing` 且 `tokenRequestUsed=false`。两个 Job 均使用
    `backoffLimit=0`、executor-only 单连接数据库凭据、无 automount token、600 秒投影 issuer token、
    无 ingress 和精确 API Service/backend/PostgreSQL `/32` egress。最终 3 个 plan/consumed approval/
    dispatch/succeeded execution/credential/published delivery、12 条安全审计、Recreate stop-before-start、
    Bound PVC journal 与 identity generation rollout 全部收敛，总 gate 为 true。
16. 三节点 K3s + PostgreSQL 18 的独立 manager 门以两个 required anti-affinity Pod、生产
    Worker management client 和 TLS 1.3 精确 Pod 寻址完成 8 admitted/8 limited；配额已满后的
    跨 Pod exact replay 返回 `existing`，最终 plan/consumed/receipt 均为 8。identity projection
    依次覆盖 generation 1、2 overlap、3 revoke，generation 2 rollback surge 以 exit 1 失败关闭且
    两个旧 Pod 保持 Ready。停库后两个业务请求均为 503、Ready 均为 503、Live 均为 200；数据库
    重启不允许旧实例原地解除 availability fence，只有 fresh rollout 的两个 Pod 返回 200。一次性
    client Job 仅对没有远端响应的 transport failure 复用同一幂等命令做有界重试，不重试任何
    HTTP 业务拒绝。该门同时发现并修复计划 repository 把 `plannedAtMs`、`expiresAtMs` 与派生 digest
    错当为调用方语义、导致跨 Pod exact replay 500 的问题；不同 target/requester 仍冲突。facade
    同时把无效计划和 semantic conflict 分别稳定映射为 HTTP 400/409，不再泄漏成 500。
17. 同一三节点 K3s 门现在直接加载仓库内 management client ServiceAccount、NetworkPolicy 与 Job，
    只把镜像替换为本次构建的生产 Admin image。固定 `qinglong3-system` DNS、TLS 1.3 `/readyz`
    init、不可变 request/assertion/CA、零 projected token 条件下，init/main 均 exit 0，client
    `restartCount=0`，`worker-credential.inspect` Job Complete；报告新增
    `gates.committedOneShotClientOperation=true` 且总 `passed=true`。该证据不依赖 kubelet 日志代理，
    以 Kubernetes Job/Pod 终态证明执行，避免把管理响应复制到 termination message。

## 仍未完成

- 外部 OIDC/client certificate 双 User ceremony、撤销审计与真实生产 ingress；
- 多节点 Kubernetes API/CSI 故障矩阵，以及固定 x64/arm64 路由设备与集群节点资源报告。
