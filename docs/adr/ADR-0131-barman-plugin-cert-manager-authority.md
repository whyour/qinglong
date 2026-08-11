# ADR-0131：Barman Plugin cert-manager 证书 Authority

- 状态：Proposed（cert-manager v1.20.3 与 Kubernetes 1.32.8 兼容选择、
  official release manifest SHA-256、三个实际运行 image 的 OCI index 与
  amd64/arm64 digest、Barman 双向 TLS 身份/轮换窗口、cross-lock 和 mutation
  gate 已完成；真实 API readiness 与轮换演练仍是 Release Gate）
- 日期：2026-08-03
- 关联 RFC：QL-RFC-0001 D-127、D-128、D-129
- 关联 ADR：ADR-0127、ADR-0129、ADR-0130

## 背景

Barman Cloud CNPG-I plugin 与 CloudNativePG operator 之间使用 TLS。官方 v0.13.0
release manifest 创建 namespaced SelfSigned Issuer、client Certificate 和 server
Certificate，并要求 cert-manager API 在安装 plugin 前 ready。上游也允许部署方
自管证书，但部署方必须自行证明完整证书链、双向身份和轮换。

QL3 当前 live Kubernetes 基线为 1.32.8。不能直接使用 `releases/latest`：最新版
可能提高最低 Kubernetes 版本，也不能在 release manifest 中继续保留 tag-only
image 后声称供应链锁定。

## 决策

### 1. Barman 默认证书 authority 为 cert-manager v1.20.3

选择 cert-manager `1.20.3`，因为官方支持矩阵覆盖 Kubernetes `1.32`–`1.35`，
与 QL3 `1.32.8` Kind 基线相交；更新的 `1.21.0` 从 Kubernetes `1.33` 起，不作为
当前默认值。`1.20.3` 还包含 Challenge/Order 聚合 RBAC 的高危安全修复。

该依赖只属于启用 Barman 的 Cluster 基础设施：

- cert-manager 安装在 `cert-manager` namespace；
- Barman plugin 和它的 Issuer/Certificate 安装在 CloudNativePG operator 所在的
  `cnpg-system` namespace；
- edge、standalone、worker 和 QL3 npm/package 闭包不得导入 cert-manager client、
  CRD 或 installer；
- cluster-control 应用 Pod 无安装、签发、renew 或读取 plugin 私钥的权限。

### 2. 供应链锁与 live readiness 分离

`operators/cert-manager/selection-lock.json` 当前强制：

- `version: 1.20.3`；
- reviewed Kubernetes `1.32.8`；
- official release asset SHA-256
  `7ee74ba06845213e96d8ceaff3d20dd51e682765c1418eddda4e8780ba082261`；
- release manifest 实际引用的 controller、cainjector、webhook 三个 image 均锁定
  OCI index 及 `linux/amd64`、`linux/arm64` 子 manifest；
- static manifest 没有 startup API check 或 solver workload，禁止为满足数量要求
  虚构第四个 image；
- `status: supply-chain-verified`、`releaseReady: false`；
- 只保留 `live-cert-manager-api-and-plugin-mtls-rotation-evidence` blocker。

源码 tag 内的 `manifest.yaml` 不是 Release 资产：v1.20.3 仍必须从固定 Release URL
下载并先核对上述 SHA-256，再按 selection lock 将三个 tag-only 引用改写为对应
OCI index digest。锁目录保持仅含 JSON，不复制约 1 MiB 的上游 installer。

该静态 lock 不会因为仓库中出现一份历史报告而改写为 `releaseReady: true`。每次正式
镜像发布必须由 `cluster-dr-release-evidence` 在 commit-scoped 私有 runner mount 中
重新审计一份 24 小时内、source revision 精确匹配的 live report；该报告必须同时证明
client/server 轮换后 WAL、backup、latest restore 与 PITR 继续成功。`publish` Job 对此
证据采用硬 `needs`，因此没有 live 报告时保持不可发布，而不是让 operator 版本锁冒充
运行证据。

### 3. Barman 双向 TLS 身份固定

在 `cnpg-system` 中只允许以下资源合同：

