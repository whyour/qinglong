# ADR-0526：Exact 写后 Reconciliation Capture

- 状态：Accepted（同源 exact Console 双架构阶段实物已交付）
- 日期：2026-09-01
- 决策：D-426c1
- 关联：ADR-0476、ADR-0482、ADR-0483、ADR-0523、ADR-0524、ADR-0525

## 上下文

ADR-0524/0525 已让 downloadable Trial Kit 在 headless 与 Console 两种变体上完成 exact adopted target probe，并证明 target 未产生业务写入时可以得到 `rollback_candidate`。这仍没有闭合另一个必须失败关闭的分支：target 已经 active 后，3.0 数据权威接受一条业务写入，target stop 必须拒绝 clean rollback，并把 legacy、target、recovery 与 cutover lineage 密封到独立 capture，供后续 plan/review/application 使用。

底层 reconciliation capture、plan、review、application、Automation、Secret/Config、Run History 与 completion authority 已由 ADR-0482 至 ADR-0493 实现，但之前没有进入用户实际下载的 Trial Kit。仅靠包级测试无法证明 exact Application/operator image、canonical shell、Docker target evidence、私有目录和 artifact workflow 能从一次真实写入贯通到 `reconciliation_captured`。

## 决策

1. canonical `upgrade-cutover-rehearsal.sh` 保持现有 5–7 参数 clean rollback 路径不变；仅在操作者显式提供完整参数 `--capture-after-write /absolute/new/capture-root` 时进入 D-426c1。capture root 必须是尚不存在、父目录 canonical、与 legacy/rehearsal root 双向不重叠的安全绝对路径。
2. 脚本仍先运行同一个 reviewed readiness/stage、Owner ceremony、transform/apply、synthetic Legacy stop、adopted bundle 与 exact target probe。target 进入 `target_active` 后，短生命周期 Operator 使用现有 `task.put` 产品入口和已交付 Owner credential 向 target SQLite 提交固定、无网络、无 Secret 的 `qinglong/command@v1` Task。该写入证明 active target 数据权威发生业务变化；它不是普通 Local API listener 或浏览器写入证据，不能冒充生产流量接管。
3. target stop 必须返回 `reconciliation_required`，并给出 exact stopped record 与 instance head digest。任何 `rollback_candidate`、`manual_review`、legacy source 漂移或缺失证据都使 capture 演练失败；脚本不调用 Legacy rollback prepare/commit，也不启动 Legacy。
4. capture 使用已存在的 `ql3-local-deploy reconciliation-capture-prepare|commit|verify`，运行于 128 MiB、0.5 CPU、32 PID、无网络、只读 rootfs 的一次性 Operator。legacy root 继续只读；rehearsal 与独立 capture root 是仅有的可写 bind。prepare 绑定 stopped authority、Profile、instance/cutover/generation、Application config、activation、legacy/target/recovery 路径以及 stop/head digest；commit 发布 sealed assets、manifest 与 receipt；verify 只读复算 bundle/head。
5. 成功后生成 `qinglong/local-alpha-upgrade-reconciliation-capture-summary@v1`，只记录 source/architecture/Profile/variant、固定 synthetic Task identity、cutover/capture digest、asset count/bytes 与 `legacySource=unchanged`、`target=stopped`、`rollback=not_authorized`、`next=review_required`。真实 capture 可能包含数据库、配置和 Secret 密文，必须继续保存在操作者指定的 owner-private root，不能上传为普通低敏 CI summary。
6. Trial Kit、verification 与 offline auditor 分别升级为 `qinglong/alpha-local-trial-kit@v9`、verification `@v7` 与 audit `@v6`；manifest schemaVersion 升为 10，并增加 required gate `legacyUpgradeReconciliationCapture=passed`。旧 v8/v6/v5 bundle 不会被新 auditor 静默接受。
7. 原生 amd64/arm64 artifact job 在上传前先保留既有 clean rollback 演练，再从同一 unchanged Legacy fixture、同一 exact bundle 用独立 rehearsal/capture root 与容器名实跑写后 capture。workflow 必须验证 summary、terminal verify、manifest/receipt/assets、legacy 无 WAL/journal，并删除四个 synthetic 容器；任一步失败都不得形成 Local milestone。
8. exact arm64 首次演练证明 `task.put` 与 `reconciliation_required` 已成功，但暴露原有 capture proof 重算 v4 adopted target 时未带入 target-stop 已验证的 post-apply baseline，因而把同一次 stopped evidence 误报为漂移。修复仅在 persisted stopped evidence 明确携带 `baselineKind=adopted_target` 时加载 durable baseline，并严格核对 Profile、instance/cutover、activation、target path 与 exact baseline digest 后才重算；缺失、篡改、换路径或换 lineage 仍失败关闭，legacy 与 service-manager 路径不变。

## Profile 与资源边界

