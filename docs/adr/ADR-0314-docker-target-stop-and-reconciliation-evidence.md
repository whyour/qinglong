# ADR-0314：Docker Target Stop 与写后 Reconciliation 证据

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-17、D-63、D-64、D-65、D-259
- 关联 ADR：ADR-0064、ADR-0065、ADR-0309、ADR-0310、ADR-0313

## 背景

ADR-0310/0313 已实现 target start/restart、`manual_required` 和新 ceremony 授权，但没有受审
target stop。更重要的是，现有 start evidence 只证明 config、legacy commitment、activation 和
legacy source 的 bind mapping，没有证明真正可写的 3.0 target SQLite、recovery 和 adoption
manifest 映射。若不先关闭这个身份缺口，停止后比较 target 内容没有可信数据对象。

ADR-0064 已明确：只有 target 仍等于 activation 的初始 SHA-256，且 source 仍等于 recovery
快照时，才可能进入未写回退；target 一旦写入，系统不得自动重启 2.x 或声称无损 rollback。

编辑前 GitNexus 显示 target normalizer/Application binding 各为 LOW、1 个直接运行入口；target
container evidence 为 LOW、2 个直接调用、0 process；instance head advance/manual evidence 与 CLI
入口也都是 LOW。没有 HIGH/CRITICAL 风险。

## 决策

### 1. Start/restart 先绑定完整 adopted 数据面

target start/restart command 增加三个宿主机 authority path：

```text
targetDatabasePath
recoveryPath
manifestPath
```

它们与 legacy source、activation、Application config 必须互不相同且都是 supervisor-safe canonical
absolute path。Application v3 config 必须提供对应的 container-side `storage.targetPath`、
`storage.recoveryPath` 和 `storage.manifestPath`。Docker inspect 必须证明每项均存在唯一 read-write
bind mapping；这些 mount 与 config/commitment/source/activation 一起进入
`targetApplicationBindingDigest`。缺失或漂移在 start barrier 前失败关闭。

此处选择 read-write 是当前 adopted Application 的实际 authority：target SQLite 必须写，activation
acquisition 会读取 recovery/manifest。未来若 runtime 将后二者收窄为 read-only 独立 mount，需要新
contract version，不得静默放宽或改变 v1 digest。

### 2. Target stop 是显式一次性 deployment 命令

新增：

```text
ql3-local-deploy cutover-target-stop
```

命令只接受当前实例 lineage head 的 exact active generation。它先重读并验证该 generation 的
start/restart request 与 `target_active`，再 inspect 当前 target，要求 container identity、Application
binding 和 active journal 完全一致。随后固定追加：

```text
4g+1 target_stop_requested | manual_required
4g+2 target_stopped        | manual_required
```

这两个 sequence 与下一代 restart recheck 使用同一位置，因此 stop 和 restart 不能并发各自成功。
stop barrier 后执行 exact container 的 `update --restart=no`、`stop --time 30` 和 stopped inspect。
stop 是安全收敛副作用，barrier 后崩溃可以幂等重做 stop-and-verify；响应丢失时以 inspect 为准。
无法证明 stopped、identity/binding 不变或 restart=no 时进入 terminal `manual_required`。

成功后实例 CAS head 从 `target_active` 变为 `target_stopped`。原 start/restart command 不得从 stopped
head 恢复，stop 终态原样重放不再打开 Docker socket。

### 3. Stopped 后生成有界只读数据证据

只有 exact stopped container 已证明后，deployment owner 才以固定 64 KiB buffer 流式读取 target 和
legacy source 主文件；不打开 SQLite connection、不执行 checkpoint/DDL、不创建副本。两文件必须是
当前 UID、private、单 link、canonical regular file。读取固定为
`lstat -> O_NOFOLLOW open -> fstat(before) -> 同一 descriptor hash -> fstat(after)`，前后
device/inode/mode/link/uid/size/mtime/ctime 任一变化都放弃分类。target path digest/device/inode 还必须与
activation 一致。

为了不把未 checkpoint 的事实误判为“未写”，任一 `-wal`、`-shm` 或 `-journal` sidecar 都视为
非空数据风险。journal 只保存布尔比较结果、文件 identity digest 和总 evidence digest，不保存路径、
表内容或原始错误。

