# ADR-0442：Catalog-ready 的终态 Release Tag 发布与闭合收据

- 状态：Superseded by ADR-0443（bounded promotion/closure 机制继续有效，发布前置顺序被收紧）
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-336、D-349、D-350
- 关联 ADR：ADR-0427、ADR-0428、ADR-0439、ADR-0441
- Supersedes：ADR-0427 中“完整 release-set 审计后即可 promotion”的最早发布顺序
- Superseded by：ADR-0443 将最终 tag mutation 继续后移到 scope-exact deployment readiness attestation 之后

## 上下文

QingLong 3 的 image publisher 先写入无 tag 的 immutable digest，完成逐镜像签名、SBOM、漏洞与 provenance 验证，再由
release-set job 聚合所有镜像。ADR-0427 因此允许在完整 release-set 审计后 promotion `versionTag/sourceTag`。

后续 ADR 又增加 release-set file provenance、durable OCI catalog、catalog signature/provenance、manifest round-trip 和 catalog receipt。
原有 promotion 步骤却仍位于这些 Gate 之前。如果 catalog 发布、签名、attestation 或 receipt 失败，公开 image tag 已经可见，但可部署的
immutable catalog authority 尚未闭合。旧 promotion 还把任意 `regctl image digest <tag>` 非零退出都当作 tag absent；网络、认证或 registry
错误可能因此被错误降级成“可以写入”。

## 决策

1. `versionTag/sourceTag` mutation 移到以下事实全部成功之后：完整 release-set 已审计并 attested；catalog 已按 immutable digest
   round-trip；catalog signature 与 GitHub provenance 已验证；catalog receipt 已生成、审计并 attested。
2. 新的 `qinglong/release-publication-plan@v1` 必须重新读取并联合审计 exact release-set、catalog plan、raw manifest、manifest
   digest 与 catalog receipt。计划只含 release identity、上游摘要、每个 image 的 immutable reference/digest、两个目标 tag 和固定策略；
   catalog receipt 之前不能生成该计划。
3. promotion 在任何 tag mutation 前，对每个已存在的 image repository 执行一次完整 tag inventory：最大 1 MiB、canonical line、OCI
   tag 字符集、无重复。inventory 读取失败、超限或畸形全部失败关闭，不能再把任意 digest lookup 错误解释为 absent。
4. 预检首先验证所有 immutable source digest。inventory 中已存在的所有目标 tag 必须逐个解析为计划 digest；任一冲突时尚未发生任何
   tag mutation。只有全量预检成功后才依固定顺序 copy absent tag；exact tag 不重写，用于 response-loss 恢复。
5. copy 阶段完成后，必须重新读取所有 `2 × imageCount` 个 tag，并用
   `qinglong/release-publication-tag-observation@v1` 固化 exact ordered mapping。缺失、额外、重排、重复或 digest 漂移均不能闭合。
6. `qinglong/release-publication-closure-receipt@v1` 同时绑定 publication plan、release-set、catalog plan/receipt/manifest、最终 tag
   observation 和固定策略，并具有自身 digest。plan、observation、receipt 必须一起进入 90 天 deployment bundle；receipt 必须再次本地
   审计并单独 attested，使下载者可以离线重放 closure audit。
7. receipt 诚实保留 `crossRepositoryAtomicity=false` 与 `registryTagCas=false`。它证明 workflow 观察到 catalog-ready 后的完整终态，
   不声称 GHCR 提供跨 repository 事务或 tag CAS。发布中途失败时不删除正确 tag；同 protected source tag 重跑只能复用 exact digest，
   任何不同 digest 都失败。
8. deployment consumer 仍只信任已签名/attested 的 immutable catalog digest。最终 image tag 和 closure receipt 是发布可见性与运维证据，
   不是部署 authority 的替代品。

## 失败与恢复

- catalog receipt attestation 前失败：没有正式 image tag mutation；修复后从同一 protected source tag 重跑。
- repository inventory 读取不确定：立即停止，不能把 auth/network/registry error 当作 absent。
- 任一既有 tag 指向其他 digest：全量预检阶段停止，不写任何本轮目标 tag。
- promotion 中途 response loss：可能已有部分 exact tag；重跑重新取得全部 inventory，复用 exact tag，只补 absent tag，最后重建相同
  observation 与 closure receipt bytes。
- promotion 后竞争：最终逐 tag digest 回读会阻止 closure；稍后外部改写也无法改变已 attested receipt 绑定的 immutable digest，consumer
  仍不会信任 mutable tag。

## 部署与资源影响

- Edge/Standalone/路由设备不执行该协议，不安装 Node、regctl、Cosign 或 GitHub CLI，不增加 RSS、磁盘写、timer、listener、watcher、
  updater 或常驻进程。
- Cluster 节点、Kubernetes object、CloudNativePG、数据库、migration、SQL、Pool、Worker 与运行时镜像均无变化。
- 新工作只在短生命周期 GitHub-hosted release runner：每个 image repository 一个最大 1 MiB inventory、一个小型计划/观察/收据文件和
  最终 tag 回读。不新增 workspace package、生产依赖或部署服务。

## 被拒绝的替代方案

### 继续在 release-set 审计后立即 promotion

拒绝。完整镜像集合不等于 durable catalog 已经可验证；后续 catalog 失败会留下过早公开的 tag。

### 继续把 `image digest` 任意失败解释为 absent

拒绝。不存在、无权限、网络中断和 registry 故障不能共享同一 mutation 决策。

### 先写 tag，再用 closure receipt 记录结果

拒绝。收据只能证明终态，不能修复错误的发布前置顺序；catalog-ready 必须是 mutation 的真实前置条件。

### 声称 closure receipt 提供跨 repository 原子性

拒绝。OCI registry 没有该事务语义。精确重放和终态闭合能收敛部分成功，但不能伪造原子 commit。

## 验证

- publication closure contract 覆盖 Local/Cluster/All 计划、确定性 receipt、缺失/重排/额外/digest 漂移 tag、上游 catalog 脱离、
  self-digest tamper、closed CLI 与 no-replace 输出；
- workflow 静态门固定 `catalog receipt attestation → publication plan → bounded inventory/preflight → tag mutation → exact observation →
  closure audit/attestation → bundle upload` 顺序，并拒绝缺失 inventory、closure 或独立 attestation；
- 发布链与完整仓库验证结果记录于 QL-RFC-0001 D-350；首份真实 GHCR 部分 promotion/response-loss 重放仍须由受保护 `v3` release tag
  或受控 release repository 演练产生。
