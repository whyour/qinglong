# ADR-0531：现有面板到规范 Run 日志的有界桥接

- 状态：Accepted（D-429 源码候选；远端 CI 与双架构 Console 实物待 gate）
- 日期：2026-09-04
- 关联 RFC：QL-RFC-0001 D-429、D-428、D-415

## 背景

ADR-0530 已把现有 2.x 面板作为受限静态客户端装入 Local Console，并只开放 Cron 列表。用户仍无法从该页面观察一次定时执行的日志。恢复旧 `/api/crons/:id/log`、文件系统日志目录或 2 秒轮询，会复制已经存在的 3.0 Run/Attempt/Artifact 权威，并给 Edge 路由设备增加持续请求。

Run 聚合已经持久化可选 `triggerId`，规范 Local API 已提供有界 Run list、Run detail 与 Attempt log range read。缺口不是新的日志后端，而是安全地把这条规范链交给受限旧页面。

## 决策

- `BoundedRunListItem` 增加可选 `triggerId`。只有值存在且满足 128 字节无控制字符边界时才投影；其余 Run 私有字段仍不跨越 projection。
- 旧面板不新增 `/api/crons/:id/log` 兼容路由。用户点击某个 Cron 的“日志”后，页面按 capability budget 分页读取 `/api/v3/projects/:project/runs`，以 `triggerId + taskId` 精确选择最新 Run，再读取 Run detail 的 latest Attempt 和该 Attempt 的首个日志片段。
- 每次日志片段仍经过既有 Bearer authentication、`artifact.read` Policy、durable audit、credential reconfirm 与 Artifact retention 检查。页面不接触文件路径、Artifact id 或 Secret。
- Edge 最多扫描 64 条 Run、读取 16 KiB；Standalone 最多扫描 256 条 Run、读取 32 KiB。每页最大 64 条。未找到、尚未就绪、已清理、运行中无 Artifact 和截断状态必须显式呈现。
- QL3 模式下 Cron 列表不再运行旧页面的 10 秒轮询，日志也不运行旧页面的 2 秒轮询。初始列表只读一次，后续列表由分页/页面动作触发；日志只由点击和“刷新”按钮触发。
- QL3 的 Action 列只保留“日志”。运行、停止、更多、创建、批量操作和写 Modal 继续隐藏；2.x 模式保持原行为。

## 部署与架构边界

- 不新增 workspace package、production dependency、migration、schema、数据库连接、listener、timer、watcher 或后台进程。
- 默认 headless 产物不含旧面板，资源占用不变。Console 仍使用同一个 loopback Local API 和同一个受限静态闭包。
- Cluster 不复用 Local 面板 shell；`triggerId` 是 profile-neutral 的 Run 低敏感关联字段，因此规范 Run projection 可被 Local/Cluster 消费，但本 ADR 不新增 Cluster UI。
- 这是一条迁移期客户端桥接，不把 2.x 页面定义为 QingLong 3.0 的领域模型或长期管理面。新的 3.0 能力优先进入原生 `/console`。

## 验证与剩余门禁

本地已完成 runtime-core 594/594、Local API 93/93、18-package clean build/test、后端 1685 项（1683 pass / 2 environment skip / 0 fail）、兼容闭包回归 4/4、Node 20 production panel build，以及 package boundary、Edge import、Cluster dependency 和 240 files / 11,965,017 bytes 离线闭包审计。真实 Chromium mock journey 验证了 QL3 credential 登录、只读 Action 列、Run list → Run detail → Attempt log 三个规范请求和 Base64/UTF-8 日志展示；页面稳定 15 秒只有一次 Cron list，日志打开后稳定 5 秒没有自动重读。

仍须完成 GitNexus staged/default-branch change detection、阶段提交、远端完整 CI，并生成、下载和离线复核 exact amd64/arm64 Console Trial Kit 与 milestone，才可把 D-429 标记为双架构阶段实物已交付。

## 不做的方案

- 不恢复旧文件日志 API 或任意路径读取；
- 不把日志轮询速度做成配置项；低端设备默认仍会付出持续成本；
- 不在本切片开放 Run start/stop、Cron mutation 或完整 `/log` 页面；
- 不为复用旧页面而把 Local SQLite/POSIX authority 带入 Cluster。
