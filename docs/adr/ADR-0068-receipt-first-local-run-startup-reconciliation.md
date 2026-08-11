# ADR-0068：回执优先、进程身份感知的本机 Run 启动恢复

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-02、D-17、D-37、D-42、D-52、D-55、D-65、D-66、D-67、D-68
- 关联 ADR：ADR-0001、ADR-0007、ADR-0040、ADR-0044、ADR-0053、ADR-0055、ADR-0056、ADR-0063、ADR-0066、ADR-0067、ADR-0069

> ADR-0087 现行增量：本文的 recovery authority 已迁入 `@qinglong/local-execution/recovery`；其只能相对依赖同 package 的 `/control` 模块以及 production dependency `local-process/runtime-core`，恢复语义和常驻边界不变。

## 上下文

ADR-0067 已让 local-application 在 domain recovery 前读取真实 SQLite `dispatching/running` Run，并对候选或截断 fail closed。这消除了恒真 recovery summary 的假安全，但它只能阻断：一次正常任务完成后若进程在数据库终态提交前崩溃，系统仍无法消费 completion receipt；若旧任务仍在运行，也无法用 durable process identity 区分“原进程仍存活”和“PID 已复用”。长期只读阻断会把每次崩溃都变成人工修库。

本机恢复同时覆盖小型路由设备与 standalone 节点。实现不能复制 cluster claim/supervisor、创建第二 SQLite authority、扫描回执目录或安装常驻 timer；也不能因为数据库显示 `running` 就把可能仍有外部副作用的任务误判为 `lost`。

## 决策

### 1. 独立、Profile-neutral 的恢复 package

新增 `@qinglong/local-run-recovery`。ADR-0072 后其生产依赖 runtime-core、local-process 与统一 local-execution-control；进程/回执基础设施归 local-process，完成终态策略归 control，启动恢复裁决归 local-run-recovery，依赖只能沿该方向前进，不得反向。三者都不导入 local-sqlite、local/cluster Profile、legacy、ORM 或 HTTP；Repository 与候选 source 由 local-application 注入，因此同一个 `LocalSqliteRunRepository` 继续拥有唯一 `DatabaseSync`、operation queue、事务和 close fence。

`@qinglong/local-application` 的生产依赖固定为 adopted storage composition、local-process、local-execution 与 local Run recovery 四条窄边界。edge/standalone 基础及 adopted-storage 产物不携带进程/执行/恢复 package；只有 application 产物为完整启动、恢复与回执维护付费。

### 2. 每个候选严格按 receipt → process identity 裁决

候选按 Run ID 顺序、最多 256 项串行处理，证据顺序不可互换：

1. 在 Repository 事务内读取 Run 与最新 Attempt，确认候选状态、version、active Attempt 数、executor type、callback sequence/token digest、durable handle 和 PID；
2. 只按 exact Attempt ID 计算分片路径并读取单个 completion receipt，不枚举目录；
3. 回执通过严格 v1 codec、大小上限、UUID/时间/exit-code 字段校验，并用 constant-time SHA-256 校验 callback token、sequence 和 Attempt identity；
4. 可信回执在同一 Repository 事务内 CAS 推进 Attempt、Run 并追加各自事件，事务提交后再删除回执；
5. 没有可信回执时，`claimed` 作为尚未启动的事实可原子转为 `lost`；`starting/running` 只能检查 exact durable local-process identity；
6. exact identity 仍运行则保留；可信 `not_running` 在一次 50 ms（edge）或 100 ms（standalone）的回执发布宽限后复查回执，再原子转为 `lost`；invalid handle、平台不支持或 provider unavailable 都不得推断 `lost`。

回执优先是因为任务进程可能已结束但 launcher 正在发布完成事实；进程检查不能先于回执把这个窗口误判为丢失。宽限只使用启动路径中的一次性、可等待 timer，不创建后台循环、watcher 或 supervisor。

### 3. 回执与进程证据必须抗替换、严格有界

completion receipt 文件最多 4 KiB、不可覆盖发布，读取使用 `O_NOFOLLOW` 并拒绝 symlink。根路径必须是非根、无 NUL、绝对且有长度上限；目标路径只由受校验 Attempt ID 的固定分片生成。非法回执隔离并使该候选保持 unresolved，不把损坏事实当作任务失败。

local-process durable handle 使用 `ql3lp1`，绑定 Linux boot ID、PID、process group 与 `/proc/<pid>/stat` start ticks。PID 不存在或 exact identity mismatch 才是可信 `not_running`；`/proc` 不可用、handle 畸形或 provider 异常均为 unknown/unavailable。当前 macOS 不能提供同等事实，因此携带 active local-process Attempt 时 fail closed，而不是降低证明标准。

