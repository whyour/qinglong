# ADR-0200：本机 SQLite Rollout 写契约与升级前快照

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-184、D-188、D-189、D-190
- 关联 ADR：ADR-0194、ADR-0197、ADR-0198、ADR-0199

## 背景

ADR-0199 能在 Compose 候选失败时恢复旧 image，但“旧 image 能启动”不等于“旧
image 能安全写当前 SQLite”。候选可能已提交数据，旧 image 的读取窗口也不能证明
它采用相同写语义。Docker selection、SQLite 文件和 rollout receipt 之间不存在
跨介质事务，断电、磁盘满或响应丢失还会留下不同的中间状态。

自动用升级前数据库覆盖当前数据库同样不安全：候选写入可能是有效的用户事实，
blind restore 会把一次容器回退扩大成数据回退。系统需要同时保留升级前恢复点、
观察候选是否写过，并让 image rollback 与 data restore 成为两个显式决策。

## 决策

### 1. 读窗口与写契约分开声明

本机 image OCI config 除 SQLite contract min/max 外，必须精确声明：

```text
io.qinglong.local.sqlite-write-contract=35
```

min/max 表示 image 可以读取的 durable contract 区间；write contract 表示它会写回
的语义版本。当前 v3 候选固定为 read `35..35`、write `35`。Compose preflight
直接读取 Docker daemon 对 exact RepoDigest 的 config，要求当前数据库 contract
同时落在读取窗口内且精确等于 write contract。缺失、非整数或不相等均在任何
container mutation 前失败关闭。

该 label 同时受 Dockerfile 静态审计、原生镜像检查、OCI 双平台 config 审计和
release workflow 约束，不能由 command file、Compose override 或调用方声明。

### 2. Generation 2 起先创建在线一致快照

每个存在 previous generation 的 apply，在 preflight 成功后、任何
`docker compose up` 前调用 Node 24 `node:sqlite backup` 创建在线一致快照：

```text
service/rollout-backups/<rolloutId>.sqlite
```

实现固定：

- source 与 backup 都必须位于 canonical、当前 UID、`0700` 私有目录；
- source/final/stage 都拒绝 symlink，SQLite 文件必须为 `0600`、单 hard link；
- stage 名由 rollout ID 确定，Edge 每批 16 pages，Standalone 每批 64 pages；
- 完成后复核完整 SQLite readiness、contract、page count/page size、bytes 与
  SHA-256，再 fsync file、no-replace rename、fsync directory；
- 不完整或 ENOSPC stage 会删除并在同一 rollout 重试；final 已存在时只做严格
  exact inspection，不覆盖；
- 目录最多保留 8 个 final snapshot。达到上限且本次没有既存快照时失败关闭，
  不由运行时自动删除恢复证据。

Generation 1 没有可替代历史，不创建 rollout snapshot；首次失败仍按 ADR-0199
显式 stop。

### 3. 候选写入使用连接级 `data_version` 观察

apply 在启动候选前保持一个只读 SQLite 连接，记录初始 `PRAGMA data_version`；
候选 active/失败观察结束后在同一连接读取一次：

- `unchanged`：观察窗口内没有其他连接提交；
- `changed`：候选窗口内观察到外部提交；
- `recovery_unknown`：进程在记录观察结果前丢失响应，或不健康候选的观察连接已
  无法可靠读取 `data_version`；恢复只能证明快照存在。

这是保守写入观察，不声称识别具体写入者，也不作为自动 restore 的授权。它只让
operator 明确知道 image rollback 与 data rollback 是否可能产生不同后果。
健康候选若无法读取观察结果仍失败关闭，不发布 active receipt；只有已经缺少
`active` evidence 的候选才允许把观察错误降级为 `recovery_unknown` 并继续建立
rollback generation。

### 4. Image rollback 不自动 restore SQLite

候选失败后仍按 ADR-0199 创建单调递增的 rollback generation，但旧 image 必须对
“当前”数据库重新执行完整 preflight，并满足 exact write contract。控制器不会把
升级前快照复制回 source database。

因此：

