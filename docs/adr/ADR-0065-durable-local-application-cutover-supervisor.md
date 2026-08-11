# ADR-0065：持久化本机应用切换 Supervisor 与未知结果收敛

- 状态：Superseded（ADR-0243；未接入产品的 package 实现已删除）
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-05、D-17、D-37、D-40、D-42、D-63、D-64、D-65
- 关联 ADR：ADR-0004、ADR-0007、ADR-0036、ADR-0062、ADR-0063、ADR-0064、ADR-0066

> ADR-0243 已删除 `@qinglong/local-cutover` 的孤立孵化实现。本 ADR 保留为 cutover
> 安全语义记录，不代表当前仓库仍提供 Supervisor package。ADR-0309 已在现有
> `ql3-local-deploy` 产品中恢复 Docker legacy-stop journal/commitment 与 adopted v3
> 启动门；ADR-0310 又恢复 Docker target start/restart barrier、崩溃后 inspect-only
> 与 terminal `manual_required`。ADR-0313 已恢复人工 resolution，ADR-0314 已恢复 Docker target
> stop 和最小写后分类；其他 init controller、legacy restart 与数据域回退仍未实现。

## 上下文

ADR-0064 已能在数据库层证明 source 与 recovery 一致、在双库写栅栏内签发 activation，并在 adopted storage 生命周期内阻断旧 SQLite writer。但数据库锁不能证明旧 HTTP listener、timer、子进程、通知请求或其他外部副作用已经停止，也不能覆盖“停止 2.x 后进程崩溃”“target start 已发出但结果未落盘”“target 曾 active、控制进程重启后 2.x 被人工拉起”等窗口。

若把这些步骤直接写入 legacy `back/app.ts`，2.x 根应用会重新成为 3.0 的进程管理 authority；若只用内存布尔值或 shell 命令串联，控制进程崩溃后无法判断某个 start 是否已经产生副作用。最危险的错误恢复是同时重启 2.x 和 3.0，或者在未知 start 结果上再次 start。

## 决策

### 1. Cutover 是独立、默认关闭的部署 authority

新增 `@qinglong/local-cutover`，只提供 driver-neutral 的切换 contract、Supervisor 和文件 journal adapter。它没有 production dependency，不导入 legacy 根、local-admin、local-sqlite、local-adopted-profile、cluster、Worker、Express、Sequelize 或 Drizzle，也不自行注册 timer、watcher、signal handler、listener 或数据库连接。

当前所有既有 runtime/Profile package 都禁止反向导入该 authority。后续只能由独立部署入口显式组合具体 2.x process controller 与 3.0 target controller；不得把它塞回普通应用启动路径。

disabled 路径在验证 cutover ID、activation digest、journal 路径或 controller 前返回，不触碰文件和进程。

### 2. Process controller 必须返回绑定切换身份的证明

Supervisor 不接受一个裸 `stop` exit code。legacy controller 的 exact-shape evidence 必须同时绑定 `cutoverId`、`activationDigest`、controller identity、稳定 process identity、观察时间，并明确声明：

- database writer 已停止；
- application 外部副作用已 quiesced。

target start/inspect/stop evidence 同样绑定 cutover 与 activation，并包含 controller/target identity。畸形、可扩展、跨 cutover 重放或身份漂移全部 fail closed。这里的 controller 是部署信任边界；当前 package 只验证 evidence contract，不假装能从 PID 或 SQLite 锁独立推导网络、子进程和外部系统已经静默。

### 3. 每个状态转换先进入有界、不可覆盖的 durable journal

journal 位于操作员预先创建的绝对路径私有目录，要求真实目录、当前用户所有且 group/other 权限为零。每条记录：

- 使用连续十二位序号和 `0600` regular file；
- 绑定 cutover/profile/activation、前一条 digest、状态、时间和低敏 evidence；
- 通过 SHA-256 形成不可变链；
- 最多 64 条记录、128 个目录项和 64 KiB 单记录；
- 先写同目录私有临时 inode 并 `fsync`，再用 no-overwrite hard link 原子发布，最后同步目录；
- 同一 sequence 的并发 compare-and-append 只能有一个 winner。

未知文件、symlink、权限过宽、序号空洞、非法 transition、digest/evidence 漂移或资源超限均 fail closed。journal 只保存低敏 identity/digest，不持久化原始错误文本、token、数据库 URL 或 Secret。

### 4. 首次切换必须先证明 legacy 停止，再跨 target start barrier

正常序列固定为：

```text
requested
  -> legacy_stop_requested
  -> legacy_stopped
  -> target_start_requested
  -> target_active
```

