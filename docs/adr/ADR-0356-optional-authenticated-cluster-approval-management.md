# ADR-0356：可选、受认证且独立授权的 Cluster Approval 管理面

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-123、D-127、D-157、D-257、D-259、D-260、D-263、D-265、D-266、D-267、D-268
- 关联 ADR：ADR-0031、ADR-0125、ADR-0129、ADR-0138、ADR-0353、ADR-0354、ADR-0355

## 背景

ADR-0355 已建立 Profile-neutral Approval inspect/decide 服务和本机 `ql3-approval` Owner CLI，但有意没有注册
Cluster 远程 route。Cluster 操作者若只能在进程内组合 service，就没有可部署、可认证、可限流、可审计且能在数据库故障时
摘流的产品入口；若把入口塞进 `cluster-control`，又会让调度/执行控制面取得人类决定 authority。另一方面，Edge/Standalone
尤其是低配路由设备不能因为 Cluster 能力而增加 HTTPS listener、证书、OIDC keyset 或 PostgreSQL Pool。

## 决策

1. Cluster Approval 管理面是独立、默认不部署的 `cluster-admin` process，固定只服务
   `POST /api/v3/approvals/management`、`/livez` 与 `/readyz`。它不注册到 `cluster-control`，也不进入
   Edge/Standalone artifact 的启动图。
2. 公共业务操作仅为 schema v1 的 `approval.inspect` 与 `approval.decide`。inspect 返回 canonical action binding 和既有
   redacted preview；decide 必须带回完整 `expectedAction`、固定 `expectedVersion: 1`、稳定 decision ID 和有界 reason code。
3. 每次业务请求都必须同时通过 TLS 1.3 mTLS 与短期 OIDC。断言固定
   `aud=qinglong3-approval-management`、`typ=ql3-approval-management+jwt`、
   `ql3_purpose=approval-management`，主体只能是具有 `multi_factor` 或 `hardware` assurance 的 User。其他 management
   plane 的 assertion 即使 issuer/key 相同也不能复用。
4. Transport 在 service 前后都重新认证。初次认证失败写 `authentication_rejected`；第二次认证漂移、Policy 或 credential
   fence 失败写 `denied`，并保持低敏错误响应。成功 inspect/decide 继续使用领域层的 durable audit 与原子状态转换。
5. PostgreSQL `pg-0054-approval-management-boundary` 将 control-core 推进到 capability v53，新增非 superuser、非
   CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS 的 `ql3_approval_manager`。它只读 Project/RoleBinding、Approval、preview
   Artifact metadata，能追加安全审计、更新 Approval、维护本 authority 的 identity keyset ledger，并执行专用 Approval
   Policy lock；不得取得 runtime、package executor、migration、AI credential 或 Secret authority。
6. 进程只能使用 `role: approval-manager` 打开一个调用方拥有的 Pool；默认/生产清单每 Pod 最多 2 条连接。任何 Pool、schema
   readiness 或 writable-primary 失败都单向撤销 `/readyz` 与 admission，完成有界 drain 后退出，由 Deployment 创建新实例；
   不在原进程透明重连或重放不确定决定。
7. 生产 base 固定 2 Pod、required hostname anti-affinity、PDB `minAvailable: 1`、只读 root、UID/GID 10001、drop ALL、无
   ServiceAccount token。Service 为 ClusterIP 8447；base 只允许 DNS egress，CloudNativePG overlay 只增加 exact database
   Pod 的 TCP 5432。
8. ingress 只接受同 namespace 且带 `qinglong.io/approval-management-client=true` 的 Pod。server TLS、client CA/CRL、
   OIDC public keyset 与 PostgreSQL CA 使用分离的只读投影；私有 overlay 必须替换 CA/CRL annotation digest 和全零 Admin
   image digest。
9. 对操作者提供独立 `ql3-approval-client` 和 opt-in `approval-management-client` Job。Job 无 RBAC/token、
   `backoffLimit: 0`，init 只重试 mTLS `/readyz`，main 只执行一次业务命令；command/assertion/client key 分离为 immutable
   Secret，只有 server CA 可使用 ConfigMap。
10. 响应丢失不等于回滚。inspect 使用新的 request/audit identity 重读；decide 只能用完全相同的 decision ID、决定、reason、
    User 与 action binding 精确重放。客户端、Kubernetes 或 HTTP 层不得自动生成新业务身份重试。
11. identity keyset generation 只能前进；同 generation rewrite、隐式 key 删除、撤销回退均失败关闭。HA gate 必须证明
    Approval ledger 在双实例竞争、COMMIT response loss、物理复制、promotion 与进程重启后仍收敛。
12. MCP 永久保持 Approval 只读，Cluster management 决定也不会 consume、dispatch 或 execute Approved Action。外部副作用仍由
    对应执行面自己的 start barrier、receipt 和恢复协议负责。

## Package 与低配资源裁决

- 不新增 workspace package。Profile-neutral inspection/decision 归 `runtime-core/approved-action`；PostgreSQL authority 归
  `cluster-postgres/approval-management`；transport/process/client 归 `cluster-admin/approval-management`。
- 这是 authority、部署和依赖边界内的包内领域目录，不按文件数制造微包，也不把写 authority 暴露到宽 root barrel。
- Edge/Standalone 仍使用短生命周期、单 SQLite connection 的 `ql3-approval`；未调用时资源为零。Cluster 的两个 listener 和
  最多四条 aggregate PostgreSQL connection 只在显式应用 operation 时存在。
- 十二档 artifact 预算不放宽。当前最紧的 Standalone Application AI 为 6,284,121 / 6,291,456 bytes，仅余 7,335 bytes；
  后续默认闭包增加必须先裁剪或重新评审，不把本次“通过”解释为充裕余量。

## 被否决方案

1. 把 decide 加入 MCP：混合 Agent read authority 与 Human write authority。
2. 把 route 加进 `cluster-control`：调度/执行进程会取得人类决策、OIDC 与 client trust authority。
3. 让 Approval manager 使用 `ql3_admin` 或 runtime role：最小权限和故障域失效。
4. 使用 bearer-only 或 mTLS-only：分别缺少 possession factor 或可审计的人类身份/assurance。
5. 为两个 Cluster 文件另建 package：没有独立依赖、版本或 artifact 生命周期收益，会重新制造微包。
6. Kubernetes Job 自动重试决定：会把未知 COMMIT 结果误当失败并制造双重语义。
7. 为路由器统一启动同一 HTTPS manager：把只属于 Cluster 的证书、监听与数据库成本强加给低配部署。

## 验证证据

- Runtime Core 459/459；Cluster Admin 271 项中 269 pass、2 条件 skip；Cluster PostgreSQL 293 项中 292 pass、1 条件 skip。
- Cluster deployment 47/47；package boundary、cluster dependency、edge import、CloudNativePG role、base/CNPG/client Kustomize
  render 与十二档 artifact 全部 compatible。
- 17 package / 994 source，968 个位于领域子目录、26 个根入口；没有单源或 shallow package，package 数未增加。
- PostgreSQL 18.4 arm64 HA gate `gates.passed=true`，覆盖 `remote_apply`、复制链分区、promotion guard、旧主 fencing、
  timeline 1→2、`pg_rewind` 只读同步重入、Approval manager readiness 与 Approval identity keyset ledger；结束后容器、网络、
  卷均零残留。
- 当前证据不是生产 Kubernetes control-plane HA、基础设施 STONITH、外部 IdP ceremony 或真实多故障域容量结论。
