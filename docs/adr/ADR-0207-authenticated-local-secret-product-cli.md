# ADR-0207：强认证 Local Secret 产品 CLI 与事务内 Credential Fence

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-197
- 关联 ADR：ADR-0074、ADR-0076、ADR-0085、ADR-0086、ADR-0185、ADR-0193
- 部分取代：ADR-0074 第 6 节“本机 CLI 保持不可达”

## 背景

ADR-0074 已有本机 Secret 加密、Policy、Project/RoleBinding fence 和 envelope +
allowed audit 原子提交，但 `@qinglong/local-secret-admin` 一直没有生产消费者。
部署用户即使完成 Fresh Setup 和首 Owner ceremony，也只能得到 Secret keyring，不能
用受支持的产品入口创建或轮换 Secret。

这同时暴露两个容易被误判的架构问题：

1. `local-secret-admin` 只有一个源码文件、没有生产 importer，看起来像过细的
   workspace package；
2. 若为了减少 package 数把它并入 `local-application`、`local-admin` 或
   `local-owner-console` 根入口，常驻 Edge 产物或 DDL/Owner ceremony authority
   又会携带 plaintext Secret 写能力。

ADR-0185 已确定 package 是交付和 authority 边界，不是按文件数划分的源码目录。
因此本轮不能通过合并包来“解决”无消费者问题，而应让该 authority 获得一个精确、
短生命周期、不可被常驻进程导入的产品消费者。

## 决策

### 1. 保留 22 个 package，不新增或合并 workspace importer

`@qinglong/local-secret-admin` 继续是独立高权限 package：

- `local-application`、Edge/Standalone application artifact 和 Cluster/Worker
  仍禁止导入；
- 只允许 `local-owner-cli/src/secretCommand.ts` 导入 package 根入口；
- 新入口使用现有 `@qinglong/local-owner-cli` 的 `ql3-secret` binary 和
  `./secret-command` subpath，不创建第 23 个 package；
- `@qinglong/local-command-file` 仍是三个上层消费者共享的稳定叶子；
  `@qinglong/local-identity` 仍隔离 credential verifier 与 POSIX/SQLite
  composition。单文件不是合并条件。

依赖审计必须同时拒绝 Owner CLI 的其他文件、未知 subpath 和任意常驻 package
导入 Secret admin authority。

### 2. 使用专用 SQLite Secret Administration composition

`@qinglong/local-sqlite/secret-administration` 只暴露本次命令所需能力：

- readiness；
- API credential 与 Owner pepper provenance 查询；
- Project Policy；
- Local Secret authorized mutation；
- Security Audit；
- credential fence 激活；
- 有界关闭。

它不暴露 Task/Run/Scheduler、Plugin Package、DDL migration、GC、recovery 或
destructive authority。每次 `ql3-secret` 只打开一个连接，执行一个 command，
随后关闭；不增加 daemon、timer、watcher、listener、端口或常驻内存。

### 3. Credential fence 必须在 Secret 写事务内重新验证

仅在 CLI 开始时验证 credential 不够：另一个管理进程可能在 Policy 判断与
`BEGIN IMMEDIATE` 之间 revoke credential。

`LocalSqliteRunRepository` 新增默认缺失的内部
`beforeAuthorizedLocalSecretMutation` barrier。普通 runtime、测试和既有
composition 不传入该 barrier，行为不变；专用 Secret composition 激活 exact
credential fence 后，barrier 在 Secret transaction 已取得写锁后重新验证：

- credential ID/version/state；
- User subject/status；
- secret digest 与有效期；
- pepper key ID/state/material digest。

缺失、变化或验证异常统一转换为
`LocalSecretAuthorizationFenceConflictError`，整个 envelope 和 allowed audit
事务回滚。Project/RoleBinding fence 仍由原 repository 在同一事务继续验证。

### 4. Plaintext 不进入 command file、stdout、stderr 或 audit

`ql3-secret` 只接受：

```text
ql3-secret run --command-file /absolute/private-command.json
```

command file 与 Secret value file 都必须是当前 POSIX UID 持有的 `0600` regular
file，路径规范、无 symlink，并位于 deployment root 下。command file 只记录
`secretValueFilePath`；value file 使用 bounded exact-shape JSON：

