# ADR-0126：锁定的 Cluster 进程、镜像与 Kubernetes 部署基线

- 状态：Accepted（进程/migration binary、builder/production 双镜像专用 lock、实际 Docker build、双副本 Kustomize、静态部署门禁、ADR-0127 私有 CA 文件绑定与 ADR-0128 精确 SBOM/多架构发布契约已完成；真实 operator/proxy、STONITH、Pod 分区和远端 release run 仍是 Gate）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-06、D-85、D-105、D-118、D-123、D-124、D-126
- 关联 ADR：ADR-0038、ADR-0042、ADR-0045、ADR-0087、ADR-0088、ADR-0090、ADR-0119、ADR-0125

## 背景

仓库原有 `deploy/kubernetes/base` 只描述 QingLong 2.x 单副本 SQLite
`StatefulSet`。它要求 `replicas: 1` 和本地 `/ql/data`，既不能表示 QL3
PostgreSQL authority，也不能通过扩大副本数安全地变成 Cluster。

QL3 已有 `@qinglong/cluster-control/production`，但此前只有可调用函数，没有
容器进程入口、信号退出 ownership、镜像闭包、迁移操作入口和多副本清单。直接
在旧镜像中加载它会携带完整 2.x 前后端依赖；把 migration credential 放进每个
control Pod 又会把短生命周期 DDL authority 变成常驻权限。

## 决策

### 1. 继续使用既有 package，以 subpath 和 binary 表达部署责任

不新增 workspace package：

- `@qinglong/cluster-control/process` 提供单进程生命周期；
- `ql3-cluster-control` 是唯一常驻 binary；
- `@qinglong/cluster-postgres/migration-process` 提供 migration-only
  生命周期；
- `ql3-cluster-migrate` 是一次性 binary。

workspace importer hard cap 继续为 21。进程/镜像/部署标签不构成新的 package
理由。

### 2. Control 进程以稳定副本身份拥有所有租约

`QL3_CLUSTER_REPLICA_ID` 必须是最多 128 字节的安全稳定标识；Kubernetes
使用 Pod `metadata.name` 注入。recovery 与 scheduler 共用该副本身份，不生成
进程内随机 owner。

进程在启动数据库前取得 `SIGINT`/`SIGTERM` ownership；收到第一个信号后调用
既有 application `stop()`，由 admission withdrawal → lifecycle drain → Pool →
listener 顺序关闭。`timed_out` 必须转成失败退出，不能在滚动更新中冒充干净
停止。

日志只输出 versioned、低敏 JSON fact。数据库 URL、pepper、错误 message 和
领域 capability 不得进入进程日志；diagnostic 只保留有界 name/code。

### 3. Migration 是显式一次性 authority

migration command 只读取 `QL3_POSTGRES_MIGRATION_URL`，建立一个
`role: migration`、`maxConnections: 1` 的 Pool，执行受审 `pg-*` stream 后无论
成功失败都关闭 Pool。

TLS 默认 `verify-full`；URL 禁止 `ssl*` query override。禁用 TLS 必须同时设置
显式 insecure gate，但 committed Kubernetes Job 固定为 `verify-full`。

Job 不进入 runtime Kustomize base，使用：

- 独立 `ql3-cluster-migration` Secret；
- `generateName`；
- `backoffLimit: 0`；
- `restartPolicy: Never`；
- 无 Kubernetes API token；
- 非 root、只读根、drop ALL、RuntimeDefault seccomp。

control Pod 永远不取得 migration URL；migration Job 永远不取得 runtime URL 或
API credential pepper。

### 4. 镜像闭包独立于 2.x 根依赖

镜像只装配三个 workspace package：

1. `@qinglong/runtime-core`
2. `@qinglong/cluster-postgres`
3. `@qinglong/cluster-control`

外部 production dependency 固定为五个：

- `@aws-sdk/client-s3@3.1093.0`
- `croner@7.0.8`
- `drizzle-orm@0.45.2`
- `pg@8.22.0`
- `semver@7.7.4`

