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

## 当前阶段实物（2026-09-01）

在下面保留的历史 exact-image 证据之外，2026-08-28 的源码阶段已把 headless 用户旅程与 opt-in Console 合并为一条可选择的交付链：

| 阶段产物 | 当前可用能力 | 仍缺少 |
| --- | --- | --- |
| Local Console Trial Kit v5 | 双架构实物已生成；一条 quickstart 完成 checksum、load、fresh setup、首 Owner、标准 credential presentation、loopback Console 与示例 Task；用户可显式运行并观察 bounded log | 仍是隔离 Alpha、无 public ingress/TLS/签名；Actions artifact 保留 30 天，不是长期 release 渠道 |
| Local headless Trial Kit v5 | 默认低配变体的双架构实物已生成并验真；POSIX shell + Docker 一条命令完成 fresh setup、首 Owner与 Application active/stop；无 listener、示例 Task 或 Console 增量 | 仍是隔离 Alpha；Actions artifact 保留 30 天；无固定物理路由器容量承诺、2.x 生产升级或长期 release 渠道 |
| 全范围 Alpha stage index | 首份 headless Local 双架构 + Cluster 四角色双架构实物已在同一 run 闭合；Edge/Standalone 只选择目标架构 Local 包，Cluster 选择 control/admin/worker 并可选 control-ai | 仍无受保护 tag、GHCR immutable digest、签名、生产 deployment lock、升级/回退或 LTS 承诺 |
| D-419 Console 首自动化闭环 | quickstart 创建无网络/SecretRef/Trigger 的示例 Task；原生 CI 使用真实 Owner credential 完成 read、fenced start、`succeeded` 与 bounded log marker | 仍不提供 Web Task 编辑、2.x 升级或生产远程管理 |
| D-420 Console Run 日志观察面 | 选择 Run 后经既有认证/Policy/Audit 链读取 latest Attempt 首个 32 KiB，展示 range、truncation、pending/retired 等明确状态 | 不自动轮询、不提供整文件下载；Web Task 创建/修订仍待独立强认证事务切片 |
| D-421 Console Task 创建切片 | request-scoped credential fence、两分钟一次性本机 proof、同事务 Policy/Audit/Task mutation 已完成；Console 可创建 command Task；同源双架构 Console v5 Trial Kit 与 milestone 已生成并验真 | Web update 等待 authoring read/lease；Cluster 不复用 Local proof；仍不是生产或公开发布 |
| D-422 Console Task 安全编辑切片 | 强认证完整定义读取、10 分钟一次性 authoring lease、第二份 exact save proof 与 revision/content/credential fence 已完成；Console 可无损编辑内建 argv command Task；同源双架构 Console v5 Trial Kit 与 milestone 已生成并验真 | Cluster 不复用 Local proof；尚无通用 workflow 编辑器、2.x 升级或生产远程管理；仍不是正式发布 |
| D-423 Console cron Trigger 管理切片 | 已复用既有 immutable Trigger、Task pin、durable schedule 与原子 audit authority；Console/API 可 list/read/create/update/enable/disable `qinglong/cron@v1`，真实 SQLite/loopback 与同源双架构 Console milestone 已通过 | Cluster 不复用 Local proof；不提供删除或通用 Trigger schema 编辑；仍不是正式发布或生产升级 |
| D-424 Console Secret-backed 自动化切片 | current-only metadata、强认证 AES-256-GCM create/rotate 与 Task pinned `SecretRef` 绑定已完成；真实 SQLite/loopback、本地与远端门、同源双架构 Console milestone 及离线 auditor 均通过 | Cluster 不复用 Local proof/custody；不提供明文读取、删除或历史浏览；仍不是正式发布或生产升级 |
| D-425 2.x 升级就绪盘点 | 同源 v6 Trial Kit 已交付 amd64/arm64 headless 阶段实物；canonical `upgrade-readiness.sh` 把 2.x root 只读挂载，在 128 MiB/无网络边界内由 exact Operator 生成 SQLite 与完整目录两个计划；artifact job 实跑、bundle auditor 与 milestone v3 均闭合 | 只完成 inspect，不授权 stage、activation、cutover 或 rollback；不是 Public Release |
| D-426a Side-by-side 暂存 | 同源 v7 Trial Kit 已交付 amd64/arm64 headless 阶段实物；reviewed-plan `upgrade-rehearsal.sh` 在新的私有 root 中执行 SQLite stage/verify/activation 与完整目录 stage/verify，legacy root 始终只读，summary 固定 `cutover=not_authorized`；exact artifact job 实跑且 milestone v4 离线审计闭合 | 不执行 transform/apply、目标启动、cutover 或回退；仍不是 Public Release |
| D-426b2b Exact headless 切换链 | 同源 v8 Trial Kit 已交付 amd64/arm64 headless 阶段实物；exact 上传包完成 readiness、reviewed stage、Owner 强认证 transform/apply、真实 legacy stop、只读 target probe start/stop 与 clean `rollback_candidate`，milestone v5 和三个离线 auditor 均闭合 | 仅授权 fresh/隔离数据演练；不停止用户真实 2.x、不执行 Legacy restart、写后 reconciliation 或生产 cutover；仍不是 Public Release |
| D-426b2c Console adopted entry | 同源 exact amd64/arm64 Console Trial Kit 与 milestone 已交付；Local API cutover probe 不启动 listener/credential/mutation，controller 绑定双层配置、exact command/mount，原生 CI 完整演练且三个下载产物离线审计通过 | 仅授权 fresh/隔离数据演练；正常 Console 启动与只读 cutover probe 是不同模式；不承诺 2.x 老面板 API 零改动兼容、真实生产停机或写后回退 |

