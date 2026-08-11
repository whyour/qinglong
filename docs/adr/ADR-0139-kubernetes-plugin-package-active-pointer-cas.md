# ADR-0139：Kubernetes Plugin Package Active Pointer CAS

- 状态：Accepted（ConfigMap exact pointer、stage evidence verifier、
  resourceVersion CAS、并发/读取窗口/响应丢失恢复与 subpath 门禁已实现；ADR-0140
  已补 durable startup recovery、标准 OCI verifier、一次性 admin process、独立
  image 与最小权限 Job/RBAC；真实集群专项门仍待完成）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-132、D-135 至 D-137
- 关联 ADR：ADR-0087、ADR-0129、ADR-0134、ADR-0138

## 背景

ADR-0138 已冻结完整 activation intent、fresh publish 与 recovery inspect 的区别，并
实现本地 POSIX pointer。PostgreSQL Repository 也已能耐久保存 Cluster installation
和 PackageLock，但没有跨 admin 副本可见的 active pointer publisher。

Cluster 不能复用本机文件锁；也不能把 active generation 只写数据库后假定 Kubernetes
资源已发布。另一方面，为一个 ConfigMap adapter 新增 workspace package会继续加剧
packages 过细，而 `@qinglong/cluster-admin` 已拥有受审 Kubernetes client 依赖和
短生命周期 mutation authority。

## 决策

### 1. Publisher 留在既有 cluster-admin

新增显式
`@qinglong/cluster-admin/plugin-package-kubernetes-activation` subpath，不从 root、
administration 或 cluster-control production 入口导出。不新增 workspace package、
第三方依赖、timer、watcher、cache、sidecar 或数据库 connection。

runtime-core 新增共享 `normalizePluginPackageActivationIntent`，所有 Cluster pointer
在读写前都使用 exact schema、identifier、digest 和 generation 上限；publisher 不复制
第二套 activation intent 语义。

### 2. 一个目标对应一个有界 ConfigMap

目标 identity 固定绑定 cluster identity、namespace、Project 和 Package。资源名为
`ql3p-` 加 domain-separated SHA-256 的前 208 bit；完整 256-bit target digest仍写入
label 并在读取 canonical intent 后重算复验，因此名称截断不缩窄内容校验。

ConfigMap：

- `apiVersion=v1`、`kind=ConfigMap`、mutable；
- data 只有 `active.json`，上限 32 KiB；
- pointer exact 保存 schema、cluster identity digest、activation intent 和 receipt；
- labels exact 保存 managed-by、active schema 和完整 target digest；
- annotation exact 保存 intent digest；
- 禁止 binaryData、deletion timestamp、finalizer 和 owner reference。

资源名冲突或 metadata/data/pointer 漂移统一失败关闭。208-bit 名称只用于 Kubernetes
寻址，完整 identity、lock、stage 双证据和 intent digest 才是 authority。

### 3. stage evidence 由注入端口复验

`ClusterPluginPackageStageEvidenceVerifier.verify(intent)` 必须返回并精确匹配：

- lock digest；
- stage reference；
-领域 stage receipt digest；
- adapter 外部 evidence digest；
- content digest。

publisher 在每次 inspect 以及 publication 最终复核时调用 verifier。具体实现可以是
exact OCI digest、对象存储 receipt 或后续受审 Kubernetes 资源，但本 ADR 不允许
publisher 自行下载、缓存或猜测来源。verifier 不可用返回 unavailable，事实漂移返回
conflict。

### 4. create/replace 使用 resourceVersion CAS

首装只在 ConfigMap 不存在且 previous lock 为 null 时 create。升级先读取 current
pointer，必须 exact 等于 previous active lock，再用该对象的 resourceVersion replace。

第一次 observe 与取得写入 resourceVersion 之间存在第二次 GET；第二次返回的实际
pointer必须再次复验 previous lock。否则另一个副本在窗口中发布新 generation 后，
stale writer 会拿赢家的新 resourceVersion 将其覆盖。

Kubernetes 409 只在重新 inspect 得到完全相同 intent 时作为 exact replay；其他 winner
均为 conflict。两个并发候选最多一个成功。

