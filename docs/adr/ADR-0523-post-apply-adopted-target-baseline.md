# ADR-0523：Apply 后的 Adopted Target 启动前基线

- 状态：Accepted（D-426b2a 源码候选；阶段实物尚未闭合）
- 日期：2026-08-30
- 决策：D-426b2a

## 上下文

D-426b1 已生成 Application v4 与内容绑定的离线 `docker-target.json`，但既有 clean rollback 判定只把 SQLite activation 中的初始 target SHA-256 当成目标基线。受认证 `local-data-directory.adoption.apply` 必然在 target 启动前向同一 SQLite 写入 Project、加密 Secret、disabled model、audit 与 receipt；因此合法 apply 后的 target 与 activation 内容摘要必然不同。若继续使用旧判定，未产生任何 post-cutover 写入的 target 也会错误进入 `reconciliation_required`；若直接把 activation 基线全局替换，又会削弱 fresh、v3、service-manager 和历史回退语义。

同时，target controller 原先只接受 Application v3，不能消费 D-426b1 生成的 v4 配置。这个矛盾意味着仅靠绿色源码无法形成新的阶段升级产物。

## 决策

只有 `docker-target` adopted bundle 在受认证 apply 已提交、target 尚未启动时发布私有 `service/adopted-target-baseline.json`。基线固定绑定：

- Profile、instance、cutover、准备时间；
- activation 与 legacy-stopped commitment digest；
- Application v4 semantic digest；
- legacy data application commit/receipt digest；
- target canonical path digest、device、inode、SHA-256；
- `targetSidecarsClear=true`；
- 上述 payload 的自摘要 `baselineDigest`。

publication 使用现有 no-replace 私有文件协议。存在 SQLite WAL/SHM/journal、目标身份变化、配置/commit/receipt 漂移、基线缺失或自摘要不一致都 fail closed。

target controller 同时接受原有 Application v3 与 adopted Application v4：

- v3/fresh 继续以 activation target SHA-256 判定，记录形状和旧语义不变；
- v4 必须读取并闭合 post-apply baseline；不得在缺失时退回 activation；
- v4 停止证据新增 `baselineKind=adopted_target`、`baselineDigest` 与 `targetMatchesBaseline`，同时保留真实的 `targetMatchesActivation`；
- baseline 未变且 legacy source/sidecar 未变才是 `rollback_candidate`；target 启动后发生写入则为 `reconciliation_required`；基线无法证明则为 `manual_review`。

旧 reconciliation journal 继续按原 exact shape 验证。新 shape 只对 adopted baseline 开放，并要求 disposition 与 `targetMatchesBaseline`、sidecar、source facts 一致。没有新增 workspace package、生产依赖、daemon、listener、timer、watcher 或稳态资源。

## 阶段实物门

本 ADR 只闭合此前不合理的 rollback 语义，仍不是新的可下载 Trial Kit。D-426a 双架构 headless bundle 仍是当前可交付的升级阶段实物。只有同源原生 amd64/arm64 artifact job 在将要上传的 exact bundle 上完成：

1. reviewed stage/verify；
2. versioned transform/verify；
3. Owner credential + `secret.manage` 认证的 apply/verify；
4. exact offline image target 创建；
5. 真实 legacy stop、target start/stop；
6. v4 baseline 绑定且最终为 clean `rollback_candidate`；
7. bundle 与 milestone 离线审计；

才能把 D-426b2 升级为阶段实物。任何一步只在仓库测试 fixture 中通过都不能替代 exact 上传包演练。

## 后续

D-426b2b 实现并审计上述 exact bundle 用户旅程，随后显式生成新的双架构 artifact。D-426c 继续处理 target 产生业务写入后的 capture、review、reconciliation 与恢复。
