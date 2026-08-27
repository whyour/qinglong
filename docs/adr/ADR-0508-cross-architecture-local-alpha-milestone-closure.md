# ADR-0508：跨架构 Local Alpha 里程碑闭合

- 状态：Accepted（首份实际 milestone artifact 待维护者授权）
- 日期：2026-08-27
- 决策：D-413
- 关联：ADR-0503、ADR-0504、ADR-0506、ADR-0507

## 背景

Local Alpha workflow 已能在原生 amd64、arm64 runner 上分别生成 Application/operator 双镜像 Trial Kit，但两个矩阵作业各自上传 artifact。只要其中一个架构上传成功，GitHub Actions 页面就会留下一个可下载大归档，即使另一架构、PostgreSQL HA、资源门或其余完整 CI 随后失败。

这类孤立文件证明一个矩阵作业曾走到上传步骤，不能证明 QingLong 3.0 已形成阶段版本。开发二十天后的阶段产物必须有一个用户可识别的成功终态，而不是让部署者从几十个 job 和零散 artifact 猜测“哪些可以用”。

原有 boolean 还会同时生成 Local 两套与 Cluster 八套原生归档；只想验证低配路由/NAS 的维护者必须无谓承担 Cluster artifact 的构建归档和存储成本。手动 milestone 与普通 `next` push 共享 `cancel-in-progress` 并发域，也可能在大归档生成过程中被后续提交取消。

## 决策

### 1. Local Alpha 必须以跨架构 milestone index 为完成信号

新增发布期脚本 `ql3-local-alpha-milestone.cjs`。`local-alpha-milestone` job 只有在完整 `QingLong 3.0 CI` 的所有现有 job 成功后才运行，并重新下载、离线审计同一 run/attempt 的 amd64 与 arm64 Trial Kit。

finalizer 精确要求：

- 两套 bundle 具有同一版本、完整 source revision、workflow SHA、run ID 与 attempt；
- 架构集合恰好为 `amd64|arm64`；
- 两个 archive digest、两份 verification digest 和四个 Application/operator image ID 相互分离；
- 每套 bundle 自身的七文件闭包、SBOM、manifest、verification evidence 与 checksum 继续由 v2 auditor 通过；
- artifact 名称从 source 与架构唯一推导，调用方不能自报。

成功后只上传三文件小型索引：`manifest.json`、`README.md`、`SHA256SUMS`，schema 为 `qinglong/alpha-local-milestone@v1`。索引绑定两个 artifact 名、各自 bundle manifest digest、archive digest、镜像 ID、verification digest 和 workflow identity。没有该索引的零散 Trial Kit 明确是失败或未闭合运行的中间文件，不是阶段交付物。

### 2. 手动产物按产品域选择

保留显式 `produce_alpha_artifacts=true` 授权，并增加 `alpha_artifact_scope=local|cluster|all`，默认 `local`：

- `local` 只归档两套 Local Trial Kit 并生成 milestone index；
- `cluster` 只归档 Cluster Integration Candidate 原生镜像，不生成 Local index；
- `all` 同时生成两类。

无论选择哪个归档 scope，完整 CI 仍执行；scope 只控制大体积 artifact 的物化和上传，不跳过测试门，也不改变 Edge/Standalone/Cluster runtime closure。

### 3. Milestone run 不由普通 push 取消

普通 push/PR 继续共享 validation 并发域并允许 newer run 取消旧 run。显式 artifact milestone 使用自身 run ID 作为并发域，`cancel-in-progress=false`；后续 push 不会中断已经授权的双架构产物。checkout、evidence 与 index 仍绑定触发时的 exact SHA，不读取移动后的 branch head。

## 被拒绝的替代方案

### 把两个独立 artifact 都称为 Alpha

拒绝。部分上传、另一架构失败或完整 CI 失败时没有唯一成功信号，部署者无法可靠裁决成熟度。

### 把两个架构 archive 再复制进一个总 artifact

拒绝。每位用户只需要自己的架构；总包会重复下载和存储数百 MiB，并对低容量设备无益。小型 index 足以闭合身份和 digest。

### Local 两个矩阵 job 成功后立即发布 index

拒绝。同一源码的 backend、资源、供应链、PostgreSQL HA 或 Kubernetes live gate 仍可能失败。阶段版本必须等待完整 CI，而不是只等待镜像局部路径。

### 赋予 finalizer 删除孤立 artifact 的权限

拒绝。索引缺失已经能失败关闭，增加 `actions: write` 和删除 authority 会扩大 workflow 权限与事故半径。孤立文件按 30 天 retention 自动过期。

## 影响

- 首个真实 Local Alpha milestone 多一次双 artifact 下载和离线复核，只发生在显式里程碑运行；
- 普通 push/PR 不生成大归档或 milestone index，CI 成本基本不变；
- 默认 Local scope 不再无谓生成八套 Cluster archive；
- 新脚本和索引属于发布期仓库工具，不新增 workspace package、设备依赖、镜像 layer、常驻进程、端口、timer、连接池或 RSS；
- Public Release Set 仍由受保护 tag、不可变 registry digest、签名、attestation、catalog 和 deployment closure 独立裁决。

## 验证

- finalizer 正向测试生成 exact 三文件 index，并复核双架构、run/attempt、四镜像主体与 archive digest；
- 负向测试覆盖跨 attempt、跨架构 image identity 复用、index mutation、额外文件和 CLI grammar；
- 静态 workflow audit 固定 scope 条件、milestone 独立并发域、19 个完整 CI dependency、双 artifact 下载、`finalize → audit → upload` 顺序和 30 天 retention；
- 首份真实 `produce_alpha_artifacts=true + alpha_artifact_scope=local` 产物仍需维护者显式授权，生成后再把 ADR-0503 从 Proposed 转为 Accepted 并记录 index/bundle digest。
