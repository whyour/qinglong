# ADR-0145：有界 Cluster Plugin Package 管理 Host 与可选部署

- 状态：Accepted（keyset、TLS 1.3 HTTPS host、默认关闭的独立 process/CLI、
  manager-only composition、可选 Kubernetes operation、静态门禁与本机
  PostgreSQL 18.4 physical HA 回归、durable distributed quota 与全副本重启
  anti-rollback 已实现；真实 IdP 双 User 与 live cluster ingress 仍是生产开放前置）
- 日期：2026-07-25
- 关联 RFC：QL-RFC-0001 D-05、D-08、D-09、D-49、D-85、D-127、
  D-139 至 D-143

## 上下文

ADR-0142 已建立唯一的认证后 Package management facade，ADR-0144 又冻结公开
`propose | decide | inspect`、强 User principal、`separation_of_duty` 与
`ql3_package_manager`/`ql3_package_executor` 双 authority。此前仍缺少三个生产
边界：

1. reviewed identity public key 如何在无网络信任发现的条件下轮换和撤销；
2. 谁拥有 TLS listener、请求容量和认证顺序；
3. Cluster 用户如何显式部署该入口，同时不把它带入 edge、`cluster-control` 或
   recovery authority。

直接把 listener 加到 `cluster-control` 会让常驻 runtime 取得 Package 管理数据库
权限。复用 recovery Pod 又会把 Registry credential、Kubernetes ConfigMap write
与公开 parser 聚合在同一故障域。使用远端 JWKS 自动发现还会新增启动网络依赖、
缓存 stale/fallback 语义和后台 refresh 生命周期。

## 决策

### 1. 继续使用既有 package

实现留在 `@qinglong/cluster-admin` 的显式子路径：

- `/plugin-package-identity-keyset`
- `/plugin-package-management-http`
- `/plugin-package-management-process`

独立 binary 为 `ql3-plugin-package-manage`。不新增 workspace package，不新增第三方
依赖，也不从 package root、`cluster-control`、Worker、edge 或 standalone 入口导出。
包边界按部署/权限生命周期划分，不按文件数量划分。

Cluster composition 只返回 `propose`、`decide` 与 `inspect` 的窄 service。即使底层
共享 facade 还定义 system `dispatch`，management process 也不构造 Package executor
repository，不向 transport 暴露该方法。

### 2. 文件式 public keyset

keyset 使用部署控制器投影的绝对路径 regular file，不进行网络发现：

- 默认最大 64 KiB，硬上限 256 KiB；
- 文件不得 group/world writable，读取前后复验 inode、device、size、mtime 与
  ctime，读取竞态失败关闭；
- JSON 必须为严格 UTF-8 和 exact shape；
- 最多 8 把 EdDSA/ES256/RS256 public JWK；私钥字段、未知字段、弱 RSA 或算法/
  key 不匹配拒绝；
- 最多 64 个 revoked `kid`，至少保留一把 active key；
- 每次认证重新打开当前文件，不保留 stale-success fallback；
- 同一进程内 generation 只增不减，同 generation 的 digest 不可改写，revocation
  只可追加，移除 active key 必须在新 generation 中显式列入 `revokedKids`。

推荐操作顺序是：先发布 old+new overlap generation，确认所有副本读取新 key，再发布
含 old `kid` revocation 的下一 generation。Secret 投影传播不是同步广播；一把 key
只有在所有副本观察到 revocation 后才可视为集群范围撤销。

进程内 monotonic guard 不能证明所有副本同时重启后的历史。生产环境还必须由 GitOps
或 admission ledger 持久化最高 generation 与 revoked set，并在写 ConfigMap 前拒绝
rollback/rewrite。该证据完成前，不把文件 loader 描述为 durable trust registry。

### 3. TLS 1.3 与认证前容量门

host 使用 Node 24 `node:https`，只允许 TLS 1.3。private key 在 secure context 创建后
立即清零输入 Buffer。公开路由只有：

