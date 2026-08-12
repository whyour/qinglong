# ADR-0386：Cluster Run Management Kubernetes 多节点实证

- 状态：Proposed（实现与静态回归完成；固定本机 live 证据待锁定输入可达后补录）
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-298
- 前置决策：ADR-0359、ADR-0364、ADR-0366、ADR-0382、ADR-0383、ADR-0384

## 上下文

Cluster 已有强认证 `run.retry | run.stop`、专用 `ql3_run_manager`、两副本 Kubernetes overlay 和 PostgreSQL HA Docker 证据，但这些证据没有在同一真实 CNI/Pod/CloudNativePG 环境中组合。静态 YAML、进程内测试和单机 PostgreSQL promotion 不能证明跨节点 Pod、mTLS/OIDC rotation、NetworkPolicy、readiness withdrawal 与数据库主切换同时成立。

部署用户跨度很大：Edge 路由设备不能为 Cluster 门增加任何常驻成本；Cluster 节点又需要真实多副本证据。因此本门必须是 `workflow_dispatch` 的短生命周期发布门，不能进入默认 CI、默认 overlay 或 Local artifact。

## 决策

1. 新增 opt-in 三节点 K3s live gate：1 control-plane + 2 worker、内置 Flannel、3 实例 CloudNativePG 1.30.0/PostgreSQL 18.4、2 个 Run manager Pod 且位于不同节点。
2. 直接构建当前 Cluster Admin/Control 镜像，应用既有 `operations/run-management/cloudnative-pg`；不新增 package、生产依赖、migration、表、角色、常驻进程或 sidecar。
3. 产品 client 以 tokenless、无 RBAC、immutable Secret 输入的 caller-driven Job 精确连接每个 Pod。`run.retry` 必须得到 `accepted → existing`，随后 `run.stop` 必须得到 `accepted → already_requested`；最终数据库只能有 1 个 retry Run、1 个 Attempt、2 个 retry Event、1 个 cancellation Event、2 个 allowed audit，重复 mutation 为 0。
4. 弱认证在业务层前返回 401 且不写项目 audit；强但无 RoleBinding 的 User 返回 403 并写恰好 1 个 denied audit。报告不保存 assertion、证书、密钥、DSN、kubeconfig 或业务内容。
5. OIDC keyset 执行 generation 1→2 overlap→3 revoke，回滚 generation 必须启动失败且始终保留 2 Ready Pod；mTLS CRL 更新必须替换全部 Pod、旧 client 被拒绝、新 client 可用，rollout 不低于 2 Ready。
6. 删除当前 CNPG primary 并确认 promotion 与恢复 3 实例；切断 `-rw` Service endpoint 时两个 Pod 都返回 503、readiness 为 503、liveness 为 200，恢复 endpoint 后旧 Pod不得原地恢复，必须由新 Pod 服务。
7. CNI 必须观测 labelled client allowed、unlabelled/wrong-port denied、manager→CNPG allowed、manager→Kubernetes API/public internet denied；ServiceAccount 无 Secret read 和 Deployment patch 权限。
8. live 代码分三层：通用 Kubernetes 管理 helper、Run 领域 scenario/SQL facts、严格离线 report audit。通用 executor 的 retry error code 改为显式配置且保留旧默认值，Approval live 回归必须通过。禁止复制身份 assertion、健康探针和平台原语；新增能力不得形成 workspace 微包。

## 证据合同

离线报告固定为 `qinglong/run-management-kubernetes-live-contract@v1`，要求：

- K3s `v1.32+`、锁定 `rancher/k3s:v1.34.3-k3s1`、3 个独立 PodCIDR；
- migration count 57、control-core capability 56、PostgreSQL version number 180004；
- 两个唯一 Pod/Node digest、PDB minAvailable 1、maxUnavailable 0、每 Pod Pool max 2；
- retry/stop exact replay、认证负向门、identity/certificate rotation、availability、isolation、durability 全为精确字段；
- `0600` regular file、no overwrite、无敏感材料；三条非生产 limitation 不得隐藏。

## Package 与低配影响

本切片不新增 workspace package。当前 package boundary 仍要求每个 `src/` 根文件都是 manifest 证明的入口；实现位于领域目录，高密度目录受 hard cap。文件少不是拆包理由，部署/authority/稳定多消费者才是 package 边界。该 live gate 只在人工发布作业中创建 Docker/K3s/CNPG 资源，完成后全部删除；Edge/Standalone 的文件、module、RSS、timer、listener 与连接预算不变。

## 验收状态

- Run/Approval live 静态合同、离线审计与既有 deployment 回归：20/20；Run report 审计含 topology/schema/deployment/client/rotation/availability/isolation/durability/secret 反向 fixture。
- runner、scenario、platform、identity、PKI 与 audit 均通过 Node syntax check；现有 Run deployment 合同通过。
- 本机真实门尝试下载校验和锁定的 CNPG manifest 时，`github.com:443` 在 75 秒无数据后超时；本机无缓存。未降低 checksum、未改用未审计输入，也未把静态结果记录为 live 通过。
- 完整 18-package build/test 退出 0；backend 1,174 pass/2 conditional skip/0 fail；14 个 Edge/Standalone Profile artifact 全部 compatible。基础 Edge 为 2,467,343 bytes/295 files/53 loaded modules，RSS delta 10,928,128 bytes，仍低于 4 MiB/512 files/16 MiB 门限。
- package/dependency/local-image boundary 全部 compatible，18 个 workspace package 无 single-source/shallow package；本切片没有改变任一 Local artifact 的生产闭包。
- PostgreSQL 18.4 arm64 HA 通过 123 gates、primary timeline `1→2`，报告 SHA-256 `6adb8c9de8929ff54b522e9a251e3081d9dd004c1a91f72f83c33288ddce63a9`；运行后 `ql3-ha-*` container、volume、network 均为空。
- 固定 K3s/CloudNativePG live report 仍是 ADR 从 Proposed 转为 Accepted 的唯一未满足证据。

## 后果

Cluster 有了可重复执行的真实组合门，但 Docker-host K3s 仍不是生产 control-plane HA 或 STONITH 证明，local deterministic IdP 也不替代外部 IdP 集成。工作流只提供 release candidate evidence，不改变默认部署。后续可把同构的 Approval/Automation runner 继续迁移到共享平台层，但不得为去除文本重复而一次性重写已通过的独立 live 流程。
