# ADR-0063：本机 SQLite 存储权威与 Profile 产物边界

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-40、D-42、D-61、D-62、D-65
- 关联 ADR：ADR-0004、ADR-0038、ADR-0040、ADR-0041、ADR-0042、ADR-0044、ADR-0062、ADR-0065、ADR-0066

## 上下文

QingLong 3.0 必须同时运行在内存、闪存和 CPU 都很小的路由设备，以及资源较充足的单机节点。之前 `next` 已有 PostgreSQL adapter 与 cluster-control 组合根，但 edge/standalone 仍只有 legacy 根应用中的 Sequelize/sqlite3 路径。只创建一个空的 Profile package 不会改变事实依赖；把 node:sqlite adapter 直接放回根应用，又会让 3.0 继续继承 Controller、Model、Keyv 和 UI 的隐式 service locator。

另有三个容易被忽略的交付问题：

1. runtime 与 migration 从同一 barrel 静态导出时，常驻进程会加载可执行 DDL；
2. Drizzle typed schema 若作为 production dependency，edge 即使不调用 ORM 也已经支付安装和供应链成本；
3. 当前 pnpm 8 shared-lockfile 下直接执行 `pnpm deploy`，实测会把 legacy 根 importer 的 424 个生产包复制进 edge，形成 177 MiB 目录并重新带入 Sequelize/sqlite3。workspace 依赖图正确不等于发布物正确。

## 决策

### 1. 固定本机 Profile 依赖方向

本机路径固定为：

```text
@qinglong/runtime-core
  <- @qinglong/local-sqlite
  <- @qinglong/local-profile
     /edge | /standalone  (基础制品入口)

@qinglong/local-sqlite
  <- @qinglong/local-admin/runtime
  <- @qinglong/local-adopted-profile -> @qinglong/local-profile
     /edge | /standalone  (接管制品入口)

@qinglong/runtime-core
  <- @qinglong/local-process
  <- @qinglong/local-run-recovery
  <- @qinglong/local-application -> @qinglong/local-adopted-profile

@qinglong/local-cutover  (独立部署 authority；当前不进入任何 Profile closure)
```

- `runtime-core` 只提供 migration-stream 与 RunRepository 公共子入口，不依赖 driver；
- `local-sqlite` 只实现 node:sqlite adapter、readiness 与冻结的 migration manifest；
- `local-profile` 只拥有一个本地数据库 authority 的 readiness/close 生命周期；
- `local-profile/edge|standalone` 是基础制品入口，只固定 Profile，不直接访问 adapter 或 legacy 根；
- `local-adopted-profile/edge|standalone` 是显式接管制品入口，默认关闭；只有接管组合包可以取得 activation runtime、旧库写栅栏和目标库 storage authority。

新包不得 deep-import `back/**`，不得依赖 Sequelize、sqlite3、Express、PostgreSQL、cluster 或 Worker package。禁用路径必须在校验数据库路径、读取文件或打开 connection 前返回，且不注册 timer、watcher、signal handler 或网络 client。

### 2. runtime 与 migration 权限分离

`@qinglong/local-sqlite/runtime` 是常驻入口，只加载：配置边界、只读 readiness、冻结 migration ID/checksum manifest、RunRepository 与必要的 driver-neutral contract。`@qinglong/local-sqlite/migration` 是短生命周期入口，才拥有 executable SQL 和 runner。

常驻启动只验证 history、checksum、capability、必要表/列/索引、foreign key 与 owned-table trigger；不自动建表、不补 migration、不调用 Drizzle Kit。未准备或漂移的数据库 fail closed。migration 必须由升级/管理流程显式执行，并在 legacy 原地接管前补齐备份、adoption manifest、旧库 fixture 与回滚门禁。

### 3. Drizzle 是开发期 schema 工具，不是本机运行时依赖

typed SQLite schema 继续作为字段、约束和索引的开发期 source，Drizzle Kit 只生成候选 diff。`drizzle-orm@1.0.0-rc.4` 与 `drizzle-kit@1.0.0-rc.4` exact pin 在 `local-sqlite` 的 devDependencies；production dependency 只有 `runtime-core`。生产 SQL 由受审 migration stream 执行，不使用 `push`。

