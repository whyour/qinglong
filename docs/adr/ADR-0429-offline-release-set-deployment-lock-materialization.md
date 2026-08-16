# ADR-0429：离线 Release-set Deployment Lock 物化

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-333、D-334、D-335、D-336、D-337

## 上下文

ADR-0428 让部署者能够从持久 OCI catalog 取得并独立验证完整 release set，但验证后的
`images[].reference` 仍需人工写入 Local Compose 或 Kubernetes 清单。Cluster 的 Kustomize 结构包含嵌套 overlay；当内层
已经把镜像转换为另一个 repository 和 digest 时，外层 image transform 不保证再次覆盖它。Plugin Package admission
ConfigMap 还把短生命周期 Admin 镜像 authority 保存于 `data.image`，不属于 Kustomize 内建 `images` transformer 的处理面。
因此，“release set 已验证”与“最终 apply 的清单确实只消费该 release set”之间仍存在人工复制和遗漏窗口。

同一解决方案还必须保持部署形态隔离。低配路由设备只能承担 Local 单镜像消费，不能为 Cluster 的渲染工具、YAML parser
或 Kubernetes client 付出安装和常驻资源；Cluster 工作站则需要处理 Core、AI、Worker 与短生命周期 Admin 多种独立清单，
但生成工具不能因此获得 Kubernetes mutation authority。

## 决策

1. 新增独立的 `ql3-deployment-lock-contract.cjs` 工作站工具。输入只能是已通过 standalone inspection 的 canonical
   release set，以及显式 release identity；所有模式均不访问网络、不读取 registry、不连接 Kubernetes API、不执行
   rollout。
2. Local 模式只接受 `local|all` scope，并生成 canonical
   `qinglong/local-compose-release-image@v1` selection。输出绑定 release-set digest、精确 Local digest reference 和显式
   `allowRootService` boolean；它不修改 Compose，也不启动服务。低配设备只消费该选择结果，不安装 materializer。
3. Kubernetes 模式只接受 `cluster|all` scope。运维者先执行 `kubectl kustomize`，materializer 再处理最终多文档 YAML，
   从而穿透任意嵌套 overlay 的 transform 顺序。调用者必须按发布顺序显式声明当前清单必含的 role；缺少任一 required role
   时失败关闭。
4. 可改写面封闭为 Pod、Deployment、StatefulSet、DaemonSet、ReplicaSet、Job、CronJob 的
   `containers`、`initContainers`、`ephemeralContainers`，以及 exact-name
   `ql3-plugin-package-secret-action-admission` ConfigMap 的 `data.image`。完整 QingLong role tag/digest 出现在其他位置时拒绝；
   已知 container 中的裸名、未知 role-like name 或畸形引用同样拒绝。非 QingLong sidecar 保持原样。
5. 每个被改写的资源和适用的 Pod template 写入 release-set digest、source revision、version annotation。输出 report 固定
   输入/输出 SHA-256、资源数、改写资源数、各 role reference/出现次数、admission authority 次数与 no-network/no-mutation
   结论，并以 self digest 封闭。
6. `local-audit` 与 `kubernetes-audit` 从原 release set 和原始 render 完整重建期望输出，要求 byte/object exact matching，
   不把“输出中看见 digest”当作充分证明。输入限制为 canonical absolute、非 symlink、有界 UTF-8 regular file；JSON 必须
   canonical，YAML 禁止 alias/cycle、非 mapping resource、过深/过多/过大结构。所有输出以 0600、no-replace 创建。
7. 仓库静态审计固定 Cluster/Worker 的 224 个 YAML 文件、31 个直接 role image 引用与两个 admission ConfigMap authority。
   新增或移动镜像 authority 必须先扩展受支持处理面与负向测试，不能静默绕过 post-renderer。

## 部署与资源影响

- Local/Edge/Standalone runtime、镜像、workspace package、生产依赖、进程、listener、timer、watcher、数据库连接和内存预算
  均不变化。Node、`js-yaml`、registry/Kubernetes 工具只存在于可信维护工作站；路由器接收一个 Local selection 与一个
  immutable image。
- Cluster 不新增 controller、admission webhook、CRD、ServiceAccount 或 API 权限。materializer 在 apply 之前退出；真正的
  `kubectl apply -f locked.yaml` 是独立、显式、可审阅的运维步骤。
- 本决策不修改 schema、migration、SQL、PostgreSQL role、Pool、连接或 HA 拓扑，因此不制造新的数据库发布证据要求。

## 被拒绝的替代方案

### 在每层 Kustomize overlay 增加 image component

拒绝。外层 component 不能可靠覆盖内层已转换的 repository/digest，且 Kustomize `images` 不处理 ConfigMap 中的 Admin
authority；继续堆叠 component 会让最终 authority 取决于难以审计的 transform 顺序。

### 直接修改仓库中的零 digest 占位符

拒绝。它把环境私有 release identity 写回共享源码，容易产生脏工作区、错误复用和漏改，而且不能证明多个清单来自同一
release set。

### 在 Cluster 内运行常驻 image policy controller

拒绝。当前缺口可以在工作站离线关闭。新增 controller/webhook 会引入可用性、升级、证书和 API authority 故障域，也会
错误地把发布供应链验真变成集群运行时依赖。

### 让路由器自行验证和物化

拒绝。低资源设备没有必要承担 Node、YAML、registry、Cosign、GitHub CLI 或 Kubernetes 工具链；可信工作站可以生成并
审计更小的 Local selection，而设备仍以 digest 消费。

## 验证

- deployment-lock 契约覆盖 Local/All selection、Cluster/All materialization、全部 workload container 类型、固定 admission
  ConfigMap、required role closure、unknown/malformed authority、release/source/report/render drift、duplicate YAML、非
  mapping、closed CLI、symlink、0600 与 no-replace；定向测试 11/11；
- 本机 `kubectl v1.36.1`/Kustomize `v5.8.1` 真实渲染 CloudNativePG Core、Cluster AI、Worker node 与 Plugin Package
  Executor 四类清单后，post-render 全部生成 release-set exact digest，内层全零占位 digest 均消失；
- 发布契约、release set/catalog、静态 workflow 与 deployment-lock 联动测试 101/101，部署面审计确认 224 个 YAML、31 个
  直接 role image 引用和两个 admission authority；
- 完整 backend 共 1,295 项，1,293 pass/2 条件 skip/0 fail；18-package clean build/test 退出 0，package boundary 仍为
  18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`，release version、dependency、Edge import、Cluster/Worker
  deployment、image release、Local image、Console distribution 与 deployment-lock surface 等 10 项审计全部 compatible；
- 14 档 Local artifact 全部 compatible：默认 Edge/Standalone 为 2,589,890/2,589,968 bytes，application+AI 为
  4,493,043/4,493,175 bytes，MCP 为 7,315,930/7,316,038 bytes；Cluster Admin pack dry-run 保持 250 files、
  271,238-byte tarball、1,690,196-byte unpacked。