D-421 已关闭 D-420 记录的“Web Task mutation 必须独立设计”缺口，而且没有改名复用 run `33173769047` 的旧 archive。修复提交 `dc1686bd6fb3505174dd9a14098ae5c2c92a1a7f` 的普通主 CI [run 33229592307](https://github.com/whyour/qinglong/actions/runs/33229592307) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源 Kubernetes deployment [run 33229592293](https://github.com/whyour/qinglong/actions/runs/33229592293) 成功；随后显式 Local Console milestone [run 33230227006](https://github.com/whyour/qinglong/actions/runs/33230227006) 为 42 success/2 scope skip/0 fail。由此 Web 创建能力已进入新的阶段实物，而不再只是候选源码。

D-422 已从“源码候选”升级为阶段实物：本地真实 SQLite/loopback 已证明读取、租约、第二次 proof、更新与新围栏启动闭环；18-package clean build/test 为 `3,038 total / 3,016 pass / 22 conditional skip / 0 fail`，Local API `64/64`，默认 Edge 与 opt-in Edge/Standalone Console 资源门及真实 Chromium 双证明编辑均通过。修复提交 `f28bf74d1bd29e9b8a8727915de19509f4bda9cf` 的普通主 CI [run 33236204273](https://github.com/whyour/qinglong/actions/runs/33236204273) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源 Kubernetes deployment [run 33236204254](https://github.com/whyour/qinglong/actions/runs/33236204254) 为 1/1；随后显式 Local Console milestone [run 33237026187](https://github.com/whyour/qinglong/actions/runs/33237026187) 为 42 success/2 scope skip/0 fail。阶段产物绑定新的 exact commit/run/artifact digest，没有沿用或改名复用 D-421 archive。

D-423 已从“源码候选”升级为阶段实物：18-package clean build/test `3,044 total / 3,022 pass / 22 conditional skip / 0 fail`，完整 backend `1,653 total / 1,651 pass / 2 Linux conditional skip / 0 fail`，Local API `70/70`；18-package boundary、122-module Edge import 与 Cluster dependency audit 均 compatible。默认 headless Edge 为 2,754,742 bytes/331 files/58 modules，opt-in Edge/Standalone Console 为 4,150,439/4,150,583 bytes、479 files/101 modules，三资产合计 84,401 bytes。提交 `b970e2aede516c350b1cdb409e0d0d3038a5deee` 的普通主 CI [run 33244982727](https://github.com/whyour/qinglong/actions/runs/33244982727) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源 Kubernetes deployment [run 33244982694](https://github.com/whyour/qinglong/actions/runs/33244982694) 成功；随后显式 Local Console milestone [run 33245745837](https://github.com/whyour/qinglong/actions/runs/33245745837) 为 42 success/2 scope skip/0 fail。阶段产物绑定新的 exact commit/run/artifact digest，没有沿用或改名复用 D-422 archive。

D-424 已从“源码候选”升级为阶段实物：本地 18-package clean build/test 为 `3,052 total / 3,030 pass / 22 conditional skip / 0 fail`，Local SQLite `250/250`、Local API `76/76`，默认 Edge 与 opt-in Console 资源门、Edge benchmark、package/source boundary 和 Cluster dependency audit 均通过。它证明 Secret metadata 不泄漏 custody 字段、create/rotate 必须 exact local presence、SQLite 只保存密文、Task 只保存 pinned `SecretRef`。提交 `f46fb44ac9534315b6965865bb3e990715bb2417` 的普通主 CI [run 33250825989](https://github.com/whyour/qinglong/actions/runs/33250825989) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源 Kubernetes deployment [run 33250826046](https://github.com/whyour/qinglong/actions/runs/33250826046) 与三节点 Security Administration [run 33250825974](https://github.com/whyour/qinglong/actions/runs/33250825974) 成功；显式 Local Console milestone [run 33252179178](https://github.com/whyour/qinglong/actions/runs/33252179178) 为 42 success/2 scope skip/0 fail。首次 artifact run [33251389615](https://github.com/whyour/qinglong/actions/runs/33251389615) 触发 x64 router 绝对 RSS 门；同源码 ordinary run 的 peak process RSS 为 98,852,864 bytes，距 96 MiB 上限仅约 1.73 MiB，表现与 runner 基线波动一致。没有提高预算、改代码或复用 failed attempt，第二次全新 run 对同一 source 通过该门并闭合产物。

D-425 已从“源码候选”升级为阶段实物：本地完整 backend 为 `1,656 total / 1,654 pass / 2 conditional skip / 0 fail`，Trial Kit/fixture/milestone/stage 聚焦回归 `30/30`，18-package clean build/test 与 3 个非沙箱 TLS/mTLS 回环补验均为 0 fail；package/source boundary、122-module Edge import、Cluster dependency、Local Operator image 和 backend build audit 全部 compatible。提交 `d6571e4b89eaf29ed6277dd08bbd7ffb57a3705d` 的普通主 CI [run 33295923855](https://github.com/whyour/qinglong/actions/runs/33295923855) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源 Kubernetes deployment [run 33295923822](https://github.com/whyour/qinglong/actions/runs/33295923822) 成功；显式 Local headless milestone [run 33300121149](https://github.com/whyour/qinglong/actions/runs/33300121149) 为 42 success/2 scope skip/0 fail。该 artifact run 在每个原生架构上创建生产形态 2.x fixture，实跑 bundle 内 exact `upgrade-readiness.sh`，要求 SQLite 与完整目录两个正式 inspect 均返回 `inspected`，再离线审计 bundle；下载后的 milestone v3 复核返回 `compatible=true`。amd64/arm64/milestone artifact ID 分别为 `9728717020`、`9728715774`、`9728851055`，保留至 2026-09-29；readiness digest 分别为 `sha256:c28bb9361eaadf27020d1ba247d6784f795585313cb7c5ead151a20712507be1` 与 `sha256:23f7f78934e66e307eab065e0dba00aeefb0f8135beba00c41606a4e6a09685b`。这仍只授权只读 inspect，不授权任何写入或切换。

D-426a 已从“源码候选”升级为阶段实物：本地完整 backend 为 `1,657 total / 1,655 pass / 2 conditional skip / 0 fail`，18 个 workspace 包的 build/test、package boundary、Edge import、Cluster dependency、Local Operator image 与 backend build audit 均为 0 fail/compatible。提交 `7a8acacb6cb49bda2116bf029fbbfe447ae5d911` 的普通主 CI [run 33306005705](https://github.com/whyour/qinglong/actions/runs/33306005705) 为 41 success/3 expected scope skip/0 fail，同源 Kubernetes deployment [run 33306005706](https://github.com/whyour/qinglong/actions/runs/33306005706) 成功；显式 Local headless milestone [run 33306650776](https://github.com/whyour/qinglong/actions/runs/33306650776) 为 42 success/2 Cluster scope skip/0 fail。amd64/arm64/milestone artifact ID 分别为 `9730748879`、`9730748991`、`9730876361`，大小分别为 187,554,547、184,786,163 与 6,206 bytes，保留至 2026-09-29；GitHub artifact SHA-256 分别为 `9e747517bf7e61581185d6ef387a75107febe2f4612dbe122b3887ff9ac560fa`、`e696933f16d32fbb2deb367dffd23855c8de54f6d8fbf00cc32ce19915c16a4f`、`4cf602b7df7adceec8681c68fededac29726c18706e53c1212af20813448e33e`。下载后的 milestone v4 通过 checksum，离线 auditor 返回 `compatible=true`，确认 exact source/run/attempt、双架构 bundle 以及不同的 readiness/rehearsal digest 全部闭合；该实物仍不授权 transform/apply、目标启动、cutover、回退或生产写入。

D-426b2b 已从“源码候选”升级为新的可交付 headless 阶段实物。提交 `79045a0d439074994812d9cd682f933b9e415706` 的显式 Local milestone [run 33326143744](https://github.com/whyour/qinglong/actions/runs/33326143744) 为 `42 success / 2 expected scope skip / 0 fail`；Profile supply-chain、双架构 Local image、Local Profiles、资源、PostgreSQL HA/CloudNativePG、Secret/provider、Plugin Package recovery 和完整 finalizer 全部成功。amd64/arm64/milestone artifact ID 分别为 `9736356778`、`9736354298`、`9736502478`，GitHub 压缩大小为 `226206170`、`221605850`、`6492` bytes，ZIP digest 分别为 `sha256:fa2def17bcb33240eabacbf8cbc0fa1eadab4f0ba9eb5b44c12e3bffa6db3204`、`sha256:5c2e98a4143c64df1396c407e7cfae0933fb8dcb81720c00f38e63ef7923d240`、`sha256:c95b7edfbd11f2cb4d61593d36845ad8c7cb70c3cd26314c771ba85d06195426`，保留至 2026-09-29。下载后三个离线 auditor 均为 `compatible=true`；内部 Docker archive 为 amd64 `226122240` bytes / `sha256:1e1c5c83fd2c39b3bbe7b194113998a96cbe810e69d34858c3f40d2638837c60`，arm64 `221521920` bytes / `sha256:dcec37f65382d7d8c06f448780878ec2474e45d6e64b2febb764b1836898d2d6`。verification v6 在两个架构都确认漏洞策略、SBOM、128 MiB router/operator entrypoint、fresh Owner、Edge/Standalone lifecycle、API cancellation、legacy readiness/stage/cutover 为 `passed`；这证明 exact bundle 的隔离切换链与未写 target 的 clean rollback candidate，不授权真实生产停机、Legacy restart 或写后回退。

D-426b2c 已从“源码候选”升级为新的可交付 Console 阶段实物。提交 `229c3cb4e826866a0c7c4d81cb5e52cdc3975eec` 的普通主 CI [run 33462165722](https://github.com/whyour/qinglong/actions/runs/33462165722) 与 Kubernetes live run [33462165834](https://github.com/whyour/qinglong/actions/runs/33462165834) 均成功；显式 Local Console [run 33463415938](https://github.com/whyour/qinglong/actions/runs/33463415938) 完成全部门禁及 finalizer。amd64/arm64/milestone artifact ID 分别为 `9784212784`、`9784111987`、`9784288018`，GitHub 压缩大小为 `226669830`、`222069510`、`6489` bytes，ZIP digest 分别为 `sha256:d967f89d901837fbfc7b3d0d7be0ceb0ae4c36d44fc3ec707da539c34edfe76b`、`sha256:20cc976303a2c1219c91a1d620a8900ae9dfc3e28aa130f5609cb1a2bd9a1a0e`、`sha256:62c955fb376aba978a56f02abb8df611f888f44a4ee58196cd61e07e9f7912ff`，保留至 2026-10-01。重新下载后的两个 Trial Kit auditor 与 milestone v5 auditor 均为 `compatible=true`，并绑定 `3.0.0-alpha.2`、`variant=console`、同一 source/run/attempt；内部 Docker archive digest 为 amd64 `sha256:2b60885d19ec6b3f62671cc9370ee5cef4f1be41150797c36610dbdeb0a6514b`、arm64 `sha256:19c2e24d16ece348672ec4cd2a1ac4374cf6338da7e6113e2c056f7c085c4c53`。这证明同一 Console image 可在升级阶段以无 listener 的只读入口参与 exact cutover 证据，并在接收流量后用正常入口提供现有 3.0 面板；它不声明 2.x 老面板 API 零改动兼容。

默认低配 headless v5 也已从“可生成”升级为独立阶段实物。绑定提交 `d459c3b45c36e856f4a1cb3ce5147905977d939d` 的显式 Local headless milestone [run 33258604609](https://github.com/whyour/qinglong/actions/runs/33258604609) 为 42 success/2 scope skip/0 fail，完整矩阵继续覆盖双架构资源、Local/Cluster image、PostgreSQL HA、CloudNativePG、Secret/provider rotation 与 Local Profiles。该 run 没有复用 Console archive；下载后的两个 `headless` Trial Kit 与 milestone 均通过 `SHA256SUMS` 和仓库 auditor，返回 `compatible=true`。

首份跨部署全范围阶段实物绑定提交 `97333da34cce48cdfcfa1bbd5e8d48340802d2ef` 与 [run 33265538836](https://github.com/whyour/qinglong/actions/runs/33265538836)，为 `44 success / 0 skip / 0 fail`。它生成 headless Local 双架构、Cluster control/control-ai/admin/worker 双架构、两个 milestone 与 `ql3-alpha-97333da34cce48cdfcfa1bbd5e8d48340802d2ef-stage-index`；三个小索引的 GitHub ZIP digest 分别为 Local `2e3bb8baeeadb40f34c130db68db8b1a7d6cf7a7c92a73a805e84990bf9875dc`、Cluster `292380a72f8b45233f6591624f6073154c2b7d2d00f62908af687193078524e2`、stage `2fbc67d478593df8bbb2ba362beb9f676be1882ac2e5386106057789906adece`，保留至 2026-09-28。下载后三个 `SHA256SUMS` 与仓库 auditor 全部 `compatible=true`；stage auditor 确认 `3.0.0-alpha.2`、同一 source/run/attempt、三种 Profile 和 10 个可选择 artifact。

首次 all-scope run `33261478880` 在 material rotation 后遇到已 Ready provider 的跨节点端点慢收敛，旧固定 8 次窗口以 `ECONNREFUSED` 失败，三个 finalizer 正确跳过。提交 `97333da3` 将瞬态网络重试改为 3 分钟 deadline 与 16 次双重上限，非网络错误仍立即失败；本地完整 back suite 为 `1,653 total / 1,651 pass / 2 conditional skip / 0 fail`，同提交普通 CI [run 33265496193](https://github.com/whyour/qinglong/actions/runs/33265496193) 为 41 success/3 expected artifact-finalizer skip/0 fail，随后全范围 run 独立再次通过 provider live 门。

当前最新可交付 Local headless v5 保留至 2026-09-28：

- `ql3-alpha-d459c3b45c36e856f4a1cb3ce5147905977d939d-local-headless-amd64`：187,535,348 bytes，GitHub artifact SHA-256 `4d45e3f0e90159cc683a319a53ffbffc0c3ad95343e37a6f50aa8dca571d8204`，内部 Docker archive SHA-256 `071100133783638cdeb04807ca313a968ca254366745ff9f624de6b62a2da8cc`；
- `ql3-alpha-d459c3b45c36e856f4a1cb3ce5147905977d939d-local-headless-arm64`：184,766,964 bytes，GitHub artifact SHA-256 `21b6c9379531e45ec029ef64ee5ba9d51cc04ffffb50c5e29b90b175209a8c54`，内部 Docker archive SHA-256 `29b411e31ec31b5ffe38a62cd5248725a03b1c35e1b92c5cbb155745680ede46`；
- `ql3-alpha-d459c3b45c36e856f4a1cb3ce5147905977d939d-local-headless-milestone`：5,626 bytes，GitHub artifact SHA-256 `ece393032ab97776e9fe961f8e6a36fec2c4d1b6f20b9bf765816a9e3d6659c3`。

> headless milestone 的 `schema=qinglong/alpha-local-milestone-audit@v2`，确认 `3.0.0-alpha.2`、`headless`、amd64/arm64、run/attempt/sourceRevision 与两个下载 bundle manifest digest 全部闭合。它没有 Local API/Console listener，也不会创建 `alpha-first-automation`；需要图形操作面时必须选择下面独立的 Console artifact。

D-418 防止把“20 天代码和测试”冒充“用户已经能下载并完整操作”：源码与普通 CI 已具备生成、审计和实跑两种 Trial Kit 的能力，但只有显式 artifact run 生成且被同 run 的双架构 milestone 收录后，才是可下载阶段产物。操作说明见 [Local Alpha Trial Kit](./ql3-local-alpha-trial-kit.md) 与 [Local Web Console](./ql3-local-web-console.md)。

当前最新可交付 Local Console v5 绑定提交 `f46fb44ac9534315b6965865bb3e990715bb2417` 与 [GitHub Actions run 33252179178](https://github.com/whyour/qinglong/actions/runs/33252179178)，保留至 2026-09-28：

- `ql3-alpha-f46fb44ac9534315b6965865bb3e990715bb2417-local-console-amd64`：187,988,434 bytes，GitHub artifact SHA-256 `9e6b308dc421213e080868a392b59750b2f8a182170a5515152762f82003e6a6`，内部 Docker archive SHA-256 `33e2c254c329dc67b1c359e3b2d76b69578feea255918531e8ad555b75561cef`；
- `ql3-alpha-f46fb44ac9534315b6965865bb3e990715bb2417-local-console-arm64`：185,220,050 bytes，GitHub artifact SHA-256 `7edd195eef948b32f18d6efdac432cf9fe67a2a1211c4655c42c47e23ad75edb`，内部 Docker archive SHA-256 `71cdb40a555a093fe9d3b406ee863a14fb25f89620695ccccbbcb69790530bfe`；
- `ql3-alpha-f46fb44ac9534315b6965865bb3e990715bb2417-local-console-milestone`：5,623 bytes，GitHub artifact SHA-256 `2b47810393a890e67a76c1cf78d15e615fbd3eabc63f3005c69d3b852d646ce5`。

> 注：GitHub 返回的 artifact digest 绑定其下载 ZIP，milestone 内的 `archiveSha256` 绑定 Trial Kit 中的 Docker archive，二者不是同一个文件。下载后三件套的 `SHA256SUMS` 均已复核，两个 Trial Kit auditor 与 milestone auditor 均返回 `compatible=true`；milestone 的 `schema=qinglong/alpha-local-milestone-audit@v2`，确认 `3.0.0-alpha.2`、`console`、amd64/arm64、run/attempt/sourceRevision 全部闭合。

上一份仅包含到 D-423 cron Trigger 管理能力的 Local Console v5 绑定提交 `b970e2aede516c350b1cdb409e0d0d3038a5deee` 与 [GitHub Actions run 33245745837](https://github.com/whyour/qinglong/actions/runs/33245745837)，不包含 D-424 Secret-backed 自动化能力。

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

ADR-0506 的 `qinglong/alpha-local-trial-kit@v2` 首次增加 source-bound verification，ADR-0511 的 `@v3` 增加 canonical quickstart，ADR-0513 的 `@v4` 再把 `headless|console` 变体绑定到 image、SBOM、verification、milestone 和 stage index，ADR-0514 的 `@v5` 增加标准 Owner credential presentation 与首自动化旅程，ADR-0520 的 `@v6` 增加只读 2.x 升级就绪盘点。旧 runtime-only、v1/v2/v3/v4/v5 bundle 均为历史工程证据，不能通过 v6 auditor。当前真实可下载实物包括新的 headless v6 双架构 Local milestone、历史 Console v5、Cluster 双架构 milestone 与跨 Profile stage index；v6 Console 与把本次 Local milestone 纳入新的跨 Profile stage index 仍需独立 artifact run。Public Release Set 继续受更严格发布门禁约束。

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
- schema 为 `qinglong/alpha-local-trial-kit@v8` 的 `manifest.json`，通过 `variant/archive/images/sboms/quickstart/upgradeReadiness/upgradeRehearsal/upgradeCutoverRehearsal/readme/verification` 绑定版本、完整 source commit、架构、两个 image tag/image ID 与文件长度/SHA-256；
- canonical `quickstart.sh`，在目标 Linux 设备上只依赖 POSIX shell、`sha256sum` 和 Docker，完成 checksum、load、identity、fresh Owner 与 Profile-bound Application active；
- canonical `upgrade-readiness.sh`，把 2.x data root 只读挂载给 128 MiB/无网络 Operator，生成 SQLite 与完整目录两个私有 inspect 计划，不获得 stage/cutover authority；
- `verification-evidence.json` 绑定 `workflow_dispatch` 的 workflow ref/SHA、run ID/attempt、同架构两个 exact image ID 和完整 gate 集；下载者仍须到 GitHub 交叉检查 run，它不替代正式签名；
- 与实际只读镜像 inventory 对账过的 CycloneDX SBOM；
- 面向 Local 用户的 README 与覆盖全部内容文件的 `SHA256SUMS`。

Cluster artifact 是每角色/架构一个六文件闭包：native Docker archive、精确 CycloneDX SBOM、workflow-bound verification evidence、README、`qinglong/alpha-cluster-image@v1` manifest 和覆盖全部内容文件的 `SHA256SUMS`。完整 CI 成功后，八个 bundle 由 `qinglong/alpha-cluster-milestone@v1` 小型索引闭合；索引本身不重复存放大 archive。

Local milestone 是 `qinglong/alpha-local-milestone@v5` 三文件闭包，绑定一个 variant 的双架构 Trial Kit，并直接记录两个架构的 `upgradeReadinessSha256`、`upgradeRehearsalSha256` 与 `upgradeCutoverRehearsalSha256`。Stage index 是 `qinglong/alpha-stage-index@v2` 三文件闭包；它重新审计两个 milestone，要求 version/source/workflow SHA/ref/run/attempt 一致，并把 Local variant/Profile 与 Cluster 的 control/admin/worker 最小集、可选 control-ai 写为机器可读选择；它不重复存放任何镜像 archive。

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
