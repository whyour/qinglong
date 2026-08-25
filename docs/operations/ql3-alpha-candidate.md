# QingLong 3.0 阶段性 Alpha 候选产物

该产物回答“当前源码是否已经形成可下载、可验证、可试运行的阶段成果”。它不是公开 release、不可变 GHCR digest 或生产升级承诺，也不能替代正式 release-set、签名、catalog、部署锁和回退门。

## 产物等级

| 等级 | 面向对象 | 必须通过 | 当前用途 |
| --- | --- | --- | --- |
| Local Alpha Candidate | amd64/arm64 路由器、NAS、单机 | OS 漏洞策略、SBOM 与镜像库存复核、128 MiB entrypoint、Edge/Standalone fresh SQLite lifecycle、真实本机 API cancellation | 下载 Docker archive，核验后进行隔离试运行与设备兼容测试 |
| Cluster Integration Candidate | amd64/arm64 集群测试节点 | OS 漏洞策略、SBOM 与镜像库存复核、non-root identity；Admin 额外通过产品 facade smoke | 导入隔离 registry/测试节点，进行多组件集成；不作为 production HA release |
| Public Release Set | 生产用户 | 受保护 tag、五镜像 multi-arch digest、签名/attestation、私有发布证据、catalog、Local/Cluster 部署与回退闭环 | 尚未实际发布；只能由受保护 release workflow 生成 |

只有第一等级可以称为本阶段“用户可试运行产物”。Cluster archive 是工程集成产物，因为离线 per-architecture tag 不满足正式 Kubernetes deployment-lock 的 GHCR immutable digest 与 catalog provenance。

## 生成

在 GitHub Actions 手动运行 `QingLong 3.0 CI`，选择目标 `next` 提交并设置 `produce_alpha_artifacts=true`。普通 push/PR 不上传大镜像，避免每次开发提交都制造伪里程碑和额外存储成本。

成功后同一次 run 生成、保留 30 天：

- `ql3-alpha-<commit>-local-amd64` 与 `ql3-alpha-<commit>-local-arm64`；
- `ql3-alpha-<commit>-control-<arch>`、`control-ai-<arch>`、`admin-<arch>`、`worker-<arch>`。

每个 artifact 含：

- 通过对应测试的 native Docker archive；
- `manifest.json`，绑定版本、完整 source commit、架构、原始 image tag、image ID、archive SHA-256 与已通过 gate；
- 与实际只读镜像 inventory 对账过的 CycloneDX SBOM；
- 本说明。

任何 required job 失败时不上传对应产物。artifact 名和 archive 内的 `ci-*` tag 都表示 commit-bound candidate，不能改名后冒充 `v3.x` release。

## 下载后验证与最小 smoke

在同架构 Linux Docker 主机上进入解压后的 artifact 目录：

```sh
archive="$(find . -maxdepth 1 -name '*.docker.tar' -type f -print -quit)"
expected="$(node -p "require('./manifest.json').archiveSha256")"
actual="sha256:$(sha256sum "${archive}" | cut -d ' ' -f 1)"
test "${actual}" = "${expected}"

docker load --input "${archive}"
image="$(node -p "require('./manifest.json').image")"
expected_id="$(node -p "require('./manifest.json').imageId")"
test "$(docker image inspect --format '{{.Id}}' "${image}")" = "${expected_id}"
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges "${image}" --help
```

下载页本身不是 source identity；还必须把 `manifest.json.sourceRevision` 与预期 `next` commit 对齐。不要在生产数据库、生产 Secret 或 2.x 唯一数据目录上直接试用。

## 试运行与回退边界

Local 正式部署仍应遵循 [Edge/Standalone 部署准备](./ql3-local-deployment.md)，先做 fresh 私有目录/数据库/Owner authority，再执行受审配置、preflight 和 rollout。Alpha Docker archive 只替代“待测镜像来源”，不会替操作者生成 pepper、credential、数据库备份或 2.x cutover evidence。

阶段试运行必须使用独立目录和独立数据库；回退的最低保证是停止并删除 Alpha 容器、保留测试目录用于诊断，然后回到未被修改的 2.x 实例。凡是执行 2.x→3.0 数据迁移或 3.0 写入后切回，都必须走既有 reconciliation/cutover/rollback ceremony，不能只换镜像。

Cluster candidate 必须先导入隔离 registry 并重新绑定该 registry 的 immutable digest。当前 archive 不带 public catalog、签名或正式 deployment selection；生产 Kubernetes、CloudNativePG HA、跨主机 STONITH/DR、CSI custody 和外部 IdP 不在此阶段产物的声明范围内。

## 里程碑判定

一次阶段里程碑只有同时记录以下事实才成立：源码 commit、版本、两种 Tier-1 架构所需产物、完整 CI run、artifact 名与 digest、至少一个目标 Profile smoke、已知限制和回退路径。仅有源码、`dist/`、单元测试数字、Dockerfile 或“理论上可构建”都不算阶段性可用产物。
