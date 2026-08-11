# ADR-0164：Trusted Tool 成功协调器与 Profile 存储装配

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0087、ADR-0088、ADR-0158 至 ADR-0163；RFC D-151 至 D-153

## 背景

ADR-0163 已定义并实现加密 Result Artifact 与双方言原子 completion repository，
但调用者仍需手工串联 durable start、adapter execution、结果密封、StepRun mutation
和 commit。手工串联会留下三类问题：

- 每个产品入口可能用不同顺序处理已有 completion、并发 winner 与 commit 响应丢失；
- adapter 成功后若盲目重试，未来非只读 Tool 可能重复副作用；
- edge、standalone 与 cluster-control 尚未从各自组合根取得同构的 Tool storage ports。

实现仍必须兼顾低配路由设备和集群节点，并遵循 ADR-0087：没有独立部署、依赖或权限
生命周期的切片不得继续拆成单文件 package。

## 决策

### 1. 协调器留在现有 runtime-core

新增显式 subpath
`@qinglong/runtime-core/trusted-tool-success-completion`，不从 root 导出执行 authority，
也不新增 workspace package 或第三方依赖。

`executeAndCompleteTrustedToolSuccess(startId, dependencies)` 固定执行：

1. 先检查 durable completion；若存在，读取密文 Artifact、解析当前 binding、按 key ID
   取 owned key、解封并返回 exact durable output；
2. 仅在 completion 不存在时执行 durable start 后的受信 adapter；
3. adapter 返回后再次检查 completion，收敛并发 winner；
4. 复验 barrier、`running` Tool StepRun、非 terminal Run 及 version/event fence；
5. 用 Profile 提供的 active result key 密封 output；
6. 生成 `running → succeeded` StepRun mutation，并调用双方言原子 repository；
7. commit 抛出未知结果时只检查 durable completion；若已提交则解封该 winner 并返回，
   同一次调用不得再次执行 adapter。

完整首次提交返回 `created`；已有或未知响应恢复返回 `existing`。结果 key provider
交付的 byte buffer 在加密、解密、成功和失败路径均由消费者覆零。RunEvent 使用固定
system actor；dedupe key 由 start ID 的 domain-local SHA-256 派生，不接受 transport
提供的 mutation、event、Artifact 或 dedupe 身份。

### 2. edge/standalone 使用惰性单例存储 bundle

`LocalSqliteRuntimeDatabase.trustedToolStorage()` 返回一个冻结的单例 bundle：

- invocation Artifact repository；
- StepRun repository；
- start barrier repository；
- completion repository；
- Project Tool Definition snapshot repository。

四个原本不属于基础启动路径的 repository module 只在首次请求 bundle 时动态加载；
snapshot repository 与既有 Package recovery 路径共享同一实例。local-profile、
local-adopted-profile 与 local-application 只逐层转交这一惰性 factory，不在启动时
构造 Tool adapter、读取 key 或执行数据库查询。

这使未启用 Tool execution 的路由设备不承担额外常驻连接、timer、watcher、socket
或 repository module 加载成本。

### 3. cluster-control 复用一个 PostgreSQL Pool

cluster-control 在 readiness 通过后，从受审
`@qinglong/cluster-postgres/runtime` 组合入口构造同构的
`ClusterTrustedToolStorage`。所有 repository 复用 bootstrap 已拥有的单一 Pool，
不创建第二个 Pool、后台线程或 cadence。

cluster-control 不直接导入 PostgreSQL adapter 的分散子入口；cluster dependency
审计继续强制它只能依赖受审 runtime composition entrypoint。package root 仍不暴露
这些 adapter。

### 4. 存储装配不等于产品执行入口

生产 cluster route allowlist 仍只有 `run.get` 与 `run.cancel`。本机 application
context 和 cluster assembly input 只取得存储能力，不自动取得 result key、当前
Project snapshot 对应的 executable adapter registry 或 transport route。

在 failed/timed_out、key catalog/rotation、人工恢复和 Tool completion 专属故障门
完成前，不得把本 ADR 解释为 production admission 已开放。

## 被否决方案

1. **新增 coordinator package**：没有独立部署边界，会继续制造单文件 package。
2. **每个 Profile 自己手写顺序**：响应丢失和并发 winner 语义会漂移。
3. **adapter 成功后直接重试 commit 全链路**：会把 adapter execution 也纳入重试。
4. **edge 启动时 eager 构造全部 repository**：无 Tool 用户仍承担模块和对象成本。
5. **cluster-control 直接导入五个 adapter 子入口**：绕过受审 PostgreSQL runtime
   composition boundary；cluster dependency audit 已证明该方案不兼容。
6. **因 storage ports 已存在而开放 HTTP route**：缺少 key 生命周期、失败终态和
   专属故障恢复证据。

## 验证

- runtime-core：325/325，新增首次完成、密文 exact replay、adapter 不重放、commit
  响应丢失恢复、key lost fail-closed 与显式 subpath 门；
- local-sqlite：原 117 项全量通过，新增 lazy singleton/storage sharing 定向门通过；
- local-profile、local-adopted-profile、local-application 全量通过；
- cluster-control：139 pass / 2 条件 skip，真实 loopback 门在沙箱外通过；
- 21 个 QL3 workspace package 全量 build/test 为 0 fail；
- edge import 与 cluster dependency 审计无 finding；
- edge artifact：3,570,130 bytes、452 files、40 loaded modules、RSS 增量
  10,715,136 bytes；
- PostgreSQL 18.4 arm64 HA：物理 streaming、`remote_apply`、timeline 1→2、旧主
  fencing、双 control replica 恢复、`pg_rewind` 只读 rejoin 与全部现有 gate 通过。

HA 报告当前只证明 Tool invocation Artifact 与 Project Tool snapshot 跨晋升，以及
已有 domain commit-window 的 exactly-once；它尚未注入新的 Tool success completion
事务响应丢失，不能用通用 PostgreSQL transaction fault 代替该领域证据。

## 后续门禁

1. 给 PostgreSQL Tool completion 增加 commit-response-loss、晋升后 exact output
   解封与 adapter-call-count=1 的领域故障注入；
2. 给 SQLite 增加 adapter 返回后、事务提交前后的进程 crash 矩阵；
3. 定义 failed/timed_out 的低敏、可恢复 completion envelope；
4. 建立 result key catalog、rotation、retention/rekey 和 key-lost 人工恢复；
5. 按 Project current snapshot 构造短生命周期 adapter registry，再评审受审的
   transport/use-case 入口。
