# ADR-0143：私有认证本机 Plugin Package CLI

- 状态：Accepted（实现完成；完整回归与物理 edge 证据待验证）
- 日期：2026-07-25
- 关联 RFC：QL-RFC-0001 D-05、D-08、D-09、D-84、D-85、D-139 至 D-141

## 上下文

ADR-0142 已建立 transport-neutral Plugin Package 管理 facade，但 local
edge/standalone 用户仍没有产品入口。把日常 Package 管理加入 `ql3-owner` 的命令
schema，会混入只应处理 Owner provisioning/recovery 的高权限 ceremony；为 CLI
再创建一个 workspace package，则会继续加剧“一个文件一个包”的碎片化。另一方面，
如果 binary 留在 `local-admin`，其 command-file 和 Owner authentication 生产依赖会
沿 `local-application → local-admin` 进入常驻制品，同样不符合权限闭包。

CLI 还必须同时解决 bearer 不进入 argv、数据库和凭证路径替换、本机 User
step-up、命令重放以及路由器低资源预算。单纯从 command file 读取一个 token 并把它
转换为 `local_console` principal，不足以证明后续 mutation 仍由相同数据库、凭证和
pepper authority 支持。

## 决策

### 1. CLI 留在既有短生命周期 local-owner-cli

`ql3-package` 由 `@qinglong/local-owner-cli` 发布，并把可测试 runner 只暴露在
`@qinglong/local-owner-cli/package-command`。它是与 `ql3-owner`、`ql3-adoption`
并列的独立 binary，不改变 `ql3-owner` 的 command schema。transport-neutral
service 仍由 `@qinglong/local-admin/package-management` 提供；`local-admin`
生产依赖不包含 local-command-file、local-owner-console、local-identity 或 keyring。
不新增 workspace package、importer、常驻 process、HTTP listener、timer 或 watcher。

命令行只有：

```text
ql3-package run --command-file /absolute/private-command.json
```

command file 必须为当前 UID 所有的 `0600` 普通文件、禁止 symlink、最大 16 KiB，
并使用 exact versioned shape。它支持 `plugin-package.propose`、`decide`、
`consume`、`dispatch` 和 `inspect`；所有 durable identity 与业务语义由文件显式
提供，发生时间由认证后的本机 authority 生成，exact replay 则复用数据库已存时间，
从而既不接受客户端伪造时钟，也不因重试改变 mutation digest。dispatcher 内部
lease/result identity 仍可随机生成，因为它们受 durable execution fence 约束。

### 2. 认证成为 Owner Console 的可复用子路径

新增 `@qinglong/local-owner-console/authenticated-command`，而不是让每个本机 CLI
复制 credential-file/pepper 验证。能力要求：

- real/effective POSIX UID 相同；
- deployment root、全部父目录和 keyring 为当前 UID 的 `0700` 实目录；
- SQLite 与 credential presentation 为当前 UID 的 `0600` 普通文件；
- 所有 authority path 都是 deployment root 后代，数据库与 credential 不得共享
  inode；
- 通过 `O_NOFOLLOW` 和 open 前后 device/inode/size fence 读取最大 1 KiB 的
  credential presentation；
- 使用数据库 credential record、pepper catalog 和私有 keyring material 完成
  `ql3c` 验证，只接受 active User；
- 将 credential authentication 与 POSIX proof 摘要绑定为最长 60 秒的
  `local_console` principal；
- 每次 use-case 前重新确认 UID、路径 identity、credential version/state/subject/
  digest/lifetime、pepper key state 和 material digest。

返回值不包含 token 或 pepper。认证错误也不回显 secret material。

### 3. 单连接、无迁移、低敏输出

新增显式 `@qinglong/local-sqlite/package-management` opener。每次 CLI 调用只打开
一个同步 SQLite connection、一个 `LocalSqliteOperationAuthority`，先验证既有
schema readiness，绝不自动 migration；结束时等待 authority queue 后幂等关闭。
edge 继续使用 DELETE journal、4 MiB cache、零 mmap，dispatcher 一次最多扫描 64
条且默认批量仍为 1。

CLI 输出只包含 Package 名称/版本、Profile、generation、状态和 canonical digest，
不输出 credential token、pepper、source locator、完整 manifest、完整
environment、authentication ID 或数据库内部 authority。

### 4. 权限仍由 facade 和 Policy 决定

POSIX + credential 认证只建立 User principal，不授予 Package 权限。
`propose/decide` 仍分别经过 `package.manage`/`approval.decide`；`consume` 仍使用
固定 system consumer 并重验 requester fence；`dispatch` 仍受 durable
Approved Action barrier 约束。local ceremony 固定为 `human_confirmation`，不能由
command file 切换。

## 影响

- workspace importer 保持 21，新增能力全部是既有 package 的显式 subpath；
- `ql3-owner` 继续只处理 Owner ceremony，日常 Package 管理由同一短生命周期产品
  package 的独立 `ql3-package` binary 承担；
- `local-admin` 的生产依赖重新收敛为 local-sqlite 与 runtime-core，本入口不会把
  Owner authentication/Identity/keyring 拖入常驻 local-application 制品闭包；
- 本机 CLI 和 Legacy adoption CLI 共同使用同一认证子路径；adoption 仍保留
  source/review/issuer/authorization 的专用多文件围栏，但不再自行解析 credential、
  查询 pepper catalog 或构造 local-console principal；
- cluster Profile 不复用本机 POSIX proof，仍需独立 bearer/MFA admin transport；
- 该入口不会让 Package 管理进入 2.x Controller 或常驻 runtime。

## 验证门禁

1. 私有 command file 完成 propose → self-confirm → consume → dispatch → inspect；
2. 相同业务 identity exact replay，不产生重复 proposal/request；proposal 已提交而
   Approval 未提交的崩溃窗口必须复用 proposal 的原始发生时间恢复；
3. 非 owner User 在 proposal mutation 前拒绝；
4. credential 文件替换、宽权限、credential revocation 和 60 秒 proof expiry
   全部失败关闭；
5. stdout/result 不含 token、secret、source locator 或 authentication ID；
6. local-owner-console、local-owner-cli、local-admin、local-sqlite 构建与测试通过；
7. source dependency audit 只允许精确文件使用精确 authority subpath；
8. edge 调用只保留单 SQLite connection，无 timer/watcher/socket。

## 后续

- 增加物理小内存设备上的峰值 RSS、启动时间与 SQLite 写放大证据；
- 实现 cluster bearer/MFA admin API、rate limit 和四眼 PostgreSQL 真库门；
- 基于 ADR-0149 active generation source 实现 Package
  Task/Workflow/Prompt/Tool 语义 materializer。
