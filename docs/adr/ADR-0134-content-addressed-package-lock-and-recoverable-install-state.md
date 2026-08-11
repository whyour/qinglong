# ADR-0134：内容寻址 PackageLock 与可恢复安装状态

- 状态：Accepted（OCI/offline 来源锁、digest-bound Approved Action、CAS 安装记录、
  exact staging/activation receipt 和有界恢复判定已实现；ADR-0135 已补确定性签名
  bundle 检查与 POSIX 私有 staging，ADR-0136/0137 已补 SQLite/PostgreSQL durable
  repository，ADR-0138 已补完整 lock 持久化、激活协调器与本地 pointer publisher；
  原子资源 generation 发布与生产 composition 仍未开放）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-130、D-132

## 背景

ADR-0132 已能规范化 Package Manifest 并生成安装、升级和回滚预览，但预览本身不能
证明最终安装的仍是用户审批的字节。若后续安装器只保存 Package 名称和版本，会留下：

- OCI tag、URL 或本地路径在审批后改变；
- Manifest、解包内容和权限预览来自不同制品；
- upgrade 激活到一半时先撤销旧版本，重启后两代都不可用；
- `activating` 状态被盲重放，导致重复注册 Task、Tool 或 Trigger；
- SQLite 与 PostgreSQL adapter 各自发明状态和恢复语义；
- 低配设备为了尚未启用的安装器常驻 watcher、timer 或下载进程。

PackageLock 和安装状态机必须先成为 profile-neutral 领域契约，再允许文件、OCI、
SQLite、PostgreSQL 或 Kubernetes adapter 消费。

## 决策

### 1. 继续留在 `@qinglong/runtime-core`

新增 `plugin-package-install` subpath，不新增 workspace package或第三方依赖。它与
Manifest、Tool Registry 同属核心契约，但不读取文件、网络、数据库或环境，不拥有
下载、解包、动态 import、注册或执行能力。

禁用插件时现有 edge、standalone、cluster-control 和 worker composition root 不加载
安装 adapter，也不增加 timer、socket、连接或后台进程。

### 2. 来源只能是不可变内容地址

首版来源锁只接受：

- 带 exact `@sha256:<64 hex>` 的 canonical `oci://` locator；
- 不保存主机路径的 `offline:sha256:<64 hex>` bundle identity。

两者都必须同时声明 1 byte–1 TiB 的 artifact 长度、artifact SHA-256 和解包后
content SHA-256；locator 中的 digest 必须与 artifact digest 相同。拒绝 tag、
`latest`、任意 HTTP URL、query、fragment、可变文件路径和 digest 不一致。

`offline` 只表达审批和审计中的来源身份，不授权打开任意路径。未来 POSIX adapter
必须另外取得私有文件 capability，且读取后复验 artifact/content digest。

### 3. PackageLock 精确绑定预览与已消费审批

`PluginPackageLock` 固定：

- Project、Package name/canonical SemVer、install/reinstall/upgrade/rollback；
- OCI/offline 来源、artifact/content digest 与字节数；
- normalized Manifest digest 和 compatible install plan digest；
- planner 使用的 QingLong/runtime/资源环境摘要，且 target 架构/Profile 必须一致；
- architecture、deployment Profile、target generation；
- upgrade/reinstall/rollback 的 previous lock digest；
- Approval request/version、immutable dispatch、human approver、有效期和
  Project/RoleBinding fence；
- action、preview 与完整 lock digest。

action digest 覆盖所有可能改变安装结果的字段。Approval 的 action digest 必须与其
一致，preview digest 必须等于 install plan digest；PackageLock 只能在审批有效期内
创建，且安装记录必须在同一已消费审批有效期内建立。所有 Package 安装仍要求
`user` subject 的人工审批，Agent、MCP Client、API App 或 system 不能充当 approver。
构造 Lock 时必须用 exact environment 和 previous Manifest 重新执行 ADR-0132
planner，结果与传入 plan 摘要一致；不能把低风险伪 plan 与另一份 Manifest
分别摘要后一起锁定。

新安装只能使用 generation 1 且没有 previous lock；upgrade、reinstall 和 rollback
必须创建 generation 2+ 的新 lock，并绑定 previous lock。回滚不是把旧状态倒写，
而是以旧内容作为候选生成一个新的、可审计的 generation。

### 4. durable 状态机不拥有副作用

安装记录只有：

```text
queued -> staged -> activating -> active
   |         |           |
   +---------+-----------+-> failed
```

- `queued`：PackageLock 与已消费审批已耐久保存；
- `staged`：artifact、Manifest 和 content digest 全部与 lock 相同，并保存摘要保护的
  staging receipt；该 receipt 同时绑定 adapter 可重新检查的外部 evidence digest；
- `activating`：外部 adapter 可以开始原子发布，但 active pointer 仍指向旧 lock；
- `active`：只有绑定 installation、generation、previous pointer、stage 双证据和
  content 的 exact activation intent receipt 提交后，active pointer 才切换到候选 lock；