### 5. 响应丢失只由恢复 inspect 裁决

create/replace 返回非 409 错误时，publisher 不在 fresh 路径猜测是否已经提交，而是
返回 unavailable，让数据库 record 保持 `activating`。ADR-0138 coordinator 在恢复时
只调用 inspect：

- exact ConfigMap pointer → 提交 durable active receipt；
- pointer absent → durable activation failure；
- pointer 为其他 generation 或 tamper → durable fact conflict。

成功 API 响应后仍要重新 GET pointer 并再次复验 stage evidence；不能只信 response
body 或本地 request。

### 6. 产品入口继续分阶段开放

ADR-0140 已提供：

- 标准 OCI Distribution stage evidence verifier；OCI manifest digest 与 bundle
  layer digest 分离，签名通过 lock-annotated OCI referrer取得；
- `ql3-plugin-package-recover` production admin binary；
- 独立 cluster-admin image；
- 仅有 ConfigMap `get/create/update` 的 ServiceAccount、Role/RoleBinding 和
  600 秒一次性 Job manifest。

仍不提供：

- object-store stage；
- Approved Action durable consumer、Policy/Audit route；
- operator repair；
- ADR-0149 active generation source 之上的 Task/Workflow/Prompt/Tool/Trigger
  语义 materializer；
- ConfigMap GC、Package byte distribution、Runtime/UI Extension。

因此 adapter 可执行不等于 Cluster 已开放插件安装。

## 拒绝的方案

- 新增 `plugin-package-kubernetes` workspace package：拒绝；一个 adapter 文件没有
  独立发布或运行生命周期，显式 subpath 足以隔离。
- 只在 PostgreSQL 切 active generation：拒绝；无法证明 Kubernetes 可见事实已发布。
- 使用普通 replace 或 merge patch：拒绝；缺少 exact previous resourceVersion fence。
- 只校验第一次 GET：拒绝；第二次 GET 后可覆盖窗口中的新赢家。
- 在 publisher 内实现 OCI client：拒绝；会合并来源、缓存、stage 与 pointer authority。
- 将 ConfigMap 设为 immutable 并每 generation 新建：拒绝；会把唯一当前 authority
  退化为目录/label 扫描和 GC 问题。

## 影响

- Cluster 多副本获得单一、可 inspect、resourceVersion-fenced active pointer。
- edge/standalone 不依赖 cluster-admin；共享 intent normalizer 使六种本机制品各增加
  2,532 bytes，但 files 与 loaded modules 不变，最大值仍低于硬门禁。
- packages importer 保持 21；cluster-admin 继续复用现有
  `@kubernetes/client-node`，dependency audit 无新增 dependency。
- Kubernetes client 只进入独立短生命周期 admin image；常驻 cluster-control
  production closure 不变。
- ConfigMap 只保存低敏摘要和 identity，不保存 bundle、Secret 或可执行内容。

## 验证

当前门禁覆盖：

1. canonical ConfigMap create、inspect 和 exact replay；
2. exact previous lock replacement 与 stale writer conflict；
3. create response loss 后 inspect 收敛且不 republish；
4. 同一 resourceVersion 的两个候选 single winner；
5. 两次 GET 之间插入新 winner 时 stale writer 不覆盖；
6. stage evidence drift 在任何 API mutation 前失败；
7. ConfigMap pointer canonical/tamper fail-closed；
8. root 不导出、显式 subpath 可达；
9. runtime-core intent normalizer 与 generation 边界；
10. cluster-admin 全量 55 pass/1 条件 skip，ConfigMap response loss 已通过 durable
    startup recovery 在下一轮 inspect 收敛且不再次 create；
11. 标准 OCI allowlist、manifest/layer/referrer/signature 与重启重新取证；
12. 独立 admin image 的真实非 root、只读 rootfs CLI smoke；
13. dependency/source 与 Kustomize/RBAC audit 仍为 21 importer、`findings=[]`。

真实 Kubernetes API 的 ConfigMap 专项 CAS、RBAC 正负向和多 Pod response-loss fault
仍是产品开放前的独立 Gate。
