# ADR-0484：私有 Reconciliation 诊断与受认证人工裁决

- 状态：Accepted（D-391 已实现并完成门禁）
- 日期：2026-08-21
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-64、D-87、D-184、D-259、D-383、D-389、D-390、D-391
- 关联 ADR：ADR-0064、ADR-0094、ADR-0095、ADR-0194、ADR-0201、ADR-0314、ADR-0315、ADR-0482、ADR-0483
- 细化：ADR-0483 的逐对象私有诊断、人工选择和审批边界

## 背景

ADR-0483 已把密封 capture 转换为固定八领域、内容无关的 `reconciliation_planned` summary。它能证明哪些领域一致、变化、分叉或必须
人工处理，但刻意不保存表名、业务标识、row value、Secret、credential、命令或日志。这样的 plan 适合审计、自动 fence 与低资源设备，
却不足以让 operator 判断具体对象应保留哪一侧、哪些事实必须交给专用 adapter、哪些只能在外部人工恢复。

不能通过扩大 plan 来解决该问题。把敏感明细写进 plan 会使长期 terminal receipt 变成数据副本，也会让 stdout、日志、Cluster consumer
和未来自动化意外获得内容读取面。另一方面，仅依赖一个 `0600` JSON 文件也不能证明真实用户完成了审阅；POSIX owner、容器 root 或遗留
脚本都不等同于近期强认证的人类 Owner。D-391 必须把“查看”“选择”“授权”和“执行”分开。

## 决策

### 1. Review 是独立状态机，不改变 plan 与 capture

既有 `ql3-local-deploy` 增加四个显式操作：

```text
local.deployment.reconciliation.review.prepare
local.deployment.reconciliation.review.diagnostics
local.deployment.reconciliation.review.commit
local.deployment.reconciliation.review.verify
```

prepare 只接受 exact terminal `planDigest`、`reconciliation_planned` instance head 和新 UUID `reviewId`，并以 CAS 推进：

```text
reconciliation_planned
  → reconciliation_review_prepared
  → reconciliation_reviewed
```

prepare 建立唯一 review fence 后，在 operator 显式提供的私有 `reviewRoot` no-replace 发布 intent。`reviewRoot` 与 deployment、capture、
plan root 必须两两不重叠；最多保留 64 个 review directory。target restart、Legacy rollback、第二个 review 和旧 plan 重放都不能越过
`reconciliation_review_prepared`。prepare response loss 必须 exact replay。

### 2. 诊断使用显式私有分页文件，不进入 stdout 或 terminal plan

diagnostics 每次只读取一个 database kind、一个固定领域和一个固定 fact kind，最多输出 64 条记录到 caller 显式提供的空目标文件。
目标父目录必须是当前 POSIX user 拥有的真实 `0700` directory；文件以 no-follow/no-replace、`0600`、file/directory fsync 发布。CLI
terminal response 只包含 `reviewId`、`planDigest`、page digest、记录数、完成标志和下一个有界 offset，不包含路径、对象名或对象 digest。

分页使用 `offset`，不是包含对象名的 cursor；每个 database 的 schema catalog 最多 4,096 条、table 最多 512 条，因此有界 OFFSET
不会形成无界扫描。page 绑定 exact `bundleDigest`、`planDigest`、review preparation digest、database kind、domain、fact kind、offset、
limit 和 bundle fingerprint。每次 SQLite open 前后继续执行 ADR-0483 的全资产 stat/hash 重验；main-only 与 WAL+SHM 的只读方式不变。

私有 page 可包含：

- schema/table 的名称、类型、所属表、领域、row count 与 fact digest；
- 已知 adapter 能安全解释的对象 ordinal、非 Secret 标签、状态、版本/时间边界和 canonical fact digest；
- `decision_requirement = informational | required | blocked` 与固定 reason code。

page 永不包含 SQLite schema SQL、Legacy command、日志、Secret/credential/token/key material、加密 envelope、Prompt/Tool payload、Artifact
内容或任意未设上限的 JSON。未知表只显示 catalog identity，不读取 row。Secret、credential、pepper、active/inconclusive Run、未知 schema
和缺少 custody 的事实固定为 `blocked`，不能被人工选择降级为自动可导入。

### 3. 决策文件是有界 NDJSON 流，不由 CLI 自动补全

operator 使用 diagnostics page 在外部形成 owner-only NDJSON review file。header 必须 exact 绑定 `reviewId`、profile、plan digest、
preparation digest 和 diagnostics contract version；后续每行只包含一个 required fact 的 ordinal、fact digest、disposition 与固定 reason。
允许的 disposition 为：

```text
retain_target | adopt_legacy | retain_both |
exclude_legacy | defer | manual_external
```

