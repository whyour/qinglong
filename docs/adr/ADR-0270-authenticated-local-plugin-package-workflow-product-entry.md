# ADR-0270：受认证的本机 Plugin Package Workflow 产品入口

- 状态：Accepted
- 日期：2026-08-04
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-12、D-70、D-212、D-213、D-250、D-251
- 关联 ADR：ADR-0223、ADR-0227、ADR-0228、ADR-0229、ADR-0269

## 背景

QingLong 3.0 已完成 Plugin Package Workflow 的 immutable plan、双方言 admission、frontier、
Task Attempt、执行、恢复、整体取消、唯一 scheduler cadence 和低资源门。但是本机产品只有 Package
安装/发布与 application runtime，没有受认证的 operator 入口来发现和启动已发布 Workflow。测试夹具能
直接调用 repository 不等于部署用户具备可用产品链。

如果 CLI 接受完整 publication、materialized revision 或 plan，调用者会取得本应由服务端权威派生的
generation/digest 字段；如果先做 Policy 检查再在另一个事务 admission，credential revoke、RoleBinding
变化或 Project archive 可以穿过 TOCTOU 窗口。

## 决策

### 1. 在既有 Owner CLI 增加 `ql3-workflow`

命令只读取当前 UID 的私有 `0600` command file，提供：

- `workflow.inspect`：使用 `run.read`，只返回当前 Package automation publication 的 Workflow 名称、
  enabled 状态、Step key、Task key 与依赖；
- `workflow.start`：使用 `run.start`，只接受 Project、Package、Workflow 与 caller-owned
  `planId/runId/stepRunIds`。publication、generation、revision、Task definition ref/digest 和完整 plan
  全部由当前 durable authority 派生。

Owner、Admin、Operator 可按现有 role matrix 启动；Viewer 只有 inspect 权限。两种操作都要求稳定强
User 与当前 credential。命令输出不含数据库路径、credential、Package digest、plan digest、Task spec
或业务参数。

### 2. 授权与 admission 必须原子提交

`workflow.start` 在现有 SQLite `BEGIN IMMEDIATE` 内重新验证：

1. credential version、pepper binding、状态和有效期；
2. active Project 与 exact Project/RoleBinding version fence；
3. allowed `workflow.start` security audit identity；
4. current active install/lifecycle/quarantine/publication/materialized revision/Workflow/Task evidence；
5. immutable Workflow Run、全部 StepRun、Event、mutation 与 admission receipt。

任一项失败回滚全部事实。底层通用 admission repository 保留原单参数接口，只增加可选的事务内 guard；
application scheduler 与既有 repository caller 不取得管理 authority。

### 3. 重放绑定 caller-owned identity

首次 start 使用 command 中的 UUID v4 `planId`、`runId` 与每个 Step 的 `stepRunId`。结果未知时必须原样
重放同一 command file；repository 先读取 durable plan，逐项比较 Project/Package/Workflow/Run/Step
identity，再返回 `existing`，不能读取 current head 后重新生成另一 plan，也不能产生第二个 Run。

### 4. 不增加低配常驻成本

能力位于既有 `runtime-core`、`local-sqlite`、`local-admin` 与 `local-owner-cli` 显式 subpath。workspace
保持 19，不增加 migration、表、第三方 dependency、连接、daemon、listener、timer 或 watcher。
`ql3-workflow` 只在 operator 调用时短生命周期加载；实际执行继续由 application 已有唯一 scheduler
cadence 接管。

## 替代方案

- **让用户提交完整 execution plan**：拒绝。会把 publication/generation/Task digest authority 交给调用者。
- **CLI 先授权、随后直接调用普通 admission**：拒绝。Role/credential revoke 可穿过事务边界。
- **为 Workflow API 新建 daemon 或 workspace package**：拒绝。本机已有安全 console、Policy、SQLite 和
  scheduler authority，新增常驻面只会扩大路由器资源与供应链成本。
- **CLI admission 后同步等待 Workflow 完成**：拒绝。长连接会把 CLI 生命周期混入 durable scheduler，
  也会在终端断开时产生错误取消语义。

## 验证

- Owner CLI 93/93；
- Runtime Core 431/431，其中新增授权契约直接证明 exact-shape、allowed audit/fence 绑定与
  subpath-only；
- Local SQLite 192/192；
- Local Admin 83/83；
- 真实 edge SQLite 产品测试证明 inspect、created→existing 三次重放、1 Run、2 StepRun、1 start audit；
- Viewer start 被 `permission_missing` 拒绝且保持 0 Run；
- transaction guard 的新建、重放与拒绝回滚门通过；
- 精确依赖边界 45/45、全仓 dependency/package-boundary/local-image audit 均为
  `findings=[]`，workspace 仍为 19；
- 完整 19-package 门退出 0；后端总回归为 1,094 pass/2 条件 skip/0 fail；
- 十档 Edge/Standalone、Adopted、Application 与 AI artifact 全部 `compatible=true`：最小
  Edge 为 3,506,692 bytes/324 files/10,780,672 bytes RSS，最大组合
  Standalone Application AI 为 5,874,007 bytes/474 files/20,496,384 bytes RSS，均未放宽预算；
- PostgreSQL 18.4 arm64 physical HA 回归 `gates.passed=true`，覆盖 `remote_apply`、timeline
  1→2、旧主 fencing、`pg_rewind` 只读重入和两个 fresh control replicas；本轮隔离的
  `ql3-ha-*` container/volume/network 均零残留。

## 影响

Plugin Package Workflow 第一次具有部署用户可调用的本机产品入口。它只负责安全 admission，不替代
application、scheduler、Worker 或 Executor。远程 Cluster transport、UI/MCP 入口和固定物理设备断电/
ENOSPC 证据仍是独立后续门。
