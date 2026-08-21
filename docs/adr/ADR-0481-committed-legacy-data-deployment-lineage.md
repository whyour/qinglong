# ADR-0481：Committed Legacy Data Receipt 的本机部署 Lineage

- 状态：Proposed（D-388 契约冻结）
- 日期：2026-08-21
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-64、D-87、D-184、D-259、D-388
- 关联 ADR：ADR-0194、ADR-0309、ADR-0310、ADR-0313、ADR-0314、ADR-0362、ADR-0476、ADR-0477、ADR-0478、ADR-0479、ADR-0480

## 背景

ADR-0480 已把 Legacy `config/db/ssh.d` prepared model 原子提交到 Local SQLite，并在 transformation root
留下内容无关、可精确验证的 `commit.json`。但是现有部署链只绑定 SQLite activation、Legacy silence
commitment、Application config、进程 identity 与 service/Compose outcome。D-387 的 `commitDigest` 和数据库
`receiptDigest` 尚未进入 systemd、OpenRC 或 Compose 的启动事实。

这不是日志字段缺失，而是 authority 缺口：现有 adopted Application v3 不认识 data application receipt，部署者
可以先完成 D-387，再继续用一个只绑定 SQLite activation 的 v3 config 启动目标；相反，若把 D-387 apply 与
service start 合并，又会让数据迁移 credential 获得 activation 权限，并破坏 ADR-0480 已明确的职责分离。

Compose 还有一个更早的产品缺口。fresh v2 固定把 deployment root 映射到 `/var/lib/qinglong3`；SQLite activation
却绑定宿主机 canonical source/target path digest。直接把 adopted config 的路径改成容器路径会让真实 Application
校验失败，继续依赖测试中的合成 mount evidence 也不能称为受审 adopted Compose create/config。

本决策只处理本机 Edge/Standalone。Cluster 必须使用 PostgreSQL、separation-of-duty、控制面 rollout 与集群专用
fencing；不能复用本机私有文件或 Owner credential ceremony。

## 决策

### 1. Receipt 是启动前置事实，不是启动授权

D-387 的 `commit.json` 证明一个 prepared transformation 已经完成数据库提交和明文逻辑回收。它不表示：

- 配置、SSH binding、Task 或 Trigger 已启用；
- Legacy 已静默；
- systemd/OpenRC unit 已安装、enable 或 start；
- Compose target 可以 `up`；
- target 可以回退，或 Legacy 可以重新启动。

因此 data apply、deployment bundle prepare、service/Compose activation 和 rollback 继续是四个独立命令与 durable
事实。任何一步成功都不隐式调用下一步。

### 2. Application v4 精确绑定 committed application

新增只允许 `storage.mode=adopted` 的
`qinglong/local-application-process@v4`。它保留 v3 的 `storage` 与 `cutover`，并增加 exact 字段：

```json
{
  "legacyDataApplication": {
    "commitPath": "/absolute/private/transformation/commit.json",
    "expectedCommitDigest": "64-hex",
    "expectedReceiptDigest": "64-hex"
  }
}
```

Application 在取得 signal、SQLite、Secret、Plugin Package、AI 或 lifecycle authority 前，按以下顺序失败关闭：

1. 解析 exact v4 config，要求所有 authority path 规范、非 root、互异且有界；
2. 使用 no-follow descriptor 有界读取私有 `commit.json`，复核 owner、mode、link count、inode 与读前后 stat；
3. 校验 D-387 exact schema、`state=committed`、reclamation 三项固定值与 payload-domain digest；
4. 同时匹配 config 的 `expectedCommitDigest`、`expectedReceiptDigest`、Profile，以及 storage activation 所绑定的
   transformation/target 事实；
5. 再验证既有 Legacy silence commitment，然后才进入 adopted storage startup。

v2 fresh 行为不变。v3 仍表示“只接管 SQLite、没有声明完整 data-directory application”的兼容模式；完成 D-387
并要把其结果作为部署前置事实的路径必须使用 v4，部署 prepare 不得为该路径生成 v3。

