# ADR-0140：有界 Plugin Package 启动恢复与准入门禁

- 状态：Accepted（Profile-neutral 恢复协调器、本机 production application gate、
  Cluster 一次性 admin process、标准 OCI resolver、独立镜像与最小权限 Job/RBAC
  已实现；真实 Kubernetes API、最小 RBAC、双 Pod ConfigMap CAS/response-loss
  专项门，以及 PostgreSQL+HTTPS OCI+Kubernetes recovery Job 与
  deployment-controller wait 组合门已通过；私有 registry credential provider
  已保持在一次性 admin Job 内实现）
- 日期：2026-07-25
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-132 至 D-138
- 关联 ADR：ADR-0036、ADR-0087、ADR-0134、ADR-0136 至 ADR-0139

> 权限模型更新：本文记录的 `ql3_admin` recovery authority 已由 ADR-0144 和
> `pg-0022-plugin-package-authority-split` 取代。当前 recovery 只使用独立
> `ql3_package_executor` LOGIN、executor readiness 与
> `QL3_POSTGRES_PACKAGE_EXECUTOR_*` credential；本文其余恢复状态机与部署顺序决策
> 保持有效。

## 背景

ADR-0134 至 ADR-0139 已经提供：

- 原子保存完整 PackageLock 的 SQLite/PostgreSQL Repository；
- `queued → staged → activating → active|failed` 的 CAS 状态机；
- 本地 POSIX 和 Cluster ConfigMap active pointer publisher；
- fresh activation 的 publish 与 `activating` 恢复的 inspect 分离。

但 Repository 只暴露 recoverable current-head page，尚没有一个统一 startup
coordinator 把页面安全收敛到准入条件。直接复用
`PluginPackageInstallationCoordinator.install()` 不可接受，因为它会再次消费一次性
Approved Action；简单地对所有记录调用 activation coordinator 也会让并发 loser 在
winner 尚未完成 publish 时执行 inspect，把暂时 absent 错判为 durable failure。

恢复还必须同时适应两种设备：

- 路由设备不能为插件安装常驻 timer、watcher、额外连接或并行 I/O worker；
- Cluster 多副本不能依赖单进程锁，必须允许 CAS loser 保留可恢复工作并在后续 pass
  收敛。

## 决策

### 1. 恢复是调用方驱动的有界 cycle

`@qinglong/runtime-core/plugin-package-recovery` 提供
`PluginPackageRecoveryCoordinator`。它不创建 timer、watcher、socket、数据库连接、
后台任务或并行 worker，只使用注入的：

- `PluginPackageInstallRepository`；
- `PluginPackageStageProvider`；
- `PluginPackageActivationPublisher`；
- 权威 `now()`。

Repository page 保持每页最多 64 条。单次 cycle 最多 64 页，默认
`pageSize=16`、`maxPages=16`；页内严格串行，调用者根据结果决定何时运行下一轮。
这样低配设备只承担一个 current head 的瞬时内存和 I/O，Cluster 则继续依赖数据库与
publisher CAS，而不是把并发转移到 coordinator。

### 2. queued 恢复不得重新消费审批

durable `queued` 证明 create 前的 Approved Action 已经消费并绑定到完整 PackageLock。
恢复路径必须：

1. 按 record 的 lock digest 读取耐久 PackageLock；
2. 重新复验 lock 与 installation 的 Project、Package、generation 和 digest；
3. 调用幂等 stage provider；
4. 以 domain-separated mutation ID 提交 exact `staged` CAS。

它不得调用 `install()`，也不接受 Approved Action consumer。审批不存在、过期或外部
系统暂时不可用都不能改变已耐久 create 的事实。

### 3. 状态所有权决定 activation 动作

- 初始 `staged`：可以调用 fresh `activate()`，由 staged→activating CAS 决定
  publisher authority；
- 初始 `activating`：只能调用 `inspect()`，永远不能 republish；
- 初始 `queued`：只有本次 commit 返回与本节点计算完全相同的 staged record，才可
  继续竞争 fresh activation。

若 queued commit 返回已经被其他恢复者推进的 `activating` 或其他 recoverable record，
本节点返回 `retry`，不能立即 inspect 或 publish。winner 可能仍在外部发布窗口内；
后续调用方驱动 pass 才能把它作为“初始 activating”检查。

即使 staged CAS 之后另一副本先推进，activation coordinator 也只会产生 CAS conflict；
当前 pass 重读 durable head并保留 retry，而不会把 loser 升级为外部 mutation owner。

### 4. 冲突与不可用必须重读 durable head

每条结果只公开四种低敏状态：

- `settled`：同 installation 已 durable `active|failed`；
- `retry`：同 installation 已前进但仍 recoverable，或 authority 暂时不可用；
- `manual_required`：durable shape/evidence、mutation identity 或未变化的 CAS 事实
  冲突；
