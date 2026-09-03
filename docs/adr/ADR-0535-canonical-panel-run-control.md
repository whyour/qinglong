# ADR-0535：现有面板的规范 Task/Run 执行管理

- 状态：Accepted（D-433 原始源码主 CI 已通过；客户端组合门与实物待验证）
- 日期：2026-09-04
- 关联：QL-RFC-0001 D-433、ADR-0530、ADR-0531、ADR-0534

## 背景

现有面板已可登录、查看定时条目和定时执行日志，但不能实际管理运行。旧 Cron 的运行状态与 ID 不是 3.0 Task revision 或 durable Run authority；直接恢复旧运行/停止按钮会混淆定时绑定版本、当前任务版本，以及多个并发运行。

## 决策

- Local capability v1 增加可选 `panel.runControl: task_run_v1`。缺省保持旧只读体验，未知值拒绝，旧客户端可忽略新增字段。`cronList=bounded_read_only` 和 `legacyMutations=false` 不变：不开放旧 Cron 写接口、Task 编辑、Trigger 编辑、批量操作或其他旧页面。
- 定时行新增“执行管理”，复用当前 Ant Design 页面和同源 API。在确认前读取 Task 当前 revision/content digest，分别展示定时绑定版本和本次运行版本；显式确认后才 POST `/api/v3/projects/:project/tasks/:task/runs`，不自动重绑 Trigger。
- Run 浏览复用规范项目 keyset API，每个显式动作至多读取 64 条并仅展示当前 Task 的匹配项。页内及跨页顺序、重复条目、next cursor 和 canonical ID 均校验；翻页替换窗口，没有总数扫描、全文累积、自动查找或轮询。空页不证明更早没有匹配运行。
- 必须读取并选择具体 Run 才能请求取消，取消 POST 指向该 Run，不按 Cron 或“最新一次”猜测目标。取消 receipt 只证明请求已登记；运行终态仍以手动刷新后的 durable projection 为准。
- 手动启动返回的 Run 可直接选择、刷新并读取 latest Attempt 首片日志；不使用定时 Trigger 匹配，以免看错另外一次运行。Edge 16 KiB、Standalone 32 KiB，日志不累计或轮询。
- 每份确认绑定一个 mutation UUID、确切版本或 Run ID。传输结果不明时保留原确认，显式重试复用同一请求体；禁止并发确认，不静默创建另一份启动请求。关闭或重连不撤销已发送的服务端操作。
- 新客户端使用不含 credential 的连接代次和窗口生命周期标记，关闭、登出或同 credential 重登后的响应不得继续产生操作。凭据仍只保留内存，不写 URL、Cookie 或 Web Storage；服务端 `run.start`/`run.stop` Policy、audit 与 mutation fence 不变。
- 新模块位于 `src/components/qinglong3`，避免 Umi 将辅助模块注册为独立页面。不新建 package、依赖、listener、timer 或数据库权威；默认 headless 和 Cluster 不携带这个 Local 面板。

## 验证与边界

客户端测试执行真实 TypeScript 模块，覆盖确认前无 POST、current revision 与旧 pin 区分、实际规范 body parser、相同 mutation 重试、并发确认拒绝、权限/版本错误、错误 receipt、准确 Run 取消、分页顺序和预算、关闭/重登、延迟解码、明确 Run 日志与新旧 capability 兼容。

客户端专项 14/14、Local API 130/130，最终后端 1700 项（1698 pass / 2 环境条件 skip / 0 fail）；Local image 与 18-package boundary audit 均 compatible。真实 Chromium 在构建后的裁剪面板和合成服务上完成登录、版本 1/2 差异展示、确认运行、选中返回 Run、读取该次日志、确认取消与 cancelled 展示。服务记录只有一个启动 POST 和一个针对相同 Run 的取消 POST；整个交互期间只有一次 Cron 列表和一次项目 Run 列表，没有后台轮询。桌面 1280 与手机 390 宽度截图复核了弹窗滚动、表格横向窗口与底部关闭入口。上述浏览器证据不包含真实执行进程或数据库写入。

Node 20 legacy migration toolchain 的 production panel build 通过；裁剪包为 240 files / 11,993,647 bytes，仍在 256 files / 13 MiB 边界。全量前端 TypeScript 检查存在 41 项错误；通过 compiler host 读取提交前源码作对比，确认本次没有新增诊断，不将存量类型错误称为通过。

本切片不是完整旧面板迁移：任务/定时创建编辑、脚本、订阅、环境变量、依赖与多用户远程 Web 会话仍未闭合。Local 仍仅 loopback/SSH tunnel；不可将本地 mock 或 unit tests 当成实际 Owner 写入、公开发布或双架构镜像证据。D-431 实物不含本切片，交付必须绑定自己的 source revision。

## 真实客户端组合验收（待 Linux 执行）

已有 `ql3-local-api-cancellation-live-contract` 不再手写面板启动与取消请求，而是在宿主机将实际 `src/utils/qinglong3.ts` 和 `src/components/qinglong3/runControl.ts` 编译为临时测试模块，在同一个隔离 Linux 网络命名空间中使用真实 fetch 连接生产 Local API。记录两个源文件的 SHA-256；TypeScript、VM 适配器与生成模块均不进入产品制品，不新增 workspace package 或生产依赖。

