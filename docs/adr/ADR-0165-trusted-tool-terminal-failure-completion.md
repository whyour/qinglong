# ADR-0165：Trusted Tool 失败与超时终态完成协议

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0156、ADR-0158、ADR-0162 至 ADR-0164；RFC D-152 至 D-154

## 背景

ADR-0163/0164 已关闭 Trusted Tool 的成功持久化与 Profile-neutral 成功协调，
但 adapter 明确失败和 deadline 到期仍会让 StepRun 停留在 `running`。如果每个
Profile 自行解释异常，低配路由设备和集群节点会产生不同的终态、重试和敏感信息
持久化语义；若把异常对象、stack 或未知 output 写进 RunEvent，又会扩大泄露面。

失败终态还必须与成功 completion 竞争收敛。仅在应用层先查一次成功记录不能证明
互斥：并发调用、事务提交响应丢失和 PostgreSQL 主库切换都可能让调用者观察到未知
结果。

## 决策

### 1. 失败完成只保存固定低敏事实

runtime-core 新增显式 subpath
`@qinglong/runtime-core/tool-execution-failure-completion`。v1 只接受：

- `failed`：`tool_adapter_failed` / `Trusted Tool execution failed`；
- `timed_out`：`tool_deadline_exceeded` /
  `Trusted Tool execution deadline exceeded`。

completion 必须绑定 exact start、Project、Run、StepRun、Tool、adapter、Run version、
event sequence、mutation 和 event identity。它不保存 raw error、stack、adapter output，
也不创建 Result Artifact 或取得 result key authority。

### 2. 成功与失败 completion 必须原子互斥

SQLite 与 PostgreSQL 各增加 append-only failure completion 表和 repository。失败提交
必须在一个事务内完成：

1. 复验 start barrier、当前 `running` Tool StepRun、非 terminal Run；
2. 拒绝同一 start 已存在的成功 completion；
3. 将 StepRun 原子迁移到 `failed` 或 `timed_out`，保持 `outputRef=null`；
4. 推进 Run version/event sequence；
5. 写入固定低敏 RunEvent、StepRunMutation 与 failure completion。

成功 repository 同样必须在事务内拒绝同一 start 的失败 completion。SQLite 使用
`BEGIN IMMEDIATE` 串行化双方竞争；PostgreSQL 使用 serializable transaction，并锁定
exact StepRun/Run。两侧都只允许完整命令 exact replay，任何部分身份复用、跨表镜像
漂移或同时存在成功/失败记录都失败关闭。

SQLite capability 推进到 v32，共 55 张受管表；PostgreSQL `control-core` capability
推进到 v33。PostgreSQL runtime role 对 failure completion 只取得 `SELECT, INSERT`，
admin、Package manager、Package executor、Worker ingress 与 PUBLIC 默认拒绝。

### 3. 一个协调器裁决所有 Tool 终态

runtime-core 新增显式 subpath
`@qinglong/runtime-core/trusted-tool-completion`，由
`executeAndCompleteTrustedTool` 固定编排：

1. 执行 adapter 前同时读取 durable success/failure winner；
2. 只有两者均不存在才调用既有 Trusted Tool execution；
3. adapter 抛错后再次读取 durable winner，先收敛并发或未知提交结果；
4. 只把明确的 `TrustedToolExecutionFailedError` 归类为 `failed`；
5. 只把明确的 `TrustedToolExecutionDeadlineExceededError` 归类为 `timed_out`；
6. Artifact、key、binding、snapshot、storage 等缺失或损坏继续保持非终态并失败关闭；
7. failure commit 响应丢失后只读取 durable winner，同一次调用不得重新执行 adapter。

返回值是 `succeeded | failed | timed_out` 的判别联合。固定 system actor、start-derived
dedupe、mutation 和 event identity 均由协调器生成，不接受 transport 注入。

### 4. 保持双 Profile 的资源边界

现有 `LocalSqliteTrustedToolStorage` 与 `ClusterTrustedToolStorage` 增加
`failureCompletions` port，不新增 workspace package或第三方依赖：

- edge/standalone 仍使用首次请求才动态加载的 SQLite 单例 bundle，不新增连接、
  timer、watcher 或 socket；
- cluster-control 仍只通过受审 `@qinglong/cluster-postgres/runtime` 组合入口，
  在现有单一 Pool 上装配同构 bundle；
- runtime-core root、PostgreSQL root/admin/ingress 和生产 transport 不获得执行
  authority；生产 allowlist 仍只有 `run.get` 与 `run.cancel`。

## 被否决方案

1. **把异常序列化进 Artifact 或 RunEvent**：扩大敏感信息面，且失败终态不需要解封。
2. **只有失败 repository 检查成功记录**：晚到的成功事务仍可穿透，无法证明互斥。
3. **用任意异常自动终态化**：会把 key 丢失、binding 漂移或数据库不可用误报为业务失败。
4. **协调器捕获后重跑全部流程**：会重复 adapter 副作用。
5. **为两个 repository 各拆一个 package**：没有独立部署或依赖边界，只会加重
   路由设备安装、构建与审计成本。
6. **因终态闭环而开放生产 route**：result key 生命周期、人工恢复和专属故障注入
   尚未完成。

## 验证

- runtime-core：331/331，覆盖成功、失败、超时、固定事实、并发 winner、响应丢失、
  adapter-call-count=1、前置条件缺失保持非终态和显式 subpath；
- local-sqlite：119/119，真实 SQLite 覆盖原子失败提交、exact replay、成功/失败双向
  排斥、固定事实与 lazy storage bundle；
- cluster-postgres：181 pass / 1 条件 skip，覆盖事务 SQL、双向排斥、typed schema、
  migration checksum、readiness、六角色权限和 composition entrypoint；
- cluster-control：139 pass / 2 条件 skip，覆盖单 Pool storage 装配与依赖边界；
- 21 个 QL3 workspace package 全量 build/test 为 0 fail，package 数量和第三方依赖
  均未增加；edge import、cluster dependency、cluster deployment 审计无 finding；
- 全新 PostgreSQL 18 六角色真库 integration：42 pass / 1 条件 skip / 0 fail，直接
  覆盖 `timed_out` 原子提交、exact replay、晚到成功拒绝、固定低敏事实与无 output
  明文；
- PostgreSQL 18.4 arm64 物理 HA 总门 `passed=true`：`remote_apply`、timeline 1→2、
  旧主 fencing、双 control replica 重新 activation、`pg_rewind` 只读同步重加入及
  既有领域 COMMIT-response-loss 门全部通过。该 HA fixture 尚未注入 Trusted Tool
  failure completion 专属 COMMIT-response-loss，不能用通用事务门替代该证据。

## 后续门禁

1. 在真实 PostgreSQL 上执行新增 terminal completion integration，并给 Tool completion
   注入 COMMIT-response-loss、主库晋升后 durable winner 和 adapter-call-count=1；
2. 给 SQLite 增加 adapter 返回后、failure/success 事务提交前后的进程 crash 矩阵；
3. 建立 result key catalog、rotation、retention/rekey 与 key-lost 人工恢复；
4. 按 Project current snapshot 构造短生命周期 adapter registry，再评审产品
   use-case/transport 入口。
