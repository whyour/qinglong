# ADR-0516：request-scoped Local Console Task mutation

- 状态：Accepted
- 日期：2026-08-29
- 对应 RFC 切片：D-421
- 关联：ADR-0256、ADR-0377、ADR-0512、ADR-0513、ADR-0514、ADR-0515

## 背景

Local Console 已能读取 Task、显式启动 Run、查看 Event/Step/有界日志并请求取消，但部署者仍必须离开 Console，使用短生命周期 `ql3-task` command file 才能创建或修订 Task。该 CLI 的安全性依赖“每个进程只激活一个 credential fence”；把同一个可变 active fence 搬进常驻、多请求 HTTP 会让并发用户互相覆盖凭据，并在 credential 撤销或 RoleBinding 漂移时产生错误授权。

单因子 Bearer 只能证明浏览器持有 API credential，不能替代现有 Task 管理要求的 strong User。本切片必须在不扩大默认 headless 路由设备常驻成本、不把 proof secret 返回 HTTP、不削弱 SQLite 原子审计、也不把本机 POSIX authority 误用到 Cluster 的前提下，形成部署者可实际操作的 Web 创建链路。

## 决策

### 1. PUT 使用 request-scoped credential fence

Local API 新增固定路由：

```text
PUT /api/v3/projects/:projectId/tasks/:taskId
```

请求体使用既有 immutable TaskDefinition command：`expectedRevision=null` 创建，`expectedRevision=current` 修订；mutation ID、occurredAt、name/kind/spec/labels/enabled 都参与规范化。Bearer 只建立 `single_factor` session，并交付该次认证解析出的 exact credential fence；服务不设置进程级 active credential。

SQLite runtime 以异步 `taskDefinitionAdministrationForCredential(fence)` 为每个请求创建独立 repository。只有 opt-in API 已验证本机 proof 并实际调用 factory 时，才惰性加载 authenticated-management 与 Task administration authority；factory 建立时先复验 credential/Identity/pepper，写事务内再次复验同一 exact fence、actor subject、Project version 与 latest RoleBinding version/state。allowed audit、Task head/revision、mutation replay 与适用的 local execution revision仍在一个事务中提交。两个同时存活的 repository 不共享可变 credential 状态。

### 2. 本机存在证明是第二权威，不经 HTTP 交付 secret

第一次 exact PUT 不带 proof 时，服务在 `<deploymentRoot>/console-presence/` 发布一次性 challenge file：目录 `0700`，文件 `0600`，当前 POSIX UID owner，exclusive/no-follow、原子 rename、文件和目录 `fsync`。响应只返回 authorization ID、请求摘要、过期时间和 basename；32-byte 随机 proof 只存在私有文件，不进入 HTTP response、URL、Cookie、Web Storage、日志或 challenge audit。

proof 精确绑定：

- canonical Task command SHA-256；
- credential ID/version；
- User subject；
- 两分钟有效期与单次消费。

Edge 最多保留 8 个待确认 challenge，Standalone 最多 32 个；过期文件按请求惰性清理，不新增 timer、watcher、daemon 或后台 I/O。错误 proof、不同 Task 内容、不同 credential/subject 和过期 proof 都不能消费原 challenge。用户提交 proof 后，服务先重新确认 Bearer credential authority，再消费 proof，并把 principal 提升为短期 `local_console` assurance；既有 Task administration service 随后重新执行 Project Policy。

### 3. Challenge audit 与最终 mutation audit 分层

生成 challenge 时记录 `approval_required/local_presence_required`，但不记录 proof、命令内容或路径。错误 proof 记录无 subject 的 `authentication_rejected/local_presence_rejected`，符合既有 audit outcome identity contract。最终 `allowed` audit 不由 HTTP 先写，而是与 Task mutation 一同进入 SQLite 事务；Policy、credential、RoleBinding 或 mutation fence 漂移都不会留下“允许但未写入”的孤立记录。

### 4. Console 先提供可完成的 command Task 创建旅程

离线 Console 新增“创建任务”编辑器：Task ID、名称、说明、argv file、逐行 args 和 enabled。第一次保存后展示只包含 `console-presence/<basename>`、两分钟时效和 password proof 输入的本机证明票据；页面内存只保留同一 immutable request，验证成功后刷新并选中新 Task。页面继续禁止 CDN、前端框架、inline script、`innerHTML`、Cookie 与 Web Storage。

HTTP contract 已同时支持 create/update。当前 bounded Task read 有意不返回完整 spec/config，因此 Console 不伪造不完整 update：Web 修订编辑器要等后续受强认证的 authoring lease/read contract，或由调用方提供完整 exact definition。既有 `ql3-task` CLI 继续作为完整 create/update/enable/disable 入口。

### 5. 部署档位保持分层

