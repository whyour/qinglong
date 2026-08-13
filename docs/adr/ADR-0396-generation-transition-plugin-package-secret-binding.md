# ADR-0396：按 Package generation 切换 Plugin Package Secret binding

- 状态：Proposed
- 日期：2026-08-13
- 关联 RFC：QL-RFC-0001 D-306B2
- 关联 ADR：ADR-0393、ADR-0394、ADR-0395

## 问题

D-306B1 只允许给当前 active 且尚未绑定的 Package generation 做首次 Secret binding，并永久禁止更新或删除历史 binding。现有安装状态机已经能够安全发布 `upgrade|rollback|reinstall` 的下一代并在发布失败时保留旧 active lock，但 binding 管理面只能从当前 active generation 生成计划，资源 materialization 又要求目标 generation 已有完整 binding。直接复用 B1 会在“下一代 activation 前需要 binding”和“只有 activation 后才能 bind”之间形成时序环。

仅增加一个 `rebind` 命令也不完整：普通 Package 升级即使沿用原 SecretRef，新 generation 仍需要独立 binding；同名 Secret 的版本前进、版本倒退、换名、optional 解绑、requirement 删除和新增具有不同风险；紧急撤权也不能假装发布新 generation 可以追回已经交给运行中进程的 Secret 明文。

## 决策

1. Secret binding 永远以 resource generation 为不可变主键。B2 不更新、不删除历史 binding，也不让 binding 脱离 Package install/lock/generation 链独立前进。
2. 新的共享 `qinglong/plugin-package-secret-binding-transition-plan@v1` 同时绑定上一代 target、可选的上一代完整 content-free binding、上一 active lock、服务端从 durable install history 得到的 `previousAttemptGeneration`、新 generation target、可选的 B1 binding plan、逐 requirement 差异和 domain-separated transition digest。上一 active Manifest 没有 Secret requirement 时不存在历史 binding，但 target/lock/generation lineage 仍必须完整保留；若 binding 存在，它必须精确匹配上一 target。新目标必须与上一代属于同一 Project/Package，generation 精确等于最后一次尝试 `+1`，使用不同 installation/lock，并由 `previousActiveLockDigest` 精确指回上一 active 代。失败尝试也永久消耗 generation，后续重试不能重用已留有 binding/evidence 的序号。
3. 服务端分别推导 requirement 的 `added|removed|tightened|relaxed|unchanged` 和 SecretRef 的 `bound|revoked|rotated|rebound|unchanged`，调用方不能自报变更类型。只有同 Project、同 Secret name、显式 version 严格增加才是 `rotated`；版本倒退、换 Secret name 或从未绑定变为绑定均为 `rebind`。移除 requirement 或从已绑定变为 `null` 为 `revoke`。
4. transition 顶层 kind 按风险收敛：存在 revoke 即为 `revoke`；否则存在 requirement 变化、首次绑定或 rebound 即为 `rebind`；否则存在 forward version change 才为 `rotate`；完全相同才为 `carry-forward`。逐项 changes 保留完整事实，顶层 kind 不能掩盖混合变化。
5. B2 的最终产品顺序固定为：审查并批准下一代 install lock → stage public Package bytes → 从 staged lock/Manifest、上一 active target 与可选 binding 构建 transition plan → Local Owner confirmation 或 Cluster separation-of-duty Approval → 在 activation 前发布目标 generation binding → materialize/reconcile 目标资源 → CAS active pointer/head。任一步失败都不得移动 active pointer，旧 generation、旧 binding 和已 materialized revision 继续可用。
6. `carry-forward` 仍必须生成新 binding 和新 evidence，不允许让下一代按运行时规则回退读取旧 binding。rollback 同样创建新的 generation/binding；它可以重新选择历史 SecretRef，但版本倒退按 `rebind` 审批，不能伪装为 rotate。若下一 Manifest 已删除全部 Secret requirements，transition 仍保留新 generation target 和撤销差异，但 `nextBindingPlan` 必须为 `null`，不得绕过 D-305 制造空 binding。
7. 紧急 revoke 分成即时围栏与代际收敛两步：先复用 lifecycle disable/quarantine withdrawal 阻止新 Task/Workflow/Prompt admission，再以新 generation 删除 requirement 或置空 optional binding。B2 不声称能追回已注入运行中进程的 Secret，相关 Run 必须由既有 stop/cancel/lease convergence 处理。
8. 共享 contract 归入现有 `@qinglong/runtime-core/plugin-package/secret-binding/`，不新增 workspace package。Local 复用单 SQLite operation authority；Cluster 复用 package-manager/package-executor 与现有 PostgreSQL Pool，不新增常驻进程、连接、timer、watcher 或 cache。

## 接受条件

- 共享 contract 覆盖 carry-forward、forward rotation、version rollback、换名 rebind、requirement add/remove、无历史 binding 时首次增加 Secret、optional revoke、跳代/断链/同 installation 拒绝、shape/digest tamper 和 exact replay。
- Local 在一个受围栏事务中证明目标 install 为 staged、上一 active binding 精确匹配、Secret versions 存在、transition 获 Owner confirmation，并在 activation 移动指针前持久化目标 binding；崩溃窗口不得切走旧代。
- Cluster 以 package-manager 生成不可伪造 transition plan，以独立 User 决策，并由 package-executor 在 activation 前发布 binding；manager 仍不能读取 binding 表或 Secret value。
- SQLite/PostgreSQL migration、trigger/readiness 与最小权限角色显式支持 staged-target binding，而不放宽为任意未来 generation 写入。
- 完整 18-package build/test、backend、package/dependency/deployment/edge/import 审计与真实 PostgreSQL/Kubernetes 升级、失败回滚、rotation/revoke 现场门通过；低配设备不得增加常驻资源。

## 当前进度

- 已冻结共享 transition plan v1 的 lineage 与差异分类语义，并完成 Local/Cluster 的 activation 前持久化门：SQLite capability v48 通过 migration 0095/0096、PostgreSQL capability v61 通过 migration pg0062，把 repository 写入和数据库 trigger 同时约束为“当前 active target”或“由完整上一 active lineage 支撑、且为 durable install history 最大 generation 的 staged target”。`queued|activating|failed`、陈旧/跳代 staged target、断裂 lineage 与直接 SQL 绕过均失败关闭；readiness 校验 exact trigger/function attachment，避免 schema 名义升级但约束缺失。
- 本切片没有新增 workspace package、第三方依赖、表、连接、daemon、timer、watcher 或常驻资源；Edge/Standalone 只增加 SQLite schema guard，Cluster 复用既有 PostgreSQL Pool/role。完整 18-package 串行测试与 backend 门已通过；真实 PostgreSQL 18.4 的 migration/runtime role 门证明 active、合规 staged 与 exact replay 可写，activating、陈旧/非最大 staged 以及直接 SQL 可被拒绝。
- Local Owner 与 Cluster management/executor 尚未消费 transition plan，完成“审批 → 发布 binding → materialize → active CAS”的产品纵切面；真实 Kubernetes rotation/revoke、升级失败回滚及物理低配设备证据也仍待完成。因此 ADR 继续保持 Proposed，下一切片只补产品编排，不再扩张 package 或常驻部署面。
