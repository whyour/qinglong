# ADR-0249：Worker 管理客户端 CA 有界重叠与安全退休

- 状态：Accepted（运行时约束、TLS 回归、部署摘要与运维流程已实现；生产多节点证据待采集）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-231、D-232、D-233
- 关联 ADR：ADR-0060、ADR-0247、ADR-0248

## 背景

ADR-0247 要求 Worker credential management 加载客户端 CA/CRL，ADR-0248 又证明同一 CA 下的证书吊销和
完整 Deployment replacement。但原 manager process 只限制文件类型、权限和 256 KiB 大小；任意 PEM 数量、
非 CA 证书、重复 trust root、过期 CA 或附加文本会一直推迟到 HTTPS/OpenSSL 行为，且部署只有 CRL 摘要，
不能可靠触发或审计 CA bundle 的 old → overlap → new 变化。

Cluster Worker ingress 已有多 CA snapshot；Worker management 不应为相同轮换问题增加新 package、controller
或 watcher。尤其 Edge/Standalone 可能运行在小型路由设备，不能让 Cluster-only PKI 运维扩大其安装闭包或
空闲资源。

## 决策

1. Worker manager 的 `ca.crt` 必须是严格 UTF-8，只含 1–16 张 PEM X.509 certificate；每张证书必须唯一、
   当前有效且 `X509Certificate.ca=true`。重复 fingerprint、附加文本、0 张或 17 张以上全部在 listener 启动前
   失败关闭。
2. `client.crl` 必须只含 1–16 份唯一 PEM X509 CRL；重复原始 PEM 摘要、附加文本、0 份或 17 份以上拒绝。
   合并 CA/CRL 集合还必须能由 Node/OpenSSL `createSecureContext` 在 TLS 1.3 边界装载。
3. runtime 不自建 ASN.1 CRL issuer parser。生产 PKI operator 必须为 overlap 中每个 issuer 提供当前 CRL，
   并以 old/new 两类真实 client handshake 证明集合完整；OpenSSL 在业务连接上继续拥有最终 certificate-chain、
   purpose 与 revocation authorization。
4. 轮换只有三个精确阶段：old、old+new overlap、new。每阶段都以不可变进程启动 snapshot 生效，并要求
   双副本 `maxUnavailable=0` 完整 rollout；不能只更新 Secret、只重启一个 Pod 或让副本持有不同 trust 集合。
5. Pod template 同时保存 CA bundle 和 CRL bundle 的 SHA-256 注解。提交态是全零 sentinel，生产私有 overlay
   必须替换；每次 bundle 变化必须推进对应摘要和 Deployment generation。
6. old 退休前，所有合法 caller 必须已经用 new identity 成功，overlap 传播窗口已完成；new-only 阶段必须
   证明 old client 401 `client_certificate_required`、new client 200。失败时只能回到一个新的 exact overlap
   generation，禁止单 Pod 临时扩权。
7. 实现留在既有 `@qinglong/cluster-admin` package 内部 subpath，不导出新公共 package，不新增第三方依赖、
   migration、controller、watcher、timer、sidecar、listener、Pool 或连接。Plugin Package management 不改变；
   Edge、Standalone 与 Worker Profile 不装配该 process，零稳态成本。

## 失败与恢复

- 候选 bundle 语法、数量、唯一性、CA 用途、有效期或 OpenSSL 装载失败：新 Pod 不监听，旧 Ready Pod 保持；
- overlap 中任一身份失败：保留 overlap，不得移除 old；修复 CA/CRL 或 client material 后推进新 generation；
- new-only 后发现漏迁移 caller：经受审变更恢复 exact overlap、同步更新两个摘要并完整 rollout，不能原地修改
  TLS context；
- old CA compromise：仍须先使 new client 可用并在全副本加载新集合，再移除 old；紧急性不能把超时或未知请求
  结果解释为成功退休；
- CA 轮换不替代 D-232 同 CA 证书吊销证据，也不改变 OIDC、Policy、审批和 durable audit 的独立要求。

## 被拒绝的替代方案

### 每个 CA 建一个 listener、sidecar 或 Deployment

拒绝。它会复制端口、证书、探针、NetworkPolicy、Pod 和故障域，并给资源受限场景增加无必要的供应链与运维面。

### 在 manager 内 watch Secret 并原地 reload

拒绝。部分副本和既有连接会出现混合 TLS generation，且 watcher/timer 增加空闲资源；启动 snapshot 加完整 rollout
更容易审计和回退。

### 只依赖 OpenSSL 接受任意 CA/CRL 文件

拒绝。它没有产品级数量、唯一性、当前有效性和附加数据边界，错误会推迟到连接或 Pod 启动，不利于稳定 rollout。

### 为校验器新建 package 或引入 X.509 第三方依赖

拒绝。校验只有一个 Cluster Admin consumer，Node 24 已提供 X.509、SHA-256 与 OpenSSL secure context；拆包会重现
D-207 所禁止的单文件边界碎片，并扩大 importer/SBOM。

## 验证

- process 定向 9/9：单 CA、双 CA overlap、重复 CA、附加文本、非 CA、17 CA、重复 CRL、无效 CRL和清理顺序；
- HTTPS 定向 6/6：真实 TLS 1.3 overlap 阶段 old/new 均 200，new-only 后 old 401、new 200；
- Cluster deployment audit 同时锁定 CA/CRL 全零摘要 sentinel，私有 overlay 必须显式替换；
- `docs/operations/ql3-worker-credential-management-ca-rollover.md` 固定阶段、负证据、恢复和 authority 分离；
- PostgreSQL 18.4 arm64 physical HA 在最终工作树重跑完成 `remote_apply`、timeline 1→2、旧主 fencing、
  `pg_rewind` 同步只读重入、双 fresh control replicas 与总 `gates.passed=true`，`ql3-ha-*` Docker 资源零残留；
- workspace 仍为 19 个 QL3 package，无新第三方依赖；生产外部 PKI/IdP/ingress 与多节点 old→overlap→new 联合
  报告仍是发布门。
