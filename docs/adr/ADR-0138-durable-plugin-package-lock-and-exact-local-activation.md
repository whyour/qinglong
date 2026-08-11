# ADR-0138：耐久 Plugin Package Lock 与精确本地激活

- 状态：Accepted（完整 PackageLock 原子持久化、双 staging evidence、activation intent、
  fresh/recovery coordinator、本地 POSIX publisher、SQLite 端到端组合与 PostgreSQL
  四角色持久化验证已完成；ADR-0139 已补 Cluster publisher，ADR-0140 已补调用方驱动
  启动恢复、本机 application gate、标准 OCI resolver、Cluster admin process、
  独立镜像与 Job/RBAC；ADR-0149 已补原子资源 generation identity/source，具体语义
  materializer 与私有 registry 仍未开放）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-132 至 D-136
- 关联 ADR：ADR-0087、ADR-0134、ADR-0135、ADR-0136、ADR-0137

## 背景

ADR-0134 至 ADR-0137 已冻结 PackageLock、安装状态机、确定性 staging 和两种数据库
Repository，但实现审计发现三个不能留给产品层修补的缺口：

1. Repository 只保存 record JSON 与 lock digest。进程重启虽能判断
   `resume_stage | resume_activation | inspect_activation`，却无法重建被审批的完整
   PackageLock；
2. POSIX staging adapter 返回 `receipt.json` 的真实 SHA-256，而领域
   `stage_completed` 又生成另一个 receipt digest。后者没有保存前者，激活时无法证明
   正在发布的仍是已验签、已 fsync 的字节；
3. activation receipt 只绑定 generation 和 content。相同 generation/content 可在不同
   installation 或不同 previous pointer 之间误重放；`activating` 的 fresh publish、
   response-loss 和 restart recovery 也没有唯一协调器。

这些问题在低配路由设备上不能靠常驻 watcher 或额外数据库解决，在 Cluster 多副本上
更不能靠进程内锁解决。修复必须继续服从 ADR-0087：能力应优先成为现有包的显式
subpath，不能因为一个 adapter 或 coordinator 再创建单文件 workspace package。

## 决策

### 1. 完整 PackageLock 与 queued record 原子保存

`PluginPackageInstallCreate` 必须携带规范化后的完整 PackageLock。Repository create
在同一个数据库 transaction 中保存 lock 与 queued record，并逐项复验
installation、Project、Package、generation、previous active pointer 和 lock digest。

Repository port 新增 `findLock(lockDigest)`。读取必须重新运行 PackageLock normalizer、
重算 digest，并拒绝 JSON、索引列或 record 之间的任何漂移；未知 digest 返回 null，
corrupt durable fact 返回 unavailable。

- SQLite `0037` 使用 `lock_json TEXT NOT NULL`，CHECK 固定 JSON object、lock digest、
  Project 和 Package；
- PostgreSQL `pg-0018` 使用 `lock_json jsonb NOT NULL`，除同样绑定外还限制 JSON
  object 和大小；
- 两种 adapter 继续由同一 shared repository contract 驱动。

不单建 lock 表：PackageLock 与 installation 同生且不可变，一对一列存储能在不增加
join、表、migration version 或 importer 的前提下保持事务原子性。

### 2. staging 同时保存领域回执和外部字节证据

`PluginPackageStageReceipt` 增加 `evidenceDigest`。领域 receipt digest 继续绑定
lock、artifact、Manifest、content 和 stage reference；`evidenceDigest` 则精确保存
adapter 可重新检查的外部事实：

- 本地 staging 为 canonical `receipt.json` 原始字节的 SHA-256；
- 未来 OCI/Kubernetes adapter 必须提供同等不可变、可 inspect 的证据摘要。

激活 publisher 必须同时检查领域 stage receipt 和外部 evidence，不能把“状态机曾进入
staged”当作“当前落盘字节仍可信”。

### 3. activation intent 绑定完整切换事实

ADR-0149 将其升级为 `qinglong/plugin-package-activation-intent@v2`，除下列切换事实外
还完整携带并摘要绑定受限的 resource generation：

- installation、Project、Package 和 PackageLock；
- target generation 与 exact previous active lock；
- stage reference、领域 stage receipt digest、外部 evidence digest；
- content digest 与 domain-separated intent digest。

activation receipt 必须携带并匹配 intent digest。这样即使 content 和 generation
相同，也不能跨 installation、Project/Package、previous pointer 或 stage evidence
重放。

### 4. fresh publish 与 recovery inspect 严格分离

`PluginPackageActivationCoordinator` 只有两条路径：

- fresh：先 CAS 保存 `activating`，再调用 publisher `publish`；得到 exact receipt 后
  才 CAS `active`；
- recovery：只调用 publisher `inspect`。exact published fact 提交 `active`，
  `not_published` 提交受审 failure，冲突提交 `activation_fact_conflict`。

publish 抛出 availability 或响应丢失时，durable record 保持 `activating`，调用者不得
在同一不确定路径重新 publish。terminal exact retry 只返回已保存事实。

`PluginPackageInstallationCoordinator` 固定
Approved Action consume → durable create/findLock → stage → staged CAS → activation
coordinator 的顺序。Approved Action consumer 是必须由产品层提供的受信、exact-replay、
带 fence capability；当前不提供默认或弱化实现。

### 5. 本地 publisher 使用单一私有原子 pointer

`@qinglong/local-admin/package-activation` 只接受两个预创建、当前 UID 拥有、真实
`0700` 且 device/inode 稳定的独立目录。每次 inspect/publish 都重新验证 authority，
再逐项验证 staging receipt、blob exact set、owner、mode、size 和 digest。

