# ADR-0116：受审 Worker POSIX Executor 与 Upload-before-completion 闭环

- 状态：Accepted（ADR-0117 已补 HTTPS/数据库闭环，ADR-0121 已补生产执行面装配；retention 与完整 Worker 产品生命周期仍默认关闭）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-14、D-17、D-24、D-26、D-68、D-110、D-114、D-115
- 关联 ADR：ADR-0021、ADR-0069、ADR-0111、ADR-0115

## 背景

ADR-0115 交付了 Worker 本地日志 spool 和 output ownership，但仍缺真实进程启动器、可认证
完成回执和 upload-before-delete 顺序。若 Worker 复制一套 launcher，会让本机与远端执行的
安全修复漂移；若先提交 Run 终态再上传日志，控制面成功而网络失败会形成不可恢复的空
Artifact；若上传后立即删除本地文件或回执，inbox CAS 崩溃又会丢失重放证据。

另一个关键窗口是 `launching` 已落盘、进程已经 spawn、`started` 尚未写入时的 Worker 崩溃。
仅在 `started` 保存启动时间，回执无法与 durable spawn authority 做 exact 匹配，恢复只能永久
阻断或错误放宽认证。

## 决策

### 1. 复用 local-process 边界，不新增 package

`@qinglong/worker-runtime/posix-executor` 依赖现有 `@qinglong/local-process`。这是有意的单向
依赖：local-process 拥有受审 POSIX launcher、verified-fd 执行、completion receipt、durable
process identity 和 OS 路径规则；Worker 只拥有 Session/Lease/inbox 策略。它们具有真实的
platform/供应链边界，符合 D-85，不复制 launcher，也不新增只有一两个文件的 package。

Worker Executor 只接受带私有 file-plan capability 的 output。它在 spawn 前重读同一 inbox，
精确校验 offer、Run、Attempt、callback sequence/token digest、log Artifact 和启动时间；随后
关闭父写 descriptor，让受审 launcher 以 verified fd 和独立进程组启动用户命令。明确
`no_spawn` 才返回 rejected；spawn 后 identity 捕获失败为 unknown，禁止上层上报 start-failure。

当前 timeout 仍 fail closed：只要 execution revision 携带 `timeoutMs`，Executor 在 durable
spawn barrier 前拒绝。没有 durable timeout/cancellation evidence 时不得用进程内 timer 冒充。

### 2. 启动时间属于 durable pre-spawn authority

Processor 在交接 output 前把 `executorStartedAtMs` 与 log ID、callback sequence/digest 一起写入
`launching`。local-process 接受可选的上层 durable start timestamp，但必须验证它是安全整数且
不晚于本地 launch observation；launcher journal、receipt、Executor result 和最终 inbox 必须
使用同一个值。

因此崩溃发生在 spawn 后、`started` CAS 前时，可信 completion receipt 仍可从 `launching` 或
`launch_outcome_unknown` 恢复，不需要裸 PID、日志内容或宽松时间范围猜测。该状态机变化影响
`processOnce`、`launch`、`acceptOffer` 三条流程，必须由 exact transition 与 restart 测试门禁。

### 3. 回执认证只消费原始 capability，不传播它

Worker inbox 只持久化 32-byte callback capability 的 SHA-256。launcher receipt 可短暂保存
base64url 原文，协调器读取后必须 canonical decode 为恰好 32 bytes，以 constant-time 比较其
SHA-256，并精确匹配 Run、Attempt、callback sequence 和 durable start time；局部 buffer 随后
清零。上传、completion command、日志、诊断和 inbox 都不得携带 token 原文。

非法、未来时间或 authority 不匹配的回执不能触发上传或 completion。当前实现保留回执供后续
隔离/运维，不把损坏证据推导成用户任务失败。

### 4. 日志使用固定内存流，不整文件载入

现有 `WorkerFileLogArtifactAllocator` 同时实现只读 source。它按 opaque ID 定位单个文件，使用
`O_NOFOLLOW` 后复验 owner、单 link、权限、fd/path inode 和 root/shard identity；不扫描目录。
内容以最多 64 KiB chunk 单次消费，Edge 与 Node 共用协议而使用各自 4/64 MiB 总上限。

launcher 的 immutable truncation fact 以同样私有路径读取，并精确匹配 Run、Attempt、log ID、
Profile maximum 和 bounded timestamp。fact 缺失表达 `unknown`，不能伪装成未截断。

### 5. 顺序固定为 upload、completion、inbox ACK、receipt cleanup

`@qinglong/worker-runtime/completion-coordinator` 的可重放顺序固定为：

1. 重读并规范化唯一 inbox authority，复验当前 Worker Session 与 Run Lease 未过期；
2. 读取并认证 completion receipt；
3. 打开 exact log Artifact，以流式 SHA-256 和 byte count 校验 uploader ACK；
4. 只有 durable upload ACK 后才提交 lease-fenced completion，command 携带 Artifact ID、长度、
   digest 和 truncation 状态；
5. completion applied/exact replay 后 CAS 写 `completion_acknowledged`；
6. 只有该本地 terminal barrier 已耐久化，才 best-effort 删除 receipt。

本协调器绝不删除本地日志。Artifact 只能由后续 retention 在已证明 upload/control-plane ACK 且
超过策略保留期后清理。任一步网络/CAS 失败都保留可重放的 receipt、inbox 和 spool；上传端与
completion 端必须用 ID/digest/fence 提供精确幂等。

当前交付的是 Worker 侧真实文件/进程实现和严格 adapter port。ADR-0117 已补中央 Artifact store
port、认证 HTTPS upload/completion endpoint 与 PostgreSQL 终态事务；ADR-0118 已补失租停止与
durable timeout/cancellation，ADR-0120 已补具体 S3-compatible store，ADR-0121 已补默认关闭的
production execution-plane composition。retention、Session/credential 产品流程与部署入口仍未装配，
因此完整 Worker Profile 继续默认不可达。

## 被否决的替代方案

1. **为 Worker launcher 新建 package 或复制 shell**：扩大碎片并产生两套安全修复源。
2. **`started` 后才保存 start time**：spawn 后崩溃无法严格认证回执。
3. **对 base64url 字符串直接 hash**：与 Processor 保存的原始 32-byte capability digest 不一致。
4. **completion 后再上传**：终态成功但日志永久留在离线 Worker。
5. **upload 返回成功但不验证消费字节/digest**：空读或部分读可冒充 durable Artifact。
6. **上传后删除 spool**：inbox/completion CAS 窗口丢失重试源。
7. **整文件读入 Buffer**：64 MiB Node 配额会放大路由器和并发 Worker 峰值内存。
8. **为完成协调器新建 workspace package**：单一 Worker consumer、同部署/依赖/权限闭包，不满足
   D-85；使用现有 package subpath。

## 验收证据

1. reviewed-fd Worker launch 产生 exact durable handle、日志和 completion receipt，callback token
   不进入用户环境。
2. spawn barrier 漂移零 spawn；spawn 后 identity 失败保持 unknown。
3. `launching` 持久化 start time，launcher receipt 与最终 state exact；重启不二次 spawn。
4. completion coordinator 可从无 executor handle 的 durable `launching` 回执恢复。
5. capability mismatch 在 upload 前拒绝并保留全部证据。
6. 文件 source 固定 chunk 流式读取并认证 truncation fact，不枚举目录。
7. 测试证明 upload 完成先于 completion，inbox terminal ACK 先于 receipt remove。
8. upload 失败时不调用 completion、不删除 receipt，并关闭只读 descriptor。
9. 未新增 workspace package、数据库、schema、timer 或 Worker 常驻连接。
