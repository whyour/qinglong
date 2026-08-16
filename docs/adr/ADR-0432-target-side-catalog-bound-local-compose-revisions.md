# ADR-0432：目标侧 Catalog-bound Local Compose 修订

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-339、D-340
- 关联 ADR：ADR-0199、ADR-0200、ADR-0431

## 上下文

ADR-0431 已让可信工作站从完整 catalog consumption bundle 生成 catalog-bound Local v2 selection，
但 Local prepare/upgrade 入口仍接收裸 `image`。运维者必须手工复制 `service.image`，目标侧的 Compose revision v1
也只保存 image、generation 与 mutation。结果是 release-set、catalog manifest、consumption report、workflow identity
和 immutable catalog reference 在最后一跳被丢失；一个格式正确的任意 digest 可以绕开已经完成的 catalog 证据链。

把 Cosign、GitHub CLI、regctl、Kustomize 或完整 release bundle audit 下沉到低配路由器，会显著扩大磁盘、内存、网络、
凭据与更新面。让发布验真成功后自动 rollout 又会混合 input authority 与 action authority。

## 决策

1. 现有 `@qinglong/local-owner-cli` 内部增加目标侧 Local selection consumer，不新增 workspace package 或生产依赖。
   Compose prepare 与 upgrade 删除裸 `image` 输入，改为 exact `releaseSelection.path + expectedSelectionDigest`；旧输入失败关闭。
2. selection 必须是 absolute normalized path，父目录为 canonical/current-UID `0700`，文件为 canonical/current-UID、单链接
   `0600`、最大 64 KiB。consumer 通过 `O_NOFOLLOW` stable descriptor 有界读取 UTF-8 canonical JSON，并在读取前后复验
   identity/size/timestamp。
3. 目标侧重新验证 `qinglong/local-compose-release-image@v2` exact shape/self-digest、3.x release/tag/revision、`local|all`
   scope、release-set/catalog digest 闭包、exact image-release workflow identity、immutable catalog reference、唯一
   `ghcr.io/<owner>/qinglong3-local-application@sha256:...` 和 explicit root policy。命令提供的 expected selection digest 是
   本次目标部署的本地 operator authority；目标机不伪称重放网络签名或 provenance verifier。
4. Compose image selection 升为 `qinglong/local-compose-image-selection@v2`。每个 immutable revision 持久保存 image 以及
   selection/release-set/catalog manifest/catalog report digest、release identity、catalog schema/source/workflow/immutable
   reference、discovery tag non-authority 与 root policy；核心 digest 同时进入 container labels。
5. upgrade 从已验证的 selection 取得完整 release authority；rollback 从目标 immutable revision 复制完整 authority，不能只复制
   image。Preflight、Apply、Restore、Evidence collection 与 durable status 继续通过同一 active/revision parser 验证 v2 canonical
   binding。
6. prepare/upgrade 只发布 revision，不访问 registry/GitHub，不启动容器、不调用 Compose up、不修改数据库。Preflight 与 Apply
   保持独立、显式命令，因此可信 selection 不会自动获得 rollout authority。

## 部署与资源影响

- 不新增 package、生产依赖、数据库、migration、SQL、Pool、Pod、controller、CRD、RBAC、listener、timer 或 watcher。
- 低配路由器每次显式 prepare/upgrade 只增加一次最多 64 KiB 的私有文件读取、JSON 校验和 SHA-256；没有后台 CPU、内存或网络开销。
- Cluster/Kubernetes lock 路径不变；本决策只闭合 Local/Compose 最后一跳。
- v2 revision 比 v1 多约 2 KiB provenance 文本。revision 数量仍由既有显式 evidence collection/保留策略约束。

## 兼容与恢复

- QingLong 3.0 尚未正式发布，不保留 v1 裸 image 旁路。已有孵化环境必须用原 catalog-bound selection 重新 prepare；不要手改
  `compose.image.yaml` 或 revision。
- command/selection 必须作为恢复证据保留。响应丢失时原样重放同一 command、path 与 expected digest；任何 selection byte、权限、
  parent、root policy 或 catalog binding 漂移都在 deployment mutation 前失败。
- revision 切换后的 rollout 失败继续使用既有 generation CAS 和 roll-forward rollback；rollback revision 保留原目标 release 来源。

## 被拒绝的替代方案

### 继续手工复制 `service.image`

拒绝。它在最后一跳重新引入无法机器证明来源的开放字段，使 ADR-0431 的 catalog binding 只停留在工作站文件中。

### 在目标机重新运行完整 catalog ceremony

拒绝。低配设备不应承担 registry/GitHub 凭据、外部二进制、网络和完整 bundle 成本；在线验真仍属于可信工作站。

### 验证 selection 后自动 Apply

拒绝。输入可信不等于变更获批；revision preparation、Docker preflight 与 rollout 必须保持不同 authority。

### 新建一个 selection-consumer package

拒绝。该能力只服务现有 Local deployment Compose 边界；拆包会制造单一消费者和浅 package，而不会形成可独立部署的职责。

## 验证

- Local deployment 定向契约 30/30，覆盖 Prepare、Upgrade、Rollback、response-loss、Preflight、Apply、Restore、Evidence
  collection、Status，以及 raw image、expected digest、权限、mutable image 和 catalog/release-set 漂移的
  mutation-before-failure；物理 Edge Compose storage 契约 6/6；
- Local Owner 全量 171 项为 166 pass/5 条件 skip/0 fail；backend 1,317 项为 1,315 pass/2 条件 skip/0 fail；18-package
  clean build/test 退出 0。workspace 保持 18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；
- 10 项架构/部署审计和 14 档 Local artifact 全部 compatible；默认 Edge/Standalone 制品保持
  2,589,890/2,589,968 bytes，application 为 3,632,769/3,632,889 bytes，MCP 为 7,315,930/7,316,038 bytes；Cluster
  Admin exact dry-run pack 为 250 files、271,238-byte tarball、1,690,196-byte unpacked；
- PostgreSQL 18.6 arm64 physical HA 重新通过 142/142、timeline `1→2`，报告 SHA-256 为
  `07c914551ec700da26b42cd42760ccb3b28ad31266a8bae5f62dee38eb97e6a9`；离线审计通过且无 `ql3-ha-*` Docker 资源残留；
- live rollout 使用明确标记的临时 synthetic selection，只测试镜像/Compose 兼容性，不冒充公开 catalog ceremony。完整结果
  同步记录在 QL-RFC-0001 D-340。