镜像目录拥有独立 builder lock；builder 只额外安装 TypeScript 与三个 exact
`@types` package，并按 runtime-core → cluster-postgres → cluster-control
直接编译。production stage 使用 ADR-0128 的 production-only manifest/lock，
避免 optional peer 把 `@types` 泄漏进产物。禁止 `pnpm deploy`、根
`package.json` 安装或 `COPY . .`。这是因为
本仓库 pnpm 8 实测的 filtered deploy 仍把 2.x 根闭包装入目标，约 212 MiB；
独立闭包样本约 38 MiB。

runtime 使用 Node 24.18.0、UID/GID 10001、`NODE_ENV=production` 和绝对
entrypoint。基础镜像与应用层的总体积必须分别记录，不能把依赖目录大小冒充
最终镜像大小。

### 5. Kubernetes 基线是无状态双副本，而不是数据库 HA 实现

`deploy/kubernetes/ql3-cluster/base` 固定：

- Deployment replicas 2；
- `maxUnavailable: 0`；
- hostname required anti-affinity；
- PDB `minAvailable: 1`；
- startup/liveness `/livez`，readiness `/readyz`；
- 128 MiB request、512 MiB limit；
- 非 root、只读根、drop ALL、RuntimeDefault seccomp；
- `automountServiceAccountToken: false`；
- runtime URL、TLS servername、pepper 从同一受审 runtime Secret 注入。

旧 `deploy/kubernetes/base` 保持 2.x 单副本语义，两者目录、Namespace、存储和
扩容说明必须分离。

## 不代表什么

本 ADR 只接受“可执行、可构建、可渲染、权限分离”的部署基线，不接受以下
生产 HA 声明：

- 真实 operator/proxy TLS endpoint 与 CA 重叠轮换演练；
- 基础设施 STONITH、节点/存储 fencing；
- 真实 Pod 网络分区或 raw PostgreSQL packet loss；
- Kubernetes HA control-plane/failover；
- northbound Gateway/Ingress TLS 与 cluster-specific NetworkPolicy；
- 远端 release workflow 的 GHCR manifest digest、Cosign/GitHub 签名/证明验证
  记录和漏洞证明；本地精确 SBOM、双架构 OCI attestations 与发布契约见
  ADR-0128。

system trust store 可支持受公开 CA 签发的稳定 PostgreSQL endpoint；私有
operator CA 已由 ADR-0127 的有界文件绑定支持，但在真实 operator endpoint 和
CA 重叠轮换演练完成前仍不能宣称生产 operator Gate 已通过。

## 替代方案

- **放大 2.x StatefulSet**：拒绝。SQLite 单写与 Cluster PostgreSQL authority
  完全不同。
- **每个 Pod 使用 initContainer migration**：拒绝。它会把 DDL credential
  常驻注入全部副本，并在滚动更新中制造并发 authority。
- **同一 runtime Secret 放入 migration URL**：拒绝。泄露域和轮换责任不同。
- **pnpm 8 filtered deploy**：拒绝。当前仓库实测会解析并安装根 2.x 闭包。
- **为镜像新建 workspace package**：拒绝。部署标签没有独立领域 contract 或
  consumer，不满足 D-85。

## 验证

- `pnpm --filter @qinglong/cluster-control check`
- `pnpm --filter @qinglong/cluster-control test`
- `pnpm --filter @qinglong/cluster-postgres check`
- `pnpm --filter @qinglong/cluster-postgres test`
- `pnpm audit:cluster-deployment:ql3`
- `pnpm sbom:cluster-image:ql3`
- `pnpm audit:cluster-image-release:ql3`
- `node --test test/back/ql3ClusterDeploymentAudit.test.cjs`
- `node --test test/back/ql3ClusterImageSbom.test.cjs`
- `kubectl kustomize deploy/kubernetes/ql3-cluster/base`
- `docker build -f deploy/containers/ql3-cluster-control/Dockerfile ...`
- 非 root/read-only 容器内分别执行两个 binary 的 `--help`
- inspect 镜像 UID、entrypoint、top-level production dependency

静态门禁必须拒绝单副本、inline Secret、privileged container、root dependency
widening、缺失进程入口以及 migration/runtime authority 混用。
