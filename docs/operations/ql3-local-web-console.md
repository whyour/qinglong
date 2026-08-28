# QingLong 3.0 Local Web Console

Local Web Console 是 `@qinglong/local-api` 的 opt-in 操作界面，用来创建 command Task、查看 Task/Run/执行事件，并显式启动或取消一次运行。它由 Console Local Alpha Trial Kit 交付，但不进入默认 headless 变体，也不是 2.x Web UI 的完整替代品。

## 选择部署档位

| 场景 | 建议 |
| --- | --- |
| 内存很小、只需后台自动化的路由/NAS | 继续使用默认 `edge` headless Application；Console 零增量 |
| 路由/NAS 需要临时人工查看与操作 | 选择 `edge-application-api`，只通过 loopback 或 SSH tunnel 访问 |
| 普通单节点服务器 | 选择 `standalone-application-api` |
| Kubernetes/Cluster 节点 | 不使用本 Local Console；继续使用 Cluster Control/Console 路径 |

D-418 已闭合独立 Console image/Trial Kit；D-419 的 v5 quickstart 进一步安装可直接使用的 Owner credential presentation，并创建默认不自动运行的 `alpha-first-automation`。D-420 又把该 Run 的 latest Attempt 首个 32 KiB 日志带到 Console。D-421 增加 request-scoped strong-auth Task PUT 与 Console command Task 创建器；它不复用 CLI 的进程级 active credential，也不让单因子 Bearer 直接写 Task。实际大 archive 仍只由维护者显式 artifact run 生成；普通 push 的源码和 CI 不是公开下载物。

## 前置条件

- 已完成 Local fresh setup，并有受支持的 Application config；
- Owner pepper keyring 与 SQLite active pepper 一致；
- 已通过 [`ql3-identity`](./ql3-local-identity-credential.md) 为 active Identity 签发 API credential；
- credential 对目标 Project 至少有读取 Task/Run 的权限；创建 Task、启动和取消分别还需要 `task.create`、`run.start` 与 `run.stop`；
- config、keyring、database 和 credential delivery 保持既有 `0700/0600`、no-symlink 和同 UID authority。

## 启动

创建私有 `local-api.json`：

```json
{
  "schema": "qinglong/local-api-process@v1",
  "deploymentRoot": "/srv/qinglong3",
  "applicationConfigFilePath": "/srv/qinglong3/private/application.json",
  "ownerPepperKeyringDirectory": "/srv/qinglong3/private/owner-pepper",
  "listener": { "host": "127.0.0.1", "port": 5701 }
}
```

运行同一进程的 Application + API + Console：

```sh
ql3-local-api --config /srv/qinglong3/private/local-api.json
```

在设备本机打开 `http://127.0.0.1:5701/`。服务只接受 `127.0.0.1` 或 `::1`，不会监听 LAN 地址。

从管理电脑访问路由/NAS 时，显式建立受信 SSH tunnel：

```sh
ssh -L 5701:127.0.0.1:5701 router.example
```

随后在管理电脑打开 `http://127.0.0.1:5701/`。不要用反向代理临时绕过 loopback；TLS、可信代理、CSRF 和远程会话边界尚未作为本阶段产品门验收。

## 使用

1. 输入 Project ID 和 `ql3c_…` API credential，选择“连接本机”。
2. 选择“创建任务”，填写 Task ID、名称、argv 可执行文件和逐行参数，再选择“保存并生成本机证明”。
3. 在部署设备上以 QingLong 数据目录 owner 读取 `<deploymentRoot>/console-presence/<页面显示的 basename>`；把 JSON 的 `proof` 值粘贴回页面。文件为 `0600`、两分钟有效且只能用于这份 exact Task 一次。不要通过聊天、日志或 URL 转发 proof。
4. 创建成功后核对 revision/content fence，再选择“运行一次”。fresh Console Trial Kit 也可直接使用 `alpha-first-automation`。
5. 在“运行”中选择 durable Run，按 Event sequence 判断实际进度；Bounded log 只显示 latest Attempt 的首个 32 KiB，后续内容仍需通过 API 分页读取。
6. 日志 pending 时使用“刷新”显式重读；retired 表示内容已按保留策略清理，不代表 Run/Event 事实丢失。
7. “请求取消”只提交 durable cancellation intent；界面出现 `cancelled|failed|succeeded|timed_out` 终态前，不要认为进程已经停止。
8. 完成后选择“断开并清除凭据”，再关闭页面。

Credential 只存在当前页面内存，不进入 URL、Cookie 或 Web Storage。页面刷新会丢失 credential，需要重新输入；这是当前安全边界，不是缺陷。

## 当前阶段可用边界

当前可操作闭环是 command Task create/list/read/start 与 Run list/read/events/steps/log/cancel。HTTP `PUT` 也支持提供完整 exact definition 的 update；页面暂不负责：

- 编辑/启停现有 Task（bounded read 不返回完整 spec，不能据此安全覆盖；继续使用 `ql3-task`，后续由 authoring lease/read 切片补齐）；
- Identity、Policy、Secret、Plugin Package 或 AI 配置管理；
- 日志整文件下载、终端、文件管理或 2.x 数据迁移；
- LAN/public 暴露、TLS termination、多用户 Web session 或 Cluster 管理。

三项静态资产总计 48,318 bytes，不依赖 CDN、网络字体或前端框架，仍低于 192 KiB 总闭包和单文件 96 KiB 门。`edge-application-api|standalone-application-api` 为 3,960,535 / 3,960,679 bytes、467 files、12 packages、90 loaded modules，仍低于 6 MiB/640-file 门；基础 headless Edge 保持 2,669,390 bytes、325 files、3 packages、58 modules，不携带这些资产。

停止 Local API 进程走与 Application 相同的 drain/shutdown 路径。Console 没有独立数据库、后台任务或需要额外清理的持久状态。
