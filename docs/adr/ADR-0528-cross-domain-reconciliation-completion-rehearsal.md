# ADR-0528：跨域 reconciliation completion 演练

- 状态：Accepted（D-426c3 源码候选，阶段实物以双架构 artifact gate 为准）
- 日期：2026-09-02
- 关联：ADR-0526、ADR-0527、D-397、D-398、D-399、D-426c3

## 背景

ADR-0527 已证明 exact stopped capture 可以经外部 review/Automation 决策完成一次正式 Automation 应用并回滚，但交付链仍停在 `reconciliation_automation_rolled_back`。产品代码已经具备 Secret/Config plan/decision/apply、Run History append-only preservation 和 completion v3；缺口在于 Trial Kit 没有把这些能力组成一个可下载、可审计、可中断重放的阶段产物。

同时，原有诊断把 Legacy `Apps`/`Auths` 的空表与含真实身份数据的表一律视为 `identity_custody_required`。2.x readiness 又要求这两张表存在，因此删除表制造“可完成样本”会被正式 inspector 拒绝，而保留空表又永远无法完成。这是状态分类不精确，不应由 fixture 绕过。

## 决策

1. `reconciliation-rehearsal.sh` 保留 ADR-0527 的 `prepare`、`review`、`apply-rollback`，新增 `apply-plan` 与 `complete`，不把人工决策合并为一个自动命令。
2. `apply-plan` 消费两个互相独立的 owner-private 文件：Automation row decision 和原始 review decision。它先应用并验证 Automation，再在该 exact head 上保存双侧终态 Run History，随后生成并验证 Secret/Config plan，停在 `secret_config_decision_required`。
3. `complete` 消费外部 Secret/Config candidate decision 和原始 review decision，执行 decision commit/verify、apply/verify，并以 completion v3 同时绑定 Automation apply、Secret/Config apply 和 Run History preservation。成功终态固定为 `reconciliation_completed` 且 `adapterCount=3`。
4. Run History 必须位于 Automation apply 与 Secret/Config plan 之间。preservation 不推进 instance head；Secret/Config plan 会推进 head。倒置顺序会使 preservation 丢失允许的 compare-and-swap 来源状态。
5. target 和 Legacy 在 completion 后继续保持 stopped。脚本固定 `targetRestart=not_authorized`、`legacyRestart=not_authorized`；重启属于后续独立 authority ceremony。
6. 外部 decision 目录必须为 current-UID `0700` canonical directory、恰好包含一个 `0400|0600` regular file、与所有 authority/Legacy root 不重叠，并整体只读挂载。两个 decision 不得放在同一父目录。
7. completion-ready 2.x fixture 保留 readiness 所需完整 schema，只移除未知 `PluginOwnedState`，并让 `Apps`/`Auths` 保持空表。诊断仅在 Legacy 已知 identity-policy 表全部为空时把该域降为 `informational/catalog_evidence`；任一 identity 行、未知 schema、目标侧 identity 或查询异常仍维持原有 required/blocked 行为。
8. CI 同时保留一条 apply→verify→rollback→verify 流和一条独立 completion-ready 全链，避免 completion 证明覆盖回滚证明。fixture/decision generator 只存在仓库 CI，不进入 Trial Kit。
9. Trial Kit、verification、offline audit 升为 `@v11/@v9/@v8`，manifest `schemaVersion=12`；Local milestone 升为 `@v7`、`schemaVersion=7`。新增 required gate `legacyUpgradeReconciliationCompletion=passed`，旧证据不会被新 auditor 接受。

## 资源与产品边界

- 所有 reconciliation Operator 命令继续使用 128 MiB memory/swap、0.5 CPU、32 PID、无网络、只读 rootfs、drop-all 和 no-new-privileges；低配设备默认 headless 不变。
- 本切片不增加 package、production dependency、daemon、listener、timer、watcher、连接池或稳态资源。
- completion 是 stopped-state durable fence，不是 target/Legacy 重启授权、生产升级、Public Release 或用户真实数据自动迁移承诺。
- Cluster 继续使用 PostgreSQL/Kubernetes authority，不复用 Local SQLite/POSIX/Docker ceremony。

## 后果

阶段产物将同时回答两个问题：Automation 是否能安全回滚，以及可适配的 Automation、Secret/Config、Run History 是否能在服务仍停止时形成可验证 completion。含真实 Legacy identity 数据、未知 schema、Secret/Config 冲突、非终态 Run 或缺少任一外部 decision 的部署仍会失败关闭，需要后续专用 adapter 或人工恢复方案。
