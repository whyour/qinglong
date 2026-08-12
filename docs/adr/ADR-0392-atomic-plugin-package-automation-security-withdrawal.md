# ADR-0392：Plugin Package Automation 安全隔离原子撤回

- 状态：Accepted
- 日期：2026-08-13
- 关联 RFC：QL-RFC-0001 D-304
- 关联 ADR：ADR-0221、ADR-0222

## 问题

现有 quarantine 会原子撤回 Package-owned Task 与 Tool snapshot，并由 Run、Tool、Workflow start guard 阻止新执行；但 Workflow/Prompt automation publication head 仍可能保持 `active`。这会让产品可见状态、安全状态与恢复扫描语义不一致。

早期 automation publication 的 `lifecycle_event_digest` 又通过外键只允许引用普通 lifecycle event，因此 quarantine event 无法成为合法撤回证据。修改历史 migration 或发布摘要会破坏已部署数据库与 append-only 证据链。

## 决策

1. 新增 append-only automation disposition event 投影，统一登记 `lifecycle|quarantine`，但保留 publication v1 字段名与 digest 计算。
2. SQLite 以追加 migration 重建 publication 外键，运行期先插入 quarantine event，由 trigger 登记 disposition，再以窄接口只允许 `active -> withdrawn`，全部处于同一 `BEGIN IMMEDIATE`。迁移表重建窗口临时关闭 foreign key，提交后恢复并立即执行 readiness、`foreign_key_check` 与 schema lockstep。
3. PostgreSQL 以 `pg-0058` 追加表、触发器、外键与能力位。既有 quarantine `SECURITY DEFINER` function 写入事件时触发 disposition，repository 随后在同一 SERIALIZABLE transaction 内 CAS automation publication；任一失败整体回滚。
4. `absent` 或已 `withdrawn` 的 publication 不制造无意义版本。publication target 与 quarantine install generation 不一致时 fail closed。
5. receipt replay 校验目标 generation 在隔离提交点之后不存在 active automation publication；缺失或被回拨的撤回证据返回 unavailable。
6. 能力位为 `plugin_package_automation_security_withdrawal@1`。实现不得增加 package、常驻进程、定时器、连接或缓存。

## 资源与部署影响

- edge/standalone：新增一个两列小表和两个 INSERT trigger；每次 lifecycle/quarantine 仅追加一行，常驻内存与连接数不变。
- cluster：新增同构表、两个 statement-local trigger 和一个只供 trigger 调用的函数；disposition 投影不向任何运行角色开放读取，无新 Pod、worker 或数据库连接。
- 历史 publication JSON、digest、lifecycle event 与 quarantine receipt 均不改写。

## 验证

- SQLite local package 全量测试、typed schema/readiness、备份恢复及 edge/standalone quarantine crash matrix。
- PostgreSQL package 全量测试、migration checksum、Drizzle/schema/readiness/least-privilege contract。
- PostgreSQL 18 physical-streaming HA Docker gate，验证 quarantine、automation withdrawn、COMMIT-response-loss、promotion 与 rewind 后证据存活。

## 当前证据

- SQLite 全量 228/228；quarantine crash matrix 覆盖 edge/standalone × 6 个 event、automation withdrawal、Task/Tool、receipt 与 COMMIT 前后窗口。
- PostgreSQL package 312 项：311 pass、1 条仅在未提供独立测试数据库 URL 时条件 skip、0 fail；migration checksum、Drizzle/schema/readiness 与最小权限契约全绿。
- Cluster Admin 304 项：302 pass/2 条件 skip；Cluster Control 232 项：230 pass/2 条件 skip；Local Owner CLI 168 项：163 pass/5 条件 skip；完整 18-package build/test 退出 0。
- backend 1,190 项：1,188 pass/2 条件 skip/0 fail；package boundary 保持精确 18 package、无 single-source/shallow package，两个 `ordered_ledger` 目录分别锁定为 PostgreSQL 59 与 SQLite 91 个 migration source；cluster dependency audit 零 finding。
- PostgreSQL 18.4 arm64 physical-streaming HA 125 项 gate 全绿，timeline `1→2`；包含 quarantine COMMIT-response-loss、standby 上 disposition/withdrawn head、promotion 后精确 publication chain 与旧主 rewind/rejoin。私有报告 SHA-256 为 `ab156901b9c96ec5a62259c44d83d24ded011e0616dc827d928f3e13efd11786`，测试容器、网络与卷均已清理。
