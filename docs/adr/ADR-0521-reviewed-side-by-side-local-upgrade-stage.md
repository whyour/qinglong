# ADR-0521：受审核计划驱动的 Local Side-by-side 升级暂存

- 状态：Accepted（原生 amd64/arm64 headless Trial Kit 与 milestone v4 已交付）
- 日期：2026-08-30
- 决策：D-426a

## 上下文

D-425 让既有 2.x 部署可以用可下载 Trial Kit 只读生成 SQLite 与完整数据目录计划，但二十天研发不能长期停留在“能盘点、不能形成下一阶段实物”。另一方面，直接把 inspect 接成自动切换会绕过计划审核，并把复制、转换、运行新目标和回退混成一个不可审计动作。

## 决策

Local Alpha Trial Kit 增加 canonical `upgrade-rehearsal.sh`。操作者必须显式提供 D-425 两个完整结果中已经审核的 64 位 `planDigest`；脚本不从终端输出猜测或替操作者批准计划。它只接受 `edge|standalone`、canonical 2.x data root 和尚不存在且与旧根互不包含的 rehearsal root。

脚本核对整包 checksum、exact Operator image ID/source/architecture 后，以当前 POSIX UID/GID、无网络、只读 rootfs、drop-all capabilities、128 MiB、0.5 CPU、32 PID 的短生命周期 Operator 顺序执行：

1. `local-sqlite.adoption.stage`；
2. `local-sqlite.adoption.verify`；
3. `local-sqlite.activation.prepare`；
4. `local-data-directory.adoption.stage`；
5. `local-data-directory.adoption.verify`。

2.x root 在全部命令中始终是 read-only bind mount；目标、recovery、manifest、activation、完整目录 staging 和每次产品命令结果只写入新的 `0700/0600` rehearsal root。最终 `stage-summary.json` 精确绑定 source、架构、两个 reviewed plan digest、SQLite manifest/activation digest 和目录 manifest digest，并固定声明 `legacySource=read_only`、`cutover=not_authorized`。

该阶段不执行 data-directory transform/apply，不建立 Owner/Secret authority，不停止 2.x，不创建或启动 3.0 Application 容器，也不授权 target start、cutover、Legacy rollback 或生产写入。失败后的 rehearsal root 作为诊断证据保留，不自动删除或重用。

Trial Kit/verification/auditor 升级为 `qinglong/alpha-local-trial-kit@v7`、`qinglong/alpha-local-trial-kit-verification@v5`、`qinglong/alpha-local-trial-kit-audit@v4`，新增 `legacyUpgradeStage=passed` 和 `upgradeRehearsalSha256`。Local milestone 升为 `qinglong/alpha-local-milestone@v4`，直接绑定两个原生架构不同的 rehearsal script digest；Stage index 只接受该新 Local milestone schema。

## 阶段实物门

普通 push/PR 只验证源码，不生成可交付实物。显式 Local Alpha artifact job 必须在将要上传的 exact bundle 上：

1. 创建生产形态 2.x fixture；
2. 实跑 bundle 内 `upgrade-readiness.sh` 并读取两个 plan digest；
3. 把这两个 exact digest 交给 bundle 内 `upgrade-rehearsal.sh`；
4. 要求 `stage-summary.json.status=verified`、`legacySource=read_only`、`cutover=not_authorized`；
5. 再由闭合 bundle auditor 和双架构 milestone finalizer 审计后上传。

缺少任一原生架构、完整 CI、milestone v4 或 exact script digest 的 archive 都只是中间文件。

提交 `7a8acacb6cb49bda2116bf029fbbfe447ae5d911` 的普通 CI [run 33306005705](https://github.com/whyour/qinglong/actions/runs/33306005705) 为 41 success/3 expected scope skip/0 fail，同源 Kubernetes deployment [run 33306005706](https://github.com/whyour/qinglong/actions/runs/33306005706) 成功。显式 Local headless [run 33306650776](https://github.com/whyour/qinglong/actions/runs/33306650776) 为 42 success/2 Cluster scope skip/0 fail；两个原生架构都在 exact 上传目录上实跑 readiness 与 rehearsal，最终生成 187,554,547-byte amd64、184,786,163-byte arm64 Trial Kit 和 6,206-byte milestone v4，保留至 2026-09-29。下载后的 milestone 通过 `SHA256SUMS`，离线 auditor 返回 `compatible=true`；其中 amd64/arm64 `upgradeRehearsalSha256` 分别为 `sha256:aa49dcd4ba7fc3c2201d267012fe3ec1aaa534f68142ddaac193299ee328c395` 与 `sha256:d869e9e0be6d35472b193e784d444d428525d7c64cdcb9e0bee169b70dbd732f`。

## 后续

D-426b 才处理受认证的 data-directory transform/apply、adopted deployment bundle、目标启动/停止和 clean `rollback_candidate`；D-426c 再闭合目标产生新事实后的 `reconciliation_required`。Public prerelease/release 仍需维护者显式授权。
