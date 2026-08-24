# ADR-0499：直接 Vault KV Worker Secret 外部托管

- 状态：Accepted
- 日期：2026-08-24
- 决策：D-404
- 关联：ADR-0058、ADR-0114、ADR-0233、ADR-0491、ADR-0494、ADR-0496、ADR-0497、ADR-0498

## 背景

ADR-0494 已证明 `mounted-files` provider 可以在 Kubernetes atomic projection 轮换后无重启读取新值，并且 Worker ingress 不需要 Secret API 权限。但该模式仍由 Kubernetes Secret 保存真实值，不能满足要求控制面只持有短期访问能力、密钥材料始终由外部托管系统保管的部署。

QingLong 3.0 需要一个可选的直接外部 custody adapter，同时保持小型 Edge/Standalone 默认闭包不变，也不能把 Vault token、Secret 值、Legacy Env 名称或 provider 路径写入 PostgreSQL、Pod environment、公开 evidence 或日志。

## 决策

### 1. Provider 边界

在既有 `@qinglong/cluster-control` Remote Execution 子域中增加 `vault-kv-v2` provider，不新建 workspace package。基础 Kubernetes 部署继续默认使用 `mounted-files`；只有显式选择 `QL3_WORKER_SECRET_PROVIDER=vault-kv-v2` 的 Cluster overlay 才加载该实现。Edge/Standalone 不导入 Cluster Control，因此其制品、常驻内存和依赖树不增加 Vault 客户端。

provider 只在 durable Worker delivery authority 已经通过 Run、Attempt、Lease、Session、execution digest 和精确 SecretRef 集合校验后执行。每个路径由 `SHA-256(canonical SecretRef)` 推导，不把 SecretRef 或环境变量名放入 URL。普通 Secret 与 opaque environment bundle 继续分别服从 16 KiB、96 KiB 和总交付上限。

### 2. 传输与身份

实现只接受无凭据、无 path/query/fragment 的 `https://` authority，使用显式投影 CA，并要求协商 TLS 1.3；不跟随 redirect，不使用系统 CA 回退。控制 Pod 只投影 CA 和短期 token，不投影真实 Secret 值，也不挂载 ServiceAccount token。

token 必须同时满足：

- orphan、non-renewable、service token；
- 只含一个精确配置的读取 policy；
- 剩余 TTL 大于 0 且不超过配置上限，部署默认上限为 900 秒；
- 每次 `verify` 或 `resolve` 都重新打开投影文件并调用 `auth/token/lookup-self`。

实现没有 cache、watcher、timer、renewal loop 或后台连接。token 轮换由外部部署 authority 原子替换投影文件；旧 token 的撤销与新 token 的签发不由 QingLong 接管。Vault 不可达、封存、CA 不可信、token 过宽/过期或材料缺失时交付失败关闭，不回退到 `mounted-files`。

### 3. KV v2 数据合同

每个值固定存放在：

```text
<mount>/data/<prefix>/<sha256(canonical SecretRef)>
```

KV payload 必须是 exact shape：

```json
{
  "schemaVersion": 1,
  "secretRefDigest": "<same 64-hex digest>",
  "encoding": "base64",
  "value": "<canonical base64>"
}
```

KV metadata 必须表明 version 为正整数、未删除且未销毁。空 Secret 是合法的 canonical base64；超限、非 canonical 编码、digest 不一致、未知字段或异常 metadata 均失败关闭。成功 material 在调用方 `dispose()` 时清零；报告和错误只暴露有界分类，不包含 endpoint path、token、SecretRef 或 value。

### 4. Kubernetes 部署

`deploy/kubernetes/ql3-cluster/vault-kv-worker-secret` overlay 删除基础部署的 value Secret env/mount/volume，只增加私有 CA 与短期 token 投影。示例文件只含占位符，仓库不保存可用 credential。

Vault policy 固定为：

```hcl
path "worker-secrets/data/values/production/*" {
  capabilities = ["read"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
```

外部 Vault 的 HA、unseal、KMS/HSM seal、审计设备、备份和灾备属于部署方独立门禁。本 ADR 证明 QingLong 的直接 custody 数据边界，不把单机 Vault file storage fixture 冒充生产 Vault HA。

## 被拒绝的替代方案

### 在 PostgreSQL 或 ConfigMap 保存密文

拒绝。即使值已加密，也会扩大数据库/配置平面的 custody、备份和读取权限，并把轮换与数据库生命周期绑定。

### 给控制 Pod Kubernetes Secret API 权限

拒绝。它扩大为 namespace 级读取能力，无法把访问限制到 durable delivery authority 中的精确引用。

### 引入 Vault SDK、Agent sidecar 或常驻续租器作为必选依赖

拒绝。直接 HTTPS adapter 已能满足有界请求；额外 SDK 或 sidecar 会扩大依赖、镜像、常驻内存和凭据生命周期。部署方可以负责 token projection，但不得通过该机制把真实值重新投影进 Pod。

## 验证

真实 arm64 live contract 使用 digest-pinned Vault 1.21.4、私有 TLS CA、3-share/2-threshold 初始化和短期 orphan token，完成两个普通 Secret 与一个 opaque environment bundle 的读取，并证明：

- value 轮换和 token 原子轮换均无需重启；
- 旧 token accessor 撤销后不再可用；
- 缺失 material、不可信 CA 和 sealed Vault 均失败关闭；
- unseal 后恢复，Vault 容器在同一持久存储上替换后值仍可读取；
- 私有 `0600` 报告不含 token、SecretRef、value、证书私钥或 Vault path。

最终本地报告 SHA-256 为 `df225509cb763009b610cb0aea2207e0b07b5e05a44cf8cf0dff1633c1624d52`，离线 audit 为 `compatible=true`、`findings=[]`。共享 CI 在原生 x64/arm64 runner 上分别构建 provider、审计 overlay、拉取同一 digest-pinned Vault image 并重跑完整 live contract；远程运行结果作为提交后的独立证据。

本地完整验证中，Cluster Control 为 `279 total / 277 pass / 2 conditional skip / 0 fail`，backend 为 `1574 total / 1572 pass / 2 conditional skip / 0 fail`，18-package clean build/test 退出 0。package boundary 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Cluster dependency、122-module Edge import、service-manager bridge、Cluster deployment、Local image、Vault overlay 和 14 档 Local artifact 均 compatible。基础 Edge/Standalone 制品仍为 `2,669,390 / 2,669,468 bytes`、325 files、58 loaded modules，不包含 Cluster Control 或 Vault adapter。

## 影响与剩余门禁

D-404 关闭 ADR-0491 的直接外部 custody adapter 门。ADR-0491 转 Accepted 前只剩固定低性能物理 Edge 的真实空间、RSS/I/O、写放大、ENOSPC 与断电恢复证据；开发机、Docker、CI runner 和 Cluster Vault live gate 均不能替代该设备证据。