```text
POST /api/v3/plugin-packages/management
GET  /livez
GET  /readyz
```

管理请求必须先验证 exact `Authorization: Bearer`，再检查 content headers 和读取
body。服务不信任 `X-Forwarded-For` 等 proxy header，peer key 只来自实际 socket
address。TLS client error 不进入高频应用日志。

容量固定为：

- body 默认 64 KiB、最小 1 KiB、硬上限 256 KiB；
- 已建立 TLS connection 默认 64、硬上限 512；
- 并发默认 32、硬上限 256；
- peer/global 固定窗口默认分别为 60/600 request/minute；
- peer table 默认 1024、硬上限 16384；Kubernetes profile 固定为 512；
- request、header、keep-alive、socket 与 graceful drain 均有上限；
- rate limiter 无 watcher 或 cleanup timer，容量满时确定性淘汰最旧 peer；
- peer 已拒绝的请求不消耗 global budget。

认证、keyset、authorization、conflict、overload 与内部错误映射为稳定低敏
HTTP error，不回显 assertion、`jti`、authentication ID、Manifest/source locator、
DSN 或底层异常。数据库 availability error 立即 withdraw readiness；重复 Pool error
只记录第一次状态转换，避免诊断日志放大。

进程内 shield 只保护匿名入口和单 Pod 内存，不是跨副本业务 quota。ADR-0146 已增加
`pg-0023`、数据库时钟、`Project + User subject + operation` bucket 与窗口内有界
receipt ledger；两个独立 manager 实例共享同一行锁裁决，自动提交响应丢失后以相同
业务 ID 重放，不额外消耗额度。

### 4. 默认关闭的 manager-only process

`QL3_PLUGIN_PACKAGE_MANAGEMENT_ENABLED` 默认为 false。关闭时 loader 只读取这一项，
不得读取 profile、TLS/keyset 路径或 PostgreSQL credential。

启用时必须满足：

- `QL3_PROFILE=cluster-admin`；
- TLS certificate、private key 与 identity keyset 都是显式绝对路径；
- PostgreSQL 默认 `verify-full`，显式 DNS servername 与 CA；
- role readiness 必须回读为 `ql3_package_manager`；
- Pool 默认最多 2 条连接、硬上限 4；
- keyset reload 与 manager schema readiness 均先于 listener；
- listener 关闭后才关闭数据库，启动失败执行相同逆序清理。

该 process 不读取 `QL3_POSTGRES_PACKAGE_EXECUTOR_*`、admin/runtime/migration
credential、Registry credential 或 Kubernetes token。它不负责 consume、dispatch、
stage、activate 或 recovery。

### 5. 可选 Kubernetes operation

部署位于
`deploy/kubernetes/ql3-cluster/operations/plugin-package-management`，不被
`base`、默认 `operations` 或 control overlay 引用。reviewed production shape：

- 两个副本、required hostname anti-affinity、`maxUnavailable=0`、PDB
  `minAvailable=1`；
- 独立 ServiceAccount，Pod 和 ServiceAccount 都
  `automountServiceAccountToken=false`，不创建 Role/RoleBinding；
- ClusterIP 8443 与 HTTPS liveness/readiness/startup probes；
- 只允许同 namespace 且标注
  `qinglong.io/plugin-package-management-client=true` 的 ingress NetworkPolicy；
- non-root UID/GID 10001、read-only root、drop ALL、RuntimeDefault seccomp；
- TLS Secret 为 `0440`，identity Secret 与 PostgreSQL CA 为 `0444`，三者独立
  read-only mount；
- 每副本 request 100m/128 MiB，limit 1 CPU/512 MiB，并发固定 16、peer table 512、
  TLS connection 固定 32、manager Pool 2。

认证后 durable quota 固定为 60 秒窗口；Kubernetes profile 显式配置 propose 30、
decide 60、inspect 600，单 bucket receipt 最多 1000 项且与计数同窗重置。该状态只
属于 `ql3_package_manager`，executor/admin/runtime/worker-ingress 均无表权限。

