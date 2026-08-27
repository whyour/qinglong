# QingLong 3.0 Alpha 阶段交付索引

本目录是一次 `alpha_artifact_scope=all` 运行的最外层交付入口。它把同一源码、同一 GitHub Actions run/attempt 的 Local Alpha milestone 与 Cluster Alpha milestone 绑定起来，并为 Edge、Standalone 与 Cluster 部署者给出机器可读的最小下载选择。它不是正式 release catalog，也不包含 Docker archive。

## 先判断设备类型

| 设备或环境 | 选择 | 稳态组件 | 需要下载 |
| --- | --- | --- | --- |
| 低配路由器、NAS、单机 | `deploymentSelections.local`；默认选择 `headless`，需要浏览器操作面时显式选择 `console` | 仅 Local Application；Operator 只在 setup/upgrade/recovery 短暂运行 | 目标架构、目标 variant 的一个 Local Trial Kit |
| 临时 K3s/Kubernetes 集群 | `deploymentSelections.cluster` | control、admin、worker；AI 按需增加 control-ai | 目标架构的三个 required artifact；需要 AI 时再下载 optional artifact |

不得把四个 Cluster 角色部署到低配路由器，也不需要为一台 amd64 主机下载 arm64 归档。索引固定列出十个可选择 artifact，但每个部署者只下载目标 Profile、架构和角色所需的子集。

## 验证

1. 在本目录运行 `sha256sum --check SHA256SUMS`。
2. 检查 `manifest.json`：
   - schema 为 `qinglong/alpha-stage-index@v2`；
   - `deploymentSelections.local.variant` 与 Local milestone、artifact 名和 Profile 一致；
   - maturity 为 `alpha_stage_delivery_not_public_release`；
   - source revision、run ID/attempt 是准备验证的显式 workflow run；
   - `milestones.local` 与 `milestones.cluster` 分别指向同一提交的 milestone artifact。
3. 下载两个 milestone 小索引，比较各自 `manifest.json` 的长度与 SHA-256 是否等于本索引的记录。
4. 按 `deploymentSelections` 下载目标大归档，再按对应 milestone 和 bundle README 逐层执行 checksum 与离线审计。

持有同一版本源码与 Node.js 24 时，可以一次复审三层索引：

```sh
node scripts/ql3-alpha-stage-index.cjs \
  --mode=audit \
  --stage=/absolute/path/to/stage-index \
  --local-milestone=/absolute/path/to/local-milestone \
  --cluster-milestone=/absolute/path/to/cluster-milestone
```

该命令拒绝跨 source、version、run/attempt 混用，重新执行两个 milestone auditor，并核对 milestone manifest digest 与部署选择。它不访问 Docker 或网络，也不会重新执行漏洞扫描、真实用户旅程或 Kubernetes live gate。

## 成熟度和回退边界

本索引只证明一次显式 Alpha 运行同时形成了两个部署档位的闭合候选物。Local 仅供 fresh、隔离、非生产目录试用；Cluster 仅供隔离 registry、临时命名空间和可删除数据库集成。它不提供受保护 tag、公开 GHCR immutable digest、签名、attestation、生产 deployment lock、HA、升级或长期支持承诺。

Local 回退是停止并删除 Alpha 容器和 fresh 测试目录；Cluster 回退是删除临时 workload、测试数据和 credential，并恢复原 deployment lock。任何 2.x 数据迁移或生产写入仍必须走正式 cutover/reconciliation/rollback ceremony。
