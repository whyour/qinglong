# QingLong 3.0 Local Alpha Trial Kit

本目录是绑定一个 QingLong 3.0 源码提交、一个 Linux 架构和一次显式 GitHub milestone run 的阶段试运行套件，不是公开 release 或生产升级承诺。它同时包含常驻 Application 镜像和短生命周期 operator 镜像；两者共享的 OCI layer 只在同一个 Docker archive 中保存一次。

一套 Trial Kit 只有被同一 run 的 `ql3-alpha-<sourceRevision>-local-<variant>-milestone` 跨架构索引收录后才是可交付阶段产物。单个矩阵 job 提前上传、另一架构或完整 CI 随后失败时留下的 artifact 只是中间文件。先按 milestone `manifest.json` 选择 `variant` 和本机架构并核对本 bundle manifest digest，再执行下述离线验收。

## 适用范围

- `amd64` 或 `arm64` Linux Docker 主机；
- 低配路由/NAS 的 Edge profile，或资源较充足单机的 Standalone profile；
- fresh、隔离的测试数据目录；
- 离线导入、设备兼容验证和 3.0 Alpha 用户旅程验证。

`headless` 是默认且最小的低配设备变体，不打开端口。`console` 是显式选择的 Linux-only 变体，携带离线 3.0 原生 Web Console 和现有面板的有界只读兼容层，并仅通过宿主 `127.0.0.1:5700` 提供操作面。二者是独立 archive，不应同时下载；远程 Console 只允许经 SSH tunnel 访问，不得暴露到 LAN 或公网。

不要把它直接用于生产数据、2.x 唯一数据目录或生产 Secret。Cluster/Kubernetes 节点应使用 Cluster Integration Candidate；本套件不包含 PostgreSQL HA、Worker 或 Cluster Admin。

## 离线验收

先在解压目录中执行不依赖 Node.js 的文件校验：

```sh
sha256sum --check SHA256SUMS
```

`manifest.json` 必须满足：

- `schema` 为 `qinglong/alpha-local-trial-kit@v11`，`schemaVersion=12`；
- `variant` 为 `headless` 或 `console`，并与 milestone、application SBOM 和 artifact 名一致；
- `sourceRevision` 是你准备试用的完整 40 位 commit；
- `architecture` 与主机相同；
- `maturity` 为 `alpha_candidate_not_public_release`。

`manifest.json.verification` 必须指向同目录的 `verification-evidence.json`。该 evidence 的 subject 必须与 manifest 中的版本、源码、架构和两个 image ID 完全一致；workflow 必须是 `whyour/qinglong` 的 `ql3-ci.yml@refs/heads/next`、`workflow_dispatch`、`local-image`。使用 `workflow.runId` 和 `workflow.runAttempt` 打开对应 GitHub Actions run，确认 source 和结论；JSON provenance 是可交叉检查的阶段证据，不是 Cosign/GitHub attestation。

如果同时持有 QingLong 源码和 Node.js 24，可执行严格的闭合文件集、manifest、SBOM 和 checksum 审计：

```sh
node scripts/ql3-local-alpha-trial-kit-bundle.cjs \
  --mode=audit \
  --bundle=/absolute/path/to/this-directory
```

任一校验失败都不要加载或运行 archive。

## 一条命令完成 Fresh 试运行

v11 bundle 内的 `quickstart.sh` 不依赖宿主 Node.js、jq 或 Compose，只需要 POSIX
shell、`sha256sum` 和已启动的 Docker。必须选择一个尚不存在、与 2.x/生产数据完全
隔离的绝对路径：

```sh
sh quickstart.sh edge /opt/qinglong3-alpha-data
```

资源较充足的单节点可以把 `edge` 改为 `standalone`。第三个可选参数用于指定容器名：

```sh
sh quickstart.sh standalone /srv/qinglong3-alpha-data ql3-alpha-standalone
```

