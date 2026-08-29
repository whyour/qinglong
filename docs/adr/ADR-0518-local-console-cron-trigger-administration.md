# ADR-0518：Local Console cron Trigger 管理

- 状态：Accepted
- 日期：2026-08-29
- 对应 RFC 切片：D-423
- 关联：ADR-0094、ADR-0103、ADR-0512、ADR-0516、ADR-0517

## 背景

Local Console 已能创建、无损编辑和手动运行内建 command Task，但部署者仍需转到受信 CLI 才能把 Task 变成周期自动化。QingLong 3.0 已有 immutable Trigger revision、固定 Task revision/content digest、语义化 cron 校验、durable schedule cursor 和原子 Run admission；缺口是一个不复制这些 authority、适合低配单机的安全产品入口。

本切片只开放既有本机 Trigger authority。它不能把 Local POSIX presence proof 搬到 Cluster，也不能为每个 Trigger 新建内存 timer，或让默认 headless 设备承担 Console 资产和 HTTP listener。

## 决策

### 1. Local API 暴露有界 Trigger 读取与强认证 mutation

新增固定路由：

```text
GET /api/v3/projects/:projectId/triggers
GET /api/v3/projects/:projectId/triggers/:triggerId
PUT /api/v3/projects/:projectId/triggers/:triggerId
```

列表按 `triggerId` 使用稳定 keyset，Edge 默认 16 条、Standalone 默认 32 条、硬上限 64 条。列表只返回 identity、revision、Task pin、schema、enabled、content digest 和时间戳；完整 cron spec 与 Task content digest 只在精确详情读取中返回。读取复用 `task.read` Policy、credential reconfirm 与 durable audit，存储损坏或不可用时失败关闭。

PUT 的 body 必须精确包含 `expectedRevision`、`mutationId`、Task ID/revision/content digest、spec、enabled 与发生时间。请求只接受 User credential，并要求 `task.update` Policy；服务为 canonical exact body 签发两分钟、一次性的 owner-private presence challenge，proof 消费后才形成 `local_console` principal。事务前再次确认 exact credential，随后由既有 Trigger administration service 和 request-scoped SQLite repository 重验 Project/RoleBinding/credential/Policy fence，原子写 immutable revision、head、schedule cursor 与 durable audit。

### 2. Trigger 始终固定当前 Task 内容

Console 在创建或更新 Trigger 前精确读取关联 Task，提交其当前 revision 与 content digest。既有 repository 在事务内重新验证 pin；Task 已变化时拒绝写入，不猜测重绑。

创建使用 `expectedRevision=null`，更新使用当前 revision。Trigger ID 与 Task ID 创建后不能改绑；启用、停用、cron/timezone/misfire 修改都追加新 revision。当前阶段不提供删除，停用是可审计、可恢复的替代操作。

### 3. 首个 UI 只支持冻结的内建 cron schema

Console 的“定时”工作区支持创建、查看、编辑、启用和停用 `qinglong/cron@v1`，字段为 cron expression、显式 timezone 与 `skip|fire_once` misfire policy。它不实现通用 provider/schema 编辑器，不接受浏览器自行扩展未知 Trigger kind。

Credential、presence proof 与编辑快照仍只保存在页面内存，不进入 Cookie、Web Storage、URL、日志或遥测。成功写入后由现有 durable Scheduler 在既有单一有界 lifecycle 中发现；Console 不轮询、不注册每 Trigger callback，也不新增 daemon、watcher、timer 或数据库连接。

### 4. Fresh 与 adopted Profile 使用同一窄 authority

Fresh SQLite runtime 和 adopted Profile 都在现有数据库 close fence 上暴露 `TriggerSource` 与 `triggerAdministrationForCredential`。每次 mutation 取得绑定当前 credential fence 的 request-scoped repository；常驻 Application 不持有一个可绕过认证的裸 append authority。

