# ADR-0066：本机 Application 激活门与反向停止顺序

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-05、D-17、D-37、D-40、D-42、D-63、D-64、D-65、D-66、D-67
- 关联 ADR：ADR-0036、ADR-0040、ADR-0042、ADR-0044、ADR-0063、ADR-0064、ADR-0065、ADR-0067、ADR-0068、ADR-0069

> ADR-0087 现行增量：application 现在只依赖 `@qinglong/local-execution`，分别从 `/execution`、`/control`、`/recovery`、`/dispatch` 取得受审能力；旧的四个物理 package 边界已被 subpath 与单向 source-boundary 门禁取代。

## 上下文

ADR-0063/0064 已提供独立本机 SQLite authority、旁路 adoption、source 生命周期写栅栏和 `adopted_storage_ready`，ADR-0065 也已固定进程切换的 durable barrier。但 storage ready 不能证明应用可接流量：startup recovery 可能尚未收敛，scheduler/executor lifecycle 可能启动失败，HTTP admission 也可能在恢复前提前开放。

若由 edge/standalone 入口、HTTP server 或部署 controller 分别拼装这些步骤，同一个 3.0 target 会产生多套启动顺序和失败清理语义；若直接复用 cluster-control 组合根，本机产物又会反向携带 PostgreSQL 和集群职责。因此需要一个只属于本机 Profile 的独立 application activation 边界。

## 决策

### 1. 独立本机 Application 组合根

新增 `@qinglong/local-application`。ADR-0071/0072 后生产依赖还包括 Profile-neutral 的
local-dispatch 与 local-execution-control；不得导入 legacy 根、cutover authority、
cluster/Worker package、Express、Sequelize、Drizzle、`sqlite3` 或 local-sqlite
adapter。作为 composition root，它可以从 runtime-core 显式 subpath取得领域门禁，
也可以从 local-admin 的显式 POSIX publisher subpath取得短调用期 adapter；不得从
二者 package root取得管理 surface。进程/执行/控制/恢复 package 仍只消费
runtime-core port，不持有 SQLite adapter。

该 package 是 target application 的进程内组合根，不是进程管理器。`@qinglong/local-cutover` 仍保持反向独立；后续 systemd、Docker/s6 或其他 deployment controller 只能启动包含此组合根的 target artifact，不能把 cutover authority 注入普通业务启动路径。

### 2. Disabled 路径不触碰数据或 runtime factory

未显式启用时，只校验 Profile、enabled flag 和 application audit sink，记录 `disabled` 后返回。它不得读取 adoption/activation 路径、打开 SQLite、调用 storage/adoption audit、创建 stack、安装 admission 或启动 timer。

### 3. 启动顺序固定为 storage → Package recovery → Secret → assembly → Run reconciliation → receipt cleanup → domain recovery → lifecycle → admission

enabled 路径只能按以下顺序推进：

```text
adopted storage ready
  -> bounded Plugin Package recovery safe
  -> Secret keyring ready
  -> assemble application stack
  -> receipt-first local Run reconciliation safe
  -> one bounded database-indexed receipt cleanup page
  -> bounded domain recovery safe
  -> lifecycles started
  -> admission installed
  -> active
```

storage authority 由组合根持有完整生命周期。Plugin Package recovery 复用该 authority
的同一 DatabaseSync；任何 retry、manual-required、remaining 或 malformed page 都在
Secret、factory、timer 和 admission 前失败关闭。factory 只有在 source fence、target
identity、SQLite readiness、Package recovery 与 Secret readiness 全部通过后才能取得
Repository；factory 必须保持装配期无 listener、timer、Executor 或 admission 副作用。
ADR-0067/0068 的数据库候选门与 receipt/process reconciliation 或 stack recovery 未安全
收敛、lifecycle 未明确返回 `started`、admission contract 畸形或 active audit 失败时都
不得返回 active。

### 4. Recovery 摘要必须严格、有界且自洽

startup recovery 摘要使用不可扩展字段 `safe/scanned/recovered/remaining/failed`。每个计数都是 0–256 的安全整数，已恢复、剩余和失败数量不得超过 scanned；只有 `remaining=0 && failed=0` 时 `safe` 才能为真。

该摘要是 application stack 的启动契约，不替代各领域 Repository 的独立 convergence verifier。ADR-0067/0068 已先以真实 SQLite 事实发现 runtime-owned `dispatching/running` Run，并以 receipt-first、process-identity-aware 协调器原子收敛或双重证明活进程；截断、不可判定和最终指纹漂移都在 stack recovery 前 fail closed。后续 Cancellation、Approval、Artifact 等 recovery 仍必须由各自 durable facts 复核；组合根不得用一个恒真的 mock summary 宣称生产 ready。

