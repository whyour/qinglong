# QingLong 3.0 Worker 管理统一发布证据

本流程把四个已经独立完成的生产证据协议收敛为一个可离线重判的 release gate。聚合器只读取本地报告并创建
`0600` 摘要清单，不访问 Kubernetes、PostgreSQL、IdP、PKI 或管理 API，也不会修改任何生产对象。

## 必需输入

必须准备同一发布边界的四份 canonical、owner-private、最大 1 MiB 报告：

1. D-229 `worker-credential-management-live-ceremony@v1`；
2. D-230 `worker-credential-management-durable-audit-evidence@v1`；
3. D-232 `worker-credential-management-pki-rotation-evidence@v2`；
4. D-234 `worker-credential-management-ca-rollover-evidence@v1`。

D-232 v1 不再兼容，因为它错误耦合了 server TLS trust CA 与 client issuer CA。四份报告必须使用相同 external
issuer/profile；D-232 与 D-234 必须由同一已审 operator subject 采集，并绑定同一 endpoint、servername、server
trust bundle、inspect command、cluster、collector 和 Deployment UID。

D-232 与 D-234 可以来自不同维护窗口，不要求两代 CRL rollout 与三代 CA rollover 的 generation 连续；但各自
报告内部的 generation/resourceVersion/Pod replacement 门必须已经通过。

## 生成 release evidence

输出路径必须尚不存在，父目录必须 canonical 且由 operator 管理：

```sh
pnpm evidence:worker-management-release:ql3 -- \
  --ceremony-report=/secure/ql3/worker-management-ceremony.json \
  --durable-audit-report=/secure/ql3/worker-management-durable-audit.json \
  --pki-rotation-report=/secure/ql3/worker-management-pki-rotation-v2.json \
  --ca-rollover-report=/secure/ql3/worker-management-ca-rollover.json \
  --output=/secure/ql3/worker-management-release-evidence.json
```

成功输出只表示聚合器已经重新验证四份 source、摘要链和交叉绑定，CLI 会返回：

```json
{"schemaVersion":1,"fixture":"qinglong/worker-credential-management-release-evidence@v1","compatible":true}
```

## 独立离线审计

不要只把最终 JSON 交给 auditor。必须同时提供生成时的四份 source；auditor 会重新计算文件摘要、重跑四个原始
validator，并重建完整 release report：

```sh
pnpm audit:worker-management-release:ql3 -- \
  --report=/secure/ql3/worker-management-release-evidence.json \
  --ceremony-report=/secure/ql3/worker-management-ceremony.json \
  --durable-audit-report=/secure/ql3/worker-management-durable-audit.json \
  --pki-rotation-report=/secure/ql3/worker-management-pki-rotation-v2.json \
  --ca-rollover-report=/secure/ql3/worker-management-ca-rollover.json
```

只有退出码 0、`compatible=true` 且最终报告 `gates.passed=true` 才能进入后续 release approval。修改 source、替换
final 字段、使用另一 operator/cluster/Deployment、时间倒置或缺失任一文件都会失败。

## D-236 镜像发布接入

生产发布不上传五份 JSON。为目标 tag commit 创建一次性 self-hosted JIT runner，并为它附加精确标签
`self-hosted,linux,ql3-release-evidence-ephemeral`；`ql3-production-release-evidence` GitHub Environment 必须启用
required reviewers。runner provisioner 在启动 job 前完成：

1. 确认 dispatch 选择的 tag 受保护，并且 tag commit 的 release workflow/gate script 已审；
2. 以 runner 实际 UID 创建 canonical `0700` 目录 `/run/qinglong3-release-evidence/<40-or-64-hex-commit>`；
3. 以 `0600`、非 symlink、最大 1 MiB 的 regular file 挂载以下固定名称：
   `worker-management-release-evidence.json`、`worker-management-ceremony.json`、
   `worker-management-durable-audit.json`、`worker-management-pki-rotation-v2.json`、
   `worker-management-ca-rollover.json`；
4. 禁止 runner 用户访问同目录之外的 PKI key、JWT、Kubeconfig、DSN 或证据归档；
5. job 完成后注销并销毁 runner/临时挂载，不复用工作目录或 runner registration token。

随后在 GitHub Actions 手动 dispatch `QingLong 3.0 Image Release`，输入不带 `v` 的 exact version，并选择
`v<version>` tag 作为 ref。gate 会执行等价命令：

```sh
pnpm gate:worker-management-release:ql3 -- \
  --report=/run/qinglong3-release-evidence/$GITHUB_SHA/worker-management-release-evidence.json \
  --ceremony-report=/run/qinglong3-release-evidence/$GITHUB_SHA/worker-management-ceremony.json \
  --durable-audit-report=/run/qinglong3-release-evidence/$GITHUB_SHA/worker-management-durable-audit.json \
  --pki-rotation-report=/run/qinglong3-release-evidence/$GITHUB_SHA/worker-management-pki-rotation-v2.json \
  --ca-rollover-report=/run/qinglong3-release-evidence/$GITHUB_SHA/worker-management-ca-rollover.json \
  --source-commit=$GITHUB_SHA \
  --release-version=3.0.0
```

final 必须在 runner 当前时间前 24 小时内生成，允许的未来时钟偏差最多 5 分钟。成功日志只包含低敏 fixture、
commit、version、final SHA-256 和 freshness 上限；workflow 不使用 artifact/cache，也不把证据路径传给 publish job。
三个镜像 publisher 只有在该 job 成功后才获得 GHCR/OIDC/attestation 写权限。

`ql3-release-evidence-ephemeral` 标签本身不能证明 runner 真正一次性；若 provisioner 未销毁 runner，必须停止发布、
隔离该主机并轮换 registration credential。不得为了“自动清理”让 workflow 删除外部不可变证据归档。

## 归档与保留

- final report 与四份 source 必须作为同一不可变归档单元保存；final 不能替代 source；
- PKI ticket、Deployment rollout log、IdP/审批记录可在外部审计系统按自身 retention 保存，但不得把原始 JWT、
  private key、certificate/CRL 内容、Kube token、Secret 或 DSN 填入 release JSON；
- 重新采集任一 source 后必须生成新的 final output，不得覆盖旧文件；
- 本门证明观察窗口内的 Worker management identity、durable review、leaf revocation、CA rollover 和部署一致性，
  不自动证明未来 CRL SLO、PKI compromise 响应、IdP 可用性或所有 caller 已永久销毁旧 material。
