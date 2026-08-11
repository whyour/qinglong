# ADR-0144：Cluster Plugin Package 管理 Transport 与双 Authority 边界

- 状态：Proposed（transport-neutral 强认证适配器、源码边界、manager/executor
  PostgreSQL 角色拆分、dedicated assertion/keyset、TLS 1.3 HTTP process、可选
  management Kubernetes overlay、静态权限门和 PostgreSQL 18.4
  physical-promotion readiness、durable distributed quota 与全副本重启
  keyset anti-rollback 已实现；真实四眼与 live ingress 证据尚未实现）
- 日期：2026-07-25
- 关联 RFC：QL-RFC-0001 D-05、D-08、D-09、D-49、D-85、D-127、D-139 至 D-142

## 上下文

ADR-0142 已在 `@qinglong/cluster-admin/plugin-package-management` 组合
PostgreSQL proposal、Approval、Project Policy 和 caller-driven dispatcher，并固定
`separation_of_duty`。这仍只是认证后的 application service，不是可公开的管理 API。

现有 `cluster-control` Bearer credential authenticator 对 User 只产生
`single_factor` principal；它适合普通控制面 API，但不能被 transport 自行升级为
`multi_factor`。现有 cluster-admin recovery Job 又同时具备 admin PostgreSQL、
Registry credential 和 Kubernetes ConfigMap publish authority。若直接给该 Job
增加长驻 HTTP listener，一个 transport 漏洞将同时取得数据库准入、供应链下载和
资源发布权限。

## 决策

### 1. 不新增 package，不复用 cluster-control

Cluster 管理 transport 留在既有 `@qinglong/cluster-admin`，使用显式子路径和独立
process binary。它不从 package root 导出，也不进入 `cluster-control`、Worker、
edge 或 standalone 闭包。

部署上它是独立且默认关闭的 management Deployment/Service，不复用 recovery Job
Pod。使用同一 workspace package 不代表使用同一 ServiceAccount、数据库角色、
Secret 投影或进程入口。

第一阶段只实现
`@qinglong/cluster-admin/plugin-package-management-transport` 的
transport-neutral command adapter，不监听 socket、不解析 HTTP、不打开 PostgreSQL，
也不直接导入 Kubernetes、Registry 或 Package execution authority。源码门禁只允许
它依赖共享 Approval、Package proposal/management 与 Security contract；其他 package
不得导入该管理子路径。这样先冻结公开操作和 Principal 注入形状，再选择具体协议，
避免临时 HTTP handler 先成为事实标准。

### 2. 人类路由与系统执行分离

公开路由只允许：

- propose：提交 exact Package install action，生成 immutable proposal 与 pending
  Approval；
- decide：由另一名强认证 User approve/reject；
- inspect：只返回 proposal、Approval 与 installation 的低敏摘要。

`consume` 和 `dispatch` 不公开为人类 HTTP 路由。它们由受信 composition 注入固定
system consumer，并通过独立 caller-driven Job/process 执行。外部请求不能提供
consumer subject、authentication ID、ceremony、数据库时间或 dispatcher identity。

### 3. Transport 注入强 Principal

请求 body 不得携带 `principal`。认证 adapter 必须验证部署显式配置的 issuer、
audience、签名 key、有效期、not-before、不可变 subject 与 step-up fact，然后只
映射为 active User 的 `multi_factor` 或 `hardware` principal。

现有 cluster-control API credential 对 User 生成的 `single_factor` principal 必须
失败关闭；service credential 不能替代人类 decide。Cluster ceremony 永久固定为
`separation_of_duty`，requester 与 approver 必须是不同 User。

具体 OIDC、mTLS+step-up 或企业 IdP adapter 在后续 ADR 中选择；在 assertion
验证、key rotation 与撤销证据完成前，本管理 Deployment 保持关闭。

首个 assertion contract 已通过
`@qinglong/cluster-admin/plugin-package-identity-assertion` 固定为专用 compact
JWS，而不是直接信任通用 access token：

- protected header 必须精确为
  `typ=ql3-plugin-package-management+jwt`、reviewed `kid` 与 key-bound
  `EdDSA|ES256|RS256`，拒绝算法降级、未知 key 和额外 header；
- issuer 是 canonical HTTPS URL，audience 与
  `ql3_purpose=plugin-package-management` 必须精确匹配，claim 集合固定且有总字节
  上限；
- key set 最多 8 把，可用新旧 key 重叠完成 restart-based rotation；每把 JWK 必须
  是 exact public signing key，RSA 仅接受 2048–4096 bit/65537，EC 仅 P-256，
  OKP 仅 Ed25519，私钥字段或未知字段均拒绝；