active pointer 名称由 Project/Package 的 domain-separated SHA-256 派生，内容为
canonical intent + receipt，权限固定 `0600`。ADR-0149 将 pointer 升级为 v2，使资源
generation 与 package pointer 同一次 rename 生效。publication 使用：

1. per-pointer `O_CREAT | O_EXCL | O_NOFOLLOW` 的 `0600` 锁；
2. 写入并 fsync 私有临时文件；
3. 同目录 atomic rename；
4. fsync activation directory；
5. 重新 inspect 最终 pointer。

升级必须匹配 exact previous pointer；stale writer 冲突失败关闭。publisher 记录自己
创建的锁 inode/device，finally 只删除身份仍匹配的 owned lock；若另一 publisher 已持锁
或路径被替换，绝不按文件名删除。

### 6. 组合继续留在既有包

- runtime-core 增加显式 `plugin-package-activation` 与
  `plugin-package-installation` subpath；
- local-admin 增加显式 `package-activation` 与 `package-installation` subpath；
- local-sqlite、cluster-postgres 只扩充原 repository subpath；
- 不新增 workspace package、第三方依赖、timer、watcher、socket、sidecar 或数据库
  connection。

本地组合已用 SQLite Repository、真实 staging evidence 和 POSIX publisher 完成端到端
测试，但没有从 package root 或 production application root 导出。

### 7. Cluster 恢复已组合，产品安装入口继续失败关闭

ADR-0140 已把 allowlisted OCI source resolver、可选 exact-registry credential
provider、同一 PostgreSQL lock authority 驱动的 stage verifier、独立 cluster-admin
image 与最小权限 Job/RBAC 组合完成。
它仍不开放：

- 具体 Approved Action durable consumer、管理 API/CLI/UI；
- operator repair workflow；
- ADR-0149 已完成的原子 generation identity/source 之上的
  Task/Workflow/Prompt/Tool/Trigger 语义 materializer 与旧代 GC；
- object-store stage；
- publisher revoke/index、Runtime/UI Extension 或动态代码加载。

因此“本地端到端组合可执行”不等于 QingLong 3.0 已允许用户安装插件；生产入口必须等
上述 authority、Audit、recovery 与资源语义 materializer 闭环完成后另行评审。

## 拒绝的方案

- 为 activation、installation coordinator 或每种 publisher 各建 workspace package：
  拒绝；这些边界由 subpath 和 dependency audit 足以隔离，拆包只增加 importer、
  build、发布和路由设备安装元数据成本。
- 只保存 lock digest，恢复时从 OCI/tag/文件重新生成 lock：拒绝；来源可能不可用，
  也无法重建已消费审批和当时环境。
- staging receipt 只保存领域摘要：拒绝；无法复验 adapter 已落盘的具体字节。
- `activating` 重启后再次 publish：拒绝；响应丢失时会重复外部副作用。
- 用无条件 `unlink(lockPath)` 清理竞争锁：拒绝；文件名不证明所有权。
- 让 local-admin 默认创建 Approved Action consumer：拒绝；会绕过身份、Policy、
  Approval ledger 和 Audit 的产品 ceremony。

## 影响

- edge/standalone 仍使用单 SQLite authority、短 transaction 和调用时 I/O；禁用路径
  不加载安装/激活 subpath，常驻成本不增加。
- Cluster Repository 已能耐久恢复完整 lock，ADR-0139 也已提供 ConfigMap publisher；
  stage verifier、短生命周期 process 和 RBAC 已组合；ADR-0149 已组合原子 resource
  generation identity/source，但语义 materializer 与 Approved Action 产品入口仍未
  组合，默认控制面仍不可安装 Package。
- 两个方言和未来 publisher 共用同一 intent/recovery 语义；数据库与部署差异留在
  adapter。
- workspace importer 保持 21 个；本切片没有新增 package 或第三方 dependency，回应
  “packages 是否拆得过细”的原则是：单文件能力先并入职责相符的包并用显式 subpath
  隔离，只有出现独立发布、独立运行或真正不同依赖生命周期时才考虑拆包。

## 验证

必须覆盖：

1. SQLite/PostgreSQL lock 与 record 原子保存、`findLock` exact replay 和 corruption；
2. shared repository contract 的缺失 lock、head replacement、CAS 和 recovery page；
3. staging 外部 evidence 进入 durable receipt 并参与 activation intent；
4. fresh activation 在 publish 前已保存 `activating`；
5. publish response loss 后只 inspect、不重复 publish；
6. external fact absent/conflict 的稳定 failed reason；
7. 本地 pointer exact replay 不推进时钟；
8. previous pointer replacement 和 stale writer conflict；
9. stage blob、receipt、pointer、root/symlink tamper fail-closed；
10. 预先存在的另一 publisher lock 不被删除；
11. Approved Action → SQLite lock → stage → POSIX active 的端到端组合；
12. explicit subpath/root isolation、依赖方向、六 Profile artifact 与 edge import；
13. PostgreSQL 四角色最小权限与物理 HA。

当前针对性结果为 runtime-core 224/224、local-sqlite 68/68、local-admin 51/51、
cluster-postgres 非数据库 124 pass/1 条件 skip，以及 PostgreSQL 18 四角色真实集成
28 pass/1 条件 skip。21-package clean build/聚合测试退出 0；dependency/source
boundary 与 edge import 通过且 `findings=[]`；ADR-0140 production wiring 后六种
Profile 全部通过，最小 Profile 仍为 39 loaded modules，最大 application 为
2,849,491 bytes/439 files/78 loaded modules，最大 RSS delta 13,090,816 bytes；
PostgreSQL 18 HA 的 21 个具体 gate 与总 `passed` 全为 true。