### 4. 终态推进必须是聚合事务，而非散落更新

恢复事务在写入前重新读取并逐项匹配 Run ID/version/status、Attempt ID/status、callback sequence/token digest、durable handle 和 PID。可信完成按 exit code/cancellation/deadline 映射 `succeeded/failed/cancelled/timed_out`；可信未运行映射 `lost`。每次推进必须在一个 Repository transaction 中完成：

```text
CAS Attempt + append Attempt event
CAS Run     + append Run event
commit
```

任一 CAS、字段复核或事件写入失败都整体回滚。恢复不创建新 Attempt、不调用 Execute、不自动 replay，也不消费 cancellation/retry 产品策略；这些动作必须在启动安全成立后由正常调度或独立人工流程决定。

### 5. 最终 verifier 独立复核数据库与外部事实

逐项处理后必须再次调用有界候选 source。`truncated=true` 永远不安全。每个仍保留的候选必须与先前保存的 Run/Attempt 指纹完全一致、没有新回执，并再次证明 exact process identity 正在运行；任何新增、消失、字段漂移、回执出现或进程身份变化都撤销本轮安全结论。

因此 application 可继续启动的条件不是“只剩零候选”，而是：所有候选已经原子终态化，或剩余候选均在最终 verifier 中被第二次证明为同一活进程。`remaining` 表示已知仍运行且指纹稳定的候选；unknown/invalid/provider failure 计入 failed 或 unresolved 并阻断 lifecycle/admission。

### 6. 低资源与集群节点边界

- 零候选只支付一次 durable query，不访问文件系统或 `/proc`；
- 候选页固定最多 256，截断在读取任何 receipt/process 证据和部分 mutation 前失败；
- 处理串行且只保留有界指纹，不创建 worker pool、第二连接或常驻内存索引；
- 无目录扫描、轮询、watcher、周期 timer 或自动 replay；
- standalone 只放宽一次性 receipt grace，不改变证明语义；
- cluster 节点继续使用 PostgreSQL claim/provider/fencing 模型，不能复用本机 PID 证据冒充远端 Worker 事实。

## 被否决的替代方案

1. **沿用永久只读阻断**：安全但不可用，正常 crash-after-exit 也只能人工修复。
2. **先探测 PID 再读回执**：扩大 launcher 发布窗口内的错误 lost。
3. **缺 handle 或不支持 `/proc` 时直接 lost**：unknown 不是可信 negative evidence。
4. **只更新 Run 或分两次更新 Attempt/Run**：会产生不可解释的聚合裂缝。
5. **恢复时创建新 Attempt 或重放命令**：可能与仍存活的旧副作用并行。
6. **扫描 receipt root 或启动后台 supervisor**：增加闪存 I/O、常驻内存和路由设备尾延迟。
7. **把 SQLite 细节写入恢复 package**：形成第二 adapter/connection authority并阻碍后续存储演进。

## 影响与未完成项

正向影响：

- 本机 application 已能自动收敛可信 completion 与可信 no-process 遗留；
- 仍存活的 exact 进程可在双重验证后安全保留，不再要求零候选；
- 状态、事件和聚合版本在同一 SQLite transaction 中提交；
- edge 零候选路径不增加文件、进程或后台调度成本；
- application production closure 保持独立、可审计且不携带 cluster/legacy ORM。

仍未完成：

- 加密本机 Secret provider、retry、Artifact retention/read 与 HTTP admission 的纵向装配；completion/cancellation/timeout/shutdown drain 已由 ADR-0072 闭环；
- cancellation、deadline、retry 与人工 recovery 的产品流程和 API/UI；
- 真实 Linux x64/arm64、容器 PID namespace、断电/强杀与固定物理路由设备基线；
- 具体 scheduler/executor/admission stack、target executable 和部署 controller。

因此本 ADR 证明的是“已有可信证据时可安全恢复，证据不充分时继续阻断”，不是完整本机执行生命周期已经交付。

## 验证

1. 零候选只查询一次且不读取 receipt、`/proc` 或安装 timer。
2. 截断在任何证据读取和状态 mutation 前 fail closed。
3. `claimed` 可原子 lost 且不探测进程；缺失/无效 starting handle 不得 lost。
4. 可信 receipt 先于 process probe，并在一个事务内推进 Attempt、Run 和两个事件；提交后删除 receipt。
5. exact live process 在初次与最终 verifier 均被检查且不终态化。
6. 最终确认期间进程、数据库指纹或回执变化会撤销启动安全。
7. ADR-0073 后 production package closure 只有十二个本机 package，不含 legacy、cluster、Worker、ORM 或额外 SQLite addon，并满足体积/RSS 硬预算。
