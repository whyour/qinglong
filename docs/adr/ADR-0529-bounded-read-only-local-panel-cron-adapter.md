# ADR-0529：有界只读 Local 旧面板 Cron Adapter

- 状态：Proposed（源码候选，尚未进入双架构阶段实物）
- 日期：2026-09-02
- 关联 RFC：QL-RFC-0001 D-427、D-423、D-424、D-426c3

## 背景

QingLong 2.x 面板以 `/api/crons`、数值型 Cron 行和 `{code,data}` 包络读取定时任务；QingLong 3.0 Local API 则以 Project-scoped Task、immutable Trigger revision 和 `/api/v3` 为权威。当前 Console Alpha 已经可以操作 Task、Trigger、Run、日志和 Secret，但它携带的是小型离线 Console，不包含 33 MiB 的 2.x 静态面板，也不能把 2.x JWT、明文 Env、整数 ID 或旧 Service 直接当作 3.0 authority。

直接让旧面板写入 3.0 SQLite 会绕过 Project Policy、credential reconfirm、durable audit、revision/content digest fence，并重新耦合已经分离的 Task 与 Trigger。另一方面，要求所有部署者立即迁移到新 Console 会阻断现有页面的渐进复用。因此需要一个显式、窄面、可逐步扩展的 Adapter，而不是恢复完整旧后端。

## 决策

第一切片在既有 `@qinglong/local-api` 内新增 `panel-compatibility/` 子域，不新增 workspace package、依赖、数据库表、连接、listener、timer、watcher 或后台进程。

### HTTP 与权限边界

- 仅新增 `GET /api/crons`；没有 POST、PUT、DELETE、login、session、WebSocket 或静态面板分发。
- 请求仍走正式 Local API Bearer credential、`task.read` Project Policy、durable security audit 和 credential reconfirm；审计 operation 固定为 `panel.cron.list`。
- 第一切片固定投影 `default` Project。多 Project 选择必须在后续 capability/session 设计中显式增加，不能从未受信 Header、Cookie 或查询参数猜测。
- 默认 headless Application 不包含 `@qinglong/local-api`，因此没有新增端口或稳态开销。Cluster 不复用本 Adapter，后续使用独立 Cluster Panel Gateway。

### 有界查询

- 接受旧页面初始读取所需的 `page`、`size`、空 `searchValue`、空 `filters={}` 和 Axios cache-buster `t`。
- 非空搜索、排序、View query 或其他字段暂时返回 `400 invalid_panel_cron_list_query`，不能静默忽略并给出错误结果。
- `size` 最大 64；`page * size` 在 Edge 最大 64、Standalone 最大 256。Adapter 用同一上限向 Trigger source 做一次有界 keyset 前缀读取，再截取所需页。
- `total` 是当前已观察前缀加一个 `truncated` 继续标记；它足以让旧分页逐页推进，但不执行无界 COUNT 或全表扫描。

### 领域映射

- 每个 `qinglong/cron@v1` Trigger 投影为一条旧面板 Cron 行，稳定 `id` 使用 `triggerId` 字符串，不构造有碰撞风险的伪数值 ID。
- Adapter 按 Trigger 固定的 `taskId + taskRevision + taskContentDigest` 读取 pinned Task revision，并复算 Trigger/Task record 与 cron semantic；缺失、漂移、未知 Trigger schema 或异常页整体返回 503。
- `schedule`、timezone、misfire policy 来自已规范化 Trigger；名称、启停状态来自 pinned Task 与 Trigger 的合成结果。
- `command` 只返回 `ql3:<kind>:<taskId>@<revision>` 描述符，不返回 Task spec、argv、环境、Secret、label、mutation ID 或 content digest。
- 返回行附带只读 `ql3` identity，明确 Project、Task/Trigger revision 与 `readOnly=true`；旧页面当前未知字段会忽略它，后续改造版面板可据此关闭写按钮。

## 明确不做

本 ADR 不声明现有 2.x 面板可以零修改登录或完整运行。尤其不允许：

- 把 `ql3c_` credential 放入 2.x 登录密码字段或长期存入 Local Storage；
- 复用 2.x Auths/Users/JWT 作为 3.0 Identity/Policy；
- 猜测 `/api/crons` 写操作、整数 ID、Cron View、Subscription 或 Script 文件语义；
- 回显 Secret/Env 明文，或将 Task 与 Trigger 的独立 revision 压回一个可直接覆盖的旧对象；
- 为兼容页面扩大 loopback、CSP、response byte、并发或低配资源预算。

## 验证与后续门禁

源码候选必须通过：

1. Adapter 单测：分页、禁用合成、pinned identity、未知 schema、预算和 storage failure；
2. HTTP 契约：编码的 `{}` 查询、正式 operation 解析、拒绝非空搜索且不进入 Admission；
3. Admission 契约：authenticate → `task.read` → audit → confirm → route；
4. 真实 SQLite 集成：正式 credential、Policy、Task/Trigger revision 和 durable audit，且响应不出现真实 argv；
5. Local API 全包、18-package build/test、dependency/import、Console/Headless image 与双架构 artifact 门。

后续按 `health/system/user capability → Run/Log read → 显式写操作` 推进。只有改造版面板取消 Local Storage credential、按 capability 隐藏未实现页面，并完成真实浏览器 journey 后，才能声明“现有面板页面可复用”；完整 2.x 零改兼容不作为 3.0 目标。
