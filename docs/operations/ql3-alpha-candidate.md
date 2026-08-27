# QingLong 3.0 阶段性 Alpha 候选产物

该产物回答“当前源码是否已经形成可下载、可验证、可试运行的阶段成果”。它不是公开 release、不可变 GHCR digest 或生产升级承诺，也不能替代正式 release-set、签名、catalog、部署锁和回退门。

## 产物等级

| 等级 | 面向对象 | 必须通过 | 当前用途 |
| --- | --- | --- | --- |
| Runtime Engineering Candidate | QingLong 开发者、设备兼容测试者 | 单个常驻镜像的 OS 漏洞策略、SBOM/库存、资源门和生命周期 | 验证 runtime 可加载、可启动；缺少管理制品时不能称用户 Alpha |
| Local Alpha Trial Kit | amd64/arm64 路由器、NAS、单机试用者 | 同源 Application + 短生命周期 operator、exact quickstart、fresh setup/Owner/active/stop 完整旅程、SBOM/库存与资源门 | POSIX shell 一条命令从去重 Docker archive 完成隔离 fresh 试运行；不承诺生产升级 |
| Cluster Integration Candidate | amd64/arm64 集群测试节点 | OS 漏洞策略、SBOM 与镜像库存复核、non-root identity；Admin 额外通过产品 facade smoke | 导入隔离 registry/测试节点，进行多组件集成；不作为 production HA release |
| Public Release Set | 生产用户 | 受保护 tag、六镜像 multi-arch digest（Local Application/operator + Cluster 四角色）、签名/attestation、私有发布证据、catalog、Local/Cluster 部署与回退闭环 | 尚未实际发布；只能由受保护 release workflow 生成 |

`Local Alpha Trial Kit + Local milestone index` 是本阶段的用户可试运行产物；`Cluster Integration Candidate + Cluster milestone index` 是集群部署者可下载、可离线验真的集成产物。单个 headless runtime、单个 Cluster archive 或没有 milestone index 的部分矩阵产物都只是工程中间件。Cluster milestone 仍不满足正式 Kubernetes deployment-lock 的 GHCR immutable digest 与 catalog provenance。

当维护者显式选择 `alpha_artifact_scope=all` 时，还会生成 `Alpha stage index`。它把同一次 run 的 Local/Cluster milestone 交叉绑定，并为 Edge、Standalone、Cluster 给出目标架构的最小 artifact 选择；这是阶段交付导航，不是正式 release catalog。只生成 Local 或 Cluster 时，各自 milestone 仍可独立成立，不制造一个不完整的总索引。

## 当前阶段实物（2026-08-27）

在下面保留的历史 exact-image 证据之外，2026-08-28 的源码阶段已经形成两条可独立验收的产品线：

| 阶段产物 | 当前可用能力 | 仍缺少 |
| --- | --- | --- |
| D-416 Local Alpha Trial Kit v3 | POSIX shell + Docker 一条命令完成 checksum、load、fresh setup、首 Owner、headless Application active/stop | 首份远端双架构实际 artifact 仍需维护者授权 `produce_alpha_artifacts=true` |
| D-417 opt-in Local Web Console | `application-api` 制品可在同进程/同 SQLite/loopback listener 上查看 Task/Run/Event 并显式运行或取消；Edge/Standalone 制品审计通过 | 尚未进入 Trial Kit Docker image/quickstart，不能冒充当前路由/NAS 下载物 |

这两个边界共同防止把“20 天代码和测试”冒充“用户已经能下载并完整操作”：D-416 已关闭 fresh headless 用户旅程，D-417 已关闭 source/application-api 操作界面，但两者尚未合并成实际可下载的 Console Trial Kit。操作说明见 [Local Web Console](./ql3-local-web-console.md)。

提交 `4239464af6937d56528a0a2c573d12329bc7ca55` 已形成最新 owner-private arm64 工程候选：

