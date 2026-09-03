# QingLong 3.0 Local Web Console

Local Web Console 是 `@qinglong/local-api` 的 opt-in 操作界面。Console Trial Kit 现在同源提供两个边界清晰的入口：`/console` 是 3.0 原生管理台，用来创建和编辑 command Task、管理加密 Secret 绑定、配置 cron Trigger、查看 Task/Run/执行事件，并显式启动或取消一次运行；`/login` 和 `/crontab` 是现有 2.x 面板的 capability-gated 只读兼容入口。它们不进入默认 headless 变体，兼容入口也不是完整 2.x Web UI 的替代品。

## 选择部署档位

| 场景 | 建议 |
| --- | --- |
| 内存很小、只需后台自动化的路由/NAS | 继续使用默认 `edge` headless Application；不携带 Console/API 资产与 listener |
| 路由/NAS 需要临时人工查看与操作 | 选择 `edge-application-api`，只通过 loopback 或 SSH tunnel 访问 |
| 普通单节点服务器 | 选择 `standalone-application-api` |
| Kubernetes/Cluster 节点 | 不使用本 Local Console；继续使用 Cluster Control/Console 路径 |

D-418 已闭合独立 Console image/Trial Kit；D-419 的 v5 quickstart 进一步安装可直接使用的 Owner credential presentation，并创建默认不自动运行的 `alpha-first-automation`。D-420 又把该 Run 的 latest Attempt 首个 32 KiB 日志带到 Console。D-421/D-422 依次增加 request-scoped strong-auth Task 创建与双 proof 无损编辑，D-423 继续开放既有 immutable Trigger/cron authority。D-424 再增加 Secret current metadata、强认证 create/rotate 与 Task pinned binding；该阶段双架构实物绑定提交 `f46fb44ac9534315b6965865bb3e990715bb2417` 与 [milestone run 33252179178](https://github.com/whyour/qinglong/actions/runs/33252179178)。

### 页面功能与下载版本

不要用当前分支的页面功能推断旧 archive 已包含同样的代码。以 Trial Kit 的 `manifest.json.sourceRevision` 和同源 milestone 为准：

| 阶段 | 页面能力 | 交付依据 |
| --- | --- | --- |
| D-429 | 原生 Task/Trigger/Secret/Run 操作；适配后旧面板登录、只读 Cron 列表与首片日志 | `09ef1745226c05521a9a44accb9d9ef95dd46c85`；[Console milestone run 33789576578](https://github.com/whyour/qinglong/actions/runs/33789576578)，已交付，见 [ADR-0531](../adr/ADR-0531-canonical-run-log-bridge-for-legacy-panel.md) |
| D-430 | 原生 `/console` 日志“下一片段”“回到开头”“刷新当前片段” | `12ed38b7d72fe6366ad8f1ac84aebb1bb772f3b5`；[Console artifact run 33793687627](https://github.com/whyour/qinglong/actions/runs/33793687627) 已交付，两个下载 bundle 与 milestone 均通过离线审计，见 [ADR-0532](../adr/ADR-0532-native-console-log-window-navigation.md) |

上表的旧面板是 bundle 自带的适配版本，不是未修改的 2.x 静态页面；旧账号密码/JWT、现有 2.x 数据和 Cluster 管理能力不会因页面可打开而自动接通。

D-431 源码候选进一步给原生 Task、Trigger、Run 列表增加页脚“下一页／回到首页／刷新当前页”。每次只显示最多 64 条，翻页替换旧记录和详情，不累积全文；顶部刷新与切换栏目回首页，页脚刷新保留当前边界。浏览期间数据可能变化，因此不提供固定总页数或快照承诺。Secret 目录和 Run Event/Step 仍维持现有窗口限制。此功能尚未交付到上表的 D-429 或 D-430 archive，见 [ADR-0533](../adr/ADR-0533-native-console-ledger-pagination.md)。

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

在设备本机打开 `http://127.0.0.1:5701/console` 使用 3.0 原生管理台；打开 `http://127.0.0.1:5701/login` 使用现有面板的只读 Crontab 兼容入口。当前 Console 产物的 `/` 指向兼容面板。服务只接受 `127.0.0.1` 或 `::1`，不会监听 LAN 地址。

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
9. 在“运行”中选择 durable Run，按 Event sequence 判断实际进度。D-429 下载产物只显示 latest Attempt 的首个 32 KiB；D-430 原生页面增加“下一片段”“回到开头”“刷新当前片段”，每次动作只读取并替换一个至多 32 KiB 的窗口，不累计全文、不自动轮询。
10. D-430 翻页固定当前 Run 的已选 Attempt；需要观察新的 Attempt 时重新选择 Run。日志 pending 时显式刷新，retired 表示内容已按保留策略清理，不代表 Run/Event 事实丢失。字节分片处的 UTF-8 字符可能显示替换符，不能将页面片段当成完整日志文件。
11. “请求取消”只提交 durable cancellation intent；界面出现 `cancelled|failed|succeeded|timed_out` 终态前，不要认为进程已经停止。
12. 完成后选择“断开并清除凭据”，再关闭页面。

Credential 只存在当前页面内存，不进入 URL、Cookie 或 Web Storage。页面刷新会丢失 credential，需要重新输入；这是当前安全边界，不是缺陷。

断开连接不会撤销服务端已经收到的写入、启动或取消请求。重连后先核对 Task/Trigger/Secret revision 与 durable Run 状态，不要因为页面没有收到结果就直接重复提交。D-432 源码候选修复旧连接的慢响应重新打开编辑器、回填 Secret 目录或影响新提交的缺陷，见 [ADR-0534](../adr/ADR-0534-native-console-session-isolation.md)；上述 D-429/D-430 归档及 D-431 构建均不包含这项修复，不能把本地回归通过当作已下载版本已更新。

## 当前阶段可用边界

D-424 阶段实物的原生 `/console` 可操作闭环是内建 argv command Task create/list/read/update/enable/disable/start、Task pinned Secret binding、Secret current metadata/create/rotate、`qinglong/cron@v1` Trigger list/read/create/update/enable/disable，以及 Run list/read/events/steps/log/cancel。Task 编辑器只修改当前展示字段并保留完整快照中的其他 config/labels；其他 Task kind 或 Trigger schema 继续使用受信管理入口。

现有面板兼容入口只开放 `/login`、`/crontab`、`/error` 与 `default` Project 的只读 Cron 投影。它接受 `ql3c_` credential，不保存在 Web Storage。D-429 已开放 Cron 行的“日志”操作，通过规范 v3 Run/Attempt API 读取匹配运行的首片日志；Edge 最多查找 64 条 Run、读取 16 KiB，Standalone 分别为 256 条和 32 KiB。刷新仍读首片，预算内找不到匹配 Run 不证明历史上从未执行。该入口没有 D-430 原生日志翻页，也没有自动轮询。

创建、运行、停止、批量操作、脚本、订阅、环境变量和写 Modal 继续隐藏。Env、Script、Subscription、完整 Run/Log 页面和 2.x 写接口都不在兼容承诺内；非空搜索、排序与 Cron View 也尚未支持。

页面暂不负责：

- Identity、Policy、Secret 明文读取/删除/历史浏览、Plugin Package 或 AI 配置管理；
- Trigger 删除、通用 Trigger provider/schema 编辑或 Cluster Trigger 管理；
- 日志整文件下载、终端、文件管理或 2.x 数据迁移；
- LAN/public 暴露、TLS termination、多用户 Web session 或 Cluster 管理。

原生 `/console` 的三项静态资产受 192 KiB 总闭包和单文件 96 KiB 门约束；D-430 阶段实物合计 106,216 bytes。D-429 兼容面板经裁剪后为 240 files / 11,965,017 bytes，上限 256 files / 13 MiB / 单文件 3 MiB，不携带 `.gz` 副本或 Monaco Editor。Console 镜像仍按 12-package 闭包及 768 files / 20 MiB 门审计，exact 文件数与字节数以该次构建结果为准，不能沿用旧镜像统计。AI 依赖仍被排除；默认 headless Edge 不携带 Console/API/兼容面板资产、listener 或 Secret mutation surface。

静态资源采用 64 KiB 流式发送；Edge 为 API 保留 4 个并发名额、另给静态资源 16 个，Standalone 分别为 32/64。兼容面板残留的外部图标和装饰图片会被严格 CSP 阻止，不影响登录、只读 Crontab 或原生 `/console`；不要为恢复装饰资源放宽 CSP 或联网边界。

停止正常 Local API 进程走与 Application 相同的 drain/shutdown 路径。Console 没有独立数据库、后台任务或需要额外清理的持久状态；一次性 cutover probe 不绑定端口，也不会进入这条常驻生命周期。
