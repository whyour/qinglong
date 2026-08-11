# ADR-0022：Pinned Task Revision 与本地执行计划物化

- 状态：Proposed
- 日期：2026-07-18
- 关联：QL-RFC-0001、ADR-0003、ADR-0014、ADR-0021、ADR-0023、ADR-0024

## 上下文

自动重试创建 Attempt N+1 后，控制面必须重建与原 Run 相同 Task revision 的执行意图，同时为新 Attempt 创建新的日志、Secret 和 completion capability。直接读取“当前 Crontab”有四个不可接受的问题：

- Task 在 Attempt 1 之后可能已编辑或删除；
- 当前行无法证明与 Run 中的 `task_revision` 一致；
- 把 Secret 环境或 callback token 存入 Task revision 会扩大静态泄漏面；
- 把 Attempt 1 的日志、handle 或 callback capability复制给 Attempt N+1 会破坏隔离和 fencing。

edge 必须能用本地存储完成精确解析，cluster-control 则需要共享数据库和 Artifact；两种部署不能因此产生两套 plan 语义。

## 决策

### 1. Task revision 只保存不可变执行模板

`PinnedTaskExecutionRevision` 固定：

- `projectId/taskId/taskRevision`；
- `executorType`；
- command、working directory、environment policy、timeout、termination grace 和 resource policy；
- 一个不透明、不可变的 `contextRef`。

模板不包含 Run/Attempt ID，也不包含 Secret 明文、callback token、进程身份或可写日志句柄。命令和资源字段复用共享 `ExecutionSpec` 边界与大小限制，未知字段在物化时剥离。

### 2. 精确 revision 解析，禁止回退 latest

`TaskExecutionRevisionSource.resolve()` 只接受冻结的 Project/Task/revision 三元组。找不到精确 revision 时返回 unavailable；禁止读取最新版本、当前 Crontab 或名称相同的 Task 继续执行。

返回记录必须再次与持久化 candidate 的 Project、Task、revision 和 executor type 完全比较。漂移在任何 Secret、output 或 Executor 副作用前拒绝。

### 3. Attempt 身份由 Dispatcher 注入

物化器只从 candidate 注入 `runId/attemptId/projectId/taskId/taskRevision`，再通过共享 `cloneExecutionSpec()` 校验和深拷贝。Revision source 返回对象即使在运行时夹带同名身份字段，也不能覆盖 candidate。

这样同一 Task revision 可以确定性生成 Attempt 1、Attempt N+1 或远程 offer 的业务执行模板，同时每个 Attempt 保持不同的 ownership capability。

### 4. 动态能力由独立 context materializer 创建

`LocalExecutionContextMaterializer` 接受冻结 candidate 和 `contextRef`，为当前 Attempt 创建：

- 只在内存存在的 Secret 环境；
- attempt-scoped output sink；
- 可选的取消 signal；
- 非阻塞、幂等资源清理回调。

`contextRef` 是解析配方或受控引用，不是 Secret 本身。环境规范化限制最多 256 项、总计 256 KiB、单值 64 KiB；名称、NUL、输出 sink 和 signal capability 在激活前校验。环境复制到无原型、只读对象，避免调用方后续修改和 `__proto__` 污染。

context 缺失时 plan unavailable，不回退到继承宿主环境。校验失败时先调用可选清理，再向上报告；清理失败不能覆盖原始校验错误，也不能把 Secret 写入日志。

### 5. edge 与 cluster 只替换 adapter

- edge/standalone 可以用本地不可变 Task revision 表或内容寻址文件，并用本地 SecretStore/Artifact 日志实现 context materializer；
- cluster-control 使用 PostgreSQL revision metadata、对象 Artifact 和集中 Secret provider；
- 两者共用 candidate identity、template 校验、context 上限和 `ExecutionSpec` 物化逻辑。

当前 `next` 已按 ADR-0023/0024 提供 append-only SQLite Task revision/context recipe migration、Repository contract、内存 Secret provider port 和私有文件 Artifact allocator；仍没有生产 SecretStore、PostgreSQL/object Artifact adapter、容量 retention 或 startup 装配，因此保持 production unreachable。

## 影响

正面影响：

- Task 编辑不会静默改变历史 Run 或自动重试的执行内容；
- Secret 与静态 revision 分离；
- Attempt N+1 获得新的日志和 callback authority；
- edge 和 cluster 能共享严格相同的 fail-closed 物化语义。

代价与风险：

- 必须实现 Task revision retention，不能只保存当前 Task 行；
- `contextRef` 的备份、权限和迁移需要与 Secret/Artifact ADR 对齐；
- revision 可读但 Artifact 已丢失时，Run 会保持 unavailable，必须有告警和运维处置；
- 256 KiB 环境上限可能要求大型输入改用 Artifact，而不是环境变量。

## 未选择的方案

1. **重试时读取当前 Crontab**：revision 漂移，拒绝。
2. **把完整 ExecutionContext JSON 存入 Run**：Secret 和 capability 静态泄漏，拒绝。
3. **复制旧 Attempt 的日志、handle 和 callback token**：破坏 Attempt 隔离与 fencing，拒绝。
4. **找不到 revision 时回退 latest**：执行内容不可审计，拒绝。
5. **edge 与 cluster 各写一套 spec builder**：验证和限制会漂移，拒绝。

## 验证要求

- revision source 只收到冻结的精确三元组；
- revision 缺失时不调用 context materializer；
- revision/executor 漂移在 context 和 Executor 副作用前拒绝；
- source 夹带身份字段不能覆盖 candidate；
- command/resource policy 和环境均深拷贝；
- context 缺失不回退，校验失败调用清理；
- 环境项数、单值、总字节、NUL、输出 sink 和 prototype pollution 有边界测试；
- Node 22、Node 24 全量回归通过。