- Application image ID `sha256:0d1d4b80ee46e9bb671d846f93d9a6d832c9856a91eed03f299055904da88a50`，operator image ID `sha256:b9122f481b1ba60d7eee9a3ed5ca57c9c141cbc389e7c7dbe19c6f6b1c98b49e`；
- 单一双镜像 archive 为 184,648,192 bytes，SHA-256 `145544c4a753192821bfbbb92000bb64af5978db57181595c9ffa9f404c1fd72`；
- checksum、旧 v1 离线内容审计、archive reload、实际 package inventory/SBOM 对账和 128 MiB 无网络只读入口 smoke 均通过；
- 同提交远端主 CI run `32990652047` 为 40/40，原生 Linux amd64/arm64 均通过 Application/operator Trivy、fresh Edge/Standalone、完整 Trial Kit journey 和 Local API cancellation；Kubernetes deployment run `32990652416` 与三节点 Security Administration run `32990653482` 同源通过。

该本地 archive 不是新的 v2 Local Alpha Trial Kit。它在 ADR-0506 前生成，manifest v1 会无条件写入 `passed`，且 macOS Docker Desktop 因 bind-mount UID 映射无法对 exact 本地 archive 完成 Owner pepper 旅程；原生 CI 证明同源码实现，不自动证明另一个 archive 的 exact image bytes。它因此保留为工程候选，不冒充已获 workflow evidence 的用户 Alpha。

ADR-0506 的 `qinglong/alpha-local-trial-kit@v2` 首次增加了 source-bound `verification-evidence.json`；ADR-0511 进一步把当前格式升级为 `@v3`，新增不依赖宿主 Node.js 的 canonical `quickstart.sh`，把可验证镜像闭合为可执行的 fresh 用户旅程。旧 `e3c05862` runtime-only archive、`2620be05` v1 Trial Kit、`4239464a` v1 archive 与未携带 quickstart 的 v2 均为历史工程证据，不能通过 v3 auditor。下一项外部里程碑仍是维护者授权 `produce_alpha_artifacts=true`，由同一次原生 milestone job 生成并实际执行 exact-image 双架构可下载 archive。

## 生成

在 GitHub Actions 手动运行 `QingLong 3.0 CI`，选择目标 `next` 提交，设置 `produce_alpha_artifacts=true`，并明确选择 `alpha_artifact_scope=local|cluster|all`。普通 push/PR 不上传大镜像，避免每次开发提交都制造伪里程碑和额外存储成本。

成功后同一次 run 生成、保留 30 天：

- `ql3-alpha-<commit>-local-amd64` 与 `ql3-alpha-<commit>-local-arm64`；
- `ql3-alpha-<commit>-local-milestone`；
- `ql3-alpha-<commit>-control-<arch>`、`control-ai-<arch>`、`admin-<arch>`、`worker-<arch>`。
- `ql3-alpha-<commit>-cluster-milestone`。
- 仅 `alpha_artifact_scope=all`：`ql3-alpha-<commit>-stage-index`。

Local artifact 含：

- 一个包含 Application 与短生命周期 operator 的 `qinglong3-local-trial-kit-<arch>.docker.tar`；共享 Node 基础层在 archive 中去重；
- schema 为 `qinglong/alpha-local-trial-kit@v3` 的 `manifest.json`，通过 `archive/images/sboms/quickstart/readme/verification` 绑定版本、完整 source commit、架构、两个 image tag/image ID 与文件长度/SHA-256；
- canonical `quickstart.sh`，在目标 Linux 设备上只依赖 POSIX shell、`sha256sum` 和 Docker，完成 checksum、load、identity、fresh Owner 与 Profile-bound Application active；
- `verification-evidence.json` 绑定 `workflow_dispatch` 的 workflow ref/SHA、run ID/attempt、同架构两个 exact image ID 和完整 gate 集；下载者仍须到 GitHub 交叉检查 run，它不替代正式签名；
- 与实际只读镜像 inventory 对账过的 CycloneDX SBOM；
- 面向 Local 用户的 README 与覆盖全部内容文件的 `SHA256SUMS`。

Cluster artifact 是每角色/架构一个六文件闭包：native Docker archive、精确 CycloneDX SBOM、workflow-bound verification evidence、README、`qinglong/alpha-cluster-image@v1` manifest 和覆盖全部内容文件的 `SHA256SUMS`。完整 CI 成功后，八个 bundle 由 `qinglong/alpha-cluster-milestone@v1` 小型索引闭合；索引本身不重复存放大 archive。

