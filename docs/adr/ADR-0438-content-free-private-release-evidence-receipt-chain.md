# ADR-0438：内容无关的私有发布证据收据链

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-333、D-335、D-336、D-346
- 关联 ADR：ADR-0245、ADR-0264、ADR-0425、ADR-0427、ADR-0428、ADR-0430、ADR-0436、ADR-0437
- Supersedes：ADR-0427 的 release-set v1 聚合边界，以及 ADR-0428 的 release-set v1 OCI media type

## 上下文

Cluster/All 发布已经要求两个 commit-scoped、24 小时内的私有门成功：Worker management 重新审计五份来源报告，CloudNativePG
disaster recovery 重新审计对象存储 backup/WAL/latest restore/PITR、证书轮换和三项静态供应链锁。publisher 通过 `needs` 只能看到 job
成功或失败，最终公开 release-set 却只记录候选策略中的“这些证据必须存在”，没有绑定本次 workflow attempt 实际审核的报告摘要。

因此 durable catalog 可以证明镜像、source 和 deployment family，却不能证明某个 Cluster release-set 对应哪一组私有发布证据。直接上传
原始报告会泄漏生产环境事实并扩大保留面；只依赖 GitHub job 状态又会在 workflow artifact 过期后丢失可验证的发布闭包。

## 决策

1. 两个私有 evidence job 在既有 release gate 成功后，各自产生一份
   `qinglong/private-release-evidence-receipt@v1`。收据精确绑定 release version、40-hex source revision、source tag、`cluster|all`
   scope、evidence kind、report SHA-256、观测/审核时间和 24 小时窗口，并具有自身 canonical SHA-256。
2. Worker 收据只投影 source-aware 聚合报告摘要。CloudNativePG 收据额外投影 backup、Barman Cloud 与 cert-manager 三项静态审计结果摘要；
   静态 selection lock 继续保持 `releaseReady=false`，因为它自身不携带时效证据。实际某次发布是否 ready 由收据与 release-set 闭包决定，
   不能永久翻转一个静态文件来冒充持续有效的现场证据。
3. 收据不得包含原始报告、路径、credential、token、连接信息、私钥、Kubernetes 对象或命令 transcript。它显式声明
   `sourceReportsUploaded=false`、`privateReportContentPublished=false`，并诚实记录公开消费者无法在缺少私有报告时重放外部结果。
4. 私有 job 只上传收据文件，保留 1 天；原报告仍只存在于 commit-scoped ephemeral runner mount，禁止 cache 或 artifact 上传。artifact 名必须
   同时绑定 `run_id/run_attempt/evidenceKind`，下载时也必须使用同一模式。
5. release-set 升级为 `qinglong/release-set@v2`：`local` scope 必须恰好零份收据；`cluster|all` 必须按固定顺序恰好包含
   `worker-management` 与 `cloudnativepg-disaster-recovery` 两份同 release identity 收据。缺失、重复、额外 kind、source/scope、freshness、
   static audit 或任一 digest 漂移均在 tag promotion 和 catalog publication 前失败关闭。
6. release-set v2 把完整 content-free 收据嵌入自身并纳入 `releaseSetDigest`，随后由 file provenance、OCI catalog immutable digest、Cosign 与
   GitHub provenance 共同保护。原始 1 天 receipt artifact 只是跨 job 交接，长期 authority 是公开 catalog 中的 release-set v2。
7. OCI artifact/file media type 升为 `application/vnd.qinglong.release-set.v2+json`。不能用 v1 media type 承载新增字段，也不接受 v1
   release-set 进入新部署锁或 catalog consumer。
8. 不新增 workspace package、production dependency、数据库、migration、listener、timer、controller、Pod 或设备侧工具。所有新工作只发生在
   Cluster/All 的短生命周期 release runner；Local 发布不等待私有 evidence job，Edge/Standalone 只消费工作站生成的 selection 与 immutable
   image。

## 失败与恢复

- 私有报告不新鲜或 source 不匹配：私有 job 失败，不生成收据；重新取得同 source 的现场证据后重跑受保护 tag。
- 收据 artifact 缺失、来自其他 attempt 或目录中出现额外文件：release-set 聚合失败；不能以 job success 或手工 digest 替代。
- 收据已生成但 publish matrix 失败：不 promotion；同一 tag 重跑必须重新审核仍在时效窗口内的证据并产生新收据。
- catalog 消费者可验证收据结构、自摘要和 release-set 闭包，但不能声称重放了私有现场结果；需要审计原始事实时进入受控私有 evidence 环境。
- v1 release-set：3.0 尚未正式发布，不提供隐式兼容；从同一 source 重新执行 release workflow 生成 v2。

## 部署与资源影响

- Local scope 的 release-set v2 收据数组为空，不启动两个私有 runner，不增加路由设备下载、CPU、内存或稳态连接。
- Cluster/All 的公开 release-set 增加两份小型 content-free JSON，节点无需安装证据工具或访问私有报告；可信工作站随 catalog 一并审核。
- 原始证据不离开私有 runner，公开内容仅能做 equality/source/freshness binding，不能反推出 credential 或生产对象内容。

## 被拒绝的替代方案

### 只依赖 GitHub `needs.<job>.result`

拒绝。它是瞬时调度事实，不能进入 release-set digest，也无法在 workflow 记录过期后由部署者独立核对。

### 上传全部私有证据到 release-set job

拒绝。公共 publisher 不需要原始生产事实；扩大跨 runner 传输和保留面违反最小披露边界。

### 把静态 Barman/cert-manager lock 永久改为 release-ready

拒绝。静态供应链选择没有 24 小时 freshness、backup/PITR 或 rotation 事实。ready 是 source-scoped release 结论，不是永久 lock 属性。

### 只在 image record 中加入一个布尔值

拒绝。布尔值无法绑定证据内容，也会把 deployment-family 级事实复制到每个镜像 publisher；release-set 才是跨镜像与私有证据的唯一终态 authority。

## 验证

- receipt contract 覆盖 Worker/DR exact projection、source/scope/freshness/report/static-lock/self-digest 漂移、私有字段注入、closed CLI、stable
  private read、mode `0600` no-replace 和内容无关输出；
- release-set contract 覆盖 Local 零收据、Cluster/All exact-two、缺失/额外/漂移收据、v2 standalone inspection 与 digest 闭包；
- workflow 静态门冻结同 attempt artifact、私有报告不上传、两份收据 create/audit、release-set 下载与 aggregate/audit handoff，以及 v2 OCI media type；
- 定向契约 134/134，完整 backend 为 1,360 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0；12 项架构/部署审计和 14 档
  Local artifact 全部 compatible，workspace 保持 18 packages 且没有 single-source/shallow-source package；
- PostgreSQL 18.6/arm64 HA 重跑 142/142 gates、timeline `1→2`，独立 evidence audit compatible，报告 SHA-256 为
  `1e7c31cc6c7aa3e1e0398eb51696b6054850d5fc25910a08d6faffc9a75f1c6f`，container/network/volume 残留为 0；
- 完整结果同步记录于 QL-RFC-0001 D-346；首份真实公开收据和 catalog 仍须由受保护 `v3` release tag 产生。
