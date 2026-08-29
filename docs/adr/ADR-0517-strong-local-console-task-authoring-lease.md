# ADR-0517：强认证 Local Console Task authoring lease

- 状态：Accepted
- 日期：2026-08-29
- 对应 RFC 切片：D-422
- 关联：ADR-0256、ADR-0377、ADR-0512、ADR-0516

## 背景

ADR-0516 已让 Local Console 以 request-scoped credential fence 和本机一次性 proof 创建 Task，但 bounded Task read 有意隐藏完整 spec。直接用该投影编辑会静默删除环境变量、Secret bundle、工作目录或未来 schema 字段；把完整定义放进普通 Bearer read 又会扩大单因子凭据的读取能力。HTTP update 虽已存在，也必须防止调用方拿旧快照或其他 credential 读取的内容发起修改。

本切片要补齐可实际试用的 Web update，同时保持低配路由设备无后台成本、默认 headless 零增量、Cluster authority 独立。

## 决策

### 1. 完整定义只通过强认证 authoring read 交付

Local API 新增固定路由：

```text
POST /api/v3/projects/:projectId/tasks/:taskId/authoring
```

请求无 body。Bearer 必须解析为 User credential，并先通过 `task.update` Policy。第一次请求只发布 ADR-0516 的 owner-private POSIX presence challenge；验证 proof 前不读取或返回完整定义。proof 验证后形成短生命周期 `local_console` principal，服务同时重新授权 `task.read` 与 `task.update`，并要求两项决定的 Project/RoleBinding fence 完全一致。

读取后再次确认 exact credential authority，再记录独立的 durable `task.authoring.read` allowed audit。不存在与跨 Project 继续按既有边界收敛；任何 Policy、credential、SQLite 或 audit 不可用均失败关闭。

### 2. 返回一次性、内容绑定的编辑租约

成功响应返回完整 `TaskDefinitionRecord`，以及 10 分钟内有效的不透明 authoring lease。服务只保存 lease presentation 的 SHA-256，不保存明文；绑定包含：

- Project ID、Task ID、revision 与 content digest；
- credential ID/version；
- User subject。

lease 只允许消费一次。Edge 最多 8 个，Standalone 最多 32 个；过期项在请求进入时惰性清理，关闭 Local API 时清零 digest。实现不增加数据库表、migration、连接池、timer、watcher、daemon 或网络 listener。

### 3. update 需要 authoring lease 与第二份内容 proof

`PUT /api/v3/projects/:projectId/tasks/:taskId` 的 create 继续不需要 authoring lease，并拒绝调用方夹带 lease。update 必须同时提交 exact lease。服务在发布保存 proof 前检查当前 revision/content/credential 仍与 lease 相同；调用方完成第二次本机 presence 后，再次读取当前定义并原子消费 lease，随后进入 ADR-0516 已有的 credential-fenced Task administration transaction。

authoring proof 证明“允许读取完整旧定义”，保存 proof 证明“操作者确认这份新内容”，两者不得复用。租约检查不能替代事务内 expectedRevision、Policy、credential、RoleBinding 与 audit fence；检查和写入之间的竞争仍由已有 CAS/事务 authority 拒绝。

### 4. Console 只修改它明确展示的字段

Console 对内建 `command + qinglong/command@v1 + argv` 提供“编辑任务”。Task ID 只读；名称、说明、file、逐行 args 与 enabled 可修改。保存时以强认证快照为基底，只替换这些可见字段，labels 与 config 中未展示的 environment、Secret bundle、working directory 及未来兼容字段原样保留。无法严格识别的 kind/schema 继续使用受信 CLI，不提供有损编辑器。

页面仍只把 credential、proof、完整快照与 lease 保存在当前内存，不使用 Cookie、Web Storage、URL、日志或遥测。刷新、断开、关闭编辑器或取消 presence 会丢弃内存状态。

### 5. 部署档位保持分层

- 默认 Edge/Standalone headless 不加载 Local API、Console 或 lease manager；
- opt-in Edge Console 的 8 项上限避免低内存设备被长会话拖住；Standalone 为 32；
- Cluster 不接受 Local POSIX proof 或内存 lease。多节点 Task authoring 必须由 Cluster Control 的 TLS、RBAC、共享持久 authority 与独立管理面设计完成。

## 不采用的方案

- 不扩大 bounded Task read：普通列表/详情不应泄漏完整执行配置。
- 不让 Bearer 单独取得完整定义：这会把 strong User 降级为浏览器持有单因子 secret。
- 不只用 lease 直接写：读取授权不等于确认新内容，保存仍需要第二份 exact proof。
- 不让 Console 重新构造整个 command config：未展示字段会被静默删除。
- 不建立持久 Web session、轮询或 lease 清理 timer：当前显式操作与惰性清理足够，低配设备不承担常驻成本。
- 不抽象成 Local/Cluster 共用插件：单机 POSIX owner 与多节点身份、审批、HA 不是同一种 authority。

## 结果与验证边界

定向验证覆盖完整定义只在 proof 后返回、两次 credential confirm、read/update Policy fence 一致、durable audit、lease 的 credential/revision/content 绑定、一次性消费、过期与 Edge 容量；PUT 覆盖缺失/过期/漂移 lease 在生成保存 proof 前拒绝，以及 proof 后再检查并消费。真实 SQLite/loopback 旅程覆盖 authoring challenge → 完整 spec/labels → lease → 保存 challenge → revision 2 → bounded read 不泄漏 spec → 新 revision/content fence 启动。

本地 Local API 为 `64/64`；18-package clean build/test 为 `3,038 total / 3,016 pass / 22 conditional、platform 或 external-service skip / 0 fail`。package boundary 保持 18 packages 且无 single-source/shallow package，Cluster dependency 与 122-module Edge import audit 均 compatible。默认 Edge 为 2,737,205 bytes/329 files/58 modules；opt-in Edge/Standalone Console 为 4,077,890/4,078,034 bytes、473 files、12 packages、95 modules，RSS delta 16,269,312/16,318,464 bytes，均低于既有门。三资产合计 69,723 bytes。真实 Chromium 已完成双 proof 更新到 revision 2，并以 409 模拟断言验证未展示 config/labels 与 lease header 不得丢失；390×844 无横向溢出。

本 ADR 被合入、远端主 CI 及对应 Profile 门通过前只算源码候选；同源 amd64/arm64 Console Trial Kit 与 milestone index 重新生成并离线验真后，才升级为新的可下载阶段产物。既有 D-421 Console v5 milestone 仍是当前可下载实物，不能改名冒充 D-422。
