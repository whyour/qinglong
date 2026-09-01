# ADR-0527：受审核 Automation Reconciliation 应用与显式回滚

- 状态：Accepted（源码与本地 exact arm64 演练已闭合；双架构阶段实物待交付）
- 日期：2026-09-01
- 决策：D-426c2
- 关联：ADR-0484、ADR-0485、ADR-0486、ADR-0487、ADR-0526

## 上下文

ADR-0526 已把 active target 的真实产品写入密封为独立 reconciliation capture，但 downloadable Trial Kit 仍停在 `review_required`。底层 plan、强认证 review、跨域 application plan、Automation row plan、apply 与 rollback 已存在；缺少的是一条部署者可执行、资源有界、不会自行替人决策的 exact artifact 链。

本切片只闭合一个最小可恢复事实：操作者审核完整计划并在 owner-private 文件中给出外部决定后，短生命周期 Operator 应用一个无冲突 Automation 行，验证正式 Task/Trigger 投影，再显式回滚到应用前 SQLite 快照。Secret/Config、Run History、completion 与服务重启继续留给后续独立决策。

## 决策

1. Trial Kit 新增 canonical `reconciliation-rehearsal.sh`，分为 `prepare`、`review`、`apply-rollback` 三个显式阶段。每个阶段只接受前一阶段的 exact sealed evidence，不跨阶段猜测路径、digest、时间或决定。
2. `prepare` 只从 ADR-0526 的 stopped capture 建立 bounded reconciliation plan、诊断页与强认证 review prepare，并终止于 `operator_decision_required`。`review` 只消费外部 review NDJSON，完成 authorization commit/verify、application prepare/commit/verify 与 Automation plan/verify，并终止于 `automation_decision_required`。`apply-rollback` 只消费外部 Automation row NDJSON，完成 decision commit、apply/verify、rollback/verify，终态为 `reconciliation_automation_rolled_back`。
3. 交付脚本永不生成 review 或 Automation decision。仓库中的 `ql3-local-alpha-reconciliation-decision-fixture.cjs` 只为 CI 合成数据生成冻结决定，不进入 Trial Kit、manifest、checksum 或用户下载包。Legacy Run History 固定为 `manual_external`，不能为了让演练通过而丢弃。
4. 每份外部 decision 必须是 owner-private canonical regular file：父目录为当前 UID 拥有的 `0700` 目录、目录中恰好只有该文件，文件不位于 deployment/reconciliation/capture 权威根内；容器只读挂载整个父目录。review 与 Automation decision 使用不同父目录，不能复用或替换。
5. review authorization 的有效期为 60 秒且不得晚于 strong principal；commit/verify 与 application/Automation 操作必须消费同一授权谱系。Automation decision commit 必须 `await` 完整确认后才能关闭 authentication database，避免异步确认读取已关闭 authority。
6. Automation target SQLite 必须位于 canonical deployment root 下，同时与 plan、capture、review、application、Automation 和 decision sibling roots 双向不重叠。apply/verify/rollback 使用短命名空间 `reconcile_automation_apply`，满足既有 32 字节授权上限。
7. `apply-rollback` 显式接收原始 Legacy root，并只读挂载它以复算 stopped proof；target deployment root 是唯一业务可写根。Operator 继续使用只读 rootfs、`network=none`、drop-all capabilities、no-new-privileges、128 MiB memory/swap、0.5 CPU、32 PID 与 8 MiB noexec tmpfs。
8. 所有带时间的 command 只在首次阶段创建；中断后必须复用原文件和原时间。容器输出先写 PID-scoped 临时结果，命令成功后才原子替换正式 result。失败重跑不能覆盖已存在的 authorization、intent、decision 或成功 result。
9. 成功 summary 只公开低敏 lineage：review/Automation/decision identity 与 digest、apply digest、采用的 Task/Trigger 数量、rollback head digest，以及 `target=restored_to_pre_automation_snapshot`。它固定 `completion=not_attempted`、`targetRestart=not_attempted`、`legacyRestart=not_attempted`。
10. Trial Kit、verification、offline audit 分别升级为 `@v10/@v8/@v7`，manifest schemaVersion 为 11；Local milestone 升级为 `@v6`、schemaVersion 6，并绑定双架构 `upgradeReconciliationRehearsalSha256`。required gate 新增 `legacyUpgradeReconciliationAutomationRollback=passed`，旧 bundle/milestone 不会被新 auditor 静默接受。

## Profile 与部署边界