### 4. 三类 disposition 不等于 rollback authority

```text
rollback_candidate
  target main SHA-256 == activation.targetSha256
  target sidecars absent
  source main SHA-256 == activation.recoverySha256
  source sidecars absent

reconciliation_required
  target main digest 已变化，或 target 存在 SQLite sidecar

manual_review
  文件/activation/稳定身份无法证明，或 target 未写但 source 不再等于 recovery
```

`rollback_candidate` 只表示“数据证据允许进入后续回退 ceremony”，不是自动重启 legacy 的授权。
本命令永远不启动 2.x、不覆盖 target、不把 target 数据回灌 source。`reconciliation_required` 必须由
后续按数据域导出/冲突清单/明确选择的流程处理；`manual_review` 不允许自动推断。

### 5. 资源与源码边界

实现继续位于现有 `@qinglong/local-owner-cli/deployment/cutover`，新增 stop contract/coordinator 和
数据 evidence 内部模块。没有新增 package、production dependency、数据库连接、timer、watcher、
daemon 或常驻制品模块。每次 stop 最多新增两条小 journal record，单 cutover 仍受 64 文件上限；
文件 hashing 使用固定 buffer，适合低内存路由器，集群节点不加载该本机 authority。

## 被否决方案

1. **只验证 container running/stopped**：不能证明正在停止的是绑定正确 target 数据的实例，拒绝。
2. **只比较 target 主文件而忽略 WAL**：可能把已提交但未 checkpoint 的 3.0 事实误判为未写，拒绝。
3. **stop 成功后直接启动 legacy**：target 可能已有新事实，违反 ADR-0064，拒绝。
4. **把 target 覆盖回 source**：方向错误且会破坏两份恢复资产，拒绝。
5. **为比较数据打开 writable SQLite/checkpoint**：诊断本身会改变证据，拒绝。
6. **新建 workspace package**：没有独立 deployable、依赖闭包或 consumer，拒绝。

## 验收证据

- cutover 专项 16/16，覆盖 start/restart/manual lineage、脱离 target writable mount 的失败关闭，以及正常
  stop、写后 classification、SQLite sidecar、source drift、barrier crash recovery 和 stop unknown terminal。
- `@qinglong/local-owner-cli` 完整回归 126/126；16-package clean build/test 退出 0。
- package boundary schema v5 为 16/16、787 source、25 root、762 nested，
  `singleSourcePackages=[]`、`shallowSourcePackages=[]`、`findings=[]`。新增源码全部位于既有
  `deployment/cutover/`，没有新增 package 或 production dependency。
- Edge import、Cluster dependency、Cluster deployment 均为 `compatible=true`。十档真实
  pack/install/import/RSS audit 全部 compatible：最小 Edge/Standalone 为
  3,623,093/3,623,129 bytes、331 files、49 modules；最大 Edge/Standalone Application AI 为
  6,108,149/6,108,281 bytes、492 files、109 modules；全部 RSS delta 在各自预算内。
- GitNexus 刷新为 43,805 nodes/99,719 edges/1,722 clusters/274 flows。stop coordinator、数据 evidence、
  stop/run normalizer、container evidence 与 instance head advance 均为 LOW，最多 3 个直接调用、14 个
  impacted symbol、0 affected process。`detect_changes` all/compare `develop` 为 12/31 与 14/34，均为
  low/0 process；当前 QL3 孵化树仍未完整进入 Git baseline，因此 change detection 只作补充证据，不替代
  上述完整 package、边界和制品门。
- 本批不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不重复生成 PostgreSQL HA
  物理晋升证据。

## 未完成

- `rollback_candidate` 的双阶段 legacy restart ceremony；
- `reconciliation_required` 的数据域清单、export、冲突裁决和受审回灌；
- Keyv、日志、配置、Secret keyring 等多资产 backup/reconciliation manifest；
- systemd/OpenRC target stop controller；
- adopted Compose live create/config 与真实 Docker crash gate；
- Cluster/Kubernetes 独立 cutover authority。

本 ADR 关闭 Docker target 显式停止、完整 adopted mount identity 和保守写后分类，但不宣称无损自动
rollback 或 QingLong 3.0 整体完成。
