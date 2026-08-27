# QingLong 3.0 Local Alpha Milestone

本目录是一次完整 Local Alpha milestone run 的跨架构闭合索引。它本身不包含大体积 Docker archive；`manifest.json` 精确列出同一次 GitHub Actions run 生成并重新审计的 amd64、arm64 Trial Kit artifact。只有该索引 artifact 与对应架构 Trial Kit 同时存在时，才能把那次运行称为阶段性可下载 Local Alpha。

## 成熟度边界

- `maturity` 固定为 `alpha_candidate_not_public_release`；
- 适用于 fresh、隔离、非生产数据上的 Edge/Standalone 试运行；
- 不提供公开 GHCR tag、Cosign 签名、GitHub attestation、catalog、生产升级或长期支持承诺；
- Cluster/Kubernetes 仍按独立 Integration Candidate 与 Public Release Set 门验收。

单个架构 artifact 提前上传并不代表 milestone 成功。没有 `ql3-alpha-<sourceRevision>-local-<variant>-milestone` 索引、索引 workflow 不是成功终态、run/attempt/variant 不一致或索引审计失败时，已有的大归档只能作为失败运行的中间文件，不得交付用户。

## 选择并验证下载物

1. 对本目录执行：

   ```sh
   sha256sum --check SHA256SUMS
   ```

2. 打开 `manifest.json`，确认：
   - `schema` 为 `qinglong/alpha-local-milestone@v2`；
   - `variant` 为 `headless` 或 `console`，且两个架构记录都使用同一变体；
   - `sourceRevision` 是准备试用的完整 40 位提交；
   - `workflow.event` 为 `workflow_dispatch`，`workflow.job` 为 `local-alpha-milestone`；
   - GitHub Actions 中对应 `runId/runAttempt` 的整条 `QingLong 3.0 CI` 为成功终态；
   - `artifacts` 恰好包含 `amd64` 与 `arm64`。
3. 根据主机架构下载 `artifacts.<architecture>.artifactName` 指向的 Trial Kit。
4. 对 Trial Kit 先执行其 `SHA256SUMS`，再确认其中 `manifest.json` 的 SHA-256 与 milestone 的 `bundleManifest.sha256` 完全一致。
5. 按 Trial Kit 自带 `README.md` 完成 Docker archive 加载、镜像 ID 对账和受限资源 smoke。

若持有同一版本源码与 Node.js 24，可额外审计 milestone 索引：

```sh
node scripts/ql3-local-alpha-milestone.cjs \
  --mode=audit \
  --milestone=/absolute/path/to/ql3-alpha-local-milestone
```

该命令验证索引目录的闭合文件集、checksum、双架构记录、镜像主体分离和 workflow identity。对应架构 Trial Kit 仍必须使用它自己的离线 auditor；索引审计不会重新执行 Docker、漏洞扫描或真实用户旅程。

## 运行与回退

实际运行只需要匹配主机架构的一套 Trial Kit，不需要同时下载另一架构。低配路由器稳态只运行 Local Application；Operator 只在 setup、upgrade 或 recovery 动作期间短暂运行。停止并删除 Alpha 容器及 fresh 测试目录即可回退，不能把本套件直接指向 2.x 唯一数据目录。
