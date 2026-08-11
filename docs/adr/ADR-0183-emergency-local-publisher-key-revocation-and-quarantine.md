# ADR-0183：本机 Publisher Key 紧急撤销与隔离证据

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-133、D-169、D-170、D-171、D-172、D-173；ADR-0135、
  ADR-0179、ADR-0180、ADR-0181、ADR-0182

## 背景

ADR-0182 的正常退休要求旧 signer 引用和未决 catalog transaction 都归零，这不适合
疑似或确认泄露的 key。继续等待重签与 collect 会允许攻击者发布新的 recovery
entry；直接删 key 又会把“信任根已删除”误写成“已经运行的 Package、Task 和 Tool
均已停止”，并遗漏受影响 durable lock 的审计锚点。

本机 trust、catalog/bundle 文件与 SQLite 仍是不同介质。紧急动作必须先建立一个跨
重启可见的阻断事实，再以双人或显式 break-glass 完成不可逆删除；不能依赖进程内
锁、watcher 或一次目录扫描。

## 决策

### 1. 提案先阻断，再确认删除

第一位 authenticated current Owner 执行
`plugin-package.publisher-trust.revoke.propose`。短生命周期命令先有界分析全部
retained catalog entry 和未决 transaction，并把受影响 lock digest 的排序集合、
计数、publisher/key、expected generation、mutation、提案 Owner 与 audit 时间绑定
为 immutable proposal 和 `impactDigest`。

proposal 以 hard-link no-replace 写入受管 `0700` trust root；一旦 durable：

- 目标 signer 的 catalog publication 立即失败；
- application 在 queued stage 前和 staging 后、返回 evidence 前各复验阻断事实；
- rotate、retire 和另一生命周期 mutation 不能越过该 pending proposal；
- 命令返回 `runtimeAction=stop_required`，要求 operator 停止 application。

proposal 不提供 abort 或 unblock。疑似泄露事实一旦发布就只能通过精确确认继续，
避免删除提案恢复已受怀疑 signer 的 authority。

### 2. 默认双人确认，break-glass 必须显式绑定影响

第二条命令 `plugin-package.publisher-trust.revoke.confirm` 必须精确重放 proposal 的
publisher、key、expected generation、mutation、`proposerSubjectId` 和
`expectedImpactDigest`，并选择：

- `dual_control`：确认者与提案者必须是两个不同 subject，且两者在确认时都仍是
  current default Project Owner；
- `break_glass`：允许同一 current Owner 独立完成，但必须显式选择该模式，并提交
  `suspected_key_compromise` 或 `confirmed_key_compromise` reason code。

两种模式都重新执行强认证、current Owner fence 和既有低敏 SecurityAudit。确认后先
写 immutable revocation receipt，再生成显式 `revoke` snapshot；snapshot 必须精确
等于前一 generation 删除一个目标 key，不得改写其他 key。

紧急撤销允许删除最后一个 key。此时 `current.json` 的空 key 集合是可恢复、可审计的
管理状态，但 runtime trust registry 构造失败关闭；operator 必须通过受审 provision/
recovery 流程重建信任，不能让 runtime 使用隐式默认 key。

### 3. Quarantine 是不可变证据，不是假热停止

receipt 保存 proposal 时观察到的受影响 lock digest 集合，并在 inspect 中只聚合返回
`quarantinedLockCount`，不回显 publisher、key 或 lock identity。它证明这些 lock
必须按 compromise 处置，但本切片不修改既有 Package installation 状态枚举，也不
声称已撤下：

- 已经 `active` 的 Package；
- 已物化的 Task/Tool resource generation；
- 已进入 `staged` 或 `activating` 的事务。

确认成功返回 `runtimeAction=restart_required`。这不是自动重启许可：operator 应在
停机状态审查受影响 lock、替代 key 与恢复源。后续 D-174 必须新增持久化
Package deactivation/quarantine 状态机，并让 Task/Tool publication 和 invocation
admission 按 durable fence 撤出已激活资源。

### 4. 恢复、容量与低配约束

proposal、receipt、snapshot 或 current 提升任一窗口崩溃，只允许同一 authenticated
command 和同一 impact/authorization/reason 精确重放；漂移失败关闭。trust root
最多保留 32 个 revocation proposal、32 个 receipt、32 组 retirement evidence、
64 代 snapshot 和 64 个临时文件；未知或超限 entry 失败关闭。

实现复用已有：

- `@qinglong/local-admin/package-publisher-trust`；
- `@qinglong/local-admin/package-recovery-catalog`；
- `@qinglong/local-owner-cli/package-publisher-trust-command`；
- `@qinglong/local-application/plugin-package-recovery-catalog`。

没有新增 workspace package、第三方依赖、timer、watcher、listener、socket 或 steady
state I/O。空队列仍不加载 catalog；proposal guard 只在真实 publication/stage 或
显式管理命令中读取有界私有目录，适合低配路由设备。

## 拒绝方案

1. **复用正常 retirement**：要求引用为零，无法立即冻结疑似泄露 signer。
2. **单命令立即删除**：缺少第二人复核或显式 break-glass，误操作不可审计。
3. **只删除 trust key**：丢失受影响 lock 集合，也无法驱动后续资源隔离。
4. **新增 `quarantined` 枚举但不接资源消费者**：形成“状态已安全”的虚假保证。
5. **进程内 denylist 或 watcher**：重启丢失且增加路由器 idle 资源和竞态。
6. **删除最后 key 时注入默认 key**：在最危险窗口引入未审计信任根。

## 当前证据

- proposal durable 后目标 signer 的 catalog publish 与 queued application stage 均
  失败关闭；
- 同一 Owner 使用 `dual_control` 被拒绝，显式 `break_glass` 可完成产品级流程；
- core 双 Owner 流程验证不同 subject、impact digest、reason 和 authorization mode；
- receipt/snapshot/current 崩溃窗口由 exact command 收敛，最后 key 可撤销且 runtime
  registry 失败关闭；
- inspect 只返回 revocation、pending 和 quarantined lock 计数；
- 非 Owner 在 proposal 可见前被拒绝，33 个 revocation evidence 触发容量失败关闭；
- local-admin 63/63、local-application 32/32、local-owner-cli 22/22、
  dependency/source boundary 30/30 和 Edge import 121 modules 全绿；
- edge/standalone application 为 4,766,330/4,766,474 bytes、607 files、90 loaded
  modules；application-ai 为 5,444,151/5,444,307 bytes、651 files、89 loaded
  modules，四种制品和 RSS 门均在预算内；
- workspace 仍为 22 package，无新增生产依赖或常驻资源。

Cluster 代码、migration、ACL 和部署 manifest 未变化。本 ADR 不声明 Cluster publisher
trust 能力；PostgreSQL HA Docker 门只在后续 Cluster 对等实现发生变更时重跑。

## 后续门禁

1. D-174：active/staged/activating Package 的持久 deactivation/quarantine；
2. Task/Tool resource generation 撤回、invocation admission fence 与 crash replay；
3. 被隔离 lock 的替代发布、恢复或永久 tombstone ceremony；
4. 在线 OCI fetch authority 与 publisher metadata/update channel；
5. 固定低配 Linux 路由器断电、ENOSPC、闪存写放大与容量证据；
6. Cluster 对等 trust lifecycle 和双人管理 transport。
