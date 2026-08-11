# ADR-0190：Cluster Approved Publisher Trust Overlap Add 与 Safe Retire

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-175、D-177、D-178、D-179、D-180；
  ADR-0185、ADR-0187、ADR-0188、ADR-0189

## 背景

ADR-0188 只实现 compromised-key emergency revoke；ADR-0189 已保证挂载文件是 material、
durable head 才是 effective authority。正常 key rotation 仍缺少两种受批变更：

1. 在不删除旧 key 的前提下让一个预分发的新 key 生效；
2. 在所有当前安装均不再依赖旧 key 后安全退役旧 key。

若把 ConfigMap 更新直接当作生效，会绕过 Project Policy/Approval；若 retirement 只在
executor 启动时检查一次 head，并发 stage 仍可能在退役扫描后提交旧 signer provenance。

## 决策

### 1. 两种 action，不复用 emergency revoke

新增两个 action type：

- `plugin_package.publisher_key.overlap_add`
- `plugin_package.publisher_key.safe_retire`

它们都要求 trust-authority Project 的 `package.manage`，固定创建
`separation_of_duty` Approval；请求人与确认人必须是不同的强认证 User。正常轮换不提供
break-glass；suspected/confirmed compromise 必须使用 D-178 emergency revoke。

客户端只提交：

- `actionRef`、approval/audit identity；
- `mode`；
- `publisher`、`keyId`；
- strong authenticated principal。

客户端不得提交 PEM、candidate snapshot、previous/current digest、generation、影响集或
retirement proof。

### 2. overlap-add 从只读 material 派生

管理进程启动时读取并严格验证 publisher material 文件。首次 observation 创建 base/head；
后续不同 snapshot 只以 digest-only candidate 写入 snapshot ledger，并返回当前 effective
head，不能隐式推进 generation。

提案时，服务用进程内已审 material snapshot 与数据库 effective snapshot计算差异：

- 所有 effective key 必须逐字段保留；
- 必须只新增请求指定的一个 `(publisher,keyId)`；
- 新 key 在 proposal time 必须处于 lifetime；
- 禁止 removal、rewrite、批量 addition 或跨 publisher 附带变更。

proposal 绑定 candidate digest；executor 执行时再次从 durable snapshot ledger 解析并
重验同一 one-key addition。

### 3. safe-retire 从 durable effective set 派生

safe-retire 不要求 operator 先删除文件中的旧 PEM。服务从当前 effective snapshot 精确删除
请求 key，要求：

- 目标 key 当前存在；
- 同一 publisher 至少保留一个在 proposal time 当前有效的 successor；
- 除目标删除外没有任何 key 或 lifetime 变化。

候选 digest 由服务派生并写入 snapshot ledger。head 生效后，D-179 verifier 会排除旧 key；
operator 可在确认所有 recovery Job 已观察新 generation 后再清理旧 PEM。

### 4. v39 schema contract / pg-0040 durable proposal 与 receipt

control-core v39 由 `pg-0040-plugin-package-publisher-trust-transitions`
新增：

- `plugin_package_publisher_trust_transition_proposals`：不可变绑定 mode、Project/Policy
  fence、proposer、generation、目标 key、previous/candidate digest、action/preview
  digest；
- `plugin_package_publisher_trust_transition_receipts`：绑定 approved dispatch、
  proposal、previous/current generation/digest、执行 User/fence、retirement proof
  summary 和数据库时间。

proposal/approval/dispatch/receipt 必须 exact replay。manager 只能插入 candidate/proposal/
approval/audit；只有 package-executor 可推进 head 和写 receipt。

### 5. retirement 与 stage 使用同一 signer fence

所有 `(publisher,keyId)` mutation 继续使用 ADR-0187/0188 的同一 domain-separated
advisory transaction lock。

safe-retire executor 在 SERIALIZABLE transaction 内：

1. 锁 signer；
2. `FOR UPDATE` 精确 authority head 并重验 generation/digest；
3. 扫描该 signer 对应的 current `staged|activating|active` install head；
4. 要求 matching count 为零；
5. 写 zero-impact retirement proof receipt；
6. 推进 effective head generation；
7. 原子提交 head 与 receipt，二者共同构成唯一业务提交点。

