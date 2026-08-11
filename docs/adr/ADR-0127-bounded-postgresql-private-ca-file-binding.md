# ADR-0127：有界 PostgreSQL 私有 CA 文件绑定

- 状态：Accepted
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-06、D-34、D-105、D-123、D-124、D-125
- 关联 ADR：ADR-0042、ADR-0045、ADR-0125、ADR-0126

## 背景

ADR-0126 已提供独立 QL3 Cluster 镜像和 Kubernetes 双副本基线，但
PostgreSQL `verify-full` 只能使用 Node 系统 trust store。多数 Kubernetes
PostgreSQL operator 使用集群私有 CA；把 CA 烘焙进镜像会把证书轮换和应用发布
耦合，把任意文件路径直接交给 `pg` 又缺少大小、类型、权限和证书用途边界。

runtime、worker-ingress 和 migration 使用不同数据库角色与 Secret 域。即使它们
信任同一 operator CA，也不能因此合并 URL、pepper 或 DDL credential。

## 决策

### 1. 在既有 cluster-postgres runtime subpath 提供唯一 CA loader

不新增 package。`loadPostgresCertificateAuthorityFile()` 在打开文件后验证：

- 路径绝对、无控制字符且不超过 4096 字节；
- `fstat` 结果是普通文件；
- group/world write bit 均未设置；
- 文件为 1–256 KiB；
- 单次有界读取必须与打开时大小一致；
- 内容是严格 UTF-8，且除 PEM certificate block 外没有其他数据；
- 只允许 1–16 张唯一 X.509 certificate；
- 每张证书的 Basic Constraints 必须为 CA。

Kubernetes projected Secret 的外层路径可以是 symlink；loader 验证已打开 target
的真实文件，因此兼容 kubelet 原子 `..data` 切换，又不把目录或 socket 当信任
材料。

输出为规范化 PEM bundle，只存在于当前进程内并直接绑定到 `pg` 的
`ssl.ca`；文件路径、PEM 和证书 subject 不进入普通进程日志。

### 2. TLS disable 与 CA file 互斥

以下配置分别接入同一 loader：

- control runtime：`QL3_POSTGRES_TLS_CA_FILE`
- migration：`QL3_POSTGRES_TLS_CA_FILE`
- Worker ingress：`QL3_WORKER_INGRESS_POSTGRES_TLS_CA_FILE`

只有 `verify-full` 可以使用 CA file。即使设置了 insecure 双门，
`TLS_MODE=disable` 与 CA file 同时存在也必须拒绝，避免部署者误以为连接仍在
校验证书。

CA file 可省略以继续支持系统 trust store，但 QL3 Kubernetes Cluster base 固定
配置私有 CA 路径。

### 3. Runtime 与 migration 保持独立投影

runtime Deployment 只从 `ql3-cluster-control-runtime` Secret 投影
`postgres-ca.crt` 到：

`/var/run/secrets/qinglong3/postgres-runtime/ca.crt`

migration Job 只从 `ql3-cluster-migration` Secret 投影同名 key 到：

`/var/run/secrets/qinglong3/postgres-migration/ca.crt`

两个 volume 都是 read-only、mode 292（八进制 0444），并用 `items` 只投影 CA
key。control Pod 不取得 migration URL，migration Job 不取得 runtime URL 或 API
pepper。

### 4. Trust rotation 以新 activation 生效

CA 在 config 装载时读取一次。kubelet 更新 Secret 后，现有 Pool 不热切换信任
根；必须滚动创建新 Pod，新 activation 重新读取 bundle，再依次通过 TLS、
schema/role readiness、startup recovery 与 lifecycle gate。

这与 ADR-0125 的 one-way availability fence 一致：数据库失联后的旧 activation
不能因文件变化原地恢复 ready。

### 5. 显式 DNS 身份与 old → overlap → new 契约

production `verify-full` 配置必须显式提供 DNS servername；不得使用 IP literal、
省略后依赖 driver 隐式推断，或用 URL `ssl*` 参数覆盖。runtime、migration 与
worker-ingress 三条配置链在创建 Pool 前执行同一 DNS servername 约束。

