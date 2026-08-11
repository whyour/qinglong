# ADR-0279：受认证的 Cluster Plugin Package Workflow 取消产品入口

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-29、D-35、D-47、D-87、D-213、D-257、ADR-0056、ADR-0228、ADR-0230、ADR-0271、ADR-0277、ADR-0278

## 上下文

Cluster Control 已有通用的 Project/Run 取消入口，也已有 Plugin Package Workflow 的 inspect/start 产品入口，
但产品用户不能通过 Package/Workflow 资源路径取消一个已经启动的 Workflow Run。若客户端先 inspect
Workflow admission，再调用通用 Run 取消入口，两个请求之间存在 TOCTOU 窗口；通用入口也不能证明目标 Run
确实来自路径中的 Package 与 Workflow。

这项补齐不能复制 ADR-0228 已有的 Run cancellation 状态机、Event、远程 Worker stop 与恢复 cadence，也
不应为一个路由增加 workspace package、表、migration、Pool、listener、timer 或 watcher。PostgreSQL runtime
角色对 immutable Workflow admission 只有 `SELECT, INSERT`，不能为了锁定一条 append-only 证据而扩大到
`UPDATE`。

## 决策

1. Cluster Control 发布
   `POST /api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs/{runId}/cancellation`，
   operation 为 `workflow.cancel`，权限为 `run.stop`。请求复用严格的
   `qinglong/run-cancellation@v1` body，只接受 `mutationId`；reason、event identity 与时间均由服务端
   决定。
2. Workflow administration capability 把路径中的 `packageName`、`workflowId` 与 `runId` 作为一个
   `workflowTarget` 传给既有 `ClusterRunCancellationRepository`。通用 Project/Run 入口不携带该 target，
   因而保持兼容。
3. PostgreSQL repository 在既有 serializable transaction 中先锁定 Project、RoleBinding 与 Run，再按唯一
   `run_id` 普通读取 immutable `plugin_package_workflow_admissions`，并要求 Project、Package、Workflow
   三元组逐项相等；缺失、跨 Project 或目标不匹配统一按 not-found 屏蔽。Run 锁仍使用 `FOR UPDATE`，admission
   不使用 `FOR SHARE`，从而保持 runtime 角色无 `UPDATE` 权限的最小权限边界。
4. 目标绑定通过后继续复用同一个 repository 的 terminal、already-requested、mutation replay、Run 更新、唯一
   `run.cancel_requested` Event 与 recovery convergence；Workflow 路由与通用 Run 路由由同一个 composition
   root 注入同一个 repository instance。
5. 首次接受返回 202，其余 durable outcome 返回 200。响应沿用 content-free cancellation projection；
   not-found 返回低敏 `workflow_run_not_found`，围栏错误只允许 `authorization_changed`、
   `project_mismatch`、`state_mismatch` 三种 reason，任何未知 adapter detail 都折叠为
   `state_mismatch`。
6. PostgreSQL HA 门必须从真实 Workflow publication/admission 出发，用明确的 `workflowTarget` 触发远程
   Worker stop，并同时验证完成提交响应丢失、取消提交响应丢失、WAL 复制、升主与 replay 收敛。

## 被拒绝的方案

- **先 inspect 再调用通用 Run 路由**：跨请求检查存在 TOCTOU，无法原子证明路径资源与 Run 的归属。
- **在 Workflow capability 中复制取消状态机**：会产生第二套 status、mutation、Event 与恢复语义。
- **给 admission 查询加 `FOR SHARE` 并授予 runtime `UPDATE`**：PostgreSQL 锁定读取要求写权限，会破坏
  append-only admission 的最小权限模型。
- **相信客户端提交 plan、digest、reason 或 event ID**：扩大了 capability surface，并允许调用者伪造服务端
  authority。
- **新增 Workflow cancellation package 或持久表**：没有独立部署、复用或生命周期价值，并违反 19-package
  硬上限的收敛方向。

## 接受证据

- Runtime Core 437/437；Cluster PostgreSQL 定向 repository 6/6；最终 Cluster Control 175 pass/2
  conditional skip/0 fail。完整 19-package 门退出 0，后端 1,101 tests、1,099 pass/2 skip/0 fail。
- Edge import、cluster dependency、package boundary schema v2、cluster deployment、worker deployment 与
  local image 六项审计全部 compatible；workspace package 数保持 19，未新增 dependency、migration、表、
  Pool 或常驻 cadence。
- 十档 local artifact 全 compatible，package/file/module closure 不变；Edge/Standalone
  3,548,694/3,548,742 bytes，Adopted 4,147,396/4,147,480，Application
  4,634,869/4,635,013，AI 4,883,616/4,883,676，Application AI
  5,969,863/5,970,019；最大档距 6 MiB 仍有 321,437 bytes。
- PostgreSQL 18.4 arm64 physical-streaming HA `passed=true`；
  `remoteWorkflowCancellationBindsWorkflowTarget`、远程 stop requested、completion exact replay、commit
  response loss convergence 与 promotion survival 全部为 true。首轮真实 HA 准确捕获 `FOR SHARE` 的
  runtime 权限失败；改为 immutable plain SELECT 后在不新增权限和 migration 的前提下通过，且
  `ql3-ha-*` container/network/volume 零残留。
- 刷新后 GitNexus 为 42,530 nodes/96,503 edges/1,675 clusters/261 flows；复查符号全部 LOW，Workflow
  capability 最高 2 direct/6 impacted/0 production process，HA matrix 仅影响测试 `main` 流程。
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

## 剩余边界

- D-213 仍需 production gateway/operator、跨区域与物理基础设施 fencing 的独立证据；Docker HA 不能替代
  production STONITH。
- x64 CI/发布 runner 的同构资源门，以及固定型号路由器的断电、闪存、热环境与长时间 soak 仍未执行。
- Web UI、MCP/Agent tool surface 与外部 OIDC ceremony 仍需在同一 `workflow.cancel` operation 上补齐，不能
  建立旁路状态机。
- 联网 production dependency vulnerability audit 因依赖元数据外发权限未获批准，本轮不重跑。