脚本会自动执行全包 checksum、加载 archive、核对 exact image ID/source/architecture、
以当前 UID:GID 和无网络的短生命周期 operator 完成 fresh setup、首 Owner 建立与标准
`owner-credential.json` presentation 安装，随后按 Profile 资源上限启动 Application。只有
容器日志出现结构化 `active` 事件才返回成功。
Owner delivery 保留在新数据目录的 `owner-delivery/`，operator command 结果保留在
`results/`；两者都位于 `0700` 私有根内，不会打印 Secret 到终端。

成功输出会给出当前容器的 logs、graceful stop 和 remove 命令。停止/删除容器不会自动
删除数据目录；确认不再需要诊断后由操作者显式删除该 fresh 测试目录。脚本拒绝既有目录，
不能用于升级、迁移或接管 2.x。

Headless Application 是无外部 listener、AI-excluded 的最小 Alpha runtime。Console 变体同样
AI-excluded，但 quickstart 会在 Linux 上使用 host network，让容器内仍严格绑定
`127.0.0.1:5700` 的 Local API 可由宿主浏览器访问。成功后打开
`http://127.0.0.1:5700/console` 使用 3.0 原生管理台，或打开 `/login` 使用现有面板的只读 Crontab 兼容入口；远程主机必须建立 SSH tunnel。两种变体都只用于 fresh Alpha，
不是完整 2.x Web UI 的生产替代版本。Console 能力和凭据边界见
[Local Web Console](./ql3-local-web-console.md)。