这些值只是未来 adapter 的 reviewed intent，不表示 SQL、文件或服务动作已经获准。`blocked` fact 只允许 `defer` 或 `manual_external`；
`run_history` 不允许删除/覆盖历史，`secret_and_config` 与 `identity_policy_audit` 不允许选择明文导出，`unknown` 不允许自动 adoption。
每个 required fact 必须按 canonical 诊断顺序出现且恰好一次，不接受遗漏、重复、额外或乱序 decision。

review file 使用稳定 descriptor 流式读取：每行不超过 64 KiB，hash buffer 64 KiB；Edge 总上限 8 MiB，Standalone 总上限 32 MiB。
解析期间重验 parent、device/inode、owner、mode、size、mtime/ctime；文件替换、hard link、symlink、增长、截断或语义重写全部失败关闭。

### 4. 人工批准必须来自近期强认证 User

commit 不能把“能运行 CLI”当作审批。Local Owner composition 必须使用既有 target Owner credential、pepper custody 与
`establishAuthenticatedLocalCommand` 建立近期强认证 User principal；认证 namespace 固定为 `local_reconciliation_review`。允许
`hardware | local_console | multi_factor` assurance，认证年龄最多 5 分钟，authorization lifetime 最多 30 分钟。Service、Agent、Worker、
弱认证或过期 principal 均拒绝。

授权沿用独立 issuer keyring 的 immutable generation、最多八把 verification key、私有路径和签名模型，但使用新的 reconciliation
domain separator 与 schema，不复用 Legacy Crontab receipt。issuer authority、credential fence、review file descriptor identity、sealed
bundle fingerprint 和 exact plan/head 在签名前后都必须再次确认。Edge 允许同一强认证 Owner 自审；本 ADR 不伪造双人审批。若未来
Standalone policy 要求 separation-of-duty，应新增 policy/ADR，而不是从设备 Profile 猜测。

### 5. Commit 重新派生事实并只发布有界 terminal evidence

commit 不信任 diagnostics page，也不要求 page 被持久保留。它从 exact sealed bundle 重新流式派生 canonical fact sequence，与 private
review file 逐条匹配，生成签名 authorization、固定 disposition/reason counts、decision-set digest 和 compact terminal receipt。
review root 只保存 `intent.json`、`authorization.ndjson`、`review.json`、`receipt.json` 与空 staging directory；authorization 是未来 adapter
读取人工选择的唯一内容载体，其余 terminal JSON 不复制对象名或业务标识。

authorization、review、receipt 和 instance head 的各个崩溃窗口均 no-replace exact replay。terminal 文件收敛为 `0400`，review root
和 staging 收敛为 `0500`；fsync 顺序覆盖 response loss。最后以 `reviewDigest` CAS 推进 `reconciliation_reviewed`。verify 只验证文件、
签名、exact plan/bundle/head binding 与曾在 commit 时有效的 reviewer authority，不重新打开 SQLite、不续期授权、不创建或清理文件。

### 6. Review completion 不授予 import、rollback 或 restart authority

`reconciliation_reviewed` 只证明一个强认证 User 对 exact fact set 给出了受约束选择。它不产生 SQL、不打开 target/Legacy 可写连接、不解密
Secret、不 checkpoint、不复制外部文件、不调用 Docker/init/socket/network，也不允许 target restart 或 Legacy rollback。下一阶段的
domain adapter 必须消费 exact `reviewDigest` 与 authorization digest，重新认证、重新授权、重新检查当前 head，并分别定义 backup、
prepare/commit、幂等 identity、冲突、response loss 和 rollback 语义。任何 adapter 都不能把 `defer/manual_external/blocked` 解释为成功。

### 7. 低资源与 package 边界

实现继续内聚在 `@qinglong/local-owner-cli/src/deployment/reconciliation/review/`，可复用的只读 classifier 可留在相邻 planning 模块；不新增
workspace package、production dependency、binary、daemon、timer、watcher、listener、socket 或后台 retry，也不得把新源码平铺回 package
`src/` 根。review composition 可以使用既有 Local Owner authentication 与 issuer keyring primitive，但 diagnostics/contract 模块不得
import Local SQLite mutation、adoption publisher 或 runtime execution authority。

运行时最多一个 SQLite handle、一个 decision iterator、64 KiB hash/read buffer、64 条 page record 和固定八领域 counters。diagnostics
output 不进入基础 Edge/Standalone artifact；Cluster/PostgreSQL/Kubernetes 不读取 Local review root、authorization 或 reviewer identity。

## 当前实现进度