- Edge/低配路由设备：默认仍选择 headless，稳态 Application 不增加依赖、listener、timer、watcher、连接或常驻内存；D-426c1 只增加一次显式升级演练的第二轮短生命周期操作。
- Standalone：沿用既有 Profile 上限；capture 大小由现有有界资产集合决定，但仍要求操作者预留独立持久空间。
- Console：capture probe 仍不启动 HTTP listener；fresh Console 产品旅程继续独立证明页面、credential 与 API。
- Cluster：不复用 Local SQLite/POSIX/Docker capture；PostgreSQL/Kubernetes recovery 与 deployment lock 不受本 ADR 授权。

## 被拒绝的方案

- 在发生写入后继续执行 clean rollback：会丢失 3.0 新事实，拒绝。
- 把 capture 放进 rehearsal root：根被误删时会同时丢失 source、target 与唯一恢复证据，拒绝。
- 修改核心 target stop classifier：ADR-0523 已正确区分 baseline/write/manual，本切片只消费结果，不扩大 HIGH/CRITICAL 状态机风险。
- 用 SQL 或文件追加制造漂移：只能证明字节变化，不能证明正式产品 mutation authority、credential fence 与 audit 生效。
- 一次性自动执行 plan/review/application/completion：review 需要人类对 exact fact set 作强认证选择；D-426c1 必须停在 `review_required`。

## 验证与交付状态

- 编辑前 GitNexus：Trial Kit verification/create 为 LOW，offline auditor 为 MEDIUM（5 direct、12 total、0 process），Operator workflow auditor 为 LOW；没有 HIGH/CRITICAL 编辑目标。Shell 模板未被索引，使用 backward-compatible 参数、`sh -n`、静态 contract 与原生 Docker artifact gate 约束。
- 聚焦 bundle/operator 静态回归为 18/18，证明 v9/v7/v6 schema、canonical script、required gate、exact `task.put`/capture command 与 workflow order 闭合。全部 18 个 `packages/ql3-*` 已重新编译并通过自身契约测试；后端脚本层全量回归为 1661 total / 1659 pass / 2 conditional skip / 0 fail。Package boundary（18 个 package、无 single/shallow source package）、Edge import、Cluster dependency 与 Local Operator image audit 全部 `compatible=true`。
- 首次 exact Console artifact run `33467541901` 在 arm64 上真实证明写入与 `reconciliation_required`，随后于 capture prepare 因 v4 adopted baseline 重算缺口失败，且未上传 Trial Kit，因而不计为交付。修复后 reconciliation 聚焦回归为 72 total / 70 pass / 2 conditional Docker skip / 0 fail，新增 adopted-baseline 正向与篡改失败关闭用例；Owner CLI 全量为 316 total / 309 pass / 7 conditional skip / 0 fail。
- 修复提交 `0235973c9b54a2f22de09b6487ea9f184f0b8bfd` 的普通主 CI [run 33469372499](https://github.com/whyour/qinglong/actions/runs/33469372499) 为 41 success / 3 expected artifact-finalizer skip / 0 fail，同源 Kubernetes [run 33469372500](https://github.com/whyour/qinglong/actions/runs/33469372500) 成功。显式 Local Console [run 33469435652](https://github.com/whyour/qinglong/actions/runs/33469435652) 为 42 success / 2 scope skip / 0 fail；amd64、arm64 的 `Materialize and offline-audit the native Local Alpha trial kit`、上传步骤和最终 `Finalize the Local Alpha milestone` 全部成功。
- 该 run 交付 artifact `9786301280`（amd64，226683392 bytes，GitHub ZIP `sha256:49e921cb251da8cec3dcee5308174dd8aca89ffa18a3df6e6c7d0f43095c6f70`）、`9786374284`（arm64，222083072 bytes，`sha256:4ff7d3fff5af16ca55350d0dbf14c35d8ddcdeecb7d395ba017a14081949e0e8`）与 `9786520389`（milestone，6489 bytes，`sha256:d69c769117268fe8559043bb62999549d215c12f353e34c51d32d22ce319dd4c`），均保留至 2026-10-01。finalizer 下载并重新审计两个 exact bundle 后才生成 milestone；本机重新下载的 milestone 通过 `SHA256SUMS`，v5 auditor 返回 `compatible=true`，绑定 `3.0.0-alpha.2`、`variant=console`、同一 source/workflow SHA/ref/run/attempt。milestone 记录的内部 Docker archive digest 为 amd64 `sha256:3c9f7dac623bacd4b88b933a3668cfe74526a9fc4fe73823f821535a11aba3f4`、arm64 `sha256:68ee76d6f0a20f876da4ccfef96bb58f08aa965969d44ed587f3df37536529db`。D-426c1 因此已形成可下载、可验真的 Alpha 阶段实物；它仍不是 Public Release，也不授权自动 reconciliation application、Legacy restart 或生产切换。

## 后续

D-426c2 将把同一 exact capture 接续到 bounded plan、强认证 review 与逐域 application/rollback；D-426c3 再证明 completion/restart 或人工恢复。Public Release 仍需受保护 tag、immutable multi-arch digest、签名/attestation、deployment lock、生产停机窗口与演练过的恢复责任人。
