# ADR-0472：Service Manager Legacy Rollback Preparation

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-64、D-274、D-275、D-379
- 关联 ADR：ADR-0314、ADR-0315、ADR-0362、ADR-0363

## 背景

QingLong 3.0 的 Docker adopted cutover 已有 `target_stopped → rollback_prepared → legacy_running` 双阶段回退，
但 systemd/OpenRC 双 authority 路径只做到 `target_stopped`。该记录证明 3.0 service 已停止、shutdown receipt 与
进程身份闭合，却没有重新计算 target/source SQLite 的哈希、稳定 inode 与 `-wal|-shm|-journal` sidecar，也没有一份
可由 root bridge 消费的持久回退授权。

直接复用 Docker rollback coordinator 不成立：Docker controller 与数据文件同属 Owner authority，而 systemd/OpenRC
需要把 Owner 私有状态判定与 root-only init mutation 分开。与此同时，低配路由器不能为回退增加数据库连接、常驻
supervisor、watcher 或第二套 SQLite 语义。

编辑前 GitNexus 对共享 reconciliation reader、service cutover consumer、cutover record parser 与 CLI main 的影响均为
LOW：最多 2 个直接调用者、6 个累计上游符号、0 条已识别 execution flow。

## 决策

### 1. 先关闭 Owner-side prepare，不在本阶段执行 root mutation

在现有 `@qinglong/local-owner-cli` 包内增加：

```text
ql3-local-deploy service-legacy-rollback-prepare --command-file <private.json>
```

命令必须提交 exact `cutoverId/profile/instanceId/generation/activationDigest`、`target_stopped` record digest 与
instance head digest。Owner 重新读取并绑定：

- 当前实例 head 必须仍是相同 generation 的 `target_stopped`；
- stop record 必须来自 action=`stop`，含有效 shutdown receipt 且没有 manual reason；
- 原 stop intent、Application v3 config、activation 与 legacy-silence commitment 的 digest/路径/lineage 必须一致；
- target/source SQLite 必须在同一稳定 fd 快照内完成 SHA-256，inode/path/size/mtime 与 sidecar 状态必须闭合。

只有 `targetMatchesActivation=true`、`sourceMatchesRecovery=true` 且双方 sidecar clear 时，disposition 才是
`rollback_candidate`，命令才 no-replace 发布
`service-manager-gNN-rollback-prepared.json` 并把 instance head CAS 到 `rollback_prepared`。prepare 不执行
start/stop/restart/enable，不修改 SQLite，也不读取 Docker socket。

### 2. 非候选不污染实例终态

target 已产生写入或存在 target sidecar 时返回 `not-prepared/reconciliation_required`；source 与 recovery 不一致或证据
无法稳定读取时返回 `not-prepared/manual_review`。两者都保持原 `target_stopped` head，不写 preparation，不进入
`manual_required`。这是为了保留显式重启 3.0 或进入后续数据 reconciliation ceremony 的能力；回退不可用不等于实例
已不可恢复。

### 3. Docker 与 service-manager 共用同一 reconciliation 实现

将既有 reader 抽成按 `profile/activation/source/target/expectedActivationDigest` 采集的内部共享接口，Docker 原入口继续
委托它，保持现有调用与返回 contract。这样两类部署使用相同哈希、stable-fd、sidecar 和 fail-closed 规则，不复制一套
容易漂移的数据判定。

### 4. 保持 package 粒度

实现继续位于 `local-owner-cli/src/deployment/service-manager`，没有新增 workspace package、production dependency、
binary 制品或常驻组件。模块边界按 Owner prepare 责任划分；只有将来 root bridge 需要独立 OS 分发/签名/依赖闭包时，
才重新评估是否拆包。

## 被否决方案

1. **stop 成功后直接启动 legacy**：没有数据重验证和 durable authorization，拒绝。
2. **非 rollback candidate 直接写 manual_required**：会错误封死 3.0 正向恢复，拒绝。
3. **复制 Docker reconciliation 代码**：两套哈希/sidecar 语义会漂移，拒绝。
4. **让 root bridge 自己读取 Owner SQLite 并决定能否回退**：混淆数据 authority 与 init mutation authority，拒绝。
5. **为 prepare 新建 workspace package**：没有独立交付和依赖边界，不制造微包。

## 验收证据

- 定向 service cutover/rollback preparation `10/10`，覆盖成功、exact replay、target 写后拒绝、Application config 漂移与
  legacy-silence commitment 漂移拒绝。
- Local Owner 完整测试为 `175 total / 170 pass / 5 conditional skip / 0 fail`；18-package clean build/逐包测试单次退出 0；
  backend 全量为 `1,507 total / 1,505 pass / 2 conditional skip / 0 fail`。
- package boundary、Service Bridge import、Edge import、Cluster dependency、Cluster/Worker deployment、Console 与 Console
  distribution 八项审计全部 compatible/passed。workspace 保持 18 packages、`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`；Local Owner 为 `108 source / 107 nested / 1 root binary entry`，没有形成单文件或浅层微包。
- 14 档 Local artifact audit 全部 compatible；基础 Edge/Standalone 为 `2,598,669 / 2,598,747` bytes、316 files、
  57 loaded modules，Adopted 为 `2,817,964 / 2,818,087` bytes、58 loaded modules，Application+AI 为
  `4,501,822 / 4,501,954` bytes，MCP 为 `7,324,601 / 7,324,709` bytes。prepare 没有进入基础路由器闭包。
- Docker live gate 已依次完成 systemd root/non-root 两个 actor 的真实 stop、prepare 与 exact replay，随后在构建 OpenRC actor
  前因 `node:24-alpine` registry mirror EOF/本机 credential helper 挂起而停止；因此本 ADR 不把 systemd/OpenRC 四组合门
  记为完整通过，待镜像基础设施恢复后补跑 OpenRC root/non-root。测试容器和临时镜像均已清理。
- 本阶段不修改 SQL、migration、PostgreSQL repository/role/Pool 或 HA 语义，因此不重新生成 PostgreSQL HA 证据。

## 未完成

- root-only systemd/OpenRC legacy start barrier、响应丢失后的 inspect-only 收敛；
- Owner 对 legacy running、target stopped 与 preparation/data 未漂移的最终消费；
- `legacy_running` 后的 2.x readiness/health proof；
- `reconciliation_required` 的 export、冲突裁决与受审回灌；
- 固定物理 Edge 的完整 prepare/commit/rollback 证据。

本 ADR 只关闭 service-manager 回退的 Owner prepare 阶段，不宣称 systemd/OpenRC legacy rollback controller 或
QingLong 3.0 升级/回退 Gate 已全部完成。