Drizzle schema 与 reviewed SQL/manifest 必须保持 lockstep。RC 升级必须重新生成 diff、运行 contract/migration suite，并重新测量产物；它不会因为 production 不安装 ORM 而免除开发供应链评审。

### 4. edge 与 standalone 采用不同且显式的 SQLite 资源策略

- edge：单 writer、rollback `DELETE` journal、`synchronous=FULL`、4 MiB page cache、`mmap=0`、8 MiB journal 上限；优先减少常驻映射、WAL/shm 文件和闪存不确定写放大。
- standalone：单 writer、WAL、`synchronous=FULL`、1000-page autocheckpoint、16 MiB page cache、64 MiB mmap 与 64 MiB journal 上限；以更高资源换取受控读写并发。

两者都只有一个 `DatabaseSync` authority、256 个待处理 operation 硬上限和短 `BEGIN IMMEDIATE` 写事务。Repository callback 可以异步组合内存决策，但事务内不得执行网络、spawn、模型调用、大文件 I/O 或无界分页。若固定 edge 设备的 event-loop p99 不达标，应重新评审 Worker Thread；不得通过增加 connection 或放宽预算掩盖。

### 5. SQLite/PostgreSQL 共享语义，不共享 adapter

本机 `LocalSqliteRunRepository` 与 PostgreSQL `PostgresRunRepository` 使用同一 contract suite，至少覆盖：原子聚合、失败回滚、Run/Attempt/RetryPolicy CAS、idempotency/Attempt/Event 唯一错误、payload/page 上限和取消恢复顺序。SQLite 使用有界串行队列与 `BEGIN IMMEDIATE`；PostgreSQL 保留 Pool、row lock 和多副本语义。

未知业务异常在事务 rollback 后原样传播；SQLite driver error 才映射为统一 repository error。Event payload 必须先 JSON 序列化并检查字节上限，再以绑定参数写入。adapter 不裁决领域状态转换，也不提供绕过 transaction 的 mutation。

### 6. 发布物由逐包 tarball 闭包生成

在当前 pnpm 8 基线下，不接受 shared-workspace `pnpm deploy` 作为 Profile 发布命令。受支持的孵化链为：

1. 按依赖顺序独立 build；
2. 对 `runtime-core`、`local-sqlite`、`local-profile` 以及接管/application 所需的额外组合包分别 `pnpm pack`；
3. 在空目录用 tarball 做 `--omit=dev --ignore-scripts` production install；
4. 核对安装包集合、文件/字节预算和启动 require closure；
5. 在 x64/arm64 Node 24 CI 分别执行 edge/standalone 测试。

当前门禁固定最多 4 MiB、512 文件和 16 MiB importer RSS 增量。Owner ceremony/GC command 单 consumer 收敛后的当前本机复验证据为：edge 1952894 bytes、standalone 1952954 bytes，均 314 文件、5 个 package、39 个加载模块，导入 RSS 增量分别为 10240000/10633216 bytes；edge-adopted 2188894 bytes、standalone-adopted 2188978 bytes，均 342 文件、7 个 package、42 个加载模块，导入 RSS 增量分别为 10436608/10584064 bytes；edge-application 2502851 bytes、standalone-application 2502983 bytes，均 413 文件、11 个 package、72 个加载模块，导入 RSS 增量分别为 12353536/12435456 bytes。短生命周期 `local-secret-admin`、`local-owner-keyring`、`local-owner-console`（含内部 ceremony）、`local-owner-maintenance`（含 GC command/bin）、`cluster-admin` 与隔离 `local-identity` 均不进入 application；adopted/application 常驻导入闭包不加载 executable migration SQL、bootstrap、cluster PostgreSQL、Kubernetes client 或 destructive GC authority。当前 application 文件预算余 99 个，新增常驻文件必须继续通过闭包审计，不能靠放宽路由设备门禁吸收。以上数字是 macOS arm64 单次孵化快照，RSS 会受 allocator/page 状态影响；它只用于证明低于硬门禁，不替代 Linux 双架构 CI 与固定物理路由设备基准。

ADR-0087 execution 合并后的更新证据：edge/standalone/adopted 数字不变；edge-application 为 2,351,639 bytes，standalone-application 为 2,351,747 bytes，均为 489 文件、9 个 package、58 个加载模块，RSS 增量分别为 11,681,792/11,878,400 bytes。构建前必须清理已登记 QL3 package 的 stale dist，当前 application 文件预算为 23 个；该更新覆盖上段旧 application 快照。