### 3. Canonical commit codec 下沉到既有 SQLite adoption domain

`commit.json` 的 payload 本来由 SQLite adoption receipt 派生。canonical type、exact normalizer 与 digest 计算放在
现有 `@qinglong/local-sqlite/data-directory-adoption` 子路径，由 D-387 cleanup、Application startup gate 和 Owner
deployment consumer 共同复用。文件身份读取仍由各自 authority owner 负责。

这不是新 package，也不让 Local SQLite 读取 deployment journal、调用 init/Docker 或获得 service authority；它只
共享内容无关的纯数据 contract，避免 Application 与 Owner 各自维护一份易漂移的 schema。

### 4. 新增 adopted bundle prepare/verify，但不激活服务

既有 `ql3-local-deploy` 增加 exact、私有 command-file 操作：

```text
local.deployment.adopted.prepare
local.deployment.adopted.verify
```

命令精确绑定 Profile、instance/cutover、deployment root、SQLite source/target/recovery/manifest/activation、Legacy
silence commitment、D-387 commit/receipt，以及 systemd、OpenRC、Compose 三选一 service contract。prepare 在发布
任何文件前验证全部源证据，随后 no-replace 发布 Application v4 config、描述符和一个内容无关 bundle receipt；verify
只验证终态，绝不修复、install、enable、start、stop、pull image 或连接 socket。

该操作不执行 `local.setup`，因为 target SQLite、Owner pepper、Secret keyring 和 D-387 receipt 已存在。fresh
`local.deployment.prepare` 保持 v2/`local.setup` 语义，避免把两种 authority 混成大量 optional 字段。

### 5. systemd/OpenRC 保持 Owner → root bridge → Owner consumer

Application v4 config 的文件 SHA-256 继续进入 service-manager intent，因此短生命周期 root bridge 可传递绑定而无需
解析 D-387 schema、打开 SQLite 或读取 transformation root。root bridge 仍只执行固定 manager/argv 并发布 outcome。

Owner consumer 必须重新读取 v4 config、commit 和既有 activation/commitment/data evidence。新的 cutover journal
版本显式记录：

- `legacyDataApplicationCommitDigest`；
- `legacyDataApplicationReceiptDigest`；
- 既有 `applicationConfigDigest`、`activationDigest` 与 `commitmentDigest`。

restart/stop 必须保持同一 commit/receipt binding；发生漂移时不能调用 manager。Legacy rollback preparation 可以读取
该 lineage，但 `commitDigest` 绝不替代既有 stopped evidence、双阶段授权、barrier 和 readiness proof。

### 6. adopted Compose 使用 identity-preserving bind

fresh v2 Compose 继续把 deployment root 映射到 `/var/lib/qinglong3`。adopted v4 不复用这一映射，而要求：

- target、recovery、manifest、activation、cutover commitment、D-387 commit 与运行时可写目录均位于私有
  deployment root；
- deployment root 以 source 与 target 相同的 canonical absolute path 绑定进容器；
- Legacy SQLite source 作为唯一额外 bind，同样映射到相同 canonical absolute path；
- 描述符固定 read-only rootfs、无网络、cap-drop、no-new-privileges、UID:GID 和 Profile memory/PID 上限；
- adopted target 不使用隐式 `unless-stopped` 绕过 generation/Legacy reproof。

这样 Application 看到的 path 字节与 activation 中的 path digest 相同，不需要重写已签定的证据，也不扩大为任意
caller-supplied mount 表。Compose config inspection 必须精确验证两条 mount、config path、restart policy、image digest、
generation 和 mutation labels。

Compose preflight 在任何 `compose up` 前验证 v4 commit/receipt，并把二者加入 rollout receipt。apply 的 exact replay、
失败回收、restore 与 evidence collection 必须继承同一 binding；restore 仍只恢复目标 SQLite generation，不删除 D-387
提交、不重新创建已回收明文，也不自动启动 Legacy。

### 7. 低配与大节点使用同一协议、不同预算

