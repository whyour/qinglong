# ADR-0443：Deployment-ready 的终态 Release Finalization

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-336、D-344、D-345、D-350、D-351
- 关联 ADR：ADR-0436、ADR-0437、ADR-0441、ADR-0442
- Supersedes：ADR-0442 中“catalog receipt attested 后即可 mutation 最终 image tag”的发布顺序

## 上下文

ADR-0442 已把最终 image tag 从 release-set 聚合点后移到 immutable catalog 建立并验签之后，但 Local Compose 与 Cluster K3s
下游门仍在该次 tag mutation 之后运行。若 catalog 可验证而 Edge、Standalone 或三节点 K3s 的真实部署链失败，公开
`versionTag/sourceTag` 已经存在，却没有与本次 scope 对应的 catalog-bound 部署证据。此时“catalog-ready”只证明发布材料完整，不能证明
该发布已进入要求的部署族。

同时，部署 job 原先只上传 content-free report，不保留生成 report 时独立消费的 catalog ceremony bundle。终态发布者无法证明 report
确实来自与自身复验相同的 immutable catalog，也无法在一个可离线审计的 readiness receipt 中闭合 catalog、scope 和部署结果。

## 决策

1. `release-set` job 只负责聚合、审计、签证 release-set，发布并验证 immutable OCI catalog，以及签证 catalog receipt。它不再拥有最终
   image tag mutation、registry login 或 publication closure 权限。
2. `local|all` 必须成功完成 Edge 与 Standalone 两个正式 Compose rollout；`cluster|all` 必须成功完成 catalog-bound 三节点 K3s
   install、Head 和 fenced retirement。终态 `release-finalization` 使用显式 needs/result 真值表，要求当前 scope 的 job 全部 `success`，不属于
   当前 scope 的 job 必须为 `skipped`；`failure`、`cancelled` 或意外运行均失败关闭。
3. 每个部署 evidence artifact 必须同时保留 owner-private、canonical、exact-three-file catalog consumption bundle 和 content-free report。
   Local artifact 精确为 consumption 三文件、`edge.json`、`standalone.json`；Cluster artifact 精确为 consumption 三文件、`report.json`。
   finalizer 下载后重新固定目录 `0700`、文件 `0600` 并拒绝缺失或额外文件。
4. finalizer 不信任 publisher 或部署 job 的瞬时内存。它再次从 discovery ref 解析 immutable catalog，独立执行 Cosign、GitHub provenance、
   manifest round-trip 与 ceremony audit，并从自己读取的 bytes 重建 catalog plan/receipt。
5. 新增 `qinglong/release-deployment-readiness-receipt@v1`。它联合审计 finalizer consumption、当前 scope 要求的每个 deployment
   consumption bundle 和 report，绑定 release identity、immutable catalog reference、manifest/release-set digest、每份 consumption/report
   digest、精确部署族和清理结果。它拒绝 synthetic fixture、不完整报告、catalog 脱离、跨 scope 证据和未清理现场。
6. readiness receipt 必须在 Docker login 和任何 tag mutation 之前生成、复审并单独 attested。只有该 attestation 成功，finalizer 才生成并执行
   `qinglong/release-publication-plan@v2`。v2 plan 和 `qinglong/release-publication-closure-receipt@v2` 都绑定 readiness receipt digest、
   finalizer consumption digest 和精确部署族，发布 authority 升为 `verified_catalog_bound_deployments`。
7. D-350 的 bounded inventory、全量 conflict preflight、exact-tag reuse、absent-tag copy、最终逐 tag 回读和无 CAS/跨仓库事务声明保持不变。
   它们只从 catalog publisher 移入唯一的 finalizer，并发生在 readiness attestation 之后。
8. 90 天最终 bundle 保存 finalizer consumption、scope-exact deployment evidence、readiness receipt、publication plan、tag observation 与 closure
   receipt。部署 authority 仍是签名并 attested 的 immutable catalog digest；mutable tag 与 closure 只表示发布可见性和终态证据。

## 失败与恢复

- catalog 已发布但任一要求的部署门失败：没有最终 image tag mutation。该 catalog 是可复验候选材料，不是 deployment-ready tag authority。
- evidence artifact 缺失、额外、权限过宽、包含 synthetic report 或引用不同 catalog：finalizer 在 registry login 前失败。
- readiness attestation 失败：不发布 tag；同一 protected source tag 可重跑并重新取得现场证据。
- tag promotion 中途 response loss：继续使用 ADR-0442 的 exact-tag reuse，仅补 absent tag；不同 digest 永远冲突失败。
- readiness receipt 是本次部署运行的操作证据，其 digest 可以随新的真实 consumption/report 变化；它不重新定义 release-set 或 immutable
  catalog identity，也不伪称跨重跑逐字节确定。

## 部署与资源影响

- Edge、Standalone、低配路由设备和 Cluster 节点不安装 Node、regctl、Cosign 或 GitHub CLI，不新增 watcher、timer、listener、updater、
  queue、缓存或常驻进程。
- 不新增 workspace package、生产依赖、数据库、schema、migration、SQL、Kubernetes object、RBAC 或业务副本。
- 增量 CPU、内存、网络和磁盘只发生在短生命周期 release runner。Local scope 不运行 K3s 门，Cluster scope 不运行 Compose 门；`all` 才运行两族。

## 被拒绝的替代方案

### catalog-ready 后继续立即发布最终 tag

拒绝。catalog 完整不等于 scope 要求的部署路径已成功，仍会留下“公开 tag 成功、真实部署失败”的窗口。

### 只依赖 GitHub job result，不闭合部署证据

拒绝。瞬时调度状态不能证明 report 使用了哪个 immutable catalog，也无法让最终 bundle 独立审计。

### 让部署 job 自行发布 tag

拒绝。会把 package write、attestation write 和 registry login 权限扩散到多个高成本 runner，并引入多写者竞争。

### 把完整 token、kubeconfig 或命令 transcript 上传给 finalizer

拒绝。finalizer 只需要 owner-private catalog bundle 和 content-free bounded report；credential 与现场控制材料必须留在原 job 生命周期内。

## 验证

- readiness contract 覆盖 Local/Cluster/All 精确部署族、缺失/额外/跨 scope 证据、catalog 脱离、synthetic/incomplete/unclean report、
  receipt tamper、自摘要重算和 closed CLI；
- release workflow 静态门固定 `catalog receipt → scope-exact deployment jobs → finalizer independent consumption → readiness audit/attestation →
  tag mutation → closure audit/attestation` 顺序，并拒绝 evidence bundle、needs/result、独立 attestation 或最终 bundle 漂移；
- 完整仓库、产物档位和部署 Gate 的阶段结果记录在 QL-RFC-0001 D-351；首份真实 GHCR deployment-ready finalization 仍须由受保护
  `v3` release tag 或受控 release repository 演练产生。
