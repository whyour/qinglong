# ADR-0444：Fail-closed Release Tag Finalizer 与重放演练

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-350、D-351、D-352
- 关联 ADR：ADR-0441、ADR-0442、ADR-0443
- Amends：ADR-0443 的最终 tag mutation 实现，不改变 deployment-ready 发布语义

## 上下文

ADR-0443 已把最终 tag mutation 移到 scope-exact deployment readiness attestation 之后，但真正执行 promotion 的代码仍是一段嵌在
GitHub Actions YAML 中的 Node heredoc。它直接 `JSON.parse` publication plan，读取 source/inventory 并执行 `regctl image copy`；只有全部
copy 和最终回读完成后，`createPublicationTagObservation` 才间接调用 plan validator。

因此，若 runner 上的 plan bytes 在生成后被替换、截断或重写为另一组 repository/tag，旧实现可能先尝试 registry mutation，再因 plan
self-digest 或 exact tag 结构不合法而失败。workflow 正则审计只能检查源码片段存在，不能直接执行“最后一个 repository 冲突时零写”或“copy
已落地但客户端丢失响应后精确重放”的状态机。

## 决策

1. 最终 tag promotion 只通过 `scripts/ql3-release-tag-finalizer.cjs` 执行；release workflow 不再包含拥有 registry mutation authority 的
   inline Node heredoc。
2. finalizer 只接受 current-user `0700` canonical parent 中的单链接 `0600` canonical publication plan。它在创建 registry adapter、读取
   immutable source、列 tag 或 copy 之前执行完整 `validatePublicationPlan`，包括 v2 schema、self-digest、release/source/scope、readiness、
   repository、immutable reference 和两个 exact target tag。
3. `regctl` 必须是 canonical absolute、current-user、单链接、不可被 group/other 写入的 executable。finalizer 固定其 dev/inode/size/
   uid/mode/mtime/ctime，并在每个 registry command 前后复验；漂移立即失败。
4. mutation 前必须完成所有 image repository 的全量 preflight：逐一回读 immutable source digest；取得最大 1 MiB、换行闭合、合法且无重复的
   tag inventory；解析每个已存在目标 tag 并要求 exact digest。任一 source、inventory 或目标冲突时，全局 copy 次数必须为零。
5. 全量 preflight 成功后，只对 absent target 执行 `regctl image copy`。exact target 不重写。copy 返回失败时不猜测远端是否已提交，也不删除
   已正确写入的 tag；同一 protected source tag 重跑会重新 inventory，复用 exact tag 并只补 absent tag。
6. copy 阶段结束后按 publication plan 固定顺序回读所有 tag，创建 canonical
   `qinglong/release-publication-tag-observation@v1`。输出只允许在 `0700` parent 下以 `0600` no-replace 创建。
7. workflow 在 closure 前再次以 `--mode=audit` 读取 plan 与 observation，重新执行 source、inventory、全部 tag digest 和 observation
   self-digest 检查；audit 明确 `registryMutation=false`。只有 live terminal audit 成功才创建 closure receipt。
8. publication plan、tag observation 与 closure schema 不升级；本 ADR 修复执行顺序和可测试性，不改变 release identity。OCI registry 仍没有 tag
   CAS 或跨 repository transaction，closure 继续诚实声明 `registryTagCas=false` 与 `crossRepositoryAtomicity=false`。

## 故障与恢复

- plan 非 canonical、权限过宽、self-digest 错误或 tag/repository 漂移：任何 registry command 前失败。
- immutable source、inventory 或任一既有 tag 不确定：所有 repository 保持零 mutation。
- copy 在远端提交后丢失响应：本轮失败且不生成 observation；重跑复用已经 exact 的 tag，只补 absent tag。
- copy 成功但 tag 回读不是计划 digest：不生成 observation/closure，不声称发布完成。
- observation 已存在：finalize 不覆盖；运维者应先执行 read-only audit，不能删除证据后伪造另一份终态。
- `regctl` 在运行中被替换或改写：命令前后 identity 复验失败，后续 mutation 停止。

## 部署与资源影响

- 不新增 workspace package、生产依赖、数据库、schema、migration、Kubernetes object、RBAC 或部署服务。
- Edge、Standalone、低配路由器和 Cluster 节点不执行 finalizer，不增加产物体积、RSS、磁盘写、listener、timer、watcher 或常驻进程。
- 增量工作只发生在短生命周期 release runner；每个 repository 一次最大 1 MiB inventory，以及 promotion 后一次小型只读 audit。

## 被拒绝的替代方案

### 继续依赖 YAML 正则审计 inline publisher

拒绝。正则能证明片段存在，不能证明 plan validation 发生在第一条 registry command 之前，也不能执行 response-loss 状态机。

### mutation 后再验证 plan

拒绝。失败关闭必须保护副作用边界；终态 validator 不能撤销已经写错的 tag。

### copy 失败时立即覆盖或删除目标 tag

拒绝。客户端错误不能区分远端未提交和响应丢失；删除或覆盖会扩大不确定性，并与 no-CAS 事实冲突。

### 把 hermetic rehearsal 当作真实 GHCR 证据

拒绝。fake registry 证明状态机与零写/重放性质，不证明 GHCR 权限、网络、Cosign、GitHub attestation 或组织级并发控制。

## 验证

- finalizer 单测覆盖正常 promotion/read-only audit、pre-registry plan rejection、全局 conflict 零写、copy-after-write response loss 重放、
  malformed/unbounded inventory、错误终态 digest、canonical private no-replace CLI 与 executable identity 漂移；
- workflow audit 强制 CI 执行 finalizer tests、唯一脚本入口、`finalize → audit → closure` 顺序，并拒绝 inline heredoc 回归；
- 完整仓库、产物档位和部署 Gate 的阶段结果记录在 QL-RFC-0001 D-352；真实 GHCR response-loss 证据仍须由受保护 release tag 或受控
  release repository 演练产生。