- 旧 image 能安全读写当前库时，可恢复服务并保留 snapshot；
- 当前库已超出旧 image 契约时，rollback preflight 失败，rollout lock 保留；
- 需要 data restore 时由后续显式、停服、受审的 restore operation 完成，不能
  由 Compose 健康失败隐式授权；
- `changed` 或 `recovery_unknown` 均不能被解释为“可以自动丢弃当前库”。

### 5. Receipt 绑定数据证据

`service/rollouts/<rolloutId>.json` 使用
`qinglong/local-compose-rollout-receipt@v2`，新增严格 canonical `sqlite` 对象，
保存 contract、write contract、write observation，以及 generation 2+ 快照的
SHA-256、bytes、page count 和 page size。重放 receipt 时必须重新检查 final
snapshot 和全部证据；快照缺失、漂移或 receipt shape 漂移均失败关闭，不再次启动
容器。旧 v1 receipt 不会被静默解释成具备数据证据。

若崩溃发生在 rollback selection 已切换而 receipt 尚未发布，恢复路径必须先找到并
复核该 rollout 的既有快照，才能继续启动旧 image。没有快照的伪造恢复状态不再被
接受。

### 6. 保持低配设备闭包

实现只在既有 `@qinglong/local-sqlite` 增加 `rollout-safety` subpath，并由既有
`local-owner-cli` Compose apply 精确导入。不新增 workspace package、第三方依赖、
daemon、timer、watcher、端口或 Edge 常驻内存。无 Docker 的 systemd/OpenRC
部署不加载此 subpath；Cluster 的 PostgreSQL/Barman 恢复边界不复用本地 SQLite
文件协议。

## 发布门

真实 release 门必须对同一个 pushed exact digest 分别执行：

```text
Edge generation 1 active
  -> 同 digest generation 2
  -> 在线 SQLite snapshot + receipt inspection
  -> active
  -> SIGTERM stopped

Standalone generation 1 active
  -> 同 digest generation 2
  -> 在线 SQLite snapshot + receipt inspection
  -> active
  -> SIGTERM stopped
```

使用相同 digest 是为了隔离 rollout/data protocol 本身，不把业务 image 差异混入
该门；正式升级仍使用不同 exact digest。

## 验收证据

- `local-sqlite` 141/141；
- `local-owner-cli` 41/41；
- image/OCI/release 专项 36/36，静态 image audit findings=0；
- workspace 保持 22 packages，无新增生产依赖；
- ENOSPC 注入在任何 `compose up` 前失败，候选外部 SQLite commit 被观察为
  `changed`，response-loss recovery 必须持有可复核 snapshot；
- arm64 Docker 上，Edge 128 MiB/64 PID 与 Standalone 256 MiB/256 PID 对
  localhost exact manifest `sha256:88c059…fe9c` 均完成 generation `1→2`、
  write contract 35、snapshot、durable receipt、active、graceful stopped 和资源
  清理；
- PostgreSQL 18.4 arm64 physical HA 回归门同期重跑，timeline `1→2`、旧主
  fencing、`pg_rewind` 同步只读重加入及全部 domain gates 均
  `gates.passed=true`。

localhost digest 只属于本机 live evidence，不替代 GHCR 双架构 manifest、签名和
attestation。

## 未包含

- operator 显式 data restore、restore dry-run 与恢复后新 generation；
- 达到 8 份后的受审 snapshot GC/归档；
- 宿主机断电、文件系统损坏和物理路由器闪存寿命矩阵；
- systemd/OpenRC 的进程激活与 rollback；
- 正式 GHCR release 成功记录。

## 被拒绝的替代方案

- **只看 read min/max**：不能证明旧 image 会以当前 durable 语义写回。
- **候选失败就自动覆盖数据库**：可能静默丢失已提交的有效事实。
- **复制 `.sqlite`/`-wal`/`-shm` 三个文件**：在线复制窗口不能证明一致性。
- **把快照存在内存或临时目录**：无法跨进程崩溃、response loss 和 daemon 重启。
- **每次升级无限保留快照**：不适合闪存有限的路由设备。
- **另拆 backup package/service**：没有独立交付或 authority，反而增加 package
  碎片与低配安装成本。