### 5. 停止固定为 admission drain → owned maintenance → stack stop → storage close

正常停止和激活失败清理都先关闭 admission 并等待有界 drain，再停止 receipt cleanup 等组合根持有的维护 lifecycle，然后停止 application stack，最后关闭 target storage 并释放 source fence。stop 必须并发幂等；drain、maintenance 或 stack 返回 `timed_out` 时继续执行后续资源收敛并把 timeout 返回给外层 target controller。

任一清理步骤抛错时仍继续执行后续步骤，最后返回单一错误或 `AggregateError`。`draining/stopped` audit 是诊断事实，失败不能阻止安全清理；但 active audit 失败意味着外部尚不能把 target 当作 ready，必须反向清理。

### 6. Application active 仍不等于 deployment cutover 完成

`active` 只证明当前 target 进程内已经通过 adopted storage、recovery、lifecycle 和 admission gate。它没有证明 2.x master/worker 已停止，也没有提供跨进程 inspect/stop evidence。部署层仍必须通过 ADR-0065 的 controller contract 把 target identity 与 cutover/activation 绑定，并在进程崩溃后独立检查。

## 被否决的替代方案

1. **继续只发布 `adopted_storage_ready`**：会让 controller 在 scheduler/executor/admission 尚未成立时宣称 target active，拒绝。
2. **由 HTTP server 自行打开数据库并启动 lifecycle**：transport 再次成为 service locator，恢复和停止顺序不可审计，拒绝。
3. **复用 cluster-control bootstrap**：把 PostgreSQL、多副本 recovery 和 cluster admission 职责带入 edge，拒绝。
4. **先开放 admission，再后台 recovery**：旧未决副作用和新请求可以并发产生双重事实，拒绝。
5. **stop timeout 时跳过 storage close**：会让 source fence 和数据库 authority 无期限泄漏；timeout 必须上报给外部 controller，但本进程仍继续收敛资源。
6. **让 local-application 直接调用 cutover**：形成 application 与 deployment authority 循环依赖，拒绝。

## 影响与未完成项

正向影响：

- 本机与 cluster-control 共享相同的 readiness/recovery/lifecycle/admission 原则，但保持独立依赖图；
- source fence、target Repository、lifecycle 和 admission 由一个 owner 反向释放；
- edge/standalone disabled 路径不支付数据库、timer 或 listener 成本；
- target process controller 获得了可启动的明确 application 边界。

仍未完成：

- 完成加密本机 Secret provider、Cancellation、timeout、completion、Approval、Artifact retention/read 的具体 recovery/lifecycle/admission 实现；
- 独立 target executable、readiness/identity protocol 和 systemd、Docker/s6 controller；
- 2.x master/worker legacy controller、人工 cutover recovery 与写后 reconciliation；
- HTTP `/api/v3` 本机安全 admission、完整兼容 API 和 UI；
- Linux x64/arm64、固定路由设备、断电及 timeout/强杀集成门禁。

因此本 ADR 完成的是本机 target 的 application activation contract 与真实 adopted-storage 纵向组合，不表示生产 scheduler/executor 已接管，也不表示部署 cutover 已可达。

## 验证

1. disabled 路径不读取无效路径、不调用 storage/adoption audit 或 stack factory。
2. 真实 SQLite adoption 严格按 storage → assembly → receipt-first Run reconciliation → domain recovery → lifecycle → admission 激活，active 期间 source writer 被阻断。
3. SQLite 中不可判定、最终指纹漂移或超过 256 条的候选在 stack recovery/lifecycle/admission 前失败并释放 source fence；可信 receipt 原子终态化，exact 活进程被双重验证后保留。
4. unsafe、畸形或超过 256 项的 stack recovery summary 在 lifecycle/admission 前失败并释放 source fence。
5. active audit 失败会先撤 admission，再停止 stack 和 storage。
6. 并发 stop 只执行一次，顺序固定为 admission → receipt cleanup → stack → storage；drain timeout 和错误不会跳过后续清理。
7. ADR-0073 后 production tarball 只包含十二个本机 package，导入闭包不含 legacy、cluster、Worker、Drizzle、Sequelize 或 sqlite3。
8. dependency audit 阻止 local-application 导入 cutover authority 或穿透 adopted composition。
