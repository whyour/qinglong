# ADR-0217：QingLong 3.0 workspace package 边界收敛

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-01、D-02、D-06、D-08、D-09、D-175、D-207
- 关联 ADR：ADR-0002、ADR-0175、ADR-0216

> 后续 ADR-0243 执行 beta 删除门：`local-cutover` 因持续没有 production consumer、
> binary 或 Profile artifact 已被删除，workspace 从本 ADR 的 20 个进一步收敛为 19 个。

## 背景

QingLong 3.0 当前有 22 个 workspace package。包数量本身不是问题，但 package 是有
成本的：每个 importer 都会扩大 lockfile、构建拓扑、制品 inventory、依赖审计、
发布版本和维护认知面。反过来，按源文件数量机械合并也会破坏安全域、可选重依赖和
低配设备的最小闭包。

当前定量审计显示：

| package | TS 文件 | 约 LOC | 直接生产依赖 | 主要消费者 |
| --- | ---: | ---: | ---: | --- |
| `local-identity` | 1 | 327 | 1 | `local-owner-console` |
| `local-secret-admin` | 1 | 489 | 2 | `local-owner-cli` |
| `local-adopted-profile` | 3 | 314 | 2 | `local-application` |
| `local-command-file` | 1 | 161 | 0 | CLI、maintenance、application |
| `local-owner-maintenance` | 4 | 982 | 5 | 独立 `ql3-owner-gc` |
| `local-process` | 8 | 1724 | 1 | local execution、worker runtime |
| `local-cutover` | 5 | 1479 | 0 | 离线 cutover 工具链 |

## 决策

### 1. package 必须证明至少一项独立价值

新建或保留 workspace package 至少满足一项：

1. 独立部署、发布或 binary；
2. 可选第三方重依赖隔离；
3. 独立进程、权限或故障域；
4. Edge/Standalone/Cluster 的可替换实现边界；
5. 被至少两个上层闭包复用，并且独立后能维持更轻依赖闭包。

“概念不同”“未来可能复用”或“当前只有一个文件”都不能单独决定拆分或合并。
同一 package 内优先使用受审 subpath exports 表达能力边界。

### 2. 两个单消费者薄包并入其生命周期 owner

3.0 alpha 在一个原子重构切片中完成：

- `local-identity` → `local-owner-console/identity-authentication`；
- `local-secret-admin` → `local-admin/secret-administration`。

完成后 workspace 从 22 收敛到 20。旧 alpha package 不保留永久 facade；所有 caller、
package manifest、lockfile、依赖审计、image inventory 和测试必须在同一切片切换。

### 3. 文件少但有边界价值的包继续保留

- `local-command-file`：零依赖、被三个上层闭包复用；合入 owner-console 或 SQLite
  会让 application/maintenance 额外携带认证或存储闭包；
- `local-adopted-profile`：制品审计支持 `adopted=true/application=false` 的独立
  迁移/接管交付；合入 application 会强迫该场景安装完整应用闭包；
- `local-owner-maintenance`：独立短生命周期、高权限、低常驻面的 maintenance binary；
- `local-process`：本机 executor 与 remote Worker 的共享进程隔离层；
- `local-cutover`：零依赖、离线、可恢复的 cutover 故障域，不进入稳态 runtime；
- `local-profile`：Edge/Standalone storage Profile 替换边界；
- Cluster 的 postgres/control/admin：分别隔离数据库 authority、control process 与
  Kubernetes 管理权限，也隔离 `pg`、S3 SDK、Kubernetes client 重依赖。

### 4. 重构验证门

物理合并前必须对被移动符号执行 GitNexus `impact`、`query`、`context`；顺序固定为
interface → implementation → callers → tests。合并后必须验证：

- workspace importer 正好 20；
- 旧 package import 为 0，旧目录为 0；
- package closure、exact-file 依赖审计与 lockfile 一致；
- Local image/OCI inventory 和启动入口不包含旧包；
- Edge artifact/RSS 不回退，禁用能力保持零常驻成本；
- SQLite v38、Owner CLI、application adoption、maintenance、worker 回归；
- PostgreSQL HA Docker gate 不因 workspace 拓扑变化回退；
- GitNexus `detect_changes` 只覆盖预期流程；未跟踪文件限制必须显式报告。

## 不采用方案

### 把所有小包合进 runtime-core 或 local-sqlite

拒绝。会形成 god package，并把 filesystem、credential、migration 与管理 authority
带入不需要它们的 Worker/Edge 闭包。

### 按固定 LOC/文件数阈值自动合并

拒绝。一个 161 行零依赖安全文件可以是有效共享 leaf；一个大文件也可能包含多个必须
隔离的权限域。

### 永久保留旧 package facade

拒绝。3.0 仍为 alpha，facade 会保留 importer、publish、审计和供应链成本，抵消合并
收益。必要时只允许一个发布周期的外部迁移说明，不在 workspace 内维持双包。

## 影响

- workspace importer 减少 2 个，约 9.1%；
- 不减少运行时安全 subpath，不改变 public product command；
- 低配设备不会因为合并而引入新的第三方依赖或常驻进程；
- 合并会触及 dependency audit、lockfile、image inventory 和多组测试，必须作为独立
  重构切片完成，不能夹带在 D-206 数据契约变更中。

## 当前状态

边界审计与物理合并已完成：

- workspace importer 为 20，两个旧目录与运行时 import 均为 0；
- identity authentication 9/9；
- secret administration 与 Owner CLI 11/11；
- adopted-profile 独立制品回归 7/7；
- exact-file dependency boundary 34/34；
- `local-owner-console`、`local-admin`、`local-application`、`local-owner-cli` 与
  `local-adopted-profile` build 均通过。

常规 workspace closure 仍受锁定的 `drizzle-orm` 与 Kubernetes client 未物化阻断；
这不是 package 拓扑回归。PostgreSQL HA Docker 门已通过复用本机受审 Cluster Admin
镜像中的锁定依赖离线重跑：PostgreSQL 18.4 arm64、physical streaming、
`remote_apply`、timeline 1→2、旧主 fencing/`pg_rewind`、双 fresh control 与总
`gates.passed=true`，没有 registry 下载。当前仍是 20 个 importer，唯一一文件包
`local-command-file` 保持零生产依赖并被三个上层闭包复用。
