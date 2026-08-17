# ADR-0437：发布后 Catalog-bound Local Release Gate

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-01、D-03、D-05、D-14、D-338、D-339、D-345
- 关联 ADR：ADR-0196、ADR-0198、ADR-0199、ADR-0200、ADR-0201、ADR-0202、ADR-0425、ADR-0430、ADR-0431、ADR-0432、ADR-0436

## 上下文

Local image publisher 已在每个刚推送的 digest 上执行 Edge 与 Standalone Compose rollout，但该检查发生在完整 release-set、版本标签和
durable OCI catalog 形成之前。ADR-0430 至 ADR-0432 已定义公开 catalog 消费、Local selection 和目标侧 Compose revision，发布流水线却
没有证明一个不继承 publisher 登录态的下游消费者能够从公开 catalog 重新发现、验签、下载并重建 selection，再让实际 Local 产品入口消费
同一份 selection。

因此 Local 发布仍有一段未被连续证明的链：publisher 内直接掌握的 image digest 成功，不等于路由器、NAS 或单机用户最终拿到的 catalog
selection 能成功进入 Edge/Standalone。该缺口不能通过为设备安装 Cosign、regctl、GitHub CLI 或常驻 updater 来关闭；这些工具应只存在于
发布者外部的短生命周期 release gate。

## 决策

1. `ql3-image-release.yml` 在 `release-set` 完成后增加独立 `release-catalog-local-deployment-live`。它仅在 `local|all` scope 运行；
   `cluster` scope 明确跳过。现有 Kubernetes gate 继续只处理 `cluster|all`，两族发布门互不替代。
2. Local gate 使用 GitHub-hosted runner、30 分钟硬上限和只读 `contents|packages|attestations` 权限。它没有 package write、OIDC signing、
   attestation write、Docker login、tag promotion 或 catalog mutation authority。
3. consumer 不下载 release-set workflow artifact 作为 authority。它使用 checksum-pinned `regctl@0.11.5`、pinned Cosign installer 与
   canonical GitHub CLI，从公开 discovery tag 两次稳定解析 immutable catalog，以 exact workflow identity、source tag/revision 和公开 OCI
   provenance 完成 ADR-0430 three-file consumption bundle。短期 GitHub token 只通过当前 UID 的 `0600` 文件进入 verifier，完成即删除。
4. 同一 job 使用 `ql3-deployment-lock-contract.cjs local-create|local-audit` 从 bundle 物化唯一
   `qinglong/local-compose-release-image@v2`。selection 必须绑定 release-set、catalog manifest、consumption report、source identity、唯一
   Local image digest 和显式 `allowRootService=false`；输出为当前 UID、单链接、canonical `0600` no-replace 文件。
5. `ql3-local-compose-rollout-live-contract.cjs` 保留原 synthetic PR 模式，并增加 all-or-none 的
   `--release-selection + --expected-selection-digest` 模式。真实模式在任何部署准备前重验 canonical path/parent、owner、mode、link count、大小、
   canonical JSON、自摘要、source tag/revision/scope、catalog 三个 digest、Local image 和 root policy；任一漂移失败关闭。
6. Edge 与 Standalone 都必须把同一 selection 交给正式 `prepareLocalDeployment`、Compose revision switch/apply、SQLite rollout backup/restore、
   evidence collection 与 graceful stop 路径。成功报告只投影 content-free `releaseAuthority` digest/identity，不上传 selection、bundle、token、
   Docker socket、deployment root、command 或数据库。
7. Local gate 先公开拉取 selection 中的 immutable image，再依次运行两种 Profile；完成后要求没有以该 image 为 ancestor 的容器残留。失败也只
   上传已有的 content-free report，runner 结束即销毁私有 bundle/selection。
8. 不新增 workspace package、production dependency、数据库、migration、listener、timer、watcher、updater 或设备侧工具。Local/Edge/
   Standalone 的镜像字节、模块闭包和稳态资源必须保持不变。
9. 第一份真实成功 evidence 只能来自实际受保护 `v3` release tag。仓库 fixture 与本机 Docker 可以证明 selection handoff、产品 rollout 和
   失败关闭语义，但不能冒充公开 GHCR/Cosign/GitHub 在线 ceremony。

## 失败与恢复

- 公开 catalog 不可读、discovery digest 漂移或签名/provenance 不匹配：发布失败；不能退回 publisher artifact 或登录态。
- selection create/audit 不一致：修正 catalog/release-set 或源码后重跑；不能手工复制 image digest。
- Edge 或 Standalone 任一失败：Local release 失败；一种 Profile 的成功不能覆盖另一种。
- selection 文件被替换、扩权、硬链接、改写或 image 不匹配：在创建 deployment root 前拒绝。
- rollout 失败：既有 Compose/SQLite recovery contract 保持 authority；release gate 不增加自动清库、删卷或覆盖 receipt 的能力。

## 部署与资源影响

- 额外成本只发生在 Local/All 正式发布 runner：一次 catalog 消费、一次 selection 物化、一次 image pull 和 Edge/Standalone 各一轮 rollout。
- 设备只消费最终 selection 和 immutable image；不安装 Node workspace、regctl、Cosign、GitHub CLI 或发布凭据。
- Cluster-only 发布不运行本门；Local-only 发布不运行 K3s，也不等待 Worker/CloudNativePG 私有证据。
- 两次 rollout 顺序执行，复用一个小型 selection；没有 per-device queue、daemon 或后台连接。

## 被拒绝的替代方案

### 继续依赖 publisher 内的 pushed-digest rollout

拒绝。它早于完整 release-set/catalog，且继承 publisher 的文件和登录态，无法证明公开消费者得到的 selection 可用。

### 把 release-set artifact 直接交给 Compose

拒绝。90 天 artifact 不是长期 discovery authority，也绕过 durable catalog 的 immutable manifest、签名、provenance 和 byte round-trip。

### 只检查 selection JSON，不运行容器

拒绝。结构审计不能覆盖 Profile compose merge、只读根、SQLite backup/restore、健康收敛和 graceful stop 的实际产品链。

### 在路由设备上执行公开 catalog 验签

拒绝。它会给低配用户增加发布工具、网络、凭据和维护负担；设备目标侧只需消费已由可信工作站生成并审核的有界 selection。

## 验证

- catalog selection 参数、权限、摘要、image/source/catalog 漂移与 synthetic compatibility：5/5；
- release workflow、deployment lock、catalog consumption 与负向 mutation 定向契约：116/116；
- 完整 backend 为 1,351 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0；package boundary 保持 18 packages 且
  `singleSourcePackages=[]`、`shallowSourcePackages=[]`，相关依赖、Edge import、发布、部署锁与版本审计全部 compatible；
- 14 档 Local artifact 全部 compatible 且与 D-344 字节基线完全一致；发布工具与工作区依赖没有进入 Edge/Standalone 制品；
- 本切片无数据库、migration、SQL、role、Pool 或 Cluster runtime 变化，不以 PostgreSQL HA 替代 Local 门；阶段完整性仍重跑
  PostgreSQL 18.6/arm64 物理 HA 142/142、timeline `1→2`，独立 evidence audit 通过且 Docker 残留为 0；
- 当前没有可供独立消费者拉取的公开 QingLong 3 Local immutable GHCR image，因此仓库内 selection/静态 workflow 证据不记为真实公开
  catalog-bound Docker Compose 成功；
- 公开成功记录继续等待实际受保护 release tag，不能用 fixture 提前改为完成。
