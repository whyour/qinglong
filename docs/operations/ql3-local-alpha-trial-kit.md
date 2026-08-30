# QingLong 3.0 Local Alpha Trial Kit

本目录是绑定一个 QingLong 3.0 源码提交、一个 Linux 架构和一次显式 GitHub milestone run 的阶段试运行套件，不是公开 release 或生产升级承诺。它同时包含常驻 Application 镜像和短生命周期 operator 镜像；两者共享的 OCI layer 只在同一个 Docker archive 中保存一次。

一套 Trial Kit 只有被同一 run 的 `ql3-alpha-<sourceRevision>-local-<variant>-milestone` 跨架构索引收录后才是可交付阶段产物。单个矩阵 job 提前上传、另一架构或完整 CI 随后失败时留下的 artifact 只是中间文件。先按 milestone `manifest.json` 选择 `variant` 和本机架构并核对本 bundle manifest digest，再执行下述离线验收。

## 适用范围

- `amd64` 或 `arm64` Linux Docker 主机；
- 低配路由/NAS 的 Edge profile，或资源较充足单机的 Standalone profile；
- fresh、隔离的测试数据目录；
- 离线导入、设备兼容验证和 3.0 Alpha 用户旅程验证。

`headless` 是默认且最小的低配设备变体，不打开端口。`console` 是显式选择的 Linux-only 变体，携带离线 Web Console，并仅通过宿主 `127.0.0.1:5700` 提供操作面。二者是独立 archive，不应同时下载；远程 Console 只允许经 SSH tunnel 访问，不得暴露到 LAN 或公网。

不要把它直接用于生产数据、2.x 唯一数据目录或生产 Secret。Cluster/Kubernetes 节点应使用 Cluster Integration Candidate；本套件不包含 PostgreSQL HA、Worker 或 Cluster Admin。

## 离线验收

先在解压目录中执行不依赖 Node.js 的文件校验：

```sh
sha256sum --check SHA256SUMS
```

`manifest.json` 必须满足：

- `schema` 为 `qinglong/alpha-local-trial-kit@v7`；
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

v6 bundle 内的 `quickstart.sh` 不依赖宿主 Node.js、jq 或 Compose，只需要 POSIX
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
`http://127.0.0.1:5700/`；远程主机必须建立 SSH tunnel。两种变体都只用于 fresh Alpha，
不是 2.x Web UI 的生产替代版本。Console 能力和凭据边界见
[Local Web Console](./ql3-local-web-console.md)。

Console quickstart 还会通过 strong local operator 创建一个默认不自动运行的
`alpha-first-automation`。在页面输入 `owner-credential.json` 中的 token，选择该 Task，
核对 revision/content digest 后显式运行；它只执行 `/bin/echo` 固定标记，不使用网络、
SecretRef 或 Trigger。D-420 后选择该 Run 还会经既有 `artifact.read` 权限链展示 latest
Attempt 首个 32 KiB 日志；后续内容继续使用 API 分页，页面不会自动轮询或下载整份日志。
headless 不创建示例 Task，因此低配默认档没有示例数据或稳态开销。

## 只读检查现有 2.x 升级就绪度

v6 bundle 还包含 canonical `upgrade-readiness.sh`。它让现有部署用户先回答“这份 2.x SQLite 和完整 data directory 是否能形成可审核
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

artifact job 必须在原生 amd64/arm64 上使用生产形态 2.x fixture 运行将要上传的 exact `upgrade-readiness.sh`，两个正式 Operator 结果都为
`inspected` 后才能记录 `verification-evidence.json.gates.legacyUpgradeReadiness=passed` 并上传。该证明仍不是用户实际磁盘、停机窗口、I/O 峰值或
生产数据内容兼容性承诺。

## 受审核计划的 Side-by-side 暂存

审核上一节两个完整结果后，把其中 exact `evidence.planDigest` 作为显式参数交给 v7 bundle 的 canonical `upgrade-rehearsal.sh`：

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

完整 fresh setup、首 Owner ceremony、Owner presentation 安装、Application active、SIGTERM drain、SQLite integrity 和原生 cancellation 必须在 `verification-evidence.json` 指向的同架构 milestone job 中验证。Console 还必须证明首页返回 200、未认证 API 返回 401，并用真实 Owner credential 完成 Task read、fenced start、`succeeded` 终态与 bounded log marker。v7 artifact job 必须从将要上传的目录实际执行 `quickstart.sh`、read-only `upgrade-readiness.sh` 和 reviewed-plan `upgrade-rehearsal.sh`，并完成 graceful stop。实际部署时仍必须使用独立目录，并让 operator 以最终数据文件 POSIX owner 的 UID/GID 运行；operator 默认无网络且每次只执行一个命令后退出，不应作为 sidecar 或 daemon 常驻。

Edge 的验证上限为 Application 128 MiB、0.5 CPU、64 PID；Standalone 为 256 MiB、0.5 CPU、256 PID；operator 为 128 MiB、0.5 CPU、32 PID。这里的数值是试运行门，不是所有 workload 的容量承诺。

停止并删除 Alpha 容器即可回退 fresh 测试环境。若触碰 2.x 数据或进行迁移，必须使用项目既有 reconciliation/cutover/rollback 流程，不能只替换镜像。
