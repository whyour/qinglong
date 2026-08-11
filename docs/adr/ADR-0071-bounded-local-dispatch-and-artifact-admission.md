# ADR-0071：有界本机调度、执行计划物化与 Artifact Admission

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-02、D-05、D-17、D-24、D-25、D-26、D-37、D-40、D-42、D-62、D-65、D-68、D-69、D-70
- 关联 ADR：ADR-0003、ADR-0007、ADR-0014、ADR-0022、ADR-0023、ADR-0024、ADR-0025、ADR-0026、ADR-0040、ADR-0042、ADR-0044、ADR-0062、ADR-0063、ADR-0066、ADR-0069、ADR-0070

> ADR-0087 现行增量：本文 dispatch authority 已迁入 `@qinglong/local-execution/dispatch`，只允许单向相对依赖 `/execution`；SQLite、Secret 与 Profile 仍通过 runtime-core contract/application 注入，不因合包获得额外生产依赖。

## 上下文

ADR-0070 已把本机 Run 的状态推进与外部 spawn 收敛到独立 coordinator，但安全的启动内核不等于安全的生产入口。若 application 仍向业务 stack 暴露 coordinator，调用方可以自行拼装命令、全局环境变量、Secret 和日志路径，绕过 Task revision、Artifact 容量与 Profile 预算。若调度器先创建文件或进程，再发现 Secret 缺失或磁盘低水位，会在低性能路由设备上积累空 Artifact、写放大和不可解释的半启动事实。

旧 `back/runtime` 调度链依赖 legacy service、Sequelize 与进程全局环境，也不能成为 3.0 本机执行入口。cluster 的 Worker Session、Run Lease、认证 transport 和共享 Artifact 又属于另一种部署权威；把它们带入 edge/standalone 会让路由器为永远不会使用的多节点能力支付依赖、内存和后台连接成本。

## 决策

### 1. 使用独立、Profile-neutral 的 local-dispatch package

新增 `@qinglong/local-dispatch`。它生产只依赖 `@qinglong/runtime-core` 与 `@qinglong/local-execution`，不得导入 local-sqlite、local-process、legacy、cluster、ORM、HTTP 或 Profile importer。固定依赖方向为：

```text
runtime-core
  <- local-process
  <- local-execution
  <- local-dispatch

local-sqlite + local-dispatch + local-execution
  <- local-application
```

SQLite adapter 通过 runtime-core port 提供候选、不可变定义和 mutation；local-dispatch 不创建数据库连接、timer、watcher或进程内队列。application 私有持有 materializer 与 coordinator，只向 assembly stack 暴露一个 `LocalRunDispatcher` 和只含不可变定义 append 的冻结 writer facade。业务 stack、插件、Workflow 与旧 Cron 都不能取得裸 launcher、coordinator、candidate source 或 SQLite repository。

### 2. 执行定义必须不可变且内容寻址

本机可执行 Task revision 只允许受审 `local_process` 类型、绝对且有界的 argv，或显式 allowlist 中的 `/bin/sh`、`/bin/bash`。执行环境由独立 `localctx:sha256:<digest>` recipe 描述；环境键排序后 canonicalize，公共值与 Secret 引用分离，`QL3_*` 保留名禁止由任务定义覆盖。revision 与 recipe 都采用 append-only、同内容幂等、不同内容冲突的写入语义。

SQLite migration `0005-local-dispatch-plan` 建立两个不可变定义表与 dispatch 候选索引；`0006-capability-v3` 在前一步 migration history 已提交后再把 `local-control-core` 提升为 v3，并声明 `local_dispatch_plan:1`。DDL 与 capability 分步，避免 readiness capability 在其依赖 migration 尚未成为耐久历史前引用不存在的事实。

### 3. 候选发现复用唯一 SQLite authority

`LocalSqliteRunRepository` 同时实现有界 dispatch port，但仍只使用既有单连接/单 operation queue。候选必须满足：

- runtime-owned Run 为 `queued`，无 cancellation intent；
- latest Attempt 为 `claimed`，executor type 精确为 `local_process`；
- Attempt 引用的 revision 已发布；
- 顺序固定为 priority 降序、Run 创建时间升序、Attempt 创建时间升序、Attempt ID 升序。

分页必须使用稳定 keyset cursor 和 `limit + 1` 截断证据，不得 offset 全表扫描。一次 dispatcher pass 只读取一页：edge 最多 4 项，standalone 最多 16 项，`maxPages=1`；成功激活一个 Run 后立即返回。candidate race 可跳过继续，launch failure 必须向调用方暴露，不能静默制造重试风暴。

### 4. 计划物化严格先于 Artifact 和 spawn

每个候选的处理顺序固定为：

1. 重读 exact candidate authority；
2. 解析 pinned Task execution revision；
3. 解析 content-addressed context recipe；
4. 去重并解析全部 Secret reference；
5. 校验、合并并冻结有界 environment；
6. 读取文件系统容量并执行 Profile quota/reserve admission；
7. 创建私有、确定性的日志 Artifact；
8. 构造 `LocalExecutionStartCommand` 并交给 ADR-0070 coordinator。