D-391 已完整实现 `review.prepare`、`review.diagnostics`、`review.commit` 与 `review.verify`。prepare/diagnostics 保持第一切片的 exact
plan/bundle/head fence、64 条私有分页、blocked fact 与 byte-exact replay；commit 新增 Edge 8 MiB、Standalone 32 MiB 的稳定 descriptor
NDJSON 流，逐条重新派生密封 bundle facts，不读取 diagnostics page。生产 composition 只通过新的 Local SQLite authentication-read
projection 读取 credential/pepper，并使用既有 `establishAuthenticatedLocalCommand` 建立最多 5 分钟的强 User principal。独立 issuer
keyring 最多八代 key，authorization 生命周期最多 30 分钟，签名前后重验 decision file、credential、keyring、plan、bundle fingerprint 和
prepared head。

authorization、review、receipt、seal 与 head 的每个 crash/response-loss 窗口均已覆盖；terminal evidence 收敛为 `0400/0500`，verify
复验签名与全部 exact binding，不打开 SQLite、不写文件。CLI 只返回 content-free digest/count/replay facts。`reconciliation_reviewed`
仍不授予 import、rollback、restart、SQL、Secret 解密或外部副作用 authority；任何领域 adapter 必须由下一份独立 ADR 定义。

验证结果：聚焦套件 `32 total / 30 pass / 2 conditional Docker skip / 0 fail`；完整 Local Owner
`254 total / 247 pass / 7 conditional skip / 0 fail`；tracked backend `1541 total / 1539 pass / 2 conditional skip / 0 fail`；
18-package clean build/逐包测试、八项架构/部署/发布审计、十四档 artifact audit 与真实 Docker readonly `2/2` 均通过。PostgreSQL 18.6
arm64 physical HA 以 146 gates、timeline `1 → 2` 通过，private report SHA-256 为
`3d6623465913d43e6f1a8838896d6deb6664dafd0c26970bddb4d6165fb60c00`，独立 evidence audit 无 finding。workspace 仍为 18 packages，
`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Local Owner 为 `155 source / 154 nested / 1 root binary entry`，Local SQLite 为
`203 source / 202 nested / 1 root public export`。新增 7 个生产源码全部进入既有领域目录，没有新增 package、dependency、binary 或常驻
对象；基础 Edge/Standalone closure 精确保持 `2,611,978 / 2,612,056` bytes、319 files、58 modules。

## 被拒绝的替代方案

### 把对象名和冲突列表直接加入 plan

拒绝。会破坏内容无关 terminal evidence，使日志、Cluster consumer 和长期 receipt 获得敏感 inventory。

### 把 diagnostics page 当作 commit authority

拒绝。page 是 operator 工作材料，可能丢失、复制或被选择性展示；commit 必须从密封 bundle 重新派生完整 canonical fact sequence。

### 只依赖 `0600` decision file

拒绝。文件所有权只能证明 POSIX actor，不能证明近期强认证的人类 User，也不能抵抗 decision file 在签名前被替换。

### 在一个大 JSON 中加载全部诊断和决策

拒绝。会让路由器/NAS 内存随 schema 或 row 数增长，并产生超大临时字符串；page、NDJSON、hash 和比较都必须流式。

### 让人工批准直接调用通用 import

拒绝。八个领域的幂等键、Project/Policy、Secret custody、append-only history 和外部资产语义不同，不存在安全的通用回灌 SQL。

## 验收条件

1. 只有 exact `reconciliation_planned` plan/head 能建立唯一 review fence；restart、rollback、旧 plan 与第二 review 被阻断。
2. diagnostics page 固定最多 64 条，只写 owner-only no-replace 文件；stdout/content-free receipt 不泄漏路径、名称或 fact digest。
3. unknown/Secret/credential/pepper/active Run/hot journal 等 blocked facts 不能被人工选择提升为自动可处理。
4. Edge 8 MiB、Standalone 32 MiB private NDJSON 流逐条覆盖 required facts；缺失、额外、重复、乱序、替换和 digest drift 全部失败。
5. 只有近期强认证 User 可签发 authorization；credential/keyring/reviewer/file/plan/bundle/head 任一 fence 漂移时零 terminal publication。
6. authorization/review/receipt/head 的崩溃窗口和 response loss exact replay；verify 完全只读且不打开 SQLite。
7. review completion 无 SQL、DML、Secret 解密、checkpoint、service、Docker/init/network 副作用，也不授予 import/rollback/restart。
8. 无新增 package/dependency/常驻对象或根目录平铺；完整 Local Owner/backend/package、架构/release、十四档 artifact 和真实 Docker
   readonly rehearsal 通过，基础 Edge closure 不增长。

## 未包含

- 任一领域 adapter 的 SQL、文件转换、Secret re-encryption 或外部对象复制；
- 自动 import、Legacy overwrite、target restart、service cutover 或 reconciliation completion；
- Cluster/PostgreSQL/Kubernetes reconciliation；
- 强制双人审批、远程 KMS/HSM、网络签名服务或集中式审批 UI；
- 固定物理 Edge/NAS 的断电、FTL 写放大与介质销毁证明。
