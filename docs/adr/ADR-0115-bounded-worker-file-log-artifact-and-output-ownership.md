# ADR-0115：有界 Worker 文件 Log Artifact 与 Output Ownership

- 状态：Accepted
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-24、D-26、D-71、D-110、D-112、D-114
- 关联 ADR：ADR-0024、ADR-0026、ADR-0071、ADR-0111、ADR-0113

## 背景

ADR-0113 只把 `logArtifactId` 送到了 Executor launch，没有具体 Worker writer，也没有定义
materializer dispose 与异步进程输出之间的所有权。若在 `Processor.launch` 的 finally 中
关闭 writer，`Executor.start` 返回后仍在运行的进程会丢失日志；若在 spawn barrier 前交接，
journal 写失败又会留下无 owner descriptor。隐式无限文件对路由设备还会直接耗尽系统盘。

Worker 同时需要适配小型路由器和普通集群节点，但这不应产生两个执行协议、额外 package
或常驻清理 timer。

## 决策

### 1. 单一、opaque、offer-scoped 日志身份

`WorkerFileLogArtifactAllocator` 在现有 `@qinglong/worker-runtime` package 内实现，不新增
package 或第三方依赖。ID 使用 domain-separated SHA-256 从
`(projectId, runId, attemptId, offerId)` 派生为 `wlog-` 加 30 个十六进制字符，总长 35。
输入只用于 digest，不进入目录名、日志正文或诊断。相同 offer 重放得到同一 ID；新的 offer
得到新 ID，避免租约重新分配后的两个 Worker 向同一对象身份竞争上传。

日志路径只能从 opaque ID 派生为固定两字符 shard 和 `.log` 文件。root/shard 必须是当前
进程 owner 的普通目录并强制 `0700`；文件使用 `O_CREAT|O_APPEND|O_NOFOLLOW` 和 `0600`，
打开后复验 ordinary file、owner、单 hard-link、path 与 fd 的 device/inode identity，以及
目录在打开窗口内未被替换。非法 symlink、hard-link、owner 或 identity 全部 fail closed。

### 2. Profile 显式容量与两层硬上限

allocator 不允许隐式无限策略：

| Worker profile | 单 Attempt 上限 | 建立前最小剩余空间 | 单 write 上限 |
| --- | ---: | ---: | ---: |
| Edge | 4 MiB | 32 MiB | 1 MiB |
| Node | 64 MiB | 256 MiB | 1 MiB |

创建 shard/file 前必须证明 `available >= minimumFree + maximumAttempt`。capacity probe 异常、
负数或非 bigint 视为不可用。writer 串行化进程内写入、立即复制 caller buffer，使用 append
保留重启前已接受 prefix；达到剩余 quota 时只写可接受 prefix，随后返回稳定
`quota_exceeded`。oversized/非法 stream/time/chunk 在写入前拒绝。跨进程唯一 writer 继续由
ADR-0110/0111 的单 journal owner 保证；不能把 allocator 当作第二个分布式锁。

writer close 幂等，等待所有已接受写入、执行 `fdatasync` 后关闭 descriptor。它不删除内容，
也不通过 timer 清理。

### 3. durable barrier 后一次性交接 ownership

Artifact preparation exact shape 为 `logArtifactId + takeOutput + release`：

1. Secret 全部闭合后才 prepare；
2. Processor 校验环境和日志 ID；
3. inbox CAS 写入 durable `launching` barrier；
4. 只调用一次 `takeOutput()`，复验 sink ID 与 materialized ID 完全相同；
5. 调用 `Executor.start` 时 ownership 转移给 Executor；
6. materializer finally 仍释放 Secret 和 preparation，但 handed-off release 不关闭 writer。

Executor 对所有已知 terminal path 负责关闭 writer。tagged `rejected` 明确证明未 spawn，
Processor 再执行一次防御性幂等 close；抛错或非法结果属于 unknown spawn，Processor 禁止
关闭，交给 recovery/exact process identity 后续裁决。这样 running ACK、journal、writer 与
未来上传都只有一个 `logArtifactId`。

### 4. 后续闭环

ADR-0116 已复用受审 local-process 实现具体 POSIX Executor、launcher truncation fact 读取、
流式 upload ACK 校验和 upload-before-completion 协调，但中央对象存储/认证 HTTPS adapter、
PostgreSQL completion、range API、terminal retention、失租/cancellation/timeout 与生产 headless
组合仍默认关闭。本地 spool 在这些闭环前不得删除。

## 被否决的替代方案

1. **writer 作为新 package**：没有独立部署或供应链边界，只制造 package 碎片。
2. **Executor 自己选择日志路径/ID**：控制面 Artifact identity 与实际字节分叉。
3. **在 materializer dispose 中无条件 close**：会截断已经交给异步 Executor 的输出。
4. **spawn barrier 前 handoff**：barrier CAS 失败会产生无 owner writer。
5. **unknown spawn 时 Processor close**：可能关闭正在运行进程的唯一日志出口。
6. **Edge/Node 两套协议或实现**：只需显式策略不同，不应复制状态机。
7. **后台 timer 做 quota/cleanup**：增加低配设备常驻资源，且 timer 不能证明进程终态。

## 验收证据

1. 相同 authority ID 稳定，新 offer ID 不同且不暴露输入。
2. root/shard/file 权限分别为 `0700/0700/0600`，symlink target fail closed。
3. reopen 使用同一 ID 并 append 已接受 prefix，不 truncate。
4. 总 quota 只保存剩余 prefix并返回 `quota_exceeded`；oversized chunk 零写入。
5. capacity 不足时 root 内没有 shard 或输出文件。
6. output 只能 take 一次；未 take 的 release 关闭，take 后 release 不关闭。
7. output 只在 durable `launching` 后交给 Executor；ID 漂移不 spawn。
8. tagged reject 幂等 close，ambiguous throw 不由 Processor close。
9. package 数、数据库、schema、依赖和 timer 均不增加。