`@qinglong/local-api` 只有 `triggerPutRoute.ts` 被 package dependency audit 精确允许导入 `@qinglong/local-admin/trigger-administration`。同目录或其他文件不能借此扩大依赖；Cluster dependency audit 继续拒绝 Local SQLite/POSIX authority 越界。

### 5. 部署档位保持分层

- 默认 Edge/Standalone headless 不包含 Local API、Console 资产或 listener；SQLite runtime 只增加复用既有 Trigger mutation 的窄装配代码。
- opt-in `edge-application-api` 与 `standalone-application-api` 承担同源 Console/API 增量，仍只有一个 Application 进程、一个 SQLite connection 和现有 Scheduler lifecycle。
- Cluster 不复用 Local proof、SQLite repository 或 Local admin service；后续 Cluster Console mutation 必须走 TLS、共享 PostgreSQL authority、RBAC/Approval 与 HA fence。

## 不采用的方案

- 不在浏览器或 HTTP 层实现第二套 cron scheduler：调度事实必须留在 durable Trigger/schedule authority。
- 不允许 Bearer 单因子直接写 Trigger：周期自动化会持续产生执行，必须保留本机 presence proof。
- 不让列表返回完整 spec 或 Task digest：列表应是低敏、有界的浏览面。
- 不通过删除实现“关闭定时”：不可变 revision 与停用记录更可审计。
- 不新建 `ql3-local-trigger-api` 微包：现有 Local API capability 内的两个路由文件不足以形成独立部署/依赖边界。
- 不为路由器注册每 Trigger timer：现有有界 durable scheduler 已覆盖该职责。

## 结果与验证边界

定向测试覆盖列表投影不泄漏 spec/digest、精确详情、坏存储失败关闭、presence challenge、exact body/credential fence、Policy/audit、Task pin、创建/更新冲突与 proof 漂移。真实 SQLite/loopback 旅程已完成 Task 创建/更新 → Trigger challenge/proof/create → bounded list → exact read → 新 revision disable，并验证 create/get/list/update audit。

本地 18-package clean build/test 为 `3,044 total / 3,022 pass / 22 conditional、platform 或 external-service skip / 0 fail`，其中 Local API `70/70`、Local SQLite `248/248`、Local Admin `96/96`，Local Application `55 total / 51 pass / 4 platform skip / 0 fail`；完整 backend 为 `1,653 total / 1,651 pass / 2 Linux conditional skip / 0 fail`。package boundary 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`，122-module Edge import 与精确 Cluster dependency audit 均 compatible。

三项 Console 静态资产合计 84,401 bytes，仍低于 192 KiB 总闭包与 96 KiB 单文件门。默认 Edge 为 2,754,742 bytes/331 files/3 packages/58 modules，RSS delta 11,108,352 bytes；opt-in Edge/Standalone Console 为 4,150,439/4,150,583 bytes、479 files/12 packages/101 modules，RSS delta 17,088,512/17,055,744 bytes，均低于既有门。

本 ADR 已由提交 `b970e2aede516c350b1cdb409e0d0d3038a5deee` 的普通主 CI [run 33244982727](https://github.com/whyour/qinglong/actions/runs/33244982727)（41 success/3 expected artifact-finalizer skip/0 fail）、Kubernetes deployment [run 33244982694](https://github.com/whyour/qinglong/actions/runs/33244982694) 与显式 Local Console milestone [run 33245745837](https://github.com/whyour/qinglong/actions/runs/33245745837)（42 success/2 scope skip/0 fail）闭合。新 run 生成独立的 amd64/arm64 Console Trial Kit 与 milestone index；下载索引的 `SHA256SUMS` 全部通过，仓库离线 auditor 返回 `schema=qinglong/alpha-local-milestone-audit@v2`、`compatible=true`，并精确绑定 `3.0.0-alpha.2`、Console、双架构、source revision 与 run attempt。因此 D-423 已升级为可下载、可验真、可在 fresh 隔离环境试运行 cron 自动化的阶段实物；它仍不是公开 release、2.x 生产升级、Cluster HA 交付或长期支持版本。