- 每个受信 `acr` 必须由部署配置显式映射到 `multi_factor|hardware`，并列出全部
  required `amr`，verifier 不从任意字符串自行推断 assurance；
- assertion lifetime、authentication age、not-before 与 clock skew 都有硬上限；
  subject 只生成 User Principal，原始 `jti` 通过 issuer-domain-separated SHA-256
  派生内部 authentication ID，不进入 service request、审计响应或低敏结果；
- verifier 只使用 Node 24 `node:crypto` 和 profile-neutral Security contract，不读取
  网络、数据库、Kubernetes 或 Registry authority；源码门禁止其他 package
  import 此子路径。

ADR-0145 已将 verifier 绑定到有界 keyset 文件和独立 HTTP process。keyset 支持
overlap rotation、显式 revocation、同进程 generation rollback/rewrite 拒绝和每请求
重新读取；HTTP 先处理 Authorization 再读取 content/body，只开放 reviewed command
endpoint，并由可选 Kubernetes operation 部署。management Service 仍不进入默认
Kustomize。ADR-0146 已关闭 durable quota 缺口，ADR-0147 又关闭全副本重启
anti-rollback；在真实 IdP 与 live ingress 证据完成前仍不得接入生产 ingress。

### 4. PostgreSQL Authority 拆分

现有广义 admin role 必须收敛为至少两个不共享 LOGIN credential 的部署角色：

- manager：只允许 proposal、Approval、Project Policy 与低敏 Audit 所需的 exact
  SELECT/INSERT/UPDATE/function EXECUTE；
- executor：只允许 consume、execution/start barrier、Package installation、
  recovery 与发布所需的 exact authority。

management Pod 不挂载 Registry credential，不授予 Kubernetes write RBAC，不取得
stage/publish Secret。executor/recovery Job 不暴露 HTTP Service。

角色拆分必须通过 reviewed PostgreSQL migration、schema readiness、unknown-grant
拒绝、连接角色回读和 PostgreSQL 18 physical-promotion 门；不能在启动脚本中使用
superuser 动态 GRANT。

`pg-0022-plugin-package-authority-split` 已把 control-core capability 推进至 v21，
并执行以下收敛：

- `ql3_admin` 撤销全部 Package proposal、Approval/dispatch/execution、
  installation/head/mutation/admission table authority，以及两个 Package fence
  function 的 EXECUTE；
- `ql3_package_manager` 只取得 Project/RoleBinding 读取、Audit
  SELECT/INSERT、proposal SELECT/INSERT、Approval SELECT/INSERT/UPDATE 和 Approval
  policy fence；
- `ql3_package_executor` 只取得 Project/RoleBinding/proposal 读取、Audit
  SELECT/INSERT、Approval consume、dispatch/execution、Package install/head/
  mutation/admission 和两个所需 fence；
- 两个角色都是独立非特权 LOGIN，不得 `SUPERUSER`、`CREATEDB`、`CREATEROLE`、
  `REPLICATION` 或 `BYPASSRLS`，也没有 schema CREATE、owner 或 DELETE authority。

`pg-0023-plugin-package-management-quota` 又将 capability 推进至 v22，只增加
`plugin_package_management_quota_buckets`。该表仅允许 `ql3_package_manager`
SELECT/INSERT/UPDATE；admin、executor、runtime 与 worker-ingress 均为零权限。
`pg-0024-plugin-package-identity-keyset-ledger` 继续推进至 v23，增加一行有界
`plugin_package_identity_keyset_ledger`，以数据库事务固定 trust domain、
generation、active/revoked key 集合和 digest。

ADR-0151 的后续 `pg-0025-plugin-package-materialized-revisions` 已推进至 v24；
新增 immutable revision 表只允许 `ql3_package_executor` SELECT/INSERT，
manager/admin/runtime/worker-ingress/PUBLIC 均无权限。

Cluster recovery process 已只从
`@qinglong/cluster-postgres/package-executor` 导入连接与 readiness，并只接受
`QL3_POSTGRES_PACKAGE_EXECUTOR_*`。CloudNativePG 清单固定六个数据库角色，恢复
Job 不再投影 `ql3_admin` credential。

### 5. 有界请求、配额和低敏响应

- request body 最大 256 KiB，JSON 深度、节点数、字符串和数组均使用现有 Package
  contract 上限；
- 认证前只使用进程内有界并发/连接/超时 shield，避免为匿名流量访问数据库；
- 认证后以 PostgreSQL 数据库时钟、Project+subject+operation key 执行 durable
  quota，多 Pod 共享同一裁决；