本能力不新增 workspace package、production dependency、daemon、timer、watcher、listener、数据库连接或后台 retry。
Application 常驻路径只增加一次不超过 64 KiB 的私有 JSON 读取和 SHA-256；Owner/Compose 验证均为人工触发的一次性
操作，不扫描历史。

Edge 保持 128 MiB/64 PID 描述符预算，Standalone 保持 256 MiB/256 PID。两档共享同一 receipt/lineage schema，避免
低配设备成为弱协议；Cluster 节点不因此获得本机模式的规模或高可用声明。

## 故障与重放语义

- commit 在 prepare 前漂移：不发布 bundle；
- prepare 在文件发布中崩溃：原命令只按 deterministic content/no-replace 收敛，未知额外文件失败关闭；
- service/Compose activation 前漂移：不调用 manager/Docker；
- manager/Docker side effect 后响应丢失：沿用既有 barrier 与 inspect-only recovery，不因 receipt 重新执行副作用；
- Application 读取 commit 后、storage 前 commit 被替换：descriptor identity/stat 复核失败；
- 已 active 后 commit 被删除或漂移：下一次 restart/stop consumer 失败关闭并进入既有人工诊断路径；当前进程不引入
  watcher，因此不冒充运行期间持续 attestation；
- rollback：必须执行既有显式 prepare/authorize/consume 或 Compose restore ceremony，receipt 本身没有回退权限。

## 被拒绝的替代方案

### 只把 `commitDigest` 加进 stdout 或 service intent

拒绝。Application 仍可用 v3 直接启动，root/Compose side effect 也可能发生在 Owner 复核前。

### D-387 apply 成功后自动 start

拒绝。数据迁移 credential 会获得 deployment authority，且 COMMIT-response-loss 会让自动副作用无法安全重放。

### Application 导入 Owner CLI 或直接调用 systemd/Docker

拒绝。会把短生命周期部署 authority 带入低配常驻闭包，并破坏 root bridge 的最小解析面。

### adopted Compose 继续映射到 `/var/lib/qinglong3`

拒绝。会改变 activation 已绑定的 path identity；重新计算 digest 等于伪造一份没有原 ceremony 支持的新证据。

### 为 receipt 建立新 workspace package或常驻 watcher

拒绝。canonical codec 已有 SQLite adoption owner；watcher 既不能回滚外部 side effect，也会为路由设备增加常驻成本。

### 用 receipt 自动允许 Legacy rollback

拒绝。receipt 证明新数据已提交，反而意味着回退更需要数据 reconciliation；它不证明 target stopped 或 Legacy ready。

## 验收条件

1. v4 config、commit schema/digest/Profile/receipt/path 任一漂移，Application 在 signal/storage 前失败；v2/v3 既有语义不变。
2. adopted prepare/verify 对 systemd、OpenRC、Compose 均可 exact replay，且不产生 install/start/socket/network 副作用。
3. systemd/OpenRC root bridge 不解析 commit；Owner cutover journal 显式绑定 commit/receipt，restart/stop 漂移失败。
4. adopted Compose 真实 config 使用 identity-preserving mount，preflight/apply/restore/evidence lineage 保留 commit/receipt。
5. activation 与 rollback 仍需既有独立命令；D-387 apply 或 bundle prepare 单独成功不会改变服务状态。
6. 覆盖成功、exact replay、commit/config/mount 漂移、发布崩溃、manager/Docker 响应丢失、ENOSPC 与低配资源边界。
7. 完整 package/backend、架构、distribution、artifact 门通过；workspace package 数、浅包审计和常驻依赖闭包不退化。

## 未包含

- Cluster/PostgreSQL/Kubernetes 的 prepared-model application 与 rollout；
- 运行期间持续文件 attestation 或 tamper remediation；
- `scripts/upload` 的最终启用、Task/Trigger activation、SSH host-key 审核；
- 数据产生后的自动 reconciliation 或 Legacy restart；
- 固定物理 Edge/NAS 的断电、FTL 写放大和加密卷销毁证明。
