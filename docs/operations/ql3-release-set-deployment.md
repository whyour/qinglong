# QingLong 3.0 release-set 部署准入

生产部署的镜像 authority 是成功 `ql3-image-release.yml` 运行产生的
`ql3-release-set-<version>-<scope>` artifact，不是可变 version/source tag。下载后先验证该 JSON 的 GitHub file
provenance，确认 repository、source tag、source revision 与目标发布一致，再从 `images[].reference` 读取完整
`ghcr.io/<owner>/<repository>@sha256:<digest>`。

## 选择 scope

| 部署类型 | release scope | 必须出现的镜像 |
| --- | --- | --- |
| 低配路由器、Edge、Standalone | `local` | `local` |
| Kubernetes/Cluster | `cluster` | `control`、`control-ai`、`worker`、`admin` |
| 同时发布两族 | `all` | 上述五个镜像 |

Local 用户不需要下载 Cluster 镜像，也不依赖 CloudNativePG 或 Worker 私有发布证据。Cluster 运维者不能拿 Local
image 的证明替代任一角色镜像；尤其 Worker 与短生命周期 Admin 必须有各自 digest。

## 准入检查

1. 只接受来自成功、未重跑替换的同一 release workflow attempt 的 artifact，并验证 release-set 文件
   provenance。
2. `schema` 必须为 `qinglong/release-set@v1`；`release.version`、`release.sourceRef`、
   `release.sourceRevision`、`release.scope` 必须与变更单一致。
3. 镜像集合必须与上表精确相等；每个 `reference` 必须是 digest reference，且 owner/repository 与部署目标一致。
4. Kubernetes overlay 用 `newName` 加 digest 或等价的 immutable image reference；不得把生产 placeholder 改成
   `newTag`。Local compose/rollout 同样固定 `@sha256:`。
5. rollout 前再次向 registry 解析 version/source tag。它们可以用于发现，但只有解析到 release set 的同一
   digest 才算一致；部署仍以 digest 为准。

## 发布失败与恢复

GHCR 不提供跨 repository tag 事务，release set 明确记录 `crossRepositoryAtomicity=false`。如果 promotion 中途
失败，不删除已经正确的 tag，也不重新构建镜像。使用原 source tag/revision 重跑 release workflow：它会先验证
每个 source digest 和既有 tag；既有 tag 指向同一 digest 时继续，指向其他 digest 时立即失败。只有最终
release-set artifact 和 provenance 都生成后，才能宣布该 deployment family 可部署。

workflow artifact 当前保留 90 天，因此长期归档属于 release owner 的外部职责。进入稳定 GA 前，应把经验证的
release-set 同步到不可变、保留期满足组织策略的发布档案；同步过程不得改写 JSON。
