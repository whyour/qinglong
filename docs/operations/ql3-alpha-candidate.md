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

## 当前阶段实物（2026-08-29）

在下面保留的历史 exact-image 证据之外，2026-08-28 的源码阶段已把 headless 用户旅程与 opt-in Console 合并为一条可选择的交付链：

| 阶段产物 | 当前可用能力 | 仍缺少 |
| --- | --- | --- |
| Local Console Trial Kit v5 | 双架构实物已生成；一条 quickstart 完成 checksum、load、fresh setup、首 Owner、标准 credential presentation、loopback Console 与示例 Task；用户可显式运行并观察 bounded log | 仍是隔离 Alpha、无 public ingress/TLS/签名；Actions artifact 保留 30 天，不是长期 release 渠道 |
| Local headless Trial Kit v5 | 默认低配变体；同一源码支持 POSIX shell + Docker 一条命令完成 fresh setup、首 Owner与 Application active/stop；无 listener、示例 Task 或 Console 增量 | 尚未为当前提交单独触发 headless 双架构 milestone；不能把 Console archive 改名复用 |
| D-419 Console 首自动化闭环 | quickstart 创建无网络/SecretRef/Trigger 的示例 Task；原生 CI 使用真实 Owner credential 完成 read、fenced start、`succeeded` 与 bounded log marker | 仍不提供 Web Task 编辑、2.x 升级或生产远程管理 |
| D-420 Console Run 日志观察面 | 选择 Run 后经既有认证/Policy/Audit 链读取 latest Attempt 首个 32 KiB，展示 range、truncation、pending/retired 等明确状态 | 不自动轮询、不提供整文件下载；Web Task 创建/修订仍待独立强认证事务切片 |
| D-421 Console Task 创建切片 | request-scoped credential fence、两分钟一次性本机 proof、同事务 Policy/Audit/Task mutation 已完成；Console 可创建 command Task；同源双架构 Console v5 Trial Kit 与 milestone 已生成并验真 | Web update 等待 authoring read/lease；Cluster 不复用 Local proof；仍不是生产或公开发布 |
| D-422 Console Task 安全编辑切片 | 强认证完整定义读取、10 分钟一次性 authoring lease、第二份 exact save proof 与 revision/content/credential fence 已完成；Console 可无损编辑内建 argv command Task；同源双架构 Console v5 Trial Kit 与 milestone 已生成并验真 | Cluster 不复用 Local proof；尚无通用 workflow 编辑器、2.x 升级或生产远程管理；仍不是正式发布 |
| D-423 Console cron Trigger 管理切片 | 已复用既有 immutable Trigger、Task pin、durable schedule 与原子 audit authority；Console/API 可 list/read/create/update/enable/disable `qinglong/cron@v1`，真实 SQLite/loopback 与同源双架构 Console milestone 已通过 | Cluster 不复用 Local proof；不提供删除或通用 Trigger schema 编辑；仍不是正式发布或生产升级 |
| D-424 Console Secret-backed 自动化切片 | 源码候选已完成 current-only metadata、强认证 AES-256-GCM create/rotate 与 Task pinned `SecretRef` 绑定；真实 SQLite/loopback、本地全量包、资源与架构门已通过 | exact commit 的远端主 CI、Kubernetes 与双架构 milestone 尚未闭合；当前可下载实物仍是 D-423 |

