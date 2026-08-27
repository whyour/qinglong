# QingLong 3.0 Local Alpha Trial Kit

本目录是绑定一个 QingLong 3.0 源码提交、一个 Linux 架构和一次显式 GitHub milestone run 的阶段试运行套件，不是公开 release 或生产升级承诺。它同时包含常驻 Application 镜像和短生命周期 operator 镜像；两者共享的 OCI layer 只在同一个 Docker archive 中保存一次。

一套 Trial Kit 只有被同一 run 的 `ql3-alpha-<sourceRevision>-local-milestone` 跨架构索引收录后才是可交付阶段产物。单个矩阵 job 提前上传、另一架构或完整 CI 随后失败时留下的 artifact 只是中间文件。先按 milestone `manifest.json` 选择本机架构并核对本 bundle manifest digest，再执行下述离线验收。

## 适用范围

- `amd64` 或 `arm64` Linux Docker 主机；
- 低配路由/NAS 的 Edge profile，或资源较充足单机的 Standalone profile；
- fresh、隔离的测试数据目录；
- 离线导入、设备兼容验证和 3.0 Alpha 用户旅程验证。

不要把它直接用于生产数据、2.x 唯一数据目录或生产 Secret。Cluster/Kubernetes 节点应使用 Cluster Integration Candidate；本套件不包含 PostgreSQL HA、Worker 或 Cluster Admin。

## 离线验收

先在解压目录中执行不依赖 Node.js 的文件校验：

```sh
sha256sum --check SHA256SUMS
```

`manifest.json` 必须满足：

- `schema` 为 `qinglong/alpha-local-trial-kit@v2`；
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

## 加载与最小 smoke

从 `manifest.json.archive.file` 找到 archive 后加载：

```sh
docker load --input qinglong3-local-trial-kit-<arch>.docker.tar
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

完整 fresh setup、首 Owner ceremony、Application active、SIGTERM drain、SQLite integrity 和原生 cancellation 必须在 `verification-evidence.json` 指向的同架构 milestone job 中验证。实际部署时仍必须使用独立目录，并让 operator 以最终数据文件 POSIX owner 的 UID/GID 运行；operator 默认无网络且每次只执行一个命令后退出，不应作为 sidecar 或 daemon 常驻。

Edge 的验证上限为 Application 128 MiB、0.5 CPU、64 PID；Standalone 为 256 MiB、0.5 CPU、256 PID；operator 为 128 MiB、0.5 CPU、32 PID。这里的数值是试运行门，不是所有 workload 的容量承诺。

停止并删除 Alpha 容器即可回退 fresh 测试环境。若触碰 2.x 数据或进行迁移，必须使用项目既有 reconciliation/cutover/rollback 流程，不能只替换镜像。
