# ADR-0482：停止态 Local SQLite Reconciliation Recovery Bundle

- 状态：Proposed（D-389 契约冻结）
- 日期：2026-08-21
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-64、D-87、D-184、D-259、D-383、D-388、D-389
- 关联 ADR：ADR-0064、ADR-0194、ADR-0201、ADR-0314、ADR-0315、ADR-0476、ADR-0480、ADR-0481

## 背景

ADR-0314 已在 target 停止后把数据状态保守分类为
`rollback_candidate|reconciliation_required|manual_review`；ADR-0315 和后续 service-manager ceremony 只允许
`rollback_candidate` 进入 Legacy restart。D-388 又把 committed Legacy data application receipt 接入了 Application、
systemd/OpenRC 与 Compose lineage。但是 target 一旦接受 3.0 写入，产品目前只能返回
`reconciliation_required`，没有一个可重放、可独立验证的命令先冻结 source、target、recovery 和 lineage。

直接实现“把 target 覆盖回 2.x source”不是下一步。3.0 的 Run、TaskDefinition、Trigger、Secret、Plugin Package、AI 与
审计事实没有通用的 2.x 逆映射；即使同名业务对象存在，revision、Project、Policy、credential 和 append-only history 也不能靠
表名相似自动合并。未先保存原始停止态证据就运行领域转换，还会让失败后的 operator 无法回到同一个裁决起点。

该能力必须服务两类本机部署：可能只有很小内存和内部闪存的路由器，也可能是有外接盘的大型单机节点。它不能要求在主数据盘
无条件再复制一份数据库，也不能为了统一 API 把 Local SQLite authority 带入 Cluster。Cluster 继续使用 PostgreSQL backup、PITR、
对象存储和控制面 recovery，不消费本 ADR 的私有 bundle。

## 决策

### 1. 先建立不可变恢复 bundle，再设计数据域 reconciliation

在既有 `ql3-local-deploy` 中增加三个独立、私有 command-file 操作：

```text
local.deployment.reconciliation.capture.prepare
local.deployment.reconciliation.capture.commit
local.deployment.reconciliation.capture.verify
```

本 ADR 的 terminal outcome 是 `reconciliation_captured`，不是 `reconciled`、`rollback_ready` 或 `legacy_ready`。bundle 只冻结
后续人工/工具裁决所需的原始停止态资产；Task、Run、Secret、Plugin Package 等领域 diff、冲突选择、导入和 Legacy readiness 必须由
后续独立 ADR 定义。

### 2. 只有 exact `reconciliation_required` stopped head 可以 prepare

prepare 必须重读当前 instance lineage、target start/restart request、`target_active`、target stop request、`target_stopped`、
reconciliation evidence、Application v4、activation、Legacy silence commitment、D-387 commit/receipt 与 adopted bundle receipt。
所有 digest、generation、Profile、instance/cutover 和 target/source physical identity 必须一致；disposition 必须恰为
`reconciliation_required`。`rollback_candidate` 继续走既有 rollback ceremony，`manual_review` 不能被 capture 自动降级。

调用方提供：

```text
captureRoot       已存在、current-UID、0700、canonical、non-root 的目录
captureId         UUID
expectedHeadDigest
expectedStoppedRecordDigest
preparedAtMs
```

`captureRoot` 可以位于受信外接盘，以免低配设备被迫占用主数据盘；工具不挂载设备、不访问网络、不自动选择 home/tmp，也不接受
环境变量默认值。prepare 只在 `<captureRoot>/<captureId>` 创建私有 intent/staging root，并将 instance head 以 CAS 推进为
`reconciliation_capture_prepared`。该状态禁止 target restart、Legacy rollback 与第二个 capture 越过同一停止态。

永久空间不足或介质故障时，operator 必须修复同一 capture root 后重放，或进入既有人工 resolution；第一版不提供会删除证据、换
destination 或倒退 instance head 的隐式 abort。