```json
{
  "schemaVersion": 1,
  "kind": "qinglong3-local-secret-value",
  "value": "plaintext"
}
```

value 最大 16 KiB。读取使用既有 private-file inode/owner/mode/size 双检查并清零
原始 Buffer；JavaScript string 生命周期限制在单次命令进程。成功只返回 opaque
SecretRef、version 和 `inserted|existing`。错误及 security audit 只包含固定 code/
reason，不记录 plaintext、credential token、key material、文件路径或
authentication proof。

### 5. 创建与轮换使用同一 CAS 命令

唯一 mutation 是 `secret.put`：

- `expectedCurrentVersion = 0` 表示创建；
- 正整数表示从精确版本轮换；
- mutation UUID、request ID 和独立 failure-audit UUID 都由 operator 固定；
- response-loss 使用原 command/value file 原样重跑；
- same mutation + same plaintext 返回 `existing`；
- same mutation + different plaintext、版本漂移或 policy/credential 漂移均失败关闭。

CLI 不提供 plaintext read、decrypt、list-all、delete、key rotation、rekey 或远程
HTTP 入口。

## 对低配路由器与集群节点的影响

- Edge/Standalone application package closure 不新增
  `local-secret-admin`，常驻 bytes/files/modules/RSS 不因本命令增加；
- 管理 CLI 仅在人工调用时加载，完成后释放 SQLite、keyring material 和进程内存；
- 没有目录扫描、后台重试、定时审计、socket 或额外数据库连接常驻；
- Cluster 节点仍使用独立 PostgreSQL/KMS/Vault 管理设计，本机 CLI 不获得 Cluster
  credential、RBAC 或远程管理能力。

## 不采用方案

### 合并 `local-secret-admin` 到 application 或 local-admin

会让常驻 runtime 或 DDL authority 携带 plaintext Secret 写能力，破坏
ADR-0074/0185 的交付隔离。

### 合并到 `local-owner-console` 根入口

Owner bootstrap、credential recovery 与 Secret mutation 的 authority 生命周期
不同；合并会使所有 Owner ceremony 默认解析 Secret crypto/storage 依赖。

### 把 plaintext 直接放入 command JSON 或命令行参数

command 需要长期保留以支持 response-loss replay；argv 又可能被进程列表读取。
单独私有 value file 能让命令事实与敏感值使用不同保留策略。

### 只在 transaction 之前调用 `authenticated.confirm()`

无法关闭跨进程 credential revoke 竞态。最终 fence 必须在 SQLite write lock 内
重验。

### 增加本机 Secret HTTP API

会新增远程攻击面、监听端口、rate-limit/session/CSRF/TLS 责任，不属于本次
Local Owner console 切片。

## 验收证据

- `ql3-secret` 真实 SQLite/CLI 专项 5/5：
  - create、exact replay、rotate；
  - ciphertext/audit/stdout/stderr 均不含 plaintext/token；
  - 非 `0600` value file 在 mutation 前失败并写低敏审计；
  - viewer 被 Policy 拒绝且 envelope 为零；
  - revoked credential 在读取 Secret 前失败；
  - credential 在预检后被 revoke 时，transaction barrier 回滚 envelope。
- 原 `local-secret-admin` 6/6 全绿；
- dependency audit 负向契约 33/33，证明只有 exact Owner CLI 文件能导入
  Secret admin 与专用 SQLite subpath；
- TypeScript 对 `local-sqlite` 变更闭包和完整 `local-owner-cli` 均通过；
- workspace importer 仍为 22，没有新增第三方或生产依赖；
- Edge application 仍不依赖 `local-owner-cli` 或 `local-secret-admin`。完整 artifact
  数字须在依赖目录恢复后重新采集，不能用源码图代替制品证据。

## 后续

- Project/RoleBinding 管理 CLI、Secret approval/break-glass；
- Secret key rotation、历史 envelope rekey、retirement proof 和备份恢复；
- audit query/retention/export/alert；
- PostgreSQL/KMS/Vault authority 与 Remote Worker 临时 delivery；
- 固定 Edge 多架构上的管理命令 RSS、真实闪存写入和断电恢复证据。
