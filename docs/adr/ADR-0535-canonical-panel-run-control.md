# ADR-0535：现有面板的规范 Task/Run 执行管理

- 状态：Accepted（D-433 源码候选；同源 CI 与实物待验证）
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