- mutation 必须使用 caller 提供的稳定业务 ID，但时间由认证后的 authority 生成；
- response 不回显 bearer/assertion、完整 Manifest、source locator、Registry
  credential、DSN、authentication ID 或底层数据库错误。

进程内 shield 不是分布式 rate limit，durable quota 也不能取代 ingress 层容量保护。

## Package 粒度影响

本决策不创建 `cluster-package-api` 一文件包。`cluster-admin` 已拥有独立镜像、Node
engine、Kubernetes/PostgreSQL 第三方闭包和管理供应链生命周期；新的 transport 是
同一部署域内的显式子路径。真正需要拆分的是运行时 credential、数据库 GRANT、
ServiceAccount 和 process，而不是再增加 workspace importer。

## 验证门禁

1. single-factor User 和 service principal 都不能 decide；
2. 同一 User propose+decide 在数据库 mutation 前拒绝；
3. 两名强认证 User 可完成 propose+decide，且 body 中不存在 principal；
4. 公开路由不存在 consume/dispatch，伪造 system consumer 失败；
5. manager role 无 installation/recovery/Kubernetes authority，executor role 无公开
   management route；
6. 多 Pod durable quota 使用数据库时间保持一致，COMMIT response loss 可重放；
7. 256 KiB body、并发、超时、低敏错误和 audit 门通过；
8. manager/executor role readiness、未知 GRANT 拒绝和 PostgreSQL HA promotion 后
   重新连接门通过；
9. management Kubernetes overlay 不挂载 Registry credential，RoleBinding 不含
   ConfigMap/Secret 写权限；
10. workspace importer 仍为 21，cluster-control/edge/worker 制品闭包不变化。

当前已经通过第 1、3、4、5、6、7、8、9、10 项的适用子集：

- 专用 assertion 已验证 EdDSA、ES256、RS256，固定 issuer/audience/purpose、
  ACR+AMR、短 lifetime 与 key-bound algorithm；签名篡改、unknown key、通用 JWT、
  weak RSA、额外 claim/header、过期/未来 token、弱 assurance、非 User 与空
  principal 都在 service 访问前失败；
- 公开 command union 不包含 consume/dispatch，未知 operation 在认证前失败；
- command body 不能携带 principal 或 authority time；proposal 半提交恢复复用
  durable `createdAtMs`；exact decision replay 不重复 mutation；
- 结果不回显完整 manifest、source locator、Secret permission 或 authentication ID；
- v24 migration、manager/executor exact readiness、旧 admin Package 权限否定、
  六角色 CloudNativePG 部署审计和 executor-only recovery binding 已通过；
- PostgreSQL 18.4 physical streaming fixture 已在原 primary 和 promotion 后的新
  primary 分别用 manager/executor credential 重新连接并通过 readiness；同一门还继续
  通过 fencing、`pg_rewind`、双控制副本恢复与既有 COMMIT-response-loss 矩阵。
- bounded keyset 已通过 overlap/revoke、rollback/rewrite、implicit removal、
  append-only revocation、malformed/private/oversized 与 no-stale-fallback 门；
- TLS 1.3 HTTPS host 默认 body 64 KiB、硬上限 256 KiB，并通过 auth-before-body、
  peer/global shield、并发、keyset unavailable、readiness withdraw 与 drain 门；
- management operation 固定双副本、零 ServiceAccount token/RBAC、独立 TLS/
  keyset/CA 投影、manager-only CloudNativePG credential、HTTPS probe、NetworkPolicy
  与 fail-closed admin image digest；两个 Kustomize 层均可实际 render。
- durable quota 使用数据库 `clock_timestamp()` 和单语句 UPSERT；同一 window 的
  receipt 与 count 共同行锁、最多 1000 项。PostgreSQL 18.4 HA fixture 已用两个独立
  manager 实例并发 16 个请求，精确 8 allow/8 reject；exact replay 不重复计数，
  autocommit response loss 后回读仍为 1，数据库时钟窗口可重置。
- durable keyset ledger 已以两个 manager 实例验证并发同代观察、全新 repository
  重启后的旧代拒绝、同代 rewrite/隐式移除拒绝，以及 COMMIT response-loss 后
  generation 3 精确收敛。

第 2、3 的真实双 User/实际 IdP 部分，以及第 7、9 项的真实双
Pod/ingress/rotation live evidence仍未完成。

## 后续

- 取得真实双 User、双 Pod、ingress/rotation 和权限否定证据；
- 在管理入口稳定后再实现 UI，UI 不复制 Policy/Approval 协议。