- `superseded`：current head 已不存在或由另一 installation 替代。

transition conflict 与 unavailable 都必须重新读取并规范化 current head：

- terminal → settled；
- 同 installation 的不同 recoverable digest → retry；
- 不同 installation/不存在 → superseded；
- 未变化却持续 transition conflict → manual-required。

未知基础设施错误不泄露诊断，当前 pass 返回 retry；产品层以低敏计数、审计和告警承接
具体运维证据。

### 5. Recovery page 是不受信任的 durable projection

coordinator 在处理前逐项复验：

- page 只有 `records`、`truncated` 和可选 `next`；
- records 数量不超过请求 limit；
- 记录均为 current recoverable state；
- `packageName, installationId` 严格递增且无重复；
- `truncated` 与 `next` 同时存在或同时不存在；
- continuation 必须精确等于本页最后一条 identity。

malformed、terminal、乱序或 detached cursor page 直接失败关闭，不做部分页面 mutation。

### 6. Cursor 耗尽后仍需从头探测

恢复过程中，另一个副本可能插入一个排序在当前 cursor 之前的新 head。因而“最后一页
在 cursor 之后为空”不证明全局没有可恢复工作。

每个 cycle 结束必须从头执行 `limit=1` final probe。只有同时满足以下条件才能返回
`safeToAdmit=true`：

1. 未因 `maxPages` 截断；
2. final probe 不含任何 recoverable head；
3. 本轮没有 `manual_required`。

product startup composition 必须在 lifecycle 和 admission 前调用该 cycle，并对 retry、
manual、remaining、page corruption 或 coordinator unavailable 失败关闭。

### 7. 保持现有 package 粒度

协调器只有 Profile-neutral 状态机职责，因此并入既有 runtime-core 显式 subpath；
SQLite、POSIX 和 Kubernetes integration 只放在各自现有 package 测试中。不新增
workspace package、第三方依赖或默认 root export。

这延续 ADR-0087：单文件能力不因“看起来独立”就拆包，只有独立发布、独立进程或真正
不同依赖生命周期才形成新 package。

### 8. Production composition 按 authority 分成 Local gate 与 Cluster admin Job

本机 `@qinglong/local-application` 在 adopted storage ready 后，从同一个
`LocalSqliteRuntimeDatabase` 取得 Plugin Package Repository，不新建 SQLite 连接。
该 Repository 通过惰性异步 port 在首次恢复时构造；只启动 edge/standalone storage
不会加载 Plugin Package adapter。
enabled 配置必须显式提供 stage provider、预创建私有 staging/activation root、权威
时钟及可选页预算。顺序固定为：

```text
adopted storage ready
  -> bounded Plugin Package recovery safe
  -> Secret keyring ready
  -> Run/receipt/domain recovery
  -> lifecycles
  -> admission
```

queued lock 没有可用的 content-addressed source resolver 时，stage provider
unavailable 只能得到 `retry/remaining`，application 必须关闭 storage、释放 adoption
fence 并拒绝启动；不得跳过该 Package 或假装空队列。disabled 路径不检查这些目录或
provider。

Cluster 不得把恢复接入常驻 `cluster-control`。Plugin Package 三表和 Project lock
function 是 `ql3_admin` 专属 authority，runtime role 明确没有权限。独立
`@qinglong/cluster-admin/plugin-package-recovery` 一次性 composition 负责：

1. 打开 admin Pool并执行完整 admin schema/role readiness；
2. 组合 PostgreSQL Repository、外部 stage provider/evidence verifier 与 Kubernetes
   ConfigMap publisher；
3. 串行执行一个 bounded recovery cycle并要求 `safeToAdmit=true`；
4. 无论成功、readiness 失败、恢复失败或 close 失败，都在返回前关闭 Pool。

该 subpath 不从 cluster-admin root 导出，也不进入 cluster-control 默认依赖闭包。
production Kustomize/Helm 必须把它做成短生命周期、失败阻断后续 rollout 的 admin
Job。`ql3-plugin-package-recover` binary 已组合：

- 只使用 `ql3_admin` 连接、单连接 Pool 与完整 admin readiness；
- 独立 `qinglong3-cluster-admin` 镜像，不把 Kubernetes client 或 admin package
  加入常驻 `cluster-control`；
- 独立 ServiceAccount，以及 namespace 内 ConfigMap
  `get/create/update` 的单一 Role；无 Secret、list/watch/delete 或 ClusterRole；
- 固定 600 秒 deadline、零 Job retry、非 root、只读 rootfs、RuntimeDefault
  seccomp 和显式资源上限；
- migration → Plugin Package recovery → runtime rollout 三段式部署顺序。Kustomize
  只负责渲染，deployment controller 必须等待前一 Job 成功，不能把两个 Job 和
  Deployment 同时 apply 后宣称形成门禁。