revision、recipe、Secret 或容量不可用时必须在创建 Artifact 和调用 coordinator 前返回 unavailable。Secret 明文只存在于单次 materialization 调用栈，不得写入 revision、recipe、Artifact metadata、RunEvent、错误或日志。

### 5. Artifact 与输出使用 Profile 硬预算

日志 Artifact root/shard 必须为 `0700`，文件为不可跟随 symlink 的 `0600` 普通文件，标识由 Attempt ID 确定性派生。分配前使用 `statfs` 同时裁决剩余空间、Profile 总配额与保留水位：

| Profile | 单日志最大字节 | 必须保留的文件系统可用空间 |
| --- | ---: | ---: |
| edge | 4 MiB | 32 MiB |
| standalone | 64 MiB | 256 MiB |

launcher wrapper 使用一个 POSIX FIFO drainer 持续消费 stdout/stderr，但只把剩余 quota 写入 Artifact；超过上限后继续 drain，避免反压改变用户进程退出语义，并以不可覆盖的低敏 `truncated` fact 记录配额触达。不得为每个任务启动 Node sidecar、把输出行写入 SQLite、把 Secret/命令写入 truncation fact，或只依赖父进程内 pipe 作为日志持有者。

### 6. 本切片不宣称完整执行生命周期

dispatcher 是显式一次性调用对象，不安装 timer；未来 scheduler lifecycle 必须由 Profile application 以独立 admission、并发和停止协议拥有。当前完成的是 queued/claimed 到安全启动的入口，不包含 completion 在线消费、timeout/cancellation、shutdown drain、retry、Artifact retention/read authorization、加密 SecretStore 产品 adapter 或 API/UI 管理面。

## 被否决的替代方案

1. **直接向 stack 暴露 coordinator**：调用方可以绕过不可变定义、Secret 与 Artifact admission，拒绝。
2. **复用 legacy Cron/全局环境拼装**：重新引入 Sequelize、全局 mutable state 与 Secret 泄漏边界，拒绝。
3. **先创建 Artifact，再解析 Secret**：缺失 Secret 会留下无主文件并消耗闪存，拒绝。
4. **把 Secret 明文保存到 context recipe**：历史 revision、事件和备份会成为凭证仓库，拒绝。
5. **用 offset 或持续循环清空 backlog**：队列规模会直接决定单次延迟与内存，拒绝。
6. **只在 Node pipe 中截断输出**：控制面崩溃后日志存活与 quota 都不再成立，拒绝。
7. **超过 quota 后关闭 pipe**：SIGPIPE/阻塞会改变用户任务行为，拒绝。
8. **复用 cluster Dispatcher/Worker Lease**：让 edge/standalone 携带多副本依赖与无关 authority，拒绝。

## 影响与未完成项

已完成：

- runtime-core 的候选、revision、context recipe、Secret provider 与 definition/store port；
- SQLite `0005/0006` reviewed migration、capability v3、typed schema/readiness lockstep 和唯一 authority dispatch adapter；
- 独立 local-dispatch importer、严格 materialization 顺序和 Profile-aware Artifact allocator；
- edge 4/standalone 16 的单页 dispatcher，单次最多启动一个 Attempt；
- durable stdout/stderr hard quota 与不可覆盖 truncation fact；
- application 只暴露 dispatcher 与冻结 definition writer facade；
- 真实 Node 24 SQLite、文件系统、缺 Secret、低水位、输出超限和 activation race 测试。

仍未完成：

- 具体加密本机 Secret provider、key lifecycle、管理权限与审计；
- Task definition/revision/context recipe 的认证 API、Policy、Approval 和引用感知 retention；
- ADR-0072 已闭环 live completion receipt、cancellation、timeout 与 shutdown drain；仍缺 retry 与 Artifact retention/read stack；
- Linux x64/arm64、PID namespace、ENOSPC/断电、overlayfs 与固定低配路由器实机门禁；
- target executable、systemd/Docker/s6 controller 与 2.x cutover 产品流程。

因此本 ADR 关闭的是“安全启动前的 scheduler admission”缺口，不表示本机 3.0 已形成完整生产生命周期，也不授权默认启用 execution target。

## 验证

1. 不可变 revision/recipe 同内容重放幂等、不同内容冲突，Secret plaintext 不进入 SQLite。
2. dispatch keyset 顺序稳定，edge/standalone 每次最多读取 4/16 项并只激活一个。
3. missing revision/recipe/Secret 或容量低水位在 Artifact 创建和 coordinator 调用前失败。
4. Artifact root/shard/file 权限、symlink/普通文件和 deterministic identity 均被复核。
5. 真实 SQLite candidate 经 materializer 原子进入 ADR-0070 coordinator；activation race 不产生第二次 spawn。
6. 用户写出超过 quota 的 stdout/stderr 时 Artifact 精确停在上限、用户退出码不变、FIFO 被清理且 truncation fact 不含用户内容。
7. application context 不包含 launcher、coordinator 或 repository 候选读取方法。
8. dependency/source/lock audit 阻止 local-dispatch 导入 adapter、legacy、cluster 或 local-process，并阻止反向依赖污染 edge/standalone。
