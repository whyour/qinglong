# ADR-0471：Legacy 核心执行 API 兼容基线

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-378、PR-0、Runtime Milestone Gate
- 关联 ADR：ADR-0002、ADR-0445、ADR-0454、ADR-0470

## 上下文

QingLong 3.0 已经具备 Shadow Run、受门禁的 Manual Primary、Run/Event、取消恢复和本地/集群执行协议，但这些新能力不能以破坏 2.x
Cron 与 Subscription API 为代价。现有路由仍是 Web UI、Shell、Open API 适配层和大量部署脚本的产品契约；仅验证 Runtime 内部状态机，不能证明
3.0 开关两侧仍保留相同的 HTTP method、path、请求校验、服务参数和响应 envelope。

首个兼容基线应从最靠近现有用户执行闭环的路径开始：Cron 与 Subscription 的列表、创建、更新、启停、手动运行、停止和日志。测试必须执行真实
Express Router 与 Celebrate 校验器，而不是复制一份路径清单或只搜索源码。它也不能为了测试方便启动完整 QingLong master/worker、数据库、gRPC、
Scheduler 或任何 3.0 后台 lifecycle。

## 决策

1. 增加独立的真实回环 HTTP 契约测试，直接注册生产 `back/api/cron.ts` 与 `back/api/subscription.ts` Router，并挂载在现行 `/api` 前缀。
2. 服务层使用 TypeDI 注入的确定性 spy，因此测试只裁决 Router 责任：HTTP method/path、Celebrate request contract、参数透传、2.x response envelope
   与错误请求在 service dispatch 前拒绝。它不伪造数据库、进程或 Scheduler 集成证据。
3. Cron 基线覆盖 list、create、update、disable、enable、run、stop、单日志、日志列表和单实例 stop。`run|stop|enable|disable` 继续返回
   `{code: 200}`，不得因为 3.0 内部拥有 Run ID 而向 2.x 成功 envelope 强塞 v3 字段。
4. Subscription 基线覆盖 list、create、update、disable、enable、run、stop 和日志；`searchValue`、`ids` 与 numeric ID 的现有转换语义保持不变。
5. 非法 Cron run 与 Subscription stop body 必须由真实校验器返回 HTTP 400，且 service spy 调用数保持不变，证明无副作用 dispatch。
6. 本切片只增加测试、ADR 和 RFC 状态，不修改任何生产 function/class/method，不新增依赖、package、binary、schema、migration、端口、服务、timer、
   queue、cache、数据库连接或部署对象。测试结束时关闭临时回环 listener 并清理 TypeDI token。
7. 本基线不是“完整 2.x 兼容已完成”的声明。System、Script、Open API、鉴权/错误码、真实 SQLite 升级、Primary 开关双态、目标实例回滚和 UI/Shell
   仍须后续独立 contract 与 rehearsal，完成前 Runtime Milestone Gate 保持未关闭。

## 被拒绝的替代方案

### 只用正则扫描路由源码

拒绝。文本存在不能证明路由注册顺序、校验器转换、TypeDI 调用和实际 JSON 序列化行为。

### 启动完整 QingLong 服务作为每次后端单测前置条件

拒绝。它会把数据库、gRPC、cluster fork、文件系统和调度器故障混入 Router contract，增加低配开发机和 CI 的成本，也无法精确定位兼容漂移。

### 让 2.x run 响应直接返回 QingLong 3.0 Run 对象

拒绝。现有客户端依赖 code-only 的异步接受语义；Run/Event 应通过 `/api/v3` 或后续显式兼容扩展发现，不能静默改变 2.x envelope。

### 将全部 2.x API 一次性冻结在一个超大测试中

拒绝。首个阶段优先覆盖执行主路径，并明确登记剩余域；后续 contract 应按 Identity/Open API、System/Script、文件与日志等稳定产品边界扩展，避免难以维护的
单体 fixture。

## 升级与回滚

- 本切片没有生产行为和持久化变更。升级只增加 CI 回归门，运行中实例不加载测试文件。
- 若契约基线本身错误，可回滚测试、ADR 与 RFC 增量；不得通过删除测试掩盖真实 2.x 兼容回归，应先由 Maintainer 明确批准兼容变更。

## 验证与证据

- 聚焦真实 Router 契约为 `18/18`，覆盖 16 个成功路径/子路径和 2 个校验前拒绝路径；每个成功路径同时校验 HTTP 状态、JSON envelope 与 service 参数。
- 完整 backend 为 `1,523 total / 1,521 pass / 2 conditional skip / 0 fail`；18-package clean build 与逐包测试在允许既有 Worker TLS
  回环门后单次退出 0。
- package boundary、Cluster dependency、Edge import、Cluster/Worker deployment、Console 与 Console distribution 七项审计全部
  compatible/passed；workspace 仍为 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`。
- 14 档 Local artifact audit 全部 compatible；基础 Edge/Standalone 为 `2,598,669 / 2,598,747` bytes、57 loaded modules，
  Application+AI 为 `4,501,822 / 4,501,954`，MCP 为 `7,324,601 / 7,324,709`。新增测试不进入任何运行制品。
- PostgreSQL HA 不重跑且不重新占有既有证明，因为本切片没有 schema、ACL、repository、role、Pool、连接或 failover 变化。
