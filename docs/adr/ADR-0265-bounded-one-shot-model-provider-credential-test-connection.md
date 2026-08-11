# ADR-0265：有预算的一次性 Model Provider Credential Test Connection

- 状态：Accepted
- 日期：2026-08-03
- 关联：RFC D-08、D-12、D-159、D-175；ADR-0169、ADR-0263、ADR-0264

## 背景

Provider credential 的 bind/revoke ceremony 已有独立 manager，但“测试连接”若直接放进
manager，会迫使常驻管理进程同时持有 Provider Secret 与任意外网访问能力；若只由客户端传 URL、
deadline 或 retry，又会成为 SSRF、费用放大和绕过部署网络策略的入口。低配路由设备不应为一个
偶发操作长期支付 listener、连接池、timer 或 AI provider 依赖；Cluster 则需要 durable quota、
崩溃后不重复请求 provider、同步复制和晋升后的明确结果。

## 决策

### 1. Manager 只签发计划，不接触 Secret 或 Provider 网络

公开操作固定为 `provider-credential.test.plan`。请求只接受 `requestId/testId/projectId/provider`，
principal 由 transport 注入；endpoint、adapter、deadline、response/model/cost/retry 预算全部从
server-owned exact allowlist 解析。manager 要求五分钟内的 strong User、`secret.manage` 和当前
Project/RoleBinding fence，在一个 SERIALIZABLE transaction 内消费 durable quota、写 immutable plan
和 allowed SecurityAudit。相同业务 identity 与相同 lifetime 的晚到 API retry 返回原始 plan，不重复
消费 quota；调用方不能提交 URL、SecretRef、deadline、budget 或 retry。

allowlist 是不含 Secret 的 ConfigMap，单文件不超过 64 KiB、最多 16 个 provider。endpoint 只允许
canonical HTTPS，deadline 1–15 秒、response 1–256 KiB、models 1–256、费用固定为零、retry 固定为零；
plan 最长存活五分钟。manager Deployment 继续不挂 Provider Secret，base NetworkPolicy 继续没有
Provider egress。

### 2. Provider authority 只存在于 caller-driven one-shot tester

新增能力仍留在既有 `@qinglong/ai`、`@qinglong/cluster-admin` 和
`@qinglong/cluster-postgres` 的显式 subpath，不新增 workspace package。tester 只接受 exact
`executionId/testId/allowlist` command，使用专用 `ql3_ai_credential_tester` PostgreSQL role 和
`maxConnections=1`：

1. 先提交 immutable execution intent；
2. 只有 `status=created` 才在同一个 one-shot Pod 内执行不带 credential 的 CNI 收敛屏障：exact
   provider TCP 必须可达，同时 deny-canary（Cluster 使用 Kubernetes API Service）必须不可达；两者共用
   原始 deadline，不重试 Provider API；
3. 屏障成立后才逐请求解析 current binding、读取一个 Project-bound projected Secret，并在 Provider
   请求前提交 content-free credential-use audit；
4. 对计划中的 `/models` 只执行一次 GET；
5. 只持久化 `reachable|unreachable`、model count、duration 与 digest，不保存 endpoint response、
   SecretRef、token/header 或 raw error；
6. completion 暂时不可用时只重试同一个结果写入一次，绝不重打 provider。

已有 intent 但无 result 表示 `outcome_unknown`，必须停止且不得网络重放；已有 result 返回 exact
existing。deadline 使用 AbortSignal 和 monotonic clock 双围栏；超时、provider error、响应超限或
model 超限统一保存 content-free `unreachable`。

### 3. PostgreSQL 与部署权限分离

`pg-9015` 新增 plan/quota/execution/result 四张表。manager 只能写 plan/quota/allowed audit，tester
只能读 plan/current binding、append execution/result/use audit；tester 不能读写 quota、SecurityAudit、
Prompt output、invocation、price、Package、Worker、admin、maintenance 或 migration authority，也没有
`ql3` schema USAGE。readiness 对拒绝权限使用 `pg_catalog` OID 检查，不能为让自检通过而扩权。

Kubernetes tester 是 opt-in、caller-driven Job：`backoffLimit=0`、`activeDeadlineSeconds=60`、
`ttlSecondsAfterFinished=300`、tokenless ServiceAccount、non-root/read-only/drop ALL，request 为
25m CPU/48 MiB、limit 为 500m/192 MiB。base 只有 DNS egress，因此故意不能访问 provider；
CloudNativePG overlay 只增加 tester role 的 PostgreSQL 5432，部署者再以私有 overlay 为 exact private
provider `/32:443` 放行。标准 NetworkPolicy 不能表达 FQDN，故应用 exact HTTPS allowlist 与部署 CIDR
必须同时成立；公网 SaaS 需要 CNI FQDN policy 或受审 egress proxy，不能静默放宽 `0.0.0.0/0`。

