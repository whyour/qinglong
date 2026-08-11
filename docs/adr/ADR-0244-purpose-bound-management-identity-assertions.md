# ADR-0244：按管理能力绑定身份断言用途

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-58、D-85、D-175、D-226、D-228
- 关联 ADR：ADR-0148、ADR-0242、ADR-0243
- 修正：Worker Credential 管理身份曾复用 Plugin Package 的 JWT `typ` 与 `ql3_purpose`

## 背景

Plugin Package 管理与 Worker Credential 管理已经拥有不同的 HTTPS 路径、PostgreSQL
角色、durable quota/identity ledger authority 和 JWT audience。Worker manager 进程却仍通过
Plugin Package keyset factory 的默认值校验：

- `typ=ql3-plugin-package-management+jwt`；
- `ql3_purpose=plugin-package-management`。

不同 audience 已阻止两条 token 直接互换，因此这不是一个已证明可利用的跨能力授权漏洞；但它使
断言自描述用途与实际 authority 不一致，要求外部 IdP 为 Worker 操作签发带 Plugin 语义的 token，
也让未来配置或审计错误更难被发现。仅靠 audience 区分两条高风险管理链不是 QingLong 3.0 应保留
的边界。

## 决策

1. 管理身份验证器接受一个严格、启动时审查的 assertion profile。profile 只含 `type` 与
   `purpose`，对象必须 exact-shape；`type` 只接受 `ql3-<capability>+jwt`，`purpose` 只接受规范化
   kebab-case，禁止任意 JWT 类型、控制字符、空白或大小写漂移。
2. Plugin Package profile 保持：
   `ql3-plugin-package-management+jwt` / `plugin-package-management`。省略 profile 时仍使用该值，
   使既有 Plugin caller 的语义不变。
3. Worker Credential profile 固定为：
   `ql3-worker-credential-management+jwt` / `worker-credential-management`。Worker 进程只通过
   `createClusterWorkerCredentialIdentityKeysetFile` 装配该 profile，调用方不能覆盖它。
4. 一条管理断言必须同时匹配 issuer、audience、JWT `typ`、`ql3_purpose`、签名、生命周期与
   assurance mapping。三类能力标识中的任一项不一致都返回同一低敏认证失败，不提供探测细节。
5. keyset generation、digest、撤销集合与 PostgreSQL durable ledger 协议不变。此决策不新增
   package、第三方依赖、migration、数据库角色、listener、Pool、timer、watcher、controller 或
   sidecar；Edge/Standalone 不装配该能力，路由设备的安装闭包与常驻资源保持不变。
6. Kubernetes Worker management live fixture 必须生成 Worker 专属 `typ/purpose`。外部 IdP ceremony
   在正式接受前还必须证明两名不同强 User 的 Worker-purpose token、申请者自批拒绝、reviewer
   批准与撤销后的失败关闭；仓库内自签 fixture 不冒充该证据。

## 被拒绝的替代方案

### 只依赖 audience

拒绝。audience 是必要条件，但不能让 token 自描述它正在请求哪一种管理 authority；多入口共享
issuer/keyset 时，显式 `typ` 与 purpose 能把错误配置在认证边界失败关闭。

### 继续复用 Plugin purpose，并只在文档中解释

拒绝。它要求 IdP 签发语义错误的 token，日志、策略和撤销规则都无法准确表达 Worker 能力；文档
不能修复运行时 contract。

### 为 Worker 身份再建 workspace package 或独立常驻身份服务

拒绝。两条链共享相同的有界 keyset、签名、lifetime、assurance 和 durable rotation 协议，差异是
编译时 profile 与部署 authority。包内显式 factory 已能隔离语义；新 importer/daemon 只会增加
低配设备的安装、SBOM、内存、连接和运维成本。

### 让部署配置任意覆盖 Worker profile

拒绝。Worker caller 的用途是产品协议而非部署偏好。允许环境变量覆盖会把 confused-purpose 风险
移给每个部署者，并可能使副本间产生不一致认证语义。

## 影响

- 现有 Plugin Package token 与 keyset 不变；
- Worker IdP/client 必须改为签发 Worker 专属 `typ/purpose`，旧的 Plugin-purpose Worker token 会在
  认证阶段失败；
- Worker keyset 的 issuer、audience、JWK、assurance mapping 与 rotation 流程不变；
- 共享实现仍位于既有 `cluster-admin` package 内，不增加 workspace importer；
- 此变更是有意的 3.0 alpha protocol correction，不提供接受旧 Worker token 的兼容窗口。

## 验证

1. verifier 单元测试证明 Plugin 与 Worker profile 分离；即使 issuer、key、audience 相同，两种
   token 仍不能互换，并拒绝非规范 profile；
2. keyset 测试证明 Worker factory 接受 Worker token、拒绝同 audience 的 Plugin-purpose token；
3. 默认 Worker manager 进程以真实 Ed25519 keyset 和 PostgreSQL ledger 交互桩装配，证明生产 caller
   选择 Worker factory，而不只是测试直接调用 verifier；定向 21/21 通过；
4. `cluster-admin` 完整测试为 177 pass、0 fail、1 条无真实 Kubernetes API 时的条件 skip；
5. PostgreSQL 18.4 arm64 physical-HA Docker 门再次通过：Worker quota 与 identity ledger 跨实例、
   重启和 promotion 收敛，`remote_apply`、timeline 1→2、旧主 fence、`pg_rewind` 只读同步重入与
   fresh control replicas 均为 true，最终 `gates.passed=true`；门退出后 `ql3-ha` Docker 资源为 0；
6. GitNexus 对当前已索引 tracked diff 报告 LOW、0 affected process；QL3 新文件尚未完整进入索引，
   因此该结果不替代上述进程级、全包与真实 HA 证据；
7. 固定 `v1.34.3+k3s1` arm64 三节点 K3s live gate 已用新 profile 完成两个跨节点 manager
   Pod、TLS 1.3 client、8 admitted/8 limited、identity generation 1→2→3 overlap/revoke、rollback
   surge 失败关闭、数据库故障 availability fence、fresh activation 双副本恢复与一次性 client Job，
   最终 `gates.passed=true`；退出后 `ql3-wcm` Docker 容器、网络、卷和临时镜像均为 0。fixture
   仍使用仓库内确定性强 User 断言，不冒充外部 IdP 证据。

## 后续门禁

- ADR-0245 已增加外部 OIDC 两用户 ceremony 协议、runner 与离线审计器；仍需在真实外部 IdP 上
  采集报告。requester plan/propose、自批失败、reviewer approve/inspect 均不得让 assertion、原始
  subject/session 标识进入低敏结果或 durable plan；
- 将 identity 共享实现中历史性的 Plugin 命名作为单独重构评审项；只有能减少错误类型/公共
  surface 且不制造兼容 facade 或新 package 时才执行。