- `failed`：保留失败阶段和受审 reason，active pointer 仍指向旧 lock。

首装失败时 active pointer 保持 null；升级或回滚失败时旧版本继续 active。终态不能
原地重试，必须创建新 mutation 或新 PackageLock，避免覆盖历史证据。

### 5. CAS、幂等与恢复必须显式

记录带单调 version、last mutation ID/digest 和 record digest。纯领域转换对最后一次
完全相同的 mutation 返回 existing 语义，同 ID 不同内容失败关闭。repository port
接收 expected version、expected record digest、mutation ID/digest 和完整 next record；
adapter 必须以事务 CAS 和 mutation ledger 实现 exact replay，不能只做 last-write-wins。

恢复扫描每页最多 64 条：

- `queued` → `resume_stage`；
- `staged` → `resume_activation`；
- `activating` → `inspect_activation`；
- `active | failed` → `none`。

`activating` 只能检查外部 activation fact，再决定提交 receipt 或失败；禁止直接重放
发布。这与进程启动、Approved Action 和 PostgreSQL COMMIT-response-loss 的既有原则
一致：不确定结果先 inspect，不把异常冒充 rollback。

### 6. 本地协议闭环已可执行，但 production 仍 unreachable

ADR-0135 已实现 runtime-core 纯流式确定性 USTAR/Ed25519 检查器与 local-admin 私有
文件 staging adapter，但两个入口都是显式 subpath，未接入生产 composition。

ADR-0136 已实现本地 SQLite migration/schema/readiness、head CAS、mutation ledger 和
current-head recovery scan；ADR-0137 又以同一可执行合同完成 PostgreSQL
migration/schema/admin-only repository parity。ADR-0138 进一步要求 queued record
与完整 PackageLock 原子保存，并实现了显式 fresh/recovery activation coordinator、
本地 POSIX pointer publisher 和注入 Approved Action consumer 的 SQLite 端到端组合。
这些能力仍只存在于按需 subpath。本 ADR 仍不实现：

- OCI client、publisher trust 获取/撤销和官方索引；
- 具体 Approved Action 产品 consumer、管理 API/CLI/UI 和 startup lifecycle；
- Task/Workflow/Prompt/Tool 的原子注册与旧 generation 退役；
- Kubernetes resource 或数据库 active generation publisher；
- production startup recovery coordinator 与 operator repair workflow；
- Trigger pause/health check、Runtime Extension 或动态代码加载。

在 adapter、Approved Action consumer、原子发布、Audit 和启动恢复闭环前，生产
composition 不得暴露安装入口。

## 影响

- 审批对象从“名称与版本”提升为 exact artifact、内容、Manifest、计划和目标环境。
- edge 可使用无路径的离线 bundle identity；cluster 可使用 exact OCI digest，二者共享
  同一状态机。
- upgrade/rollback 不会在候选激活前移除旧 generation。
- `packages/` 仍为 21 个 importer；ADR-0135 也只在既有 runtime-core/local-admin
  增加按需 subpath。
- 该 contract 不是零闪存成本：加入 ADR-0138 的显式 activation/installation subpath
  后最大制品为 2,825,780 bytes/437 files，最大单次 RSS delta 12,615,680 bytes，
  loaded module 数仍为 72，低于 4 MiB/512 files/16 MiB 硬门禁。
- SQLite/PostgreSQL adapter 已共用同一 CAS/receipt/recovery 可执行合同，后续变更
  不能自行缩窄任一端安全语义。

## 验证

单元测试必须覆盖：

1. immutable OCI PackageLock 与 plan/approval digest binding；
2. 不保存主机路径的 offline bundle；
3. mutable source 与 source digest mismatch 拒绝；
4. detached、过期和非人工 Approval 拒绝；
5. exact environment/previous Manifest planner 重算与伪 plan 拒绝；
6. upgrade/rollback previous lock 与 generation 约束；
7. queued record 保留 previous active pointer；
8. exact staging receipt 与 lock mismatch 拒绝；
9. activating 阶段保持旧 active，commit 后才切换；
10. failure 保留旧 generation；
11. last mutation exact replay 与 mutation conflict；
12. 非法转换、时间倒退和 record tamper；
13. exact CAS commit envelope 与 immutable identity；
14. `activating -> inspect_activation` 及 64 条 recovery page 上限；
15. 根入口与 `plugin-package-install` subpath 导出一致。

ADR-0138 加入后当前针对性结果为 runtime-core 215/215、local-sqlite 68/68、
local-admin 50/50、cluster-postgres 非数据库全量 124 pass/1 skip，真实四角色
PostgreSQL 28 pass/1 skip。21 个 importer 的 clean build/聚合测试退出 0，
dependency/source boundary 与 edge import 均通过且 `findings=[]`；六种 Profile
artifact 全部通过，PostgreSQL 18 HA 的 21 个具体 gate 与总 `passed` 全为 true。