### 4. Edge/Standalone 保持零常驻成本

本 ADR 不把 Cluster manager/tester、`pg`、Kubernetes client、listener 或 pool 带入 Edge/Standalone。
低配设备若后续需要同等产品入口，应复用短生命周期本机 Owner/SQLite ceremony 和 AI feature gate；
不得为了 API 对称启动常驻 daemon。Cluster 可由 Job 横向处理不同请求，但每个 test 仍是唯一 intent、
零 provider retry；不能把副本数变成隐式 provider 重试。

## 被否决方案

1. **让 manager 直接测试**：合并身份管理、Secret read 和任意 provider egress 三种 authority。
2. **客户端直接传 URL/预算**：打开 SSRF、长连接、响应放大和费用绕过。
3. **已有 intent 自动重打 provider**：COMMIT 响应丢失时会产生重复外部副作用和费用。
4. **按 provider 建 workspace package**：只有少量协议/adapter 文件，没有新的独立交付或依赖反转价值。
5. **base NetworkPolicy 放行公网 443**：无法证明流量只去 allowlist hostname。
6. **给 tester `ql3` schema USAGE 以通过 readiness**：扩大实际 authority，并掩盖拒绝权限探针缺陷。

## 当前验证

- AI 全量 176 项：173 通过、3 条条件跳过、0 失败；Cluster Admin 全量 242 项：240 通过、
  2 条条件跳过、0 失败；plan/execution PostgreSQL 定向 9/9；
- manager service/transport/client/process、executor/process/CLI、Kustomize base/CNPG、manager/tester/
  CloudNativePG/dependency audit 均通过；workspace 仍为 19，没有为 test connection 新增 package；
- PostgreSQL 18.4 arm64 physical HA 实际使用 `ql3_ai_credential_tester` 单连接池，证明 plan/execution
  exact replay、provider 调用恰好一次、Secret material 清零一次、completion COMMIT 已提交但响应
  丢失后以同结果收敛、四类 durable fact 无 Secret、`remote_apply` 同步 WAL、timeline 1→2 晋升后
  facts/readiness 完全一致；新增五个具体 gate 和总 `gates.passed=true`；
- HA 运行后 `ql3-ha-*` 容器、网络、卷零残留，既有
  `ql3-cnpg-evidence-control-plane` 容器保持运行且未被操作。
- 显式 opt-in 的真实三节点 K3s/arm64 纵切面使用锁定的 K3s `v1.34.3+k3s1`、CloudNativePG
  `1.30.0` 与 PostgreSQL `18.4`，三个 PostgreSQL 实例分别预绑定到两个 worker 和唯一 control-plane；
  初始主库固定在 worker A，停止该 worker 后 primary 成功切换，worker 恢复后数据库回到 3/3 Ready，
  唯一 control-plane 始终在线；
- 纵切面真实执行 8 个 one-shot Job（7 个 execution、1 个 exact replay），证明 projected Secret
  material generation 1→2、旧 material 拒绝、新 Pod 重解析、Provider Pod/CIDR 轮换、旧 CIDR
  fail-close、exact private `/32:8443`、DNS/CloudNativePG allow 与 Kubernetes API/公网 deny。CNI 在新
  Pod 创建后存在短暂策略编程窗口，因此 tester 现在必须在 Secret/binding/audit 前同时证明 Provider
  allow 与 Kubernetes API deny，不能以另一个预检 Pod 代替；
- 最终 content-free 报告为 `gates.passed=true`：7 plan/execution/result、7 plan audit、5 次实际到达
  credential-use 阶段的 use audit、4 reachable、3 unreachable、5 次 Provider `/models` 请求、零 replay
  duplicate，并在 CloudNativePG failover 后完整存活；报告审计和部署审计均无 finding；
- Docker K3s 的本地 `imagePullPolicy: Never` 镜像会在节点重启或 containerd GC 后消失，测试夹具在
  节点恢复后重新导入 exact 本地 admin image，再执行全节点收敛。这是离线测试制品恢复，不是生产
  Provider 或数据库重试。成功运行后随机 K3s 容器、网络、卷和测试镜像零残留，受保护的既有
  evidence control-plane 未被操作。

## 剩余生产证据与边界

本 ADR 的私有 Provider test-connection 接受门已经关闭，但该 Docker 夹具使用 privileged K3s、
fixture-only prebound hostPath、单个 Docker host 和唯一 Kubernetes control-plane；它不能冒充动态 CSI、
基础设施 STONITH、control-plane HA 或跨故障域证据。确定性私有 HTTPS Provider 也不是外部 SaaS。
公网 SaaS 仍必须选择并验证 CNI FQDN policy 或 egress proxy，不能复用私网 `/32` 结论；真实外部
OIDC/mTLS、KMS/Vault/HSM custody、首次 provision/active rotation/lost-secret recovery 继续由后续
ADR 和发布门负责。
