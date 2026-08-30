# ADR-0522：内容绑定的离线 Docker Adopted Target

- 状态：Accepted（D-426b 源码候选；阶段实物尚未闭合）
- 日期：2026-08-30
- 决策：D-426b1

## 上下文

D-426a 已交付可下载、可校验、可执行 reviewed side-by-side stage 的双架构 Trial Kit，但其 Docker archive 只含本地 image reference 与 Docker content ID，不具备 registry `RepoDigest`。既有 target-start 契约只接受 `name@sha256:...`，因此下载产物虽然能完成 stage，却不能诚实创建并启动 adopted target。把本地镜像伪装成 GHCR digest，或为 Alpha branch 伪造 release catalog/tag provenance，都会破坏正式 Compose 发布链。

## 决策

目标镜像权威统一为 exact `targetImage`：

- `registry-digest`：reference 必须是不可变 `name@sha256:...`；
- `local-image-id`：reference 只允许有界本地 tag，并必须来自同一 Trial Kit；
- 两种权威都必须携带 `sha256:...` Docker content ID。

target start/restart/stop 与 Legacy rollback 共享这一不可变对象。容器证据同时核对 `Config.Image` reference 和 `.Image` content ID；journal 中的镜像 digest 绑定 authority/reference/imageId 三者。content ID 漂移不会启动容器，而是收敛到 `manual_required`。

adopted bundle 增加 `docker-target` service kind，生成 `service/docker-target.json` 与 Application v4 config。descriptor 固定 numeric UID:GID、`restart=no`、无网络、read-only rootfs、drop ALL、no-new-privileges、Profile memory/PID 上限、deployment root 可写 mount 和 legacy source 只读 mount。它只准备创建材料，不创建或启动容器，也不授予 cutover。

正式 Compose 继续只接受 catalog-bound GHCR digest selection；systemd/OpenRC 不接收 Docker image authority。没有新增 workspace package、生产依赖、daemon、listener、timer、watcher、队列或稳态资源。

## 阶段实物门

本 ADR 当前只是源码候选，不得称为已交付的 D-426b 阶段实物。只有后续同源原生 amd64/arm64 artifact job 在将要上传的 exact Trial Kit 上完成受认证 transform/apply、生成并验证 `docker-target.json`、真实 target start/stop，并得到 clean `rollback_candidate`，再由 bundle/milestone auditor 闭合，才能把状态升级为“阶段实物已交付”。

在此之前，用户可继续使用 D-426a 的 `upgrade-rehearsal.sh` 完成 read-only legacy + side-by-side stage；不得从本 ADR 推导生产切换授权。

## 后续

D-426b2 接入受认证 transform/apply、descriptor 消费、真实 target start/stop 与 clean rollback candidate；D-426c 处理 target 写入后的 `reconciliation_required`。Public prerelease/release 仍需维护者显式授权。