- `Issuer/selfsigned-issuer`，`cert-manager.io/v1`、namespaced、SelfSigned；
- client Certificate `barman-cloud-client`：
  `commonName=barman-cloud-client`、`usage=client auth`、
  Secret `barman-cloud-client-tls`；
- server Certificate `barman-cloud-server`：
  `commonName=barman-cloud`、DNS SAN `barman-cloud`、
  `usage=server auth`、Secret `barman-cloud-server-tls`；
- 两者 `duration=2160h`、`renewBefore=360h`。

Secret 内容不得进入 Git、审计输出或应用 Pod。证书名称、用途、SAN、namespace 或
轮换窗口漂移必须失败关闭。SelfSigned 只用于 namespace 内 plugin transport，
不能复用为 PostgreSQL、Ingress、Worker 或用户 workload 的通用 CA。

### 4. 安装和轮换顺序固定

安装顺序：

1. 核验 cert-manager release asset 与全部平台 image digest；
2. 以 cluster-admin 安装锁定清单；
3. 等待 CRD established、webhook/cainjector/controller ready，并通过 API
   readiness；不能只看 Deployment 副本数；
4. 核验 Barman release asset，使用 digest-pinned controller/sidecar 引用安装；
5. 等待两个 Certificate Ready，复验证书 Secret type、key 集合、subject/SAN、
   usage、serial、NotBefore/NotAfter 与不相同的私钥；
6. 等待 Barman Deployment ready，再允许任何 Cluster 增加 plugin/WAL archiver。

轮换演练必须在有连续 WAL 和可恢复 base backup 的测试集群上执行：

1. 记录 client/server 旧 serial、Secret resourceVersion 和 NotAfter；
2. 触发受审 renew，不删除 Issuer、Secret 或跳过证书验证；
3. 等待两个 Certificate 再次 Ready，并证明 serial/resourceVersion 推进；
4. 证明 CloudNativePG operator 与 Barman manager 重连、每个 PostgreSQL sidecar
   使用新证书且无旧证书长期连接；
5. 轮换窗口内继续归档 WAL，完成一份新 base backup，并用轮换后的证书恢复；
6. 保存非密钥事件、condition、serial/fingerprint 和中断时间报告。

仅 Certificate Ready、Secret 更新或 plugin Pod 重启不能单独证明轮换成功。

## 替代方案

- **直接使用 `releases/latest`**：拒绝。版本、Kubernetes 兼容性和镜像都会漂移。
- **当前选择 cert-manager 1.21.0**：拒绝。其官方最低 Kubernetes 为 1.33，高于
  QL3 1.32.8 live 基线。
- **每个部署默认自管证书 Secret**：拒绝作为默认值。它会把链验证、双向身份、
  renew、原子 Secret 发布和 sidecar/operator 重载证明复制给每个部署。成熟平台
  可在独立 ADR/overlay 中采用外部 CA，但必须满足同等证据。
- **复用 PostgreSQL operator CA 或应用 CA**：拒绝。会合并数据库、plugin 和应用
  transport 的信任域。
- **由 cluster-control Pod 生成证书**：拒绝。常驻应用不能获得 cluster-wide
  签发或 Secret 写 authority。

## 影响

- 启用 Barman 的 Cluster 增加 cert-manager controller、webhook 和 cainjector
  常驻成本；这不进入路由器/standalone/worker 产物。
- Kubernetes 1.32 基线存在时，cert-manager 不能独立升级到 1.21；若升级
  Kubernetes，需重新评审两者的原子升级顺序。
- 供应链锁已完成；真实 API readiness 与轮换证据完成前，本 ADR 和 Barman
  Release Gate 保持 Proposed。

## 验证

- `pnpm audit:cert-manager-selection:ql3`
- `node --test test/back/ql3CertManagerSelectionAudit.test.cjs`
- `pnpm audit:barman-cloud-supply-chain:ql3`
- `node --test test/back/ql3CloudNativePgDrEvidenceAudit.test.cjs`
- official Release manifest/OCI digest 复核
- cert-manager API readiness、Barman mTLS 安装与 renew/backup/restore live evidence