ADR-0087 Owner ceremony 合并后的复验继续保持相同制品字节/文件/模块闭包：edge/standalone 为 1,750,966/1,751,092 bytes，edge-adopted/standalone-adopted 为 1,867,793/1,867,966 bytes，edge-application/standalone-application 为 2,351,639/2,351,747 bytes；六种制品全部通过。短生命周期 authority 当时的名称为 `@qinglong/local-owner-ceremony/bootstrap|credential-recovery`，仍未进入任何 application 闭包。本次 RSS 抽样分别为 7,929,856/5,783,552、6,094,848/8,257,536、11,714,560/11,862,016 bytes；RSS 只作硬门禁证据，不作为跨次精确比较。

ADR-0087 的后续单 consumer 收敛已把上述 ceremony 变成 `local-owner-console` 内部模块，并把 `ql3-owner-gc` command/bin 并入 `local-owner-maintenance`；删除包名保持墓碑。两次合并均发生在短生命周期闭包，不能改变任何 application 制品集合、加载模块或常驻 RSS；现行 importer hard cap 为 21，仍需以下文最新六制品实测为准。

ADR-0106 将四个无独立依赖的 wrapper package 收敛为现有组合包 subpath；叠加后续 Scheduler 能力后的当前制品为：edge/standalone 1,662,386/1,662,434 bytes、238 files、37 modules；edge-adopted/standalone-adopted 1,898,370/1,898,442 bytes、266 files、40 modules；edge-application/standalone-application 2,211,411/2,211,531 bytes、337 files、70 modules。六种制品均通过 4 MiB/512 files/16 MiB 门禁，基础闭包仍不安装 local-admin。RSS 单次抽样最大为 12,288,000 bytes，只用于门禁。

## 当前实现状态

已完成：

- Node 24 node:sqlite adapter、typed schema、二十六条 reviewed migration 与 checksum；capability v13 在 receipt journal、不可变 execution revision/context recipe、dispatch candidate index、append-only encrypted Secret envelope、本机 Project Policy、security audit、原子授权 Secret mutation、ownerless stable Identity、append-only API credential catalog、Owner delivery acknowledgement ledger、credential-version pepper provenance binding 与 versioned Owner pepper catalog/activation generation 之外，加入 credential recovery、indexed pepper reference inspection、material GC ledger 与 acknowledgement tombstone ledger；
- runtime/migration 子入口和“runtime 不加载 executable SQL”的子进程门禁；
- edge rollback journal、standalone WAL 与路径/权限/defensive/readiness 边界；
- LocalSqliteRunRepository 和与 PostgreSQL 共用的完整 RunRepository contract；
- Drizzle typed schema 与 migration 后真实 SQLite catalog 的 table/column/index/CHECK/FK lockstep；
- `local-profile` storage-only 组合根及 `/edge|standalone` 基础制品入口；
- `local-adopted-profile` 接管组合根及 `/edge|standalone` 默认关闭的接管制品入口；
- 当前二十一个 3.0 importer 的 exact manifest/lock/source boundary；local-admin 的 migration 能力只允许短生命周期管理入口调用，adopted 常驻路径只能导入其无 DDL 的 runtime 子入口，local-process 只依赖 runtime-core，local-execution 内部 subpath 保持单向依赖，local-secret 与 local-identity 生产均只依赖 runtime-core，短生命周期 local-secret-admin、Owner keyring/console/maintenance/CLI 与隔离 local-identity 不得被常驻 package 反向导入，console 内部 ceremony 和 maintenance 内部 GC command 仍按源文件隔离，destructive keyring/SQLite 子入口仍只允许对应 GC authority 导入，local-application 只能消费受审组合边界，local-cutover 不得被 runtime/Profile/application 反向导入；
- 六种本机 importer 的实际 production tarball closure、体积、文件数、导入闭包与 RSS 门禁；
- ADR-0064 的 activation document、旧库生命周期写栅栏、目标稳定文件身份和 target-open 后复核。

尚未完成：