### 3. Commit 字节精确捕获固定资产集合

commit 必须携带 prepare 返回的 exact `preparationDigest`，重新证明 instance head、target/Legacy stopped、source/target identity 与
reconciliation evidence 未漂移，然后捕获固定集合：

- target SQLite main，以及存在的 `-wal`、`-shm`、`-journal`；
- Legacy source SQLite main，以及存在的同类 sidecar；
- activation 绑定的 recovery SQLite main；
- 内容无关 lineage projection：activation、commitment、D-387 commit/receipt、Application config、bundle、target-stopped 与 instance
  head 的 digest，不复制包含绝对路径的配置正文；
- 固定 schema 的 manifest 与 terminal receipt。

工具不打开 SQLite connection、不 checkpoint、不执行 WAL recovery、不修改 source/target/recovery。每个输入使用
`lstat → O_NOFOLLOW open → fstat(before) → 64 KiB descriptor copy/hash → fstat(after)`；device、inode、uid、mode、link、size、
mtime、ctime 任一变化都失败关闭。sidecar 集合在枚举前后必须相同，未知 sibling 不扫描也不进入 bundle。

输出目录固定 `0700`、文件固定 `0600`、单链接、no-replace。每个 payload 先写 deterministic stage、`fsync(file)`，再在同一
destination directory 原子发布并 `fsync(directory)`；manifest 最后发布，terminal receipt 再最后发布。manifest 只使用固定逻辑名、
byte count、SHA-256、source identity digest 和 lineage digest，不保存原绝对路径、表名、row count、Secret、用户名或日志内容。

### 4. Bundle 是敏感恢复资产，但不复制密钥 authority

SQLite payload 可能包含 credential digest、加密 Secret envelope、任务参数和业务历史，因此 capture root 必须由 operator 置于符合
其备份策略的私有/加密介质；stdout 只返回 schema、captureId、bundleDigest、Profile、asset count/bytes 和状态。

本命令不复制 Local Secret keyring、Owner pepper、credential、SSH private key 或 recovery assertion。manifest 只绑定当前 keyring/
pepper backup 的内容无关 generation/digest（若既有 evidence 提供），不能把“SQLite bytes 已捕获”冒充“完整 Secret 可恢复”。密钥
custody、介质加密和多资产 disaster-recovery 仍使用各自 ceremony。

### 5. Crash、ENOSPC 与 exact replay

- prepare response loss：以 preparation bytes 和 instance head inspect 收敛，不创建第二个 capture；
- payload stage 写入中 ENOSPC：清理不完整的新 stage；清理失败的 stage 只允许同 bytes 重放，source/target/recovery 不变；
- payload 已发布、manifest 前崩溃：同一 commit 逐项验证并只补 absent asset，不覆盖既有文件；
- manifest 已发布、receipt 前崩溃：只验证 manifest 与资产，再补 terminal receipt；
- receipt 已发布、head 未推进：以 exact receipt CAS 推进为 `reconciliation_captured`；
- commit response loss：重放只验证 bundle/head，绝不重拷已发布资产；
- verify：只读取 terminal bundle 与当前 lineage binding，不创建、清理、修复或访问 Docker/init/socket/network。

任一已存在文件 bytes、mode、owner、link、canonical path 或 digest 漂移均失败关闭。不同 command 不能占用已有 captureId，也不能把
同一 stopped generation 输出到两个未串联的 terminal bundle。

### 6. 捕获不授予 rollback、import 或服务副作用

prepare/commit/verify 均不得：

- 启动或停止 target/Legacy；
- 调用 Docker、systemd、OpenRC 或 Compose；
- 覆盖、删除、rename、checkpoint source/target/recovery；
- 把 target 表写回 Legacy；
- 激活 config、SSH、Task、Trigger、Plugin Package 或 AI；
- 根据 capture 成功自动改变 readiness/health 声明。