- 默认 `edge`/`standalone` headless 不加载 Local API、Console 或 challenge manager，资源零增量；
- opt-in `edge-application-api` 使用 8 个 pending 上限，适合低内存路由/NAS；
- opt-in `standalone-application-api` 使用 32 个 pending 上限；
- Cluster 不复用 POSIX proof、SQLite fence 或 Local credential。集群 Task mutation 后续必须使用 Cluster Control 的 TLS/RBAC/多副本 authority。

## 不采用的方案

- 不允许 Bearer 直接 `task.put`：它会把 strong User 降级为单因子远程 secret possession。
- 不复用 CLI 的进程级 `activateUserCredentialFence`：常驻并发 HTTP 会发生 ambient authority 串线。
- 不把 proof 放进 challenge response、Console HTML 或 quickstart stdout：这会让第二权威退化为同一网络通道内的 bearer。
- 不为低配设备增加 WebSocket、轮询 challenge、timer 或长期 session store：显式读取私有文件已经形成可审计的本机动作。
- 不让 Console 用 bounded read 投影拼装 update：投影刻意不含 spec/config，猜测会覆盖调用方未知字段。
- 不把 Local proof 抽象为 Cluster 通用插件：POSIX owner/mode 不能证明 Kubernetes/多节点身份与审批。

## 结果与验证边界

定向验证覆盖：proof 文件权限与无身份泄漏、exact request/credential/subject 绑定、一次性消费、Edge 容量与过期惰性清理；Task route 的 challenge→confirm→strong Policy→事务 mutation、内容漂移、非 User、过期和失败关闭；两个同时存活的 credential repository、单方 credential revoke、另一方继续写入与 RoleBinding 漂移原子拒绝；真实 loopback HTTP→私有 proof file→SQLite Task/audit 创建；真实 Chromium 的 Task 编辑器与 proof ticket 可访问性/布局。

本地 18-package clean build/test 已通过：`3,030 total / 3,008 pass / 22 conditional、platform 或 external-service skip / 0 fail`；Local API 完整 loopback/SQLite/Console 回归为 `56/56`，新增双 credential request-fence 为 `1/1`，package boundary 契约为 `10/10`。package/source、Local image、122-module Edge import 与 Cluster dependency audit 均 `compatible=true`。离线 Console 三资产合计 62,632 bytes；默认 Edge 为 2,737,205 bytes/329 files/3 packages/58 loaded modules，仍低于 4 MiB/512-file/20 MiB RSS-delta 门；opt-in `edge-application-api|standalone-application-api` 为 4,041,294/4,041,438 bytes、472 files、12 packages、94 loaded modules，仍低于 6 MiB/640-file/28 MiB RSS-delta 门。真实 Chromium 的创建编辑器与 proof ticket 已完成桌面布局、键盘焦点与可访问树检查。

阶段提交 `884912d1` 的首轮远端主 CI 为 40 success/3 expected artifact-finalizer skip/1 fail，Kubernetes deployment 与三节点 Security live 均成功。唯一失败在 x64 默认 Edge import RSS：静态引入 request-scoped administration 后 loaded modules 从历史 58 增至 83，RSS 为 21,229,568 bytes，超过 20 MiB 门 258,048 bytes；failed-only attempt 2 确认同一确定性结果。修复没有扩大预算，而是把两个 authority 改成 request-time dynamic import；默认 Edge 恢复 58 loaded modules，本机 RSS delta 为 11,157,504 bytes，Console 仍为 94 modules。修复提交 `dc1686bd6fb3505174dd9a14098ae5c2c92a1a7f` 的主 CI run `33229592307` 最终为 41 success/3 expected skip/0 fail，Kubernetes deployment run `33229592293` 成功；显式 Local Console milestone run `33230227006` 为 42 success/2 scope skip/0 fail，闭合了同源双架构下载物。

本机 2.x backend 兼容门首次运行得到 `1,348 total / 1,293 pass / 53 fail / 2 skip`，其中 52 个文件在加载 Sequelize 前统一因锁定的 `@whyour/sqlite3` 原生绑定缺失而失败，另一个 loopback 用例受当前 sandbox 拒绝；依赖重建先因 GitHub 预编译包下载超时、再因本机 C++ SDK 缺少 `<functional>` 失败，未伪装成源码回归。唯一实际源码契约漂移是 Local API 文件计数 18/17→20/19，修正后 package-boundary `10/10` 通过。完整 backend 与原生 Linux loopback 必须由阶段提交的远端 CI 闭合。

该 ADR 对应的阶段产物已经由同源显式 milestone run 重新生成并进入 Local milestone index：amd64/arm64 GitHub artifacts 分别为 187,797,970/185,029,586 bytes，索引为 5,623 bytes，保留至 2026-09-28。下载后的索引通过 `SHA256SUMS` 与 `qinglong/alpha-local-milestone-audit@v2` 离线审计，结果 `compatible=true`。它只声明 fresh、隔离、非生产数据上的 `3.0.0-alpha.2` Local Console Alpha Candidate，不声明公开 release、2.x 原地升级、生产 HA 或长期支持。
