# QingLong 3.0 Local Web Console

Local Web Console 是 `@qinglong/local-api` 的 opt-in 操作界面，用来创建和编辑 command Task、管理加密 Secret 绑定、配置 cron Trigger、查看 Task/Run/执行事件，并显式启动或取消一次运行。它由 Console Local Alpha Trial Kit 交付，但不进入默认 headless 变体，也不是 2.x Web UI 的完整替代品。

## 选择部署档位

| 场景 | 建议 |
| --- | --- |
| 内存很小、只需后台自动化的路由/NAS | 继续使用默认 `edge` headless Application；不携带 Console/API 资产与 listener |
| 路由/NAS 需要临时人工查看与操作 | 选择 `edge-application-api`，只通过 loopback 或 SSH tunnel 访问 |
| 普通单节点服务器 | 选择 `standalone-application-api` |
| Kubernetes/Cluster 节点 | 不使用本 Local Console；继续使用 Cluster Control/Console 路径 |

D-418 已闭合独立 Console image/Trial Kit；D-419 的 v5 quickstart 进一步安装可直接使用的 Owner credential presentation，并创建默认不自动运行的 `alpha-first-automation`。D-420 又把该 Run 的 latest Attempt 首个 32 KiB 日志带到 Console。D-421/D-422 依次增加 request-scoped strong-auth Task 创建与双 proof 无损编辑，D-423 继续开放既有 immutable Trigger/cron authority。D-424 再增加 Secret current metadata、强认证 create/rotate 与 Task pinned binding；绑定提交 `f46fb44ac9534315b6965865bb3e990715bb2417` 的最新双架构实物已由 [milestone run 33252179178](https://github.com/whyour/qinglong/actions/runs/33252179178) 生成并完成 milestone checksum/auditor 复核，没有借用或改名 D-423 archive。

D-426b2c 又补齐了 Console 镜像的 adopted-target 入口证据：切换演练使用 `ql3-local-api --cutover-probe --config <local-api.json>`，同时绑定外层 API 配置、内层 Application 配置与 exact mounts，但该模式不会启动本页使用的 listener、credential、scheduler 或 mutation surface。正常启动仍使用下文不带 `--cutover-probe` 的命令；提交 `229c3cb4e826866a0c7c4d81cb5e52cdc3975eec` 的 [artifact run 33463415938](https://github.com/whyour/qinglong/actions/runs/33463415938) 已交付 exact amd64/arm64 Console Trial Kit 与 milestone，三份下载产物的离线 auditor 均为 `compatible=true`。

## 前置条件

- 已完成 Local fresh setup，并有受支持的 Application config；
- Owner pepper keyring 与 SQLite active pepper 一致；
- 已通过 [`ql3-identity`](./ql3-local-identity-credential.md) 为 active Identity 签发 API credential；
- credential 对目标 Project 至少有读取 Task/Run 的权限；创建 Task、修改 Task/Trigger、启动和取消分别还需要 `task.create`、`task.update`、`run.start` 与 `run.stop`；
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
3. 在部署设备上以 QingLong 数据目录 owner 读取 `<deploymentRoot>/console-presence/<页面显示的 basename>`；把 JSON 的完整 `ql3p_…` proof 值粘贴回页面。文件为 `0600`、两分钟有效且只能用于这份 exact 操作一次。不要通过聊天、日志或 URL 转发 proof。
4. 编辑现有内建 command Task 时先选择“编辑任务”，完成第一次本机证明以读取完整定义并取得 10 分钟一次性编辑租约。保存新内容时页面会要求第二份 proof；第一份只授权读取，不能复用来保存。Task ID 只读，未展示的 command config 与 labels 会原样保留。
5. 需要敏感环境变量时进入“凭据”，创建或轮换 Secret。每次操作都要求一份绑定 exact plaintext digest 的新 proof；Console 永不显示旧值，提交后立即清空输入。Task 编辑器使用 `ENV_NAME=secret-name` 或 `ENV_NAME=secret-name@version`，省略版本时也会在保存前固定为当前版本。
6. 需要周期运行时进入“定时”，选择“新建定时”，填写 Trigger ID、已存在的 Task ID、cron expression、显式 timezone、`skip|fire_once` misfire policy 与 enabled。页面会先读取当前 Task revision/content digest，再要求一份绑定这次 exact Trigger 内容的本机 proof。
7. 编辑、启用或停用 Trigger 都会追加 immutable revision；当前阶段没有删除。Task 已被其他操作更新时，旧 pin 会失败关闭，应刷新后重新确认，不能猜测重绑。
8. 创建或更新 Task 成功后核对 revision/content fence，再选择“运行一次”。fresh Console Trial Kit 也可直接使用 `alpha-first-automation`；enabled Trigger 则由已有 durable Scheduler 自动产生 Run，不依赖浏览器保持打开。
9. 在“运行”中选择 durable Run，按 Event sequence 判断实际进度；Bounded log 只显示 latest Attempt 的首个 32 KiB，后续内容仍需通过 API 分页读取。
10. 日志 pending 时使用“刷新”显式重读；retired 表示内容已按保留策略清理，不代表 Run/Event 事实丢失。
11. “请求取消”只提交 durable cancellation intent；界面出现 `cancelled|failed|succeeded|timed_out` 终态前，不要认为进程已经停止。
12. 完成后选择“断开并清除凭据”，再关闭页面。

Credential 只存在当前页面内存，不进入 URL、Cookie 或 Web Storage。页面刷新会丢失 credential，需要重新输入；这是当前安全边界，不是缺陷。

## 当前阶段可用边界

D-424 阶段实物的可操作闭环是内建 argv command Task create/list/read/update/enable/disable/start、Task pinned Secret binding、Secret current metadata/create/rotate、`qinglong/cron@v1` Trigger list/read/create/update/enable/disable，以及 Run list/read/events/steps/log/cancel。Task 编辑器只修改当前展示字段并保留完整快照中的其他 config/labels；其他 Task kind 或 Trigger schema 继续使用受信管理入口。页面暂不负责：

- Identity、Policy、Secret 明文读取/删除/历史浏览、Plugin Package 或 AI 配置管理；
- Trigger 删除、通用 Trigger provider/schema 编辑或 Cluster Trigger 管理；
- 日志整文件下载、终端、文件管理或 2.x 数据迁移；
- LAN/public 暴露、TLS termination、多用户 Web session 或 Cluster 管理。

D-424 的三项静态资产总计 102,182 bytes，不依赖 CDN、网络字体或前端框架，仍低于 192 KiB 总闭包和单文件 96 KiB 门。`edge-application-api|standalone-application-api` 为 4,210,024 / 4,210,168 bytes、482 files、12 packages、111 loaded modules，仍低于 6 MiB/640-file 门；本机 RSS delta 为 20,447,232 / 18,399,232 bytes，低于 28 MiB。默认 headless Edge 为 2,760,847 bytes、332 files、3 packages、59 modules，RSS delta 11,026,432 bytes；它不携带 Console/API 资产、listener 或 Secret mutation surface，只增加复用现有 SQLite connection 的有界 metadata 装配。

停止正常 Local API 进程走与 Application 相同的 drain/shutdown 路径。Console 没有独立数据库、后台任务或需要额外清理的持久状态；一次性 cutover probe 不绑定端口，也不会进入这条常驻生命周期。