`legacy_stop_requested` 可在崩溃后幂等重做 stop-and-verify，因为它只收敛旧 owner。`target_start_requested` 是外部副作用 start barrier：同一调用在 barrier 持久化后只调用一次 `startAndVerify`；若控制进程在调用期间崩溃，恢复只能 `inspect`。只有 exact active evidence 可以补写 `target_active`；inactive、unknown、异常或不匹配都进入 terminal `manual_required`，禁止盲目再次 start，也禁止自动重启 legacy。

### 5. Target 重启前必须重新证明 legacy 仍静默

曾经 `target_active` 的 journal 不代表旧进程永远停止。若恢复时 target inspection 为 inactive，必须执行：

```text
target_active
  -> legacy_recheck_requested
  -> legacy_reverified
  -> target_restart_requested
  -> target_active
```

只有新的 legacy evidence 同时证明数据库 writer 与外部副作用仍停止，才允许写 restart barrier。`target_restart_requested` 与首次 start barrier 相同：崩溃恢复只 inspect，不重放 start。target inspection 为 active 时还必须与已记录 controller/target identity 一致；unknown 或 identity drift 进入人工恢复。

target 正常停止使用 `target_stop_requested -> stopped`，stop-and-verify 可以幂等恢复。停止 target 后 Supervisor 不自动重启 2.x，因为 target 可能已经产生 3.0 新事实；回退仍遵守 ADR-0064 的 reconciliation 边界。

### 6. `manual_required` 是安全终态，不是可重试错误

legacy 停止未证明、target start/restart 结果未知、active identity 漂移、target stop 未证明或 journal fencing 冲突都必须收敛为 `manual_required`。记录只包含有限 reason、uncertain state 和错误摘要 digest。

同一 cutover ID 不允许从 `manual_required` 或 `stopped` 自动重新开始。操作员必须先检查进程、外部副作用、activation 和 target 数据事实，再通过后续受审恢复命令创建新的 cutover/recovery 事实；不得删除或重写旧 journal 伪造新起点。

## 被否决的替代方案

1. **在 `back/app.ts` 内直接 stop 旧 runtime 并启动 3.0**：继续让 legacy 根成为新架构 service locator，且进程崩溃后没有独立权威，拒绝。
2. **只检查 PID 不存在**：PID 可复用，且不能证明子进程、listener 或远端副作用静默，拒绝。
3. **target start 报错就自动重试**：错误可能发生在副作用之后，会形成重复 owner，拒绝。
4. **target 启动失败就自动重启 legacy**：未知 target 可能已经 active，且 target 可能已有新事实，会造成双跑或数据丢失，拒绝。
5. **用一个可覆盖 JSON 保存当前状态**：断电、并发 writer 或部分写会丢失转换历史和 CAS fence，拒绝。
6. **target 曾 active 后直接按旧 legacy evidence 重启**：旧证据可能已因人工恢复失效，拒绝；必须重新 stop-and-verify。

## 影响与未完成项

正向影响：

- 数据库 activation 与应用进程 cutover 成为两个清晰 authority；
- start/restart/stop 崩溃窗口有 durable barrier，不靠内存猜测；
- 并发 supervisor、journal 篡改和错误详情泄漏均 fail closed；
- edge 不安装进程管理 framework 或 cluster 依赖；
- 旧应用不会因 target 错误被自动拉起形成双 owner。

仍未完成：

- systemd、Docker/s6 与当前 QingLong master/worker 的具体 legacy controller；
- 把具体 Run/scheduler/Executor recovery、lifecycle 和 admission stack 注入 local-application，并由独立 target process controller 驱动；
- `manual_required` 的只读诊断、人工 resolution 和新 cutover ceremony；
- 多资产 backup manifest、target 写后 reconciliation 和用户可见回退选择；
- Linux x64/arm64、固定路由设备、断电和只读/overlay 文件系统验证；
- 独立 supervisor CLI/镜像、权限模型、SBOM、签名与审计导出。

因此本 ADR 只把 cutover state machine 和 crash semantics 孵化为默认不可达的 authority，不表示 QingLong 3.0 已自动接管 2.x 部署。

## 验证

1. disabled 路径不读取 journal、不调用任何 controller。
2. 正常流程严格先持久化 legacy stop proof 和 target start barrier，stop 后不启动 legacy。
3. legacy evidence 不完整时 target 永远不启动并进入 `manual_required`。
4. start barrier 后的异常不保存原始错误、不重放 start；重入保持同一人工终态。
5. start crash 只有 exact active inspection 能恢复，inactive/unknown 不会重试。
6. 曾 active 的 target 只有在新 legacy quiescence evidence 后才能重启。
7. stop crash 只幂等 stop-and-verify，不会触发 legacy start。
8. 两个并发 first append 只有一个成功；篡改、宽权限和 symlink journal 均 fail closed。
9. package dependency/import audit 证明 local-cutover 没有 runtime dependency，且既有 package 无法反向导入。
10. supervisor、真实 target/legacy adapter、写后 reconciliation 和多架构 Gate 完成前保持默认不可达。