验收顺序为未认证请求 401、实际 capability discovery、读取 Task 当前版本、确认前零写入、启动一次、SQLite/PID start identity 核对、运行列表与指定 Run 读取、运行中日志标记、取消响应已被服务端接受后模拟丢失、同一客户端 action 精确重试、进程退出、唯一取消事件与两条 allowed audit、有序重启后读取 cancelled 及原日志。等待仅属于测试驱动，不在页面中增加轮询。

报告升级为 `schemaVersion=2`，要求客户端源摘要、日志/重启日志、响应丢失和相同 body 重试事实，以及一次 start POST、两次 cancellation POST。旧 v1 报告不能代替新门；原 Linux、128/256 MiB、64/256 PID、SQLite 完整性和精确事件计数要求保持不变。报告明确固定 `browserRendering=false`、`ownerProvisioning=seeded_fixture`，不能声称已经完成浏览器渲染、真实 Owner 初始化、任务创建或定时配置全链路。

本地专项回归 21/21，完整后端 1704 项（1702 pass / 2 条件 skip / 0 fail）；Local image 与 18-package boundary audit 均通过。沙箱内完整回归因 loopback `EPERM` 失败后，在允许本机端口的环境完成上述重跑，不将首次失败算作通过。本机 Docker Engine 不可连接，官方启动/恢复尝试未成功，因此新增 Linux 客户端组合门尚未执行；原有 CI amd64/arm64 Local image job 将继续执行此门，不以单元测试替代。

## 远程 CI 与整分钟边界回归

原始面板执行管理提交 `e4ba5d405f55543dd5d3ca432c24648171ebdda4` 的主 CI [33802395394](https://github.com/whyour/qinglong/actions/runs/33802395394) 已成功；它不包含后续 `e684a6e6` 的真实客户端组合验收增强。

同一原始提交的 Console 流水线 [33802432083](https://github.com/whyour/qinglong/actions/runs/33802432083) 中 PostgreSQL 18 x64 job `100804888235` 失败于 `postgres.integration.test.cjs` 的双副本调度测试：首次 `initialized` 合计为 0、期望 1。该夹具将 Trigger 时间设为观察时间前 999 ms，又使用整分钟对齐的 evaluator；在 :00 附近首次调度会合法得到 `admit`，而不是 `initialize`。本地直接执行真实 `resolveLocalScheduleDecision` 已复现这一断言失败。

修正仅将这个副本/lease 测试注入的 evaluator 改为相对一分钟，避免日历边界决定测试阶段；后续仍通过 PostgreSQL 明确置 due，保持两个副本只接纳一次、一个 Run/两个事件及过期 claim 接管断言。新增覆盖分钟偏移 0、1、999、1000、59999 ms 的回归，确认初始化与显式 due admission 分离；不修改生产 croner、misfire、数据库时钟或 claim fence。相关本地 20 项通过，真实 PostgreSQL 集成因无服务跳过 1 项，仍须由远程 CI 验证；不得将旧失败 run 改记为通过。

后续 `eaf1370c` 主 CI [33804738059](https://github.com/whyour/qinglong/actions/runs/33804738059) 的 PostgreSQL 18 x64 job 已通过，但 arm64 后端 job `100812384844` 暴露验收步骤改名回归：Local Operator 静态审计按稳定步骤名校验 gate 顺序，改名导致 `LOCAL_OPERATOR_CI_GATE_ORDER_DRIFT`。此前全量本地回归发生在工作流步骤改名之前，因此不能作为最终提交全绿证据。修正恢复原步骤名，仅增加说明实际客户端验收的注释；不放宽审计、不改变执行内容。最终工作流状态下专项 12/12、完整后端 1704 项（1702 pass / 2 条件 skip / 0 fail）及 Operator image audit 均通过，仍需新 CI 终态证明。

## 中间包检查，不构成交付

`e4ba5d40` 的 Console 流水线虽然存在上述 PostgreSQL 失败，amd64 artifact `9912447836` 与 arm64 artifact `9912402613` 已上传。两份实际下载物的 `SHA256SUMS`、bundle v8 离线审计通过；archive SHA-256 分别为 `0a8a7ba60acc4753c3889fe18255adfd2cf8fde696814a066df87e7618282f2b`、`4d6b87c4822258233ff977bac36a09064a2c4e90df6a20ccb1d86af20d3fd583`。

两架构最终 Application layer 的原生 `console.js` 均为 82,521 bytes，SHA-256 `dfcba011a165743052fe290e4f4c6b6b90074fde8dec20392252100332a6eaed`，与该 source revision 逐字节相同，包含会话隔离修复；Crontab chunk 为 76,500 bytes，SHA-256 `16f7f79622947024b84c7bd43c74b81841a2372d90a09864e473fda863794446`，核对含 `task_run_v1`、版本确认、规范 cancellation 与 receipt 校验代码。240 文件 panel manifest 的两架构摘要同为 `923ea32ae7c08624f495e7e90aa9b37a66edfc69bbda3d971001d06cb439e842`。

这些证据只排除了“包里仍是旧页面”的问题，没有补齐浏览器端到端、客户端 Linux 组合门或成功 milestone；失败流水线的中间包不提供给用户部署，不替代 D-431 已交付阶段包。