CloudNativePG overlay 只投影 `ql3-postgres-package-manager-auth` 和
`ql3-postgres-ca`，并使用独立 admin image 的 all-zero fail-closed digest placeholder。
它不取得 executor/admin/runtime credential。TLS Secret 与 identity Secret 必须由
私有 deployment controller 创建；identity 使用 Secret 而不是 ConfigMap，是因为
recovery ServiceAccount 必须能更新动态 active-pointer ConfigMap，但没有任何 Secret
权限。提交的 example 不进入任何 Kustomization。

一节点开发环境可显式 patch 为单副本并移除 PDB/required anti-affinity，但不能把该
形态记录为 production HA evidence。

### 6. Edge 与 cluster 资源档位

路由器/edge 不启动 TLS listener、不打开 PostgreSQL，也不导入本 ADR 的 process。
它继续使用 ADR-0143 的短生命周期本机 CLI、单 SQLite authority、零 watcher/timer。

Cluster 才承担常驻双副本成本。reviewed aggregate request 为 200m CPU/256 MiB，
limit 为 2 CPU/1 GiB，数据库连接上限为 4。两副本进程内 rate limit 不能相加解释为
强全局 quota；入口层容量与 durable quota 都必须单独记录。

## 验证

已完成：

1. identity keyset 6/6：初载认证、overlap/revoke、rollback/rewrite/隐式移除、
   append-only/stale fallback、durable ledger 重启复核、malformed/private/oversized；
2. HTTPS 8/8：256 KiB hard ceiling、TLS health、auth-before-body、keyset unavailable、
   peer limit、body/concurrency、durable quota 429/Retry-After、withdraw/drain；
3. process 8/8：disabled zero-read、exact config、负向配置、256 KiB/connection
   ceiling、startup/清理顺序、private key mode 与 certificate failure 清零；
4. cluster-admin TypeScript check；
5. cluster-admin 全包 97 pass/1 个真实 Kubernetes 条件 skip/0 fail；
6. deployment audit 16/16，包含 default enablement、Kubernetes/executor authority、
   file projection 与 digest pin 否定；
7. source/deployment 联合边界 45/45，dependency audit `findings=[]`；
8. base 和 CloudNativePG 两个 Kustomize 实际 render；
9. PostgreSQL 18.4 arm64 physical HA 的 24 个子门全部通过，包括 manager/executor
   promotion 前后 readiness、timeline 1→2、fence、partition、`pg_rewind` 与既有
   COMMIT-response-loss 收敛；新增两个 manager 实例 16 路并发精确 8 allow/8
   reject、窗口重置、幂等 replay 和 autocommit response-loss 收敛；运行后无残留
   container、volume 或 network；新增 durable keyset ledger 又证明双 manager
   同代竞争、全新实例旧代拒绝、同代 rewrite/隐式移除拒绝和 COMMIT response-loss
   收敛。

尚未完成、不得据此宣称生产公开：

- 真实 IdP 两名 User 的 propose/decide 四眼 ceremony；
- management 双 Pod、NetworkPolicy、证书/ConfigMap rotation 的 live cluster 门；
- production ingress/WAF 容量、TLS certificate rotation 与告警；
- admin image 的真实远端 multi-architecture digest/signature/attestation 记录。

ADR-0148 已为上述真实 IdP、双 Pod ingress/rotation 和三控制面证据建立 exact
live-report 审计，并把 management egress 收敛为 DNS 加精确 PostgreSQL 目标；在
真实报告取得前，本列表仍保持未完成。

## 后果

优点是公开 parser、强身份、manager 数据库与 recovery/publisher authority 被拆为独立
故障域，同时不增加 workspace package 或 edge 常驻成本。代价是 cluster 部署多一个
显式 operation、TLS/IdP 配置与两副本资源预算，并且生产团队必须维护 durable trust
变更记录；入口容量仍不能依赖进程内 Map 冒充分布式业务配额。