OCI resolver 将 `locator` 中的 digest 正确定义为 OCI manifest digest，将
`artifactDigest` 定义为唯一 QingLong bundle layer digest；两者独立绑定同一
PackageLock，不再错误要求相等。resolver 只访问显式 allowlist 的 HTTPS registry，
拒绝 redirect 与 ambient credential，验证 content-addressed manifest/config、唯一
bundle descriptor、lock-annotated OCI signature referrer、Ed25519 trust 与流式 bundle
内容。证据摘要以 `lock.createdAtMs` 作为确定性签名观察时点，重启后可从完整 lock
重新取证；进程内最多缓存 64 条低敏 evidence，不缓存 bundle。

私有 Registry 不触发 Docker config、credential helper 或 challenge-based ambient
discovery。可选 `QL3_PLUGIN_PACKAGE_REGISTRY_CREDENTIAL_FILE` 只在一次性
`cluster-admin` recovery process 中加载
`qinglong/plugin-package-registry-credentials@v1`：

- 文件必须是绝对路径、最多 256 KiB、regular file，允许 owner/group read，但拒绝
  group write/execute 与任何 world 权限；
- 最多 32 个 credential，每项必须精确匹配 OCI allowlist 中的一个 registry，重复、
  多余 registry 和未知字段失败关闭；
- 只接受显式 Basic username/password 或 Bearer token；provider 只有
  `authorizationFor(exactRegistry)` 窄能力；
- source 通过 allowlist 后才查询 provider；Authorization 只随同一 HTTPS registry
  请求发送，redirect 继续为 `error`；
- process 在成功、配置/网络/Kubernetes/数据库失败时都 dispose provider，并清空其
  持有的 Authorization Buffer。JavaScript 临时 string 不提供可证明的零化，因此
  credential authority 仍依赖短生命周期 Job，而不能进入常驻 control。

默认未配置该文件时行为保持公开 Registry、无 Authorization header。生产 overlay
通过单独 `private-registry` Kustomize 层把现有 CloudNativePG recovery Job 绑定到
一个 `0440` Secret 文件；默认 base 不创建、不引用 Registry Secret，recovery
ServiceAccount 也没有 Secret API 读取权限。

完整组合门已让真实
PostgreSQL 18 migration、durable queued installation、经 TLS 的 content-addressed
OCI Distribution GET/referrers surface、真实 recovery Job、ConfigMap publisher 与双副本
runtime rollout 在同一个三节点 Kind 中依次完成；deployment controller 只有在读取到
recovery Job 的 `Complete=True` 后才创建带该 Job UID/resourceVersion/completion time
绑定的 Deployment。该 OCI fixture 不是生产 Registry 存储/认证实现，测试 PostgreSQL
也显式关闭 TLS；对象存储来源、production TLS 与
Approved Action 产品 consumer 仍须独立完成，因此 Cluster 插件安装产品入口仍不能视为
完整开放。

## 拒绝的方案

- 复用 `PluginPackageInstallationCoordinator.install()`：拒绝；会重新消费一次性
  Approved Action。
- 对 queued/staged/activating 统一调用 publish：拒绝；响应丢失会重复外部副作用。
- 并行处理整页：拒绝；放大路由设备 I/O，也缩短不了数据库或 Kubernetes 的权威
  CAS。
- CAS loser 立即 inspect winner：拒绝；winner 可能仍处于 publish 窗口，absent 不是
  durable failure。
- 只在当前 cursor 后探测：拒绝；会漏掉并发插入到 cursor 之前的 recoverable head。
- coordinator 自建重试 timer：拒绝；会形成 Profile 隐式常驻资源、停机竞态和每副本
  重试风暴。

## 影响

- edge/standalone 获得单记录、串行、caller-driven 的恢复边界；禁用或未组合时没有
  常驻开销。
- Cluster 多副本继续以 PostgreSQL record CAS 与 Kubernetes resourceVersion CAS
  协调，coordinator 不引入第二套 leader election。
- 常驻 cluster-control 不获得 Plugin Package 表或 Project lock function 权限；恢复
  只由短生命周期 admin authority执行。
- 恢复不再依赖重新取得 Approval 服务，也不会把一次性审批降级为可重复凭据。
- workspace importer 经 ADR-0217 保持 20；没有新增 workspace package。ADR-0218
  又从 admin 移除了不使用的 Croner，既有
  `@kubernetes/client-node` 只进入独立 admin 镜像。
- admin 镜像使用独立 builder/runtime 双 lock：4 个 production root、84 个 external
  package，加 3 个 QL3 workspace package；常驻 control 镜像闭包不变。
