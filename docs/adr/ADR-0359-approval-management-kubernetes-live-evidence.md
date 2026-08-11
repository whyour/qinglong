# ADR-0359：Approval Management Kubernetes 多节点实证门

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-271、ADR-0356

## 上下文

ADR-0356 已完成 Cluster Approval Management 的专用 PostgreSQL role、双认证 transport、双 Pod 部署与静态最小权限契约，但静态 Kustomize、单机 PostgreSQL HA 和单元测试不能证明真实 CNI、跨节点调度、CloudNativePG operator、Pod replacement、证书轮换与数据库失联时的组合行为。

该证据不能进入 Edge/Standalone 默认门。路由器和低配设备仍应只承担短生命周期 `ql3-approval`，不能因为 Cluster 发布验证而安装 Kubernetes、CloudNativePG、OIDC、证书或常驻 Pool。

## 决策

1. 增加显式 opt-in 的 `qinglong/approval-management-kubernetes-live-contract@v1`，使用三个真实 K3s 节点、Flannel CNI、CloudNativePG 1.30.0 和三个 PostgreSQL 18.4 实例。
2. runner 必须从当前源码构建并加载 Cluster Admin/Control 镜像，执行 54 条 migration、验证 capability v53，再部署两个 Approval manager Pod；两个 Pod 必须被 required anti-affinity 放到不同节点。
3. 产品请求只经 TLS 1.3、mTLS 和 purpose-bound 强 User assertion 发出，并直接命中两个精确 Pod。测试必须覆盖 inspect、决定、exact replay、弱认证拒绝和有效但无权 User 的 durable denied audit。
4. identity keyset 必须证明 generation 1→2 overlap、generation 3 revoke、旧 assertion 拒绝，以及向 generation 2 回滚时两个 ready replica 保持但新 surge fail closed。
5. client certificate/CRL 必须证明旧证书吊销、替代证书可用、全 Pod replacement 和 `maxUnavailable: 0`。
6. 删除 CloudNativePG primary 后必须看到 primary 改变；临时切断 `-rw` Service 时两个客户端收到 503、readiness 撤销而 liveness 保留。数据库恢复后旧 Pod 不允许原地恢复，必须由 fresh Pod 重新通过 readiness。
7. CNI/RBAC 证据必须同时证明带 label client 可达、无 label/wrong port/API/public egress 不可达、CNPG 5432 可达，以及 manager 无 Secret read 或 mutation RBAC。
8. 最终报告必须验证 Approval version/state、allowed/denied audit、零重复决定、identity generation 3 和 failover 后 durable facts；报告只能写入调用方提供的绝对私有路径，以 `0600`、no-replace 方式原子产生，stdout 不承载完整证据。
9. runner、离线 importer 和手工 GitHub Actions workflow 只属于 Cluster release gate，不改变 package、生产 dependency、Edge/Standalone artifact 或默认 CI 成本。

## 放弃的方案

- 只复用 PostgreSQL Docker HA：不能证明 Kubernetes CNI、调度、PDB、Service、Secret projection 与 Pod replacement。
- 只检查 YAML：不能证明 transport、identity、certificate 和 database fence 的运行时组合。
- 在默认 CI 每次执行三节点门：成本和不稳定性会拖累低配与普通贡献路径；发布证据应显式触发。
- 把弱/过期 assertion 拒绝计入 durable audit：请求在可信身份建立前即失败，强行持久化会制造未认证审计噪声；另用有效强 User 的 Policy 拒绝证明 durable denied audit。
- 将该门推广为生产 control-plane HA 或 STONITH 结论：三个 privileged K3s Docker 节点仍共享一个宿主机。

## 结果

2026-08-11 arm64 实证报告通过全部十一项 gate：K3s `v1.34.3+k3s1` 三节点、Flannel 三节点 ready、CloudNativePG 1.30.0 三实例、PostgreSQL 18.4、54 条 migration/capability v53、Approval 双 Pod 跨两个节点。五次精确 Pod 请求完成三次 inspect、一次决定和一次 exact replay；最终 Approval 为 approved/version 2，allowed audit 4、denied audit 1、duplicate decision 0、identity generation 3。

identity rollback、证书吊销滚动、primary failover、数据库断连 readiness fence、fresh Pod recovery、CNI 与 RBAC 最小权限全部通过。报告为 5,093 bytes、mode `0600`，SHA-256 为 `4071610c524f30e6708002f5012f710a2edd3fd9571789c05b547e734b444a11`；离线审计 compatible，运行后相关 Docker container/network 零残留。

限制保持显式：它不是生产基础设施或 control-plane HA 证据；strong User assertion 来自确定性的本地 ceremony 而非外部 IdP；同一 Docker host 内的 CloudNativePG failover 不是基础设施 STONITH 证据。

## 验证

```bash
QL3_APPROVAL_MANAGEMENT_KUBERNETES_LIVE=1 \
QL3_KUBECTL_BIN=/absolute/path/to/kubectl \
QL3_CNPG_OPERATOR_MANIFEST_FILE=/absolute/path/to/cnpg-1.30.0.yaml \
pnpm test:approval-management-kubernetes-live:ql3 \
  --report=/absolute/private/approval-management-live-report.json

pnpm audit:approval-management-kubernetes-live:ql3 \
  --report=/absolute/private/approval-management-live-report.json
```

对应 GitHub Actions workflow 为 `.github/workflows/ql3-approval-management-live.yml`，仅允许手工触发，并在上传证据前复验内容、权限与资源清理。
