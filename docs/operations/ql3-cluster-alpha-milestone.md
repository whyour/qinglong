# QingLong 3.0 Cluster Alpha Integration Milestone

本目录是一次完整 Cluster Alpha integration milestone 的闭合索引，不包含八个大体积 Docker archive。`manifest.json` 精确列出同一次 GitHub Actions run 生成并离线复核的 control、control-ai、admin、worker 在 amd64、arm64 上的八个 artifact。只有该索引和目标 artifact 同时存在，才可把这次运行称为阶段性 Cluster 集成产物。

## 成熟度边界

- `maturity` 固定为 `cluster_integration_candidate_not_public_release`；
- 适用于隔离 registry、临时 Kubernetes/K3s 节点和非生产数据库上的集成验证；
- 不提供公开 GHCR tag、不可变 catalog selection、Cosign 签名、GitHub attestation、生产 HA、升级或长期支持承诺；
- 低配路由器/NAS 应选择 Local Alpha Trial Kit，不能部署四个 Cluster 角色。

任何单角色或单架构 artifact 提前上传都只是中间文件。缺少 `ql3-alpha-<sourceRevision>-cluster-milestone`、完整 CI 未成功、run/attempt 不一致或索引审计失败时，不得作为阶段交付物。

## 选择并验证下载物

1. 在本目录执行 `sha256sum --check SHA256SUMS`。
2. 确认 `manifest.json`：
   - schema 为 `qinglong/alpha-cluster-milestone@v1`；
   - `sourceRevision` 为目标完整 40 位提交；
   - workflow event/job 为 `workflow_dispatch` / `cluster-alpha-milestone`；
   - 对应 run ID/attempt 的完整 `QingLong 3.0 CI` 成功；
   - `artifacts` 恰好包含四角色乘两架构的八项。
3. 按节点架构和需要的角色下载 artifact；一个可运行的完整 Cluster 测试部署通常需要 control、admin、worker，启用 AI 才增加 control-ai。
4. 对每个 bundle 执行其 `SHA256SUMS`，并核对 bundle `manifest.json` 的 digest 等于 milestone `bundleManifest.sha256`。
5. 使用隔离 registry 导入 Docker archive，再以导入后的 immutable digest 更新测试 deployment lock；不要直接依赖 archive 内的 `ci-*` tag。

持有同版本源码与 Node.js 24 时可离线复审：

```sh
node scripts/ql3-cluster-alpha-milestone.cjs \
  --mode=audit \
  --milestone=/absolute/path/to/ql3-alpha-cluster-milestone

node scripts/ql3-cluster-alpha-bundle.cjs \
  --mode=offline-audit \
  --bundle=/absolute/path/to/one-cluster-bundle
```

这两个命令不访问 Docker 或网络；它们验证闭合文件集、长度、SHA-256、SBOM identity、workflow evidence、角色/架构集合和八个主体互不复用。它们不会重新执行漏洞扫描或 Kubernetes live gate。

## 部署与回退

Cluster candidate 只应进入临时命名空间、隔离 registry 和可删除数据库。回退方式是删除测试 workload 与测试数据、撤销临时 credential，并回到原 deployment lock。生产 CloudNativePG、跨主机 STONITH/DR、CSI custody、外部 ingress TLS/IdP 和正式升级仍必须由 Public Release Set 的 catalog-bound deployment ceremony 证明。
