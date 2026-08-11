# QingLong 3.0 CloudNativePG DR 发布证据

正式 `v3.*` 镜像发布必须从候选提交手动运行
`ql3-cloudnativepg-dr-live.yml`。该演练需要至少 35 GiB 可用空间，并使用仓库锁定的
Kubernetes、CloudNativePG、PostgreSQL、Barman 与 cert-manager 版本。live runner
必须设置 `QL3_SOURCE_REVISION` 为候选提交 SHA；产出的 JSON 报告权限必须为 `0600`。

35 GiB 是硬前置而不是建议值。GitHub workflow 和 Node live runner 会分别检查；Node 入口在创建
临时目录、Docker network/container 或 K3s 数据前检查 `os.tmpdir()` 所在文件系统，空间不足立即退出。
不得通过修改脚本、换用较小阈值或全局 `docker volume prune` 绕过：先识别并清理本次 gate 自己带
`ql3-barman-dr-*` 前缀/label 的可重建资源，无法证明归属的共享匿名卷必须保留。容量失败不生成报告，
也不能把静态审计或 PostgreSQL HA contract 的成功当作 latest/PITR 恢复证据。

报告证明的不只是 operator readiness。它必须同时覆盖：

- 连续 WAL 归档与完整 base backup；
- latest restore 和位于两个持久 marker 之间的 PITR；
- 恢复后的 schema、最小权限角色、同步提交与源集群隔离；
- object-store writer/reader authority、版本化、不可变性与生命周期；
- Barman client/server 证书轮换后继续完成 WAL、backup、latest restore 和 PITR；
- 数据库与应用层 RPO/RTO 目标。

## 私有交接合同

受控流程把审计后的报告放入发布 runner 的私有挂载：

```text
/run/qinglong3-release-evidence/<GITHUB_SHA>/cloudnativepg-dr-evidence.json
```

目录必须为 `0700`，报告必须为普通、非符号链接、`0600` 文件。runner 使用
`ql3-release-evidence-ephemeral` 标签和 `ql3-production-release-evidence`
environment；执行后销毁，不缓存或上传私有证据。

`ql3-image-release.yml` 的 `cluster-dr-release-evidence` Job 会先重新运行
CloudNativePG backup、Barman supply-chain 和 cert-manager selection 静态审计，再执行：

```bash
pnpm gate:cloudnativepg-dr-release:ql3 -- \
  --report="/run/qinglong3-release-evidence/${GITHUB_SHA}/cloudnativepg-dr-evidence.json" \
  --source-commit="${GITHUB_SHA}" \
  --release-version="${RELEASE_VERSION}"
```

门禁要求 source commit 精确相等、证据不超过 24 小时，且最多容忍 5 分钟未来时钟
偏差。`publish` 对该 Job 使用硬 `needs`；未通过时，发布矩阵不会获得 registry package
写权限或 GitHub OIDC token。

仓库内 CloudNativePG、Barman 与 cert-manager 静态锁仍保持
`releaseReady: false`。版本/digest 锁只能证明被评审的供应链输入，不能替代当前候选
提交上的真实备份、恢复与证书轮换证据。