Console quickstart 还会通过 strong local operator 创建一个默认不自动运行的
`alpha-first-automation`。在页面输入 `owner-credential.json` 中的 token，选择该 Task，
核对 revision/content digest 后显式运行；它只执行 `/bin/echo` 固定标记，不使用网络、
SecretRef 或 Trigger。D-429 已交付产物选择该 Run 后，会经既有 `artifact.read` 权限链展示 latest
Attempt 首个 32 KiB 日志。D-430 源码候选在原生 `/console` 增加手动分段导航；其 exact 双架构
产物尚待验收，不应把旧 archive 当作支持翻页的版本。版本与入口差异见
[页面功能与下载版本](./ql3-local-web-console.md#页面功能与下载版本)。页面不会自动轮询或下载整份日志。
headless 不创建示例 Task，因此低配默认档没有示例数据或稳态开销。

## 只读检查现有 2.x 升级就绪度

v11 bundle 还包含 canonical `upgrade-readiness.sh`。它让现有部署用户先回答“这份 2.x SQLite 和完整 data directory 是否能形成可审核
计划”，不会把 inspect 成功冒充自动升级。建议停止 2.x、同步器和下载器，确认主库位于 `db/database.sqlite`，再选择一个尚不存在且不在
2.x data root 内的 evidence 路径：

```sh
sh upgrade-readiness.sh \
  edge \
  /opt/qinglong/data \
  /opt/qinglong3-alpha-upgrade-readiness
```

NAS/较大单机使用 `standalone`。脚本继续只依赖 POSIX shell、`sha256sum` 和 Docker；它先验证全包 checksum、exact Operator image ID、源码和
架构，再把 2.x root 以 read-only bind mount 提供给当前 UID:GID 的短生命周期 Operator。Operator 固定无网络、只读 rootfs、128 MiB、
0.5 CPU 和 32 PID，分别执行正式的 `local-sqlite.adoption.inspect` 与 `local-data-directory.adoption.inspect`。

两个完整结果保存在 evidence root 的：

- `results/sqlite-inspect.result.json`；
- `results/data-directory-inspect.result.json`。

不要只保存终端输出或手工抄写 digest。审核 SQLite catalog/task inventory、完整目录的 `assessment`、disposition、预算、unsafe/unknown 条目、主库
计数和 active sidecar，并保存两个 exact `planDigest`。脚本不会运行 stage、activation、transform/apply、cutover、target stop 或 Legacy
rollback，也不会修改 source、修权限或删除 sidecar。readiness 成功不授权下一阶段；需要继续演练时按仓库运维协议显式提交审核后的 digest。

macOS Docker Desktop 可能在新建 bind mount 的父/子进程间短暂呈现不同 UID。readiness 对每个纯只读 inspect 最多执行两次相同命令，且只在命令成功后原子发布结果；第二次仍失败就立即停止。该兼容窗口不修改数据、不重写成功结果，也不放宽原生 Linux 的 canonical path、POSIX owner 或 mode 校验。

artifact job 必须在原生 amd64/arm64 上使用生产形态 2.x fixture 运行将要上传的 exact `upgrade-readiness.sh`，两个正式 Operator 结果都为
`inspected` 后才能记录 `verification-evidence.json.gates.legacyUpgradeReadiness=passed` 并上传。该证明仍不是用户实际磁盘、停机窗口、I/O 峰值或
生产数据内容兼容性承诺。

## 受审核计划的 Side-by-side 暂存

审核上一节两个完整结果后，把其中 exact `evidence.planDigest` 作为显式参数交给 v11 bundle 的 canonical `upgrade-rehearsal.sh`：

```sh
sh upgrade-rehearsal.sh \
  edge \
  /opt/qinglong/data \
  /opt/qinglong3-alpha-upgrade-stage \
  <reviewed-sqlite-plan-digest> \
  <reviewed-data-directory-plan-digest>
```

脚本在新的私有 rehearsal root 中完成 SQLite stage/verify/activation 与完整 data-directory stage/verify；2.x root 全程只读，Operator 仍为无网络、
128 MiB、0.5 CPU、32 PID 的一次性容器。成功后保存 `stage-summary.json`、全部 command result、SQLite target/recovery/manifest/activation 和完整目录
staging manifest。summary 必须是 `status=verified`、`legacySource=read_only`、`cutover=not_authorized`。

这不是升级完成：本阶段不执行 transform/apply，不安装 Owner/Secret，不停止 2.x，不启动 3.0，也不授权 cutover 或 Legacy rollback。不要编辑、移动、
复用或当作生产数据根；后续 adopted start 必须精确消费这里的 evidence，并走独立的 D-426b 门。artifact job 必须对将要上传的 exact 脚本使用同一个
生产形态 fixture 实跑，并记录 `verification-evidence.json.gates.legacyUpgradeStage=passed`。

## 隔离的真实切换链演练

v9 `headless|console` bundle 都提供 `upgrade-cutover-rehearsal.sh`。它只面向 Linux Docker 测试主机，在新的 rehearsal root 和两个专用合成容器上消费上一阶段已审核的两个 plan digest：

```sh
sh upgrade-cutover-rehearsal.sh \
  edge \
  /opt/qinglong/data \
  /opt/qinglong3-alpha-upgrade-cutover \
  <reviewed-sqlite-plan-digest> \
  <reviewed-data-directory-plan-digest> \
  ql3-alpha-upgrade-legacy \
  ql3-alpha-upgrade-target
```

脚本先重跑 canonical stage/verify，再完成 fresh Owner 建立、data-directory transform/apply、真实 Docker socket 上的合成 Legacy 停机和 3.0 target 启停。headless target 使用 Application `--cutover-probe`；Console target 使用生产 `ql3-local-api` 入口的 `--cutover-probe`，同时绑定外层 Local API 与内层 Application 配置。后者只验证 loopback 配置并委托 Application 只读 readiness，不启动 listener、不读取 credential/pepper，也不激活 recovery、scheduler、execution 或管理面。Operator 镜像仅增加固定版本 Docker CLI，仍不携带 daemon、Compose，也不常驻。Legacy root 在所有容器中均以只读方式挂载；脚本对演练前后的 `db/database.sqlite` 做 SHA-256 闭合校验。

成功时 `cutover-summary.json` 使用 `qinglong/local-alpha-upgrade-cutover-summary@v2`，必须同时绑定当前 `variant`、`targetEntrypoint=local-application|local-api`、`status=rollback_candidate`、`legacySource=unchanged` 与 `target=stopped`。两个合成容器会保持停止状态供审查，随后按脚本输出显式 `docker rm`；失败时脚本自动清理。该结果证明打包产物能够走通 controller 与 Docker 证据闭环，但不会停止用户真实 2.x 容器、执行 Legacy restart/rollback 或授权生产升级。

原生 amd64/arm64 的 headless 与 Console artifact job 都必须从将要上传的目录执行 exact `upgrade-cutover-rehearsal.sh`，检查 summary 和旧 SQLite 未变，并删除合成容器后才能上传；对应 gate 均为 `verification-evidence.json.gates.legacyUpgradeCutover=passed`。Console 的 fresh HTTP/credential/Task journey 仍是独立门：它证明真实 listener 和产品面可用，而无 listener 的 cutover probe 只证明 adopted entry 与 clean rollback，两者不能互相冒充。

### 写后 reconciliation capture

需要演练 target 接受业务写入后的失败关闭路径时，必须使用另一组全新 rehearsal/capture root 和容器名，并显式追加两个参数：

```sh
sh upgrade-cutover-rehearsal.sh \
  edge \
  /opt/qinglong/data \
  /opt/qinglong3-alpha-upgrade-reconciliation \
  <reviewed-sqlite-plan-digest> \
  <reviewed-data-directory-plan-digest> \
  ql3-alpha-reconciliation-legacy \
  ql3-alpha-reconciliation-target \
  --capture-after-write \
  /opt/qinglong3-alpha-reconciliation-capture
```

该模式在 target probe 已 active 后，通过既有 Owner `task.put` 产品入口提交固定的无网络/Secret Task，然后停止 target。只有 classifier 返回 `reconciliation_required` 才继续执行 `reconciliation-capture-prepare|commit|verify`。成功时：

- rehearsal root 写入 `reconciliation-capture-summary.json`，schema 为 `qinglong/local-alpha-upgrade-reconciliation-capture-summary@v1`；
- summary 固定 `status=reconciliation_captured`、`legacySource=unchanged`、`target=stopped`、`rollback=not_authorized` 与 `next=review_required`；
- 独立 capture root 保存 `<captureId>/{intent.json,manifest.json,receipt.json,assets/}`，必须作为包含数据库与配置材料的 owner-private 恢复资产保护；
- 两个容器保持 stopped 供人工核对，脚本不执行 Legacy restart、rollback、plan、review、application 或 completion。

该写入由短生命周期 Owner Operator 提交到 active target 的数据权威，不经过普通 Local API listener，因此只证明写后分类与 capture，不证明浏览器/生产流量接管。原生 artifact job 会先执行默认 clean rollback，再用同一 unchanged fixture 独立实跑本模式；`verification-evidence.json.gates.legacyUpgradeReconciliationCapture` 必须为 `passed`。

当前已闭合的 exact Console v9 阶段实物绑定源码 `0235973c9b54a2f22de09b6487ea9f184f0b8bfd` 与 [workflow run 33469435652](https://github.com/whyour/qinglong/actions/runs/33469435652)：amd64 artifact `9786301280`、arm64 artifact `9786374284`、双架构 milestone `9786520389`，均保留至 2026-10-01。两个原生架构在上传前分别完成 clean rollback、写后 capture 和 bundle offline audit；milestone finalizer 下载并再次审计两个 exact bundle。本机重新下载的 milestone v5 通过 `SHA256SUMS`，auditor 返回 `compatible=true`。这是 `3.0.0-alpha.2` 的隔离 Alpha 候选，不是 Public Release 或用户真实 2.x 数据的自动升级授权。

### 受审核的跨域应用、回滚与 completion

v11 bundle 在写后 capture 之外提供 `reconciliation-rehearsal.sh`。回滚链仍是三个命令；完成链在同一 `prepare`/`review` 之后增加两个独立决策点，不能一条命令自动跨越：

```sh
sh reconciliation-rehearsal.sh \
  prepare edge \
  /opt/qinglong3-alpha-upgrade-reconciliation \
  /opt/qinglong3-alpha-reconciliation-capture \
  /opt/qinglong3-alpha-reconciliation-work \
  Asia/Shanghai

sh reconciliation-rehearsal.sh \
  review edge \
  /opt/qinglong3-alpha-upgrade-reconciliation \
  /opt/qinglong3-alpha-reconciliation-capture \
  /opt/qinglong3-alpha-reconciliation-work \
  /opt/qinglong3-alpha-decisions/review/review.ndjson

sh reconciliation-rehearsal.sh \
  apply-rollback edge \
  /opt/qinglong3-alpha-upgrade-reconciliation \
  /opt/qinglong3-alpha-reconciliation-capture \
  /opt/qinglong3-alpha-reconciliation-work \
  /opt/qinglong3-alpha-decisions/automation/automation.ndjson \
  /opt/qinglong/data

# 完成链使用另一套全新 capture/reconciliation root：
sh reconciliation-rehearsal.sh \
  apply-plan edge \
  /opt/qinglong3-alpha-upgrade-reconciliation-completion \
  /opt/qinglong3-alpha-reconciliation-completion-capture \
  /opt/qinglong3-alpha-reconciliation-completion-work \
  /opt/qinglong3-alpha-completion-decisions/automation/automation.ndjson \
  /opt/qinglong3-alpha-completion-decisions/review/review.ndjson \
  /opt/qinglong/data

sh reconciliation-rehearsal.sh \
  complete edge \
  /opt/qinglong3-alpha-upgrade-reconciliation-completion \
  /opt/qinglong3-alpha-reconciliation-completion-capture \
  /opt/qinglong3-alpha-reconciliation-completion-work \
  /opt/qinglong3-alpha-completion-decisions/secret-config/secret-config.ndjson \
  /opt/qinglong3-alpha-completion-decisions/review/review.ndjson \
  /opt/qinglong/data
```

`prepare` 成功只会生成 bounded plan、私有诊断与 review prepare，并把 `summary.json.status` 置为 `operator_decision_required`。操作者必须审核完整事实集，在独立 `0700` 目录中自行生成唯一的 `0400|0600` canonical NDJSON；交付包不含决定生成器。`review` 消费该文件，以 60 秒 strong Owner authorization 提交并验证裁决，生成跨域 application plan 和 Automation row plan，然后停在 `automation_decision_required`。review 文件与 Automation 文件必须位于不同私有目录，目录中不得有其他文件。

`apply-rollback` 只消费外部 Automation row decision，并额外只读挂载原始 Legacy root。它在无网络、只读 rootfs、128 MiB、0.5 CPU、32 PID 的短生命周期 Operator 中应用已审核行、验证 Task/Trigger 投影、生成应用前 backup，再显式 rollback/verify。成功 summary 必须是 `reconciliation_automation_rolled_back`、`target=restored_to_pre_automation_snapshot`，并固定 `completion/targetRestart/legacyRestart=not_attempted`。本阶段不应用 Secret/Config、不修改 Run History、不完成 reconciliation，也不启动 target 或 Legacy。

`apply-plan` 必须同时重新提供原始 review decision；脚本不会从 reconciliation root 中复制或推断外部权限。它先保留 Automation apply，再以相同 review authority 对 Legacy/Target 的终态 Run History 做 append-only preservation/verify，随后生成 Secret/Config candidate plan 和 decision prepare，停在 `secret_config_decision_required`。该顺序是状态机约束：Run History preservation 不推进 head，而 Secret/Config plan 会推进 head，不能倒置。

操作者审核 Secret/Config plan 后，在第三个独立 `0700` 父目录中提供唯一 decision 文件。`complete` 才会提交并验证这些决定、加密应用 active binding/disabled preservation，再以 completion v3 同时绑定 Automation apply、Secret/Config apply 和 Run History preservation。成功 summary 必须是 `reconciliation_completed`、`adapterCount=3`，且 target/Legacy 仍为 stopped，`targetRestart/legacyRestart=not_authorized`。重启需要后续独立 authority ceremony。

每个 decision 父目录必须由当前 UID 控制、mode `0700`、恰好包含一个 `0400|0600` canonical regular file，并与 rehearsal/capture/reconciliation/Legacy roots 全部不重叠。review、Automation、Secret/Config decision 不得放在同一个父目录。交付包只消费决定，不生成决定；仓库内合成 fixture/generator 不进入 Trial Kit。

命令文件和成功结果支持中断后的 exact replay：脚本只在首次创建带时间 command，输出先写临时文件，成功后原子发布。不要编辑或删除 reconciliation root 中的 authorization、intent、plan、decision、backup、receipt 或 result；任何 digest、权限、路径或 lineage 漂移都应失败关闭。

仓库 CI 会保留两条互相独立的合成链：第一条实跑 apply→verify→rollback→verify；第二条保持完整 2.x schema、空 Apps/Auths 且无未知插件表，实跑 Automation→Run History→Secret/Config→completion。两个 required gate 分别是 `legacyUpgradeReconciliationAutomationRollback=passed` 与 `legacyUpgradeReconciliationCompletion=passed`。空 Legacy Apps/Auths 只作为无数据 catalog evidence；任一真实 identity 行仍阻塞 completion。Local milestone v7 绑定两个架构各自的 `upgradeReconciliationRehearsalSha256`；只有同 run finalizer 重新下载、审计并闭合两个 bundle 后才是 D-426c3 阶段实物。

## 手工加载与最小 smoke

从 `manifest.json.archive.file` 找到 archive 后加载：

```sh
docker load --input qinglong3-local-trial-kit-<arch>.docker.tar
# Console 变体使用 qinglong3-local-console-trial-kit-<arch>.docker.tar
```

以 manifest 中 `images.application.reference` 和 `images.operator.reference` 为准，分别核对 `docker image inspect` 返回的 image ID。然后执行无网络、只读 smoke：

```sh
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges \
  <application-image> --help

docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges \
  <operator-image> --version

docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges \
  <operator-image> setup --help
```

## Fresh 试运行边界

完整 fresh setup、首 Owner ceremony、Owner presentation 安装、Application active、SIGTERM drain、SQLite integrity 和原生 cancellation 必须在 `verification-evidence.json` 指向的同架构 milestone job 中验证。Console 还必须证明首页返回 200、未认证 API 返回 401，并用真实 Owner credential 完成 Task read、fenced start、`succeeded` 终态与 bounded log marker。v11 artifact job 必须从将要上传的目录实际执行 `quickstart.sh`、read-only `upgrade-readiness.sh`、isolated `upgrade-cutover-rehearsal.sh` 的 clean/write-after 路径，以及独立的 Automation rollback 和三 adapter completion 两条 reconciliation 流；并完成 graceful stop、rollback-candidate、capture、全部外部 decision、旧 SQLite 未变与合成容器清理。实际部署时仍必须使用独立目录，并让 operator 以最终数据文件 POSIX owner 的 UID/GID 运行；operator 默认无网络且每次只执行一个命令后退出，不应作为 sidecar 或 daemon 常驻。

Edge 的验证上限为 Application 128 MiB、0.5 CPU、64 PID；Standalone 为 256 MiB、0.5 CPU、256 PID；operator 为 128 MiB、0.5 CPU、32 PID。这里的数值是试运行门，不是所有 workload 的容量承诺。

停止并删除 Alpha 容器即可回退 fresh 测试环境。若触碰 2.x 数据或进行迁移，必须使用项目既有 reconciliation/cutover/rollback 流程，不能只替换镜像。