通用 Approved Action dispatcher 在业务事务返回后，将 execution 投影为 `succeeded`。该投影
不参与 trust authority 判定，也不能单独推进 generation。若进程在业务 COMMIT 成功后、
execution 完成前崩溃，恢复执行必须以同一 dispatch、proposal、execution start time
重新调用 transition repository；repository 只允许返回完全相同的 receipt/head，
dispatcher 再收敛 execution。不得为了消除该投影窗口，把通用 dispatcher 的 execution
协议或其他 handler 的事务所有权耦合进 publisher trust repository。

provenance stage commit 在 signer lock 后必须按安装显式绑定的 trust authority 查询当前
effective snapshot，并要求 signer 仍存在。这样顺序只有两种：

- stage 先获锁并提交，retire 随后看到 impact > 0 而拒绝；
- retire 先获锁并提交，stage 随后看到 key 已不在 effective set 而拒绝。

不得仅依赖 recovery 启动时缓存的 registry。

### 6. authority ID 必须显式贯穿 stage

Package recovery 配置已经具有 `QL3_PLUGIN_PACKAGE_TRUST_AUTHORITY_ID`。D-180 将该 ID
传入 provenance repository/commit command；repository 不允许“任一 authority 包含该 key”
或隐式选择第一条 head。若未来需要一个集群多个 trust domain，必须在 Package proposal/
lock 中增加受批 authority binding，不能靠数据库枚举猜测。

### 7. 资源与包边界

复用现有：

- runtime-core trust/action contract；
- cluster-postgres snapshot/head、Approved Action、provenance repository 与 migration
  stream；
- cluster-admin management transport/process 和 caller-driven executor。

不新增 workspace package、生产依赖、listener、timer、Service 或常驻 controller。现有
executor 的最多 2 个连接、批预算和 opt-in CronJob 不变；低配节点可继续外部调用一次性
CLI。

## 不采用方案

### ConfigMap rollout 自动推进 head

Kubernetes write authority 不能替代 Project Policy、双人 Approval 和 durable exact replay。

### safe-retire 复用 emergency revoke

正常零影响 retirement 不应制造 compromise reason、revocation receipt、Run/Tool emergency
deny 与 quarantine 语义。

### retirement 只检查当前 catalog 或只读快照

catalog 不是 Cluster 当前 install-head authority，事务外只读也无法与并发 stage 串行化。

### 查询任意 authority 是否包含 signer

会在多 authority 时错误放宽 signer，属于 confused-deputy。

### 新拆 trust-transition package

没有新的 Profile、credential、制品或第三方依赖边界，违反 ADR-0185。

## 验收证据

- 纯 contract 覆盖 exact one-key add/remove、same-publisher successor、lifetime 和客户端
  digest injection 拒绝；
- PostgreSQL mock 与真实 PG 覆盖 candidate observation、proposal exact replay、
  manager/executor ACL、receipt/head atomicity，以及业务 COMMIT 后 execution 投影丢失的
  exact replay；
- 并发真库门确定性覆盖 `stage wins → retire blocked` 与
  `retire wins → stage blocked`；
- management transport 只暴露 mode/publisher/key ID；
- executor 同时消费 revoke 与 transition，保持 caller-driven bounded work；
- 本机 arm64 PostgreSQL 18.4 真库集成覆盖 generation `1→2→3`、2 条 receipt、
  safe-retire exact replay，以及共享 advisory lock 下 stage/retire 双向单赢家；
- `qinglong/postgresql-ha-contract@v1` 使用 physical streaming、`remote_apply`、
  timeline `1→2`、旧主 fencing、promotion、`pg_rewind` 与只读同步 rejoin，证明
  old+new material 预分发、双人审批、2 proposals、2 receipts、2 succeeded
  executions 和 generation `1→2→3` 在 WAL replay 与 promotion 后持续；
- workspace 保持 22 包；cluster dependency、cluster deployment、CloudNativePG
  deployment 与 edge import audit 均无 finding。