后续数据域 plan 必须消费 exact `bundleDigest` 和 `reconciliation_captured` head。任何 import/回灌都要有独立 prepare/commit、冲突清单、
Owner 审批、目标 schema adapter、备份与响应丢失语义，不能借 capture credential 获得写 authority。

### 7. 低资源与 package 边界

实现内聚在现有 `@qinglong/local-owner-cli/src/deployment/reconciliation/`，通用稳定文件复制/hash 原语可进入既有 deployment
foundation；不新增 workspace package、production dependency、binary、daemon、timer、watcher、listener、数据库连接或后台 retry。
新增源码不得平铺回 `src/` 根。

内存成本固定为单个 64 KiB copy buffer、一个不超过 64 KiB 的 manifest builder 和固定资产数组；不按数据库大小保存 chunk/hash
列表，不扫描表或历史。Edge/Standalone 使用同一协议，区别只在既有命令/文件/总字节预算和 operator 选择的 destination；Cluster
package/import/artifact closure 必须保持零 Local reconciliation authority。

## 被拒绝的替代方案

### 自动覆盖 Legacy source

拒绝。3.0 事实没有通用无损 2.x 逆映射，且会销毁唯一旧系统恢复资产。

### 只复制 target 主文件

拒绝。WAL 中可能有已提交但未 checkpoint 的事实；忽略 sidecar 会生成不可恢复或语义倒退的快照。

### 打开 SQLite 并 checkpoint 后备份

拒绝。诊断/捕获会改变要裁决的停止态证据；WAL recovery 需要由后续受审 adapter 在副本上执行。

### 默认写入 deployment root 或 `/tmp`

拒绝。路由器主盘可能没有第二份数据库空间，`/tmp` 可能是小容量 RAM；destination 必须由 operator 明确提供。

### 将 keyring/pepper 与数据库一起复制

拒绝。会把一次 SQLite capture 变成可解密 Secret 的新高价值 authority；密钥 custody 必须保持独立。

### 为 capture 新建 workspace package或常驻备份服务

拒绝。它没有独立部署/消费者或常驻生命周期，新增 importer 和后台资源只会扩大低配与供应链成本。

## 验收条件

1. 只有 exact stopped `reconciliation_required` head 可 prepare；rollback/manual、lineage 或 evidence 漂移均零发布。
2. prepare CAS 建立唯一 capture fence；target restart、Legacy rollback 和并发 capture 不能越过。
3. commit 字节精确捕获固定 main/sidecar/recovery 集合，输入前后 stat 与 sidecar 集合稳定，不打开 SQLite 或服务 socket。
4. bundle/manifest/receipt 私有、no-replace、内容无关；stdout 除 terminal `bundleDigest` 外不泄漏输入路径、单资产摘要、表、
   Secret 或业务标识。
5. stage/link/manifest/receipt/head 各崩溃窗口、ENOSPC、partial write 与 commit response loss 均 exact replay，绝不重复覆盖。
6. verify 完全只读；capture 成功不授予 import、rollback、Legacy start 或 target restart。
7. Edge 64 KiB 固定缓冲与 Standalone 同协议；无新增 package/dependency/常驻对象，边界与十四档 artifact 不退化。
8. 完整 Local Owner、backend、package、架构、distribution 和 release gate 通过；真实 stopped target bundle 在 Linux/Docker
   rehearsal 中可由独立 verify 重建相同 digest。

## 未包含

- Task/Run/Trigger/Secret/Plugin Package/AI 等数据域 diff 与冲突裁决；
- 任何写入 Legacy 或 target 的 import/回灌；
- Legacy application readiness、自动 restart 或 target resume；
- keyring、pepper、SSH private key、日志和外部文件资产的完整 disaster-recovery bundle；
- 压缩、上传、对象存储、网络传输、远端签名或介质加密；
- Cluster/PostgreSQL/Kubernetes reconciliation；
- 固定物理 Edge/NAS 的断电、FTL 写放大与加密卷销毁证明。
