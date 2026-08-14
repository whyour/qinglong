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
- Local Owner 产品纵切面已完成：新增私有短命令 `plugin-package.secret-binding.transition.plan|execute`，从当前 staged head、上一 active install/proposal/lock、历史 binding 与 durable 最大尝试 generation 重建计划；Owner 重新鉴权后在一个 `BEGIN IMMEDIATE` 中原子写入可选目标 binding、allowed audit 和 immutable transition receipt。相同 plan/audit 可跨时钟 exact replay，revoke 通过 `bindingDigest: null` receipt 表达，不制造空 binding。
- SQLite capability v49（0097/0098）新增 transition receipt ledger、exact schema/readiness/typed schema 和插入 trigger。安装恢复在缺 receipt 时不扫描该 staged generation，旧 active 继续服务；共享 activation prerequisite 在直接安装/恢复路径再次 fail-closed 检查 receipt，receipt 到位后才允许 active CAS。没有新增连接、timer、watcher、常驻进程、workspace package 或第三方依赖，Edge/Standalone/Adopted 共用同一 SQLite authority。
- PostgreSQL capability v62（pg-0063）新增不可变 transition receipt ledger。package-executor 在一个 SERIALIZABLE transaction 内复验 current staged head、上一 active lineage、durable 最大 generation 与可选上一 binding，随后原子写入目标 binding（revoke 时为空）和 receipt；数据库 trigger 独立重验 staged target，角色只取得 receipt 的 `SELECT, INSERT`。安装恢复与直接 activation 共用 receipt prerequisite，缺 receipt 的 staged generation 不进入激活候选。真实 PostgreSQL 18.4 已通过 63 条 migration、最小角色 readiness、binding+receipt 原子提交、exact replay、activating/错误 lineage 拒绝；同时修复并回归了 PostgreSQL `jsonb` 对象键重排后的 transition plan 归一化，digest 与语义校验不依赖对象属性顺序。
- 阶段完整性门已串行复验：18 个 `ql3-*` workspace package 的统一 clean build/test 退出 0；backend 共 1194 项，1192 pass、2 条条件 skip、0 fail；PostgreSQL 18.4 arm64 physical HA 完成 timeline `1→2` 提升并通过 125 项门禁，报告 SHA-256 为 `a72477cfd40e9945fd97ed18dd014f4600e0049a29285990c6359054309db812`。package boundary、cluster dependency 与 edge import 审计均无新增越界；这些证据证明当前 authority 与既有运行路径兼容，不替代尚未完成的真实 Kubernetes rotation/revoke 和固定低配物理设备验证。
- Runtime Core 534/534、Local SQLite 235/235、Local Admin 91/91、Local Owner CLI 165 pass/5 条 root-only skip、Local Application 47 pass/4 条平台 skip，合计 1072 pass/9 条条件 skip/0 fail；定向纵切面覆盖 staged 阻断、Owner plan/execute、binding+receipt 原子提交、跨时钟 replay 和 receipt 后恢复激活。
- Cluster management/executor 的 separation-of-duty 产品编排仍未消费 transition plan；真实 Kubernetes rotation/revoke、升级失败回滚及物理低配设备证据也仍待完成。因此 ADR 继续保持 Proposed，下一切片把既有 package-manager Approval 与 package-executor 接入这条 durable authority，再进入 Kubernetes/低配现场门。
- 后续切片已经完成 Cluster transition Approval/执行、Kubernetes active pointer v3 与三节点 rotation/revoke rollout 原语现场门；该历史未完成描述由本条取代。当前 executor 重构进一步增加 exact `dispatchById` start-barrier 路径和由 durable dispatch + approval plan 联合绑定的 action-scoped Job renderer。常规 batch CronJob 不再挂载 `ql3-cluster-plugin-package-values`，也不注册需要 Secret projection 的 handler；action Job 只投影单动作所需的去重 SHA-256 key，固定 `0440`、`optional:false`、digest 镜像、tokenless ServiceAccount、单连接 PostgreSQL 与 48 MiB request。零 Secret transition 使用空目录而不是空 Secret `items`。因此“整个 optional Secret 暴露给批处理 executor”的生产缺口已经失败关闭，但自动 controller 仍未启用：Kubernetes `jobs.create` 是可间接选择镜像/ServiceAccount/Secret 的放大权限，必须由 ValidatingAdmissionPolicy（或同等级外部 admission）把 renderer 契约固定后，才允许 create/get-only RBAC、响应丢失收敛与失败 Job 恢复。升级失败自动回滚、controller/admission/RBAC 真实门及固定物理低配证据继续阻断 ADR Accepted。
- 本阶段完整性门已闭合：18-package clean build/test 退出 0；backend 1195 项为 1193 pass、2 条条件 skip、0 fail；package boundary 仍为 18 个 package 且无 single-source/shallow-source package，cluster dependency、edge import、cluster deployment 均零 finding。Edge arm64 本机观测模块加载 RSS `+8,945,664` bytes、1 万行输出峰值 `+5,226,496` bytes，不冒充固定物理低配门。PostgreSQL `18.4` arm64 physical HA 125 项、timeline `1→2` 通过，报告 SHA-256 `45fab400eb449774d50429103dd766a2755166530ac54ddc1056f777bc16c15f`，临时 Docker 资源已清理。
- 后续 controller/admission 切片取代上一条“自动 controller 仍未启用”的历史描述：生产 executor 已接入确定性 create/get-only Kubernetes Job controller。它以 durable approval/execution 为唯一创建依据；CREATE 的 409 或响应丢失通过 exact GET 收敛，`executing` 但 Job 缺失、approval 过期、终态 Job 或 contract 漂移均进入 `recoveryRequired`，不自动重建可能已经产生外部效果的动作。常规 dispatcher 只查询已注册 action type，因此不会误领取 Secret action。
- Controller ServiceAccount 只具有 Job `create|get`，action ServiceAccount 无 API token且没有 Job/Pod/Secret 权限。`admissionregistration.k8s.io/v1` ValidatingAdmissionPolicy 以请求者身份和固定参数 ConfigMap 锁死 digest 镜像、command、ServiceAccount、source Secret、exact SHA-256 item/path、PostgreSQL SecretRef、安全上下文、资源与 volume/mount；`failurePolicy: Fail`、`parameterNotFoundAction: Deny`。基础 NetworkPolicy 保持 DNS-only，生产集群必须用私有 overlay 显式加入 API Server 精确 CIDR/TCP 443 出口，避免为 controller 放开任意公网。
- 真实 K3s `v1.34.3+k3s1` 现场门已证明策略可由 API Server 编译：合规 Job dry-run 被接受，镜像漂移和参数 ConfigMap 缺失被拒绝；controller SA 的 `list|watch|delete jobs`、Pod 创建和 Secret 读取均被拒绝，action SA 的 Job/Pod 创建和 Secret 读取也均被拒绝。实现没有新增 workspace package、Edge daemon/timer/watcher 或低配设备常驻负担，18-package boundary 继续为 `singleSourcePackages=[]`、`shallowSourcePackages=[]`。
- 本切片完整性门：controller/renderer/process 定向 18/18；cluster-admin 339 pass/3 条件 skip、cluster-postgres 328 pass/2 条件 skip；完整 18-package clean build/test 退出 0；backend 1196 项为 1194 pass、2 条条件 skip、0 fail；package boundary、cluster dependency、edge import、cluster deployment 均零 finding。PostgreSQL `18.4` arm64 physical HA 125 项、timeline `1→2` 通过，报告 SHA-256 `a3d34e61ea2064e1cde574e533137186e09fdce9048455da64f582906037fa0d`，临时 Docker 资源已清理。
- ADR 继续保持 Proposed：升级失败自动回滚、终态 Job 的 durable 恢复决议和固定物理低配设备证据尚未完成。当前 controller 明确暴露恢复要求，不以不安全的自动重试冒充闭环。