`audit:postgres-ca-overlap:ql3` 复用上述有界 CA loader 读取 old、overlap 和 new
三个 bundle，并只输出低敏 anchor count 与集合 SHA-256。overlap 必须是 old/new
anchor 的精确并集，不得遗漏旧 anchor 或夹带第三方 anchor；新旧集合必须至少
引入和退役一张证书。部署固定按“扩信任并全量滚动 → operator 轮换 endpoint
certificate → 再滚动新连接 → 收缩信任并全量滚动”的顺序执行，回退则先恢复
overlap trust，再回退 server certificate。

具体命令、停止条件、回退顺序和证据字段冻结在
`deploy/kubernetes/ql3-cluster/operations/postgres-ca-rotation.md`。

## 不代表什么

本 ADR 证明 CA 文件到 `pg ssl.ca` 的本地和清单契约，不证明：

- 任一真实 PostgreSQL operator/proxy endpoint 的证书链和 SAN；
- 在真实 operator 上执行 CA 重叠轮换、旧 CA 移除和 rollback 演练；
- operator primary Service、promotion 或基础设施 STONITH；
- Pod 网络分区、raw PostgreSQL packet loss，或 ADR-0128 远端多架构 release
  workflow 的成功记录。

这些仍需使用实际 operator 与集群故障注入验证。

## 替代方案

- **把私有 CA 烘焙进镜像 trust store**：拒绝。轮换需要重建镜像，并扩大所有
  Node TLS consumer 的信任面。
- **URL `sslrootcert`/`sslmode` 参数**：拒绝。会绕过统一 TLS 配置和静态审计。
- **把整个 Secret volume 暴露给进程**：拒绝。只投影 CA key，避免无意暴露
  URL、pepper 或其他 authority。
- **监听文件并热更新 Pool**：拒绝。增加 watcher 和 trust 切换竞态，且不能为
  已建立连接重新完成 readiness/recovery。
- **runtime 与 migration 共用 Secret**：拒绝。信任根相同不等于数据库权限相同。

## 验证

- CA loader 正向覆盖 projected-Secret symlink；
- 负向覆盖相对/缺失/目录/可写/超限文件；
- 负向覆盖 trailing data、非 CA、重复和超过 16 张证书；
- runtime、migration、worker-ingress config 验证 exact `tls.ca`；
- 三条 `verify-full` 配置链拒绝缺失、IP literal 或非法 DNS servername；
- TLS disable + CA file 必须拒绝；
- old/overlap/new auditor 正向验证精确集合并集，负向拒绝遗漏、夹带、无退役和
  非规范 fingerprint；
- `qinglong/postgresql-tls-rotation@v1` 在本机 arm64 `postgres:18`
  （PostgreSQL 18.4）建立真实 TLS 1.3 会话：错误 SAN servername 以
  `ERR_TLS_CERT_ALTNAME_INVALID` 拒绝；old certificate 下 old-only/overlap
  通过，SIGHUP 切换 new certificate 后 old-only 以
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 拒绝而 new-only/overlap 通过；回退 old
  certificate 后 new-only 被拒绝、old-only/overlap 恢复。每个成功连接同时
  证明 `pg_stat_ssl.ssl=true`、`pg_is_in_recovery()=false` 与
  `transaction_read_only=off`；
- x64/arm64 原生 PostgreSQL 18 physical-promotion CI job 在 promotion 门前执行
  独立 TLS rotation gate；
- 部署静态门拒绝错误路径、Secret、mount、mode 或投影 key；
- runtime base 通过离线 Kustomize 渲染，`generateName` migration Job 通过严格
  YAML/静态契约验证；
- 最小镜像在 UID 10001、只读根、drop ALL、no-new-privileges 下从正式 mount
  path 为 runtime/migration 读取同一 CA bundle；
- cluster-postgres、cluster-control 全量类型和测试门通过。