Stage index 是 `qinglong/alpha-stage-index@v1` 三文件闭包。它重新审计两个 milestone，要求 version/source/workflow SHA/ref/run/attempt 一致，并把路由/NAS 的单 Local Trial Kit 与 Cluster 的 control/admin/worker 最小集、可选 control-ai 写为机器可读选择；它不重复存放任何镜像 archive。

任何 required job 失败时不上传对应产物。artifact 名和 archive 内的 `ci-*` tag 都表示 commit-bound candidate，不能改名后冒充 `v3.x` release。

## 下载后直接试运行

在同架构原生 Linux Docker 主机上进入解压后的 Local artifact 目录，使用一个尚不存在的
隔离目录：

```sh
sh quickstart.sh edge /opt/qinglong3-alpha-data
```

也可以选择 `standalone` 和自定义容器名。quickstart 会先执行 `SHA256SUMS`，再核对 exact
镜像身份并完成 fresh setup、首 Owner 与 Application active；成功后输出 logs、stop 和
remove 命令。当前是无外部 listener、AI-excluded 的 headless runtime 阶段成果，不是
2.x Web UI 的替代品。

## 手工验证与最小 smoke

在同架构 Linux Docker 主机上进入解压后的 artifact 目录：

```sh
sha256sum --check SHA256SUMS

archive="$(node -p "require('./manifest.json').archive.file")"
docker load --input "${archive}"
image="$(node -p "require('./manifest.json').images.application.reference")"
expected_id="$(node -p "require('./manifest.json').images.application.id")"
test "$(docker image inspect --format '{{.Id}}' "${image}")" = "${expected_id}"
operator_image="$(node -p "require('./manifest.json').images.operator.reference")"
operator_expected_id="$(node -p "require('./manifest.json').images.operator.id")"
test "$(docker image inspect --format '{{.Id}}' "${operator_image}")" = "${operator_expected_id}"
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges "${image}" --help
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges "${operator_image}" --version
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges "${operator_image}" setup --help
```

下载页本身不是 source identity；还必须把 `manifest.json.sourceRevision` 与预期 `next` commit 对齐。不要在生产数据库、生产 Secret 或 2.x 唯一数据目录上直接试用。

## 试运行与回退边界

Local 正式部署仍应遵循 [Edge/Standalone 部署准备](./ql3-local-deployment.md)。Trial Kit 中的 operator 可以从受审命令文件生成 fresh pepper、credential 和数据库，但不会猜测部署路径、mutation ID、POSIX owner，也不会替操作者生成 2.x cutover evidence。使用 bind mount 时必须以最终文件 owner 的 UID/GID 运行 operator；Docker Desktop 的 mount-root UID 语义不等价于原生 Linux，失败时不得放宽 Owner proof。

阶段试运行必须使用独立目录和独立数据库；回退的最低保证是停止并删除 Alpha 容器、保留测试目录用于诊断，然后回到未被修改的 2.x 实例。凡是执行 2.x→3.0 数据迁移或 3.0 写入后切回，都必须走既有 reconciliation/cutover/rollback ceremony，不能只换镜像。

Cluster candidate 必须先导入隔离 registry 并重新绑定该 registry 的 immutable digest。当前 archive 不带 public catalog、签名或正式 deployment selection；生产 Kubernetes、CloudNativePG HA、跨主机 STONITH/DR、CSI custody 和外部 IdP 不在此阶段产物的声明范围内。

## 里程碑判定

一次 Local 用户阶段里程碑只有同时记录以下事实才成立：源码 commit、版本、两种 Tier-1 架构的 Application/operator、完整 CI run、artifact 名与 digest、fresh setup→首 Owner→active→stop 的目标 Profile smoke、已知限制和回退路径。一次 Cluster 集成里程碑还必须精确闭合四角色乘两架构、同一 run/attempt 和八个独立主体。仅有源码、`dist/`、单元测试数字、Dockerfile、单个 headless runtime 或“理论上可构建”都不算阶段可用产物。
