# ADR-0533：原生 Console 的任务、定时与运行列表分页

- 状态：Accepted（D-431 源码候选；远端 CI 与阶段实物待验证）
- 日期：2026-09-04
- 关联：QL-RFC-0001 D-431、ADR-0532

## 问题

原生 Console 已能创建任务、配置定时、运行和读取日志，但 Task、Trigger、Run 列表在第 64 条后要求操作者自行调用 API。超过一屏的数据无法从页面到达，不能作为日常管理体验。后端已有三类规范 keyset API，不需要新增分页服务或恢复旧 Cron 权威。

## 决策

- 三类列表共用当前静态客户端中的小型分页逻辑，不新增 workspace package、依赖或后端路由。页脚提供“下一页”“回到首页”“刷新当前页”；顶部刷新、切换栏目和管理写入后的列表刷新从首页开始。
- 每个显式动作最多一个列表 GET、64 条记录，替换当前 DOM；只保留当前请求边界，不缓存历史页、累积记录、自动翻页、轮询或增加总数扫描。Run 详情和日志仍按既有显式选择流程读取。
- Task/Trigger 分别按 `taskId`/`triggerId` 升序；Run 按 `createdAtMs`、同时间戳下 `runId` 降序。客户端核对页内及跨页顺序、重复 ID、64 条上限、继续标志、完整 cursor 字段与最后一行一致性。异常页不显示继续操作。
- 查询使用正式 HTTP parser 接受的 canonical ASCII ID；这些 ID 不含查询分隔符，不能把合法冒号编码成 parser 不接受的别名。新增测试将真实客户端生成的 URL 送入生产 HTTP surface，验证三类 continuation 被解析成正确的 typed cursor。
- 每轮刷新绑定 Project、栏目与不含 credential 的请求代次；过期成功、失败和 finally 不覆盖新的列表、连接状态或 busy 状态。刷新清空旧详情选择；Task/Trigger 详情响应也绑定选择代次和列表代次。Secret 仍保持原有有界目录，但列表响应在提交 catalog/DOM 前同样检查代次。
- 页脚在旧 DOM 被替换后不能再发起请求；重复点击同一个页脚只提交一次。失败的后续页保留当前边界重试与回首页入口，空的后续页不会被误报为整个 Project 没有数据。

## 明确边界

这不是数据库快照：浏览期间新建或更新的数据可能需要回首页重读。没有虚构总页数、随机跳页或无界上一页历史。它不包含 Secret 全目录分页、Run Event/Step 分页、筛选搜索、Cluster UI 或旧面板写操作。默认 headless 的资源和安装闭包不变。

## 验证

客户端测试直接执行发布的 `console.js`，覆盖三类第 65 条到达、刷新/回首页、同时间戳 Run、空页、503 重试、错误 cursor/顺序、重复点击、切换栏目、断开、同栏目重读、旧详情和旧 Secret catalog 丢弃；含真实 HTTP parser 集成合计 15/15。完整 Local API 为 114/114，无失败或跳过；完整后端 1685 项（1683 pass / 2 环境条件 skip / 0 fail）。Local image 与 18-package boundary audit 均 compatible。

原生 JS 为 80,336 bytes，三项静态资产共 111,857 bytes，仍小于单文件 96 KiB / 合计 192 KiB。D-430 的 `12ed38b7` 构建不含本切片；本地测试不等于 exact 双架构产物交付。

真实 Chromium 使用当前原生静态资产与合成 HTTP 数据验证了 Task、Trigger、Run 的第 65 条可达，任务详情可从第二页打开，DOM 每次只保留当前页。请求记录包含三个规范 continuation URL，浏览期间没有自动列表轮询。该浏览器证据验证交互，不冒充真实数据库、Owner 写入或双架构镜像验收。
