# ADR-0215：实例 Owner 围栏化、有界的 Local Security Audit 查询

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-198、D-200、D-201、D-203、D-204、D-205
- 关联 ADR：ADR-0049、ADR-0074、ADR-0208、ADR-0211、ADR-0213、ADR-0214

## 背景

QingLong 3.0 的本机管理入口已经为 Secret、Identity、Credential、Project 和
RoleBinding 的允许、拒绝与最终围栏失败写入 durable security audit，但部署者仍没有
受支持的读取入口。直接查询 SQLite 会把内部 schema 变成产品 API，绕过强认证、
authority、字段脱敏和有界资源契约。

审计记录横跨整个实例，可能包含 Project 拓扑、subject、操作结果和认证关联信息。
它不是普通的 Project-scoped 业务数据，任意 secondary Project Owner 不应因为拥有
自己的 `project.manage` 就能枚举其他 Project 的安全事件。

## 决策

### 1. 在既有 package 内增加独立 subpath 和短生命周期 CLI

新增：

- `@qinglong/runtime-core/local-security-audit-query`；
- `@qinglong/local-sqlite/security-audit-query`；
- `@qinglong/local-admin/security-audit-query`；
- `@qinglong/local-owner-cli/security-audit-query-command`；
- 一次命令、一次进程的 `ql3-audit` binary。

这些是已有 package 内的能力边界，不是新的 workspace package。查询不进入常驻
application，不创建 daemon、timer、watcher、listener、连接池、缓存或端口。SQLite
contract 保持 v37，workspace 保持 22 个 package。

### 2. 只有实例 authority Project 的当前强认证 User Owner 可以查询

request 必须携带 `authorityProjectId`。local-admin 固定以 `project.manage` 请求
Owner-only decision；SQLite 在同一个 `BEGIN IMMEDIATE` 内重新验证：

1. authenticated credential、Identity、有效期和 pepper provenance；
2. ADR-0211 instance authority anchor；
3. authority Project 的 active/version；
4. actor 最新 active Owner RoleBinding/version。

secondary Project Owner、admin/operator/viewer、非 User principal 和 foreign
authority Project 全部失败关闭。服务授权后 credential、anchor、Project 或
RoleBinding 漂移时，最终事务拒绝且不得提交 allowed audit。

### 3. 查询形状固定且有界

`security.audit.list` 复用共享 security audit query 的精确语义：

- `limit` 为 1–64；共享 Cluster 上限 200 不改变本机更严格上限；
- filter 只允许可选 `projectId`、精确 `subject`、精确 `outcome`；
- cursor 精确为 `{occurredAtMs,eventId}`；
- 排序固定为 `(occurredAtMs DESC,eventId DESC)`；
- SQLite 读取 `limit + 1`，只有实际存在额外记录才返回 `nextCursor`。

禁止 offset、任意排序、模糊搜索、调用方 SQL、无界数组或历史全量 export。每一页是
一次独立授权、独立审计的 SQLite snapshot，不承诺跨 command 的同一时点视图。

### 4. 查询与自己的 allowed audit 原子提交

SQLite 先在事务内完成 authority 复验和查询，再写本次 `security.audit.list` allowed
audit，最后 commit。因此返回的 snapshot 不包含本次查询事件；查询成功和审计写入
仍保持原子性。

翻页必须使用新的 request ID 和 audit event ID。查询不是 mutation receipt；不得以
重放旧 audit event ID 的方式请求下一页。

### 5. 产品输出必须脱敏

`ql3-audit` 只输出：

- event/request/operation identity；
- nullable Project；
- nullable subject；
- outcome、reasons、nullable policy fence；
- occurred timestamp；
- nullable next cursor。

即使 durable row 中存在，也不得输出 `authenticationId`。同样不得输出 credential、
pepper、Secret、路径、command 内容或数据库内部字段。认证失败和最终围栏失败只写
低敏 failure audit。

## 不采用方案

### 直接开放只读 SQLite 或通用 SQL

拒绝。它无法约束字段、行数、排序、authority 或审计，并把 schema 演进变成外部兼容
承诺。

### 让每个 Project Owner 查询自己 Project 的原始审计

拒绝。当前 security audit 还包含 nullable/global 和实例管理事件，没有独立的
Project 安全视图、行级投影或字段级 redaction contract。需要时应另行设计
Project-local projection，而不是弱化实例审计 authority。

### 一次返回全部记录或实现 export

拒绝。Edge 路由设备的内存、闪存和终端输出必须有硬上限。合规 export、签名、保留期
和销毁证明是后续独立能力，不能伪装成大页查询。

### 新建 audit package 或常驻管理服务

拒绝。该能力与既有 runtime contract、单 SQLite authority、local-admin 和 Owner CLI
共享部署生命周期；新 package/daemon 只会增加低配设备的供应链和空闲成本。

## 影响

正向影响：

- 部署者不再需要直接读取 SQLite 才能诊断拒绝和围栏失败；
- 实例级审计 authority 与 Project-scoped RoleBinding authority 明确分离；
- 64 条硬上限、keyset 和精确 filter 约束内存、CPU 与输出；
- 同事务 final fence 防止 credential/Policy TOCTOU；
- CLI 删除 `authenticationId`，避免认证关联标识进入终端或脚本输出；
- 不新增 migration、package、生产依赖或常驻资源。

代价与限制：

- 每页查询都会短暂取得 SQLite write reservation，以原子写查询审计；
- 当前不提供 operation filter、时间范围、聚合、export、retention、签名或告警；
- 每页是独立 snapshot，翻页期间的新事件可能改变后续结果；
- Cluster 继续使用独立 PostgreSQL management authority 和更高的共享页上限。

## 验证

- GitNexus：共享 `normalizeSecurityAuditQuery` 上游风险 LOW；高风险
  `LocalSqliteRunRepository`（17 个直接、45 个总上游）未修改，D-205 使用独立
  repository/composition；
- D-205 五个新源文件通过隔离 strict TypeScript，启用
  `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`；
- 定向测试 8/8：
  - instance Owner 授权与 filter/cursor 透传；
  - limit 65 在 repository 前拒绝；
  - non-Owner denial audit；
  - service 后 final policy/credential fence conflict 保留；
  - 真实 SQLite `limit + 1`、两页降序 keyset 和末页 null cursor；
  - query snapshot 不包含自己的 allowed audit；
  - foreign instance authority 在读取/allowed audit 前拒绝；
  - CLI 删除 `authenticationId` 并审计 credential fence failure；
- SQLite contract 保持 v37，workspace 保持 22 package；
- 完整 package closure 与 PostgreSQL HA Docker 门仍需在锁定依赖物化后重跑。

## 后续状态

ADR-0216 已在 SQLite v38 完成实例 Owner 围栏化、64/512 条硬上限的诊断审计压缩。
它只回收无已知引用的拒绝/失败事件和精确只读查询事件；完整领域 retention、签名
export、远端归档与合规销毁证明仍未完成。