- Edge/低配路由设备：默认 headless Application 和稳态资源不变。D-426c2 只启动串行短生命周期 Operator；不会新增 package、依赖、daemon、listener、timer、watcher、连接池或常驻缓存。
- Standalone：复用相同命令与安全边界，仅沿用既有较大 reconciliation 文件预算；本 ADR 不提高 Operator 资源上限。
- Console：同一 reconciliation script 可存在于 Console bundle，但不会启动 Web listener；3.0 Console 与 2.x 面板仍是不同 API/认证/领域协议，不能据此声明零改动兼容。
- Cluster：不复用 Local SQLite/POSIX/Docker 证据。PostgreSQL HA、Kubernetes lease、Worker 与 Cluster reconciliation 不受本 ADR 授权。

## 被拒绝的方案

- 在脚本内自动选择 `prefer_target` 或批量 adopt：会把 CI 策略伪装成人类审核，拒绝。
- 一次命令从 capture 直接推进 completion/restart：跨越 Secret/Config、Run History 与服务权威，拒绝。
- 只验证目标行数、不执行显式 rollback：无法证明应用前快照、backup digest 与恢复 head 闭合，拒绝。
- 把 decision 单文件直接 bind mount，或允许父目录中存在额外文件：会扩大路径替换与同目录注入面，拒绝。
- 为 Docker Desktop 放宽 POSIX owner 校验：会削弱原生 Linux 的 owner proof，拒绝。只读 readiness 可对瞬时 mount UID 漂移执行同一命令的一次有界重试；持续错误仍失败关闭。

## 验证与交付状态

- GitNexus 对修改的 TypeScript 符号均为 LOW：decision authorization 2 个上游、apply contract 8 个上游、apply/rollback authentication 4 个上游，均无 execution flow；shell 模板未被索引，按静态引用、`sh -n`、功能测试与 exact Docker gate 约束。
- 聚焦回归覆盖 strong-principal expiry、authentication database close fence、target path containment、短 authorization namespace、decision file private parent、命令/结果精确重放，以及 CI fixture 不进入 bundle。
- 本机完整 backend 回归为 `1667 total / 1665 pass / 0 fail / 2 conditional skip`；18 个 QL3 package clean build、package boundary、cluster dependency 与 image audit 均通过。PostgreSQL 18.6 arm64 HA Docker 门进一步完成 timeline `1→2` promotion 与 147 项检查，私有报告摘要为 `sha256:68e2f60b962ac62cee3c70bf759fccb6f8080541264427a4ea66bf8f586707db`。
- 本机 exact arm64 headless Trial Kit 使用最终 Application `sha256:eec404d24b5c101871e000caac902d3866e5fe3f0e6dcef31366cb526ef32f80` 与无源码覆盖的 Operator `sha256:10f75f12d185e5796dcc4a230b6684c074bd9a6e6156ee1110fff1c2d8dd3390`，离线 audit v7 返回 `compatible=true`。全新 2.x fixture 已贯通 readiness、stage、cutover、post-write capture、437 条外部 review 决定、1 条外部 Automation 决定、apply/verify 与 explicit rollback/verify；最终实际采用 1 个 Task、1 个 Trigger并返回 `reconciliation_automation_rolled_back`，且未尝试 completion、restart、Secret/Config 或 Run History mutation。
- 提交 `c8d9eed95d402aae642e81e60fce336670ac06a0` 的普通主 CI [run 33526720941](https://github.com/whyour/qinglong/actions/runs/33526720941) 为 41 success/3 expected skip/0 fail，Kubernetes [run 33526721040](https://github.com/whyour/qinglong/actions/runs/33526721040) 成功；显式 Local headless [run 33528370769](https://github.com/whyour/qinglong/actions/runs/33528370769) 为 42 success/2 scope skip/0 fail。amd64/arm64/milestone artifact `9809046864`/`9809000920`/`9809293769` 保留至 2026-10-01，下载后的 milestone v6 auditor 返回 `compatible=true` 并绑定 exact source/run/attempt、两个不同 archive digest 与两个不同 reconciliation script digest。D-426c2 因此已是可下载阶段产物，但仍不是 Public Release 或生产升级授权。

## 后续

D-426c3 再独立处理 Secret/Config、Run History、跨域 completion 与 target/Legacy restart 选择。2.x 面板复用走单独 UI adapter RFC：保留现有视觉组件，替换 `/api/*` 数据层、JWT/session 假设与 Crontab/Env/Log 领域映射；不得把 D-426c2 当作 2.x API compatibility layer。