- ADR-0064 已完成 `data/db/database.sqlite` 的只读 baseline、在线备份、旁路 target migration、staged manifest、activation document、数据库级停写栅栏和 storage-only adopted 组合；尚缺部署 supervisor 对旧进程及外部副作用的停机证明，以及目标产生 3.0 新事实后的数据对账式回退；
- Keyv、其他 Sequelize 数据域和 legacy 调用者迁移；
- 本机 execution coordinator/recovery、ADR-0071 scheduler admission、Artifact/output quota、ADR-0072 统一 completion/cancellation/timeout/receipt cleanup/shutdown drain，以及 ADR-0073 加密 Secret provider 已注入 application；仍缺首 owner/Secret 管理产品入口、retry、Artifact retention/read 与 HTTP admission 的完整 Profile application stack；
- Linux x64/arm64 CI 首次远端证据、固定路由设备 event-loop/闪存/断电/ENOSPC 基准；
- 可发布镜像、SBOM、签名、provenance 和独立 migration/admin artifact。

因此 `storage_ready` 只证明数据库 adapter 可安全提供 RunRepository；`adopted_storage_ready` 进一步证明旧库在该生命周期内被数据库写栅栏保护、目标身份与 activation 一致。两者都不表示 QingLong 3.0 edge/standalone 已具备完整生产功能，也不证明旧进程的网络、spawn 或其他外部副作用已经静默。

## 被否决的替代方案

1. **继续让 edge/standalone 以 legacy 根包作为 3.0 importer**：保留 Sequelize、sqlite3、UI 和全局 singleton，拒绝。
2. **在 runtime-core 放入 SQLite adapter**：让所有 Profile 支付 driver/schema 成本并反转依赖，拒绝。
3. **runtime 启动时自动 migrate**：常驻 authority 同时拥有 DDL，失败与多进程启动边界不清，拒绝。
4. **edge 与 standalone 都硬编码 WAL**：忽略低配闪存、额外文件和 checkpoint 风险，拒绝。
5. **production 安装 Drizzle RC**：当前 runtime 使用审查后的绑定 SQL，不需要 ORM；为未加载能力付出体积与 advisory 面没有收益，拒绝。
6. **把 `pnpm deploy` 成功当成产物证明**：当前实测会污染 legacy 根依赖，拒绝，直至升级包管理器并由同一门禁证明新行为。
7. **SQLite 与 PostgreSQL 共享 SQL/driver**：掩盖单 writer 与多副本锁语义差异，拒绝。

## 影响

正向影响：

- edge 用户不安装 cluster、legacy ORM/native addon 或开发期 Drizzle；
- standalone 可以独立调优，不迫使路由设备接受同一资源策略；
- migration 权限、runtime 生命周期和发布 importer 可分别审计；
- SQLite/PostgreSQL 通过公共契约保持领域一致，而不是复制 SQL；
- 不合理的根 service locator 与万能产物开始有可删除的替代路径。

代价与风险：

- 增加 adapter、共享组合根和两个 Profile importer package；
- 迁移期仍保留 legacy SQLite/Sequelize 与全新 3.0 SQLite stream，两者不能同时写同一生产库；
- node:sqlite 同步 API、Node 24 架构覆盖和 Drizzle RC schema tooling 仍是 Alpha 风险；
- tarball 产物链在升级 pnpm 后需要重新评审，不能长期形成第二套无人维护的打包系统。

## 验证

1. local-sqlite 的数据库安全测试、共享 RunRepository contract 全部通过。
2. runtime 子入口 require cache 不包含 executable migration SQL。
3. disabled edge/standalone 不检查路径、不创建数据库、不加载 cluster/ORM。
4. edge readiness 报告 `delete`，standalone 报告 `wal`，runtime 不自动迁移。
5. dependency audit 拒绝 local-profile 导入 migration/root entrypoint，并拒绝本机 runtime 源码导入 Drizzle。
6. base tarball production install 只有四个预期 package，adopted install 只有六个预期 package，application install 只有十二个预期 package；三类体积、文件、require closure 和 RSS 均在硬预算内。
7. Node 24 x64/arm64 CI 独立运行 adapter、两个组合根、四个 importer 和产物门禁。
8. 旧进程停机、外部副作用静默、写后数据对账、物理设备与可发布镜像 Gate 完成前最多保持 `adopted_storage_ready`，不宣称 production active 或无损自动回退。