D-421 已关闭 D-420 记录的“Web Task mutation 必须独立设计”缺口，而且没有改名复用 run `33173769047` 的旧 archive。修复提交 `dc1686bd6fb3505174dd9a14098ae5c2c92a1a7f` 的普通主 CI [run 33229592307](https://github.com/whyour/qinglong/actions/runs/33229592307) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源 Kubernetes deployment [run 33229592293](https://github.com/whyour/qinglong/actions/runs/33229592293) 成功；随后显式 Local Console milestone [run 33230227006](https://github.com/whyour/qinglong/actions/runs/33230227006) 为 42 success/2 scope skip/0 fail。由此 Web 创建能力已进入新的阶段实物，而不再只是候选源码。

D-422 已从“源码候选”升级为阶段实物：本地真实 SQLite/loopback 已证明读取、租约、第二次 proof、更新与新围栏启动闭环；18-package clean build/test 为 `3,038 total / 3,016 pass / 22 conditional skip / 0 fail`，Local API `64/64`，默认 Edge 与 opt-in Edge/Standalone Console 资源门及真实 Chromium 双证明编辑均通过。修复提交 `f28bf74d1bd29e9b8a8727915de19509f4bda9cf` 的普通主 CI [run 33236204273](https://github.com/whyour/qinglong/actions/runs/33236204273) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源 Kubernetes deployment [run 33236204254](https://github.com/whyour/qinglong/actions/runs/33236204254) 为 1/1；随后显式 Local Console milestone [run 33237026187](https://github.com/whyour/qinglong/actions/runs/33237026187) 为 42 success/2 scope skip/0 fail。阶段产物绑定新的 exact commit/run/artifact digest，没有沿用或改名复用 D-421 archive。

D-423 已从“源码候选”升级为阶段实物：18-package clean build/test `3,044 total / 3,022 pass / 22 conditional skip / 0 fail`，完整 backend `1,653 total / 1,651 pass / 2 Linux conditional skip / 0 fail`，Local API `70/70`；18-package boundary、122-module Edge import 与 Cluster dependency audit 均 compatible。默认 headless Edge 为 2,754,742 bytes/331 files/58 modules，opt-in Edge/Standalone Console 为 4,150,439/4,150,583 bytes、479 files/101 modules，三资产合计 84,401 bytes。提交 `b970e2aede516c350b1cdb409e0d0d3038a5deee` 的普通主 CI [run 33244982727](https://github.com/whyour/qinglong/actions/runs/33244982727) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源 Kubernetes deployment [run 33244982694](https://github.com/whyour/qinglong/actions/runs/33244982694) 成功；随后显式 Local Console milestone [run 33245745837](https://github.com/whyour/qinglong/actions/runs/33245745837) 为 42 success/2 scope skip/0 fail。阶段产物绑定新的 exact commit/run/artifact digest，没有沿用或改名复用 D-422 archive。

D-424 当前严格标记为源码候选，而不是“开发完成即交付”：本地 18-package clean build/test 为 `3,052 total / 3,030 pass / 22 conditional skip / 0 fail`，Local SQLite `250/250`、Local API `76/76`，默认 Edge 与 opt-in Console 资源门、Edge benchmark、package/source boundary 和 Cluster dependency audit 均通过。它已经证明 Secret metadata 不泄漏 custody 字段、create/rotate 必须 exact local presence、SQLite 只保存密文、Task 只保存 pinned `SecretRef`。只有 exact source commit 的普通主 CI、Kubernetes deployment 与显式双架构 Console milestone 全绿，并下载复核 checksum/auditor 后，本段才会改为阶段实物；当前下载者应继续使用下面的 D-423 run `33245745837`。

D-418 防止把“20 天代码和测试”冒充“用户已经能下载并完整操作”：源码与普通 CI 已具备生成、审计和实跑两种 Trial Kit 的能力，但只有显式 artifact run 生成且被同 run 的双架构 milestone 收录后，才是可下载阶段产物。操作说明见 [Local Alpha Trial Kit](./ql3-local-alpha-trial-kit.md) 与 [Local Web Console](./ql3-local-web-console.md)。

当前最新可交付 Local Console v5 绑定提交 `b970e2aede516c350b1cdb409e0d0d3038a5deee` 与 [GitHub Actions run 33245745837](https://github.com/whyour/qinglong/actions/runs/33245745837)，保留至 2026-09-28：

- `ql3-alpha-b970e2aede516c350b1cdb409e0d0d3038a5deee-local-console-amd64`：187,914,706 bytes，GitHub artifact SHA-256 `4addcea450563838538abfe3a27b6f073aa671937d9c3e34913e3fa19f98ffd4`，内部 Docker archive SHA-256 `026c496e33e3e5d52f99f733ae71c5187e1aa5e769378728a1c31f8e6fc036fc`；
- `ql3-alpha-b970e2aede516c350b1cdb409e0d0d3038a5deee-local-console-arm64`：185,146,322 bytes，GitHub artifact SHA-256 `9fa1ce68ba8c7ac8594a76aa0dac0726566b086708d60a7df7cedad11804d5a6`，内部 Docker archive SHA-256 `d6073c6a6f5c3a6a2e485b5386be0e174a33e75dfab7b1d91f6228e3880708af`；
- `ql3-alpha-b970e2aede516c350b1cdb409e0d0d3038a5deee-local-console-milestone`：5,623 bytes，GitHub artifact SHA-256 `427c4804d63bd14683193003fcb430f7eb6cac6706daee56c3d80948b3ee58c7`。

> 注：GitHub 返回的 artifact digest 绑定其下载 ZIP，milestone 内的 `archiveSha256` 绑定 Trial Kit 中的 Docker archive，二者不是同一个文件。下载后的 milestone `SHA256SUMS` 已复核，仓库 auditor 返回 `schema=qinglong/alpha-local-milestone-audit@v2`、`compatible=true`，并确认 `3.0.0-alpha.2`、`console`、amd64/arm64、run/attempt/sourceRevision 全部闭合。

上一份仅包含 D-422 Web 安全编辑能力的 Local Console v5 绑定提交 `f28bf74d1bd29e9b8a8727915de19509f4bda9cf` 与 [GitHub Actions run 33237026187](https://github.com/whyour/qinglong/actions/runs/33237026187)，不包含 D-423 cron Trigger 管理能力。

更早一份仅包含 D-421 Web 创建能力的 Local Console v5 绑定提交 `dc1686bd6fb3505174dd9a14098ae5c2c92a1a7f` 与 [GitHub Actions run 33230227006](https://github.com/whyour/qinglong/actions/runs/33230227006)，不包含 D-422 Web 编辑能力。

前一份首自动化/日志观察阶段的 Local Console v5 绑定提交 `37abfa160da7669b2628c0a70dbd52f50f7dcec1` 与 [GitHub Actions run 33173769047](https://github.com/whyour/qinglong/actions/runs/33173769047)，保留至 2026-09-27：

- `ql3-alpha-37abfa160da7669b2628c0a70dbd52f50f7dcec1-local-console-amd64`：187,712,409 bytes，GitHub artifact SHA-256 `baf9861b70ebaccccab45fb49714589dc2d2083da4dc122a4393052285890b2f`，内部 Docker archive SHA-256 `5a7ccda8d50bb902077faa021cf9481631ff9331fc513352fc874a93bffbf5be`；
- `ql3-alpha-37abfa160da7669b2628c0a70dbd52f50f7dcec1-local-console-arm64`：184,944,025 bytes，GitHub artifact SHA-256 `880574fcabf0214051eec424e1befd5a972dec907d386e5b06d0f8a6dcfe70dc`，内部 Docker archive SHA-256 `812a6ab375f79bcedaab2592acd915b4c715d016c6aa9722a8c3fda21649abab`；
- `ql3-alpha-37abfa160da7669b2628c0a70dbd52f50f7dcec1-local-console-milestone`：5,623 bytes，GitHub artifact SHA-256 `d3df83539969fbb77ff45c65c2f92bd9f74e30e50ebae5ba0eb688743fad89e8`。

下载后的 milestone `SHA256SUMS` 与离线 auditor 已复核，返回 `compatible: true`。首次 run `33164186855` 虽生成两个架构的大 bundle，却因 finalizer 未安装根依赖而无法形成索引；它被保留为失败运行中间件。提交 `37abfa16` 补齐三个 finalizer 的 frozen install 并新增静态回归门，证明阶段产物判定确实会拒绝“有 archive、无闭合索引”的状态。

提交 `4239464af6937d56528a0a2c573d12329bc7ca55` 已形成最新 owner-private arm64 工程候选：

- Application image ID `sha256:0d1d4b80ee46e9bb671d846f93d9a6d832c9856a91eed03f299055904da88a50`，operator image ID `sha256:b9122f481b1ba60d7eee9a3ed5ca57c9c141cbc389e7c7dbe19c6f6b1c98b49e`；
- 单一双镜像 archive 为 184,648,192 bytes，SHA-256 `145544c4a753192821bfbbb92000bb64af5978db57181595c9ffa9f404c1fd72`；
- checksum、旧 v1 离线内容审计、archive reload、实际 package inventory/SBOM 对账和 128 MiB 无网络只读入口 smoke 均通过；
- 同提交远端主 CI run `32990652047` 为 40/40，原生 Linux amd64/arm64 均通过 Application/operator Trivy、fresh Edge/Standalone、完整 Trial Kit journey 和 Local API cancellation；Kubernetes deployment run `32990652416` 与三节点 Security Administration run `32990653482` 同源通过。

该本地 archive 不是新的 v2 Local Alpha Trial Kit。它在 ADR-0506 前生成，manifest v1 会无条件写入 `passed`，且 macOS Docker Desktop 因 bind-mount UID 映射无法对 exact 本地 archive 完成 Owner pepper 旅程；原生 CI 证明同源码实现，不自动证明另一个 archive 的 exact image bytes。它因此保留为工程候选，不冒充已获 workflow evidence 的用户 Alpha。

ADR-0506 的 `qinglong/alpha-local-trial-kit@v2` 首次增加 source-bound verification，ADR-0511 的 `@v3` 增加 canonical quickstart，ADR-0513 的 `@v4` 再把 `headless|console` 变体绑定到 image、SBOM、verification、milestone 和 stage index，ADR-0514 的 `@v5` 增加标准 Owner credential presentation 与首自动化旅程。旧 runtime-only、v1/v2/v3/v4 bundle 均为历史工程证据，不能通过 v5 auditor。下一项 Local 外部里程碑是为同一阶段单独生成默认低配 headless v5；Cluster milestone、跨 Profile stage index 和 Public Release Set 仍分别受各自门禁约束。

## 生成

在 GitHub Actions 手动运行 `QingLong 3.0 CI`，选择目标 `next` 提交，设置 `produce_alpha_artifacts=true`，明确选择 `alpha_artifact_scope=local|cluster|all`，并为 Local 选择 `local_alpha_variant=headless|console`（默认 headless）。普通 push/PR 不上传大镜像，避免每次开发提交都制造伪里程碑和额外存储成本。

成功后同一次 run 生成、保留 30 天：

- `ql3-alpha-<commit>-local-<variant>-amd64` 与 `ql3-alpha-<commit>-local-<variant>-arm64`；
- `ql3-alpha-<commit>-local-<variant>-milestone`；
- `ql3-alpha-<commit>-control-<arch>`、`control-ai-<arch>`、`admin-<arch>`、`worker-<arch>`。
- `ql3-alpha-<commit>-cluster-milestone`。
- 仅 `alpha_artifact_scope=all`：`ql3-alpha-<commit>-stage-index`。

Local artifact 含：

- 一个包含所选 Application 与短生命周期 operator 的 archive；headless 为 `qinglong3-local-trial-kit-<arch>.docker.tar`，Console 为 `qinglong3-local-console-trial-kit-<arch>.docker.tar`，共享 Node 基础层在 archive 中去重；
- schema 为 `qinglong/alpha-local-trial-kit@v5` 的 `manifest.json`，通过 `variant/archive/images/sboms/quickstart/readme/verification` 绑定版本、完整 source commit、架构、两个 image tag/image ID 与文件长度/SHA-256；
- canonical `quickstart.sh`，在目标 Linux 设备上只依赖 POSIX shell、`sha256sum` 和 Docker，完成 checksum、load、identity、fresh Owner 与 Profile-bound Application active；
- `verification-evidence.json` 绑定 `workflow_dispatch` 的 workflow ref/SHA、run ID/attempt、同架构两个 exact image ID 和完整 gate 集；下载者仍须到 GitHub 交叉检查 run，它不替代正式签名；
- 与实际只读镜像 inventory 对账过的 CycloneDX SBOM；
- 面向 Local 用户的 README 与覆盖全部内容文件的 `SHA256SUMS`。

Cluster artifact 是每角色/架构一个六文件闭包：native Docker archive、精确 CycloneDX SBOM、workflow-bound verification evidence、README、`qinglong/alpha-cluster-image@v1` manifest 和覆盖全部内容文件的 `SHA256SUMS`。完整 CI 成功后，八个 bundle 由 `qinglong/alpha-cluster-milestone@v1` 小型索引闭合；索引本身不重复存放大 archive。

Local milestone 是 `qinglong/alpha-local-milestone@v2` 三文件闭包，绑定一个 variant 的双架构 Trial Kit。Stage index 是 `qinglong/alpha-stage-index@v2` 三文件闭包；它重新审计两个 milestone，要求 version/source/workflow SHA/ref/run/attempt 一致，并把 Local variant/Profile 与 Cluster 的 control/admin/worker 最小集、可选 control-ai 写为机器可读选择；它不重复存放任何镜像 archive。

任何 required job 失败时不上传对应产物。artifact 名和 archive 内的 `ci-*` tag 都表示 commit-bound candidate，不能改名后冒充 `v3.x` release。

## 下载后直接试运行

在同架构原生 Linux Docker 主机上进入解压后的 Local artifact 目录，使用一个尚不存在的
隔离目录：

```sh
sh quickstart.sh edge /opt/qinglong3-alpha-data
```

也可以选择 `standalone` 和自定义容器名。quickstart 会先执行 `SHA256SUMS`，再核对 exact
镜像身份并完成 fresh setup、首 Owner 与 Application active；成功后输出 logs、stop 和
remove 命令。Headless 不开放 listener；Console 只在 Linux host 的 `127.0.0.1:5700`
提供 Alpha 操作面，远程访问必须经 SSH tunnel。两者都不是 2.x Web UI 的生产替代品。

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