- ADR-0128 的 SBOM/OCI/release verifier 以 exact `control|admin` profile 复用：
  admin 当前 lock/SBOM 为 87-component CycloneDX/88 dependency node；更新前实际
  镜像曾在非 root、只读根下完整对账，更新后的真实 inventory 待依赖物化复验。CI 与
  release workflow 分别为两个 image repository 生成独立
  amd64/arm64 manifest、digest、签名与证明，control 证据不能替代 admin。
- production wiring 后六种本机制品仍为 334/368/439 files。惰性 Repository port
  使 edge/standalone 保持 39 loaded modules、adopted 保持 42；只有 application
  入口加载 78。最大 application 为 2,849,582 bytes/439 files，最大 RSS delta
  13,221,888 bytes，仍低于 4 MiB/512 files/16 MiB 门禁。

## 验证

当前门禁覆盖：

1. queued→stage→activating→active，且 coordinator 没有 Approved Action 端口；
2. 初始 activating 只 inspect，不 publish；
3. publish response loss 首轮保持 activating，下一轮 inspect 收敛；
4. queued stage commit 被并发恢复者推进后返回 retry，publish/inspect 均为 0；
5. stage unavailable 保持 queued、阻止 admission；
6. invalid stage evidence 标记 manual-required；
7. multi-page 扫描与 final head probe 捕获 cursor 之前的新 work；
8. malformed order/continuation page 在 mutation 前失败；
9. 真实 SQLite Repository + POSIX publisher 从 durable queued 收敛 active；
10. Kubernetes ConfigMap create response loss 经 durable activating 在下一轮收敛，且
    create 调用保持 1；
11. local-application 14/14，包含空队列顺序与 queued source unavailable
    fail-closed/释放 fence；
12. cluster-admin 61 pass/1 条件 skip，包含标准 OCI manifest/layer digest 分离、
    registry allowlist、redirect-free streaming、referrer signature、重启重新取证、
    exact-registry Basic/Bearer provider、私有文件权限/绑定/清理、process 配置、
    一次性 admin composition、返回前 close 与 root export isolation；
13. 21-package clean build/聚合测试、dependency/source boundary 与 edge import
    通过，`findings=[]`；
14. 六种 Profile artifact 全部低于资源硬门；
15. PostgreSQL 18.4 arm64 HA Docker 门 21 个具体 gate 与总 `passed` 全为 true：
    fail-closed 262.122 ms、双 fresh activation 457.148 ms、`pg_rewind`
    1,992.910 ms，且 `unexpectedDomainSideEffects=0`、门后无遗留 HA
    容器/volume；
16. admin 当前 SBOM 为 84 external + 3 internal、88 dependency node，
    双镜像 SBOM/OCI/release 38 项负向合同及 11 项部署合同全部通过；
17. 独立 Kind 1.32.8 门使用两个真实 projected ServiceAccount token 的
    `cluster-admin` Pod；两者以同一个 `resourceVersion=487` 竞争，得到一成功、
    一 conflict，最终只有一个 active pointer。API 已确认 create 后的客户端边界
    response-loss 经 inspect/exact replay 收敛，create 保持一次；ConfigMap
    get/create/update 允许，list/delete、Secret 读写及跨 namespace GET 全部 403。
18. 三节点 Kind 组合门从当前源码构建 admin/control 镜像，运行 PostgreSQL 18.4 的
    18 条 reviewed migration/capability v17，使用正式 PostgreSQL Repository 持久化
    一个 durable queued installation，再由真实 `ql3-plugin-package-recover` Job
    通过 exact-registry Basic credential 完成 6 个唯一 authenticated HTTPS OCI
    manifest/config/referrer/signature/bundle 请求、
    `queued→staged→activating→active` 四次 mutation 与唯一 ConfigMap pointer。
    recovery SA 仍只有 ConfigMap get/create/update，runtime role 读取 Plugin Package
    三表被 PostgreSQL 拒绝；deployment controller 观察 recovery Job 完成后才创建
    绑定其 UID/resourceVersion/completion time 的两副本 Deployment，两 Pod 分布在
    不同 worker。arm64 现场总耗时 152,189 ms，完成后精确删除临时集群。

PostgreSQL HA 门验证数据库 migration/repository 与既有领域事务的 promotion/rewind
基础链路；双 Pod Kind 门独立验证 Kubernetes ConfigMap publisher 与 RBAC；三节点
组合门已经把 PostgreSQL、HTTPS OCI、正式 recovery Job 与 deployment-controller
rollout wait 合成。response loss 仍只在 API 确认 create 后的客户端边界注入，不是
raw-wire packet loss；组合门的 PostgreSQL 显式关闭 TLS、OCI endpoint 是只读
content-addressed fixture，单 control-plane Kind 也不是 Kubernetes control-plane HA
证明。生产 Registry 存储/认证、production PostgreSQL TLS、admin Buildx
真实双架构 OCI 记录和受保护
GHCR/Cosign/GitHub attestation 记录仍是独立 Gate。
