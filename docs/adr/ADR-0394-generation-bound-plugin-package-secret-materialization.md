# ADR-0394：按 Generation 固定的 Plugin Package Secret Materialization

- 状态：Accepted
- 日期：2026-08-13
- 关联 RFC：QL-RFC-0001 D-306A
- 关联 ADR：ADR-0151、ADR-0153、ADR-0393

## 问题

D-305 已把 Package 的逻辑 Secret requirement 固定为不可变、按 generation 绑定的版本化 `qlsecret://` 引用，但 Task source 仍不能消费该绑定。若在 dispatch 时才按 requirement 名称查找，会使 materialized revision 与实际 Secret 版本脱节；若允许 Package source 直接携带部署方 SecretRef，又会绕过安装方授权。

Local/Edge 还要求只读 readiness 不加载 migration 执行模块，且不能因 Secret-aware Package 引入 watcher、缓存、连接或常驻进程。Cluster 必须在直接数据库写入时也拒绝未绑定或越权的 SecretRef。

## 决策

1. Package Task source 以 `{kind:"package-secret", requirement:"NAME"}` 引用 Manifest 的逻辑 requirement，不允许直接写 `kind:"secret"` 或 `qlsecret://`。
2. materialization 读取当前 generation 的 D-305 binding，把逻辑 requirement 编译为已有、固定版本的 Task `SecretRef`；optional 且显式绑定为 `null` 的环境项被省略。普通 Task dispatch、Local 短时解密和 Cluster offer/lease-fenced delivery 继续复用现有执行链，不增加新的 Secret 传输协议。
3. materialized revision 嵌入完整 binding 快照但不含明文，binding 与最终资源共同进入 revision digest。任何 Task SecretRef 必须属于该快照；Manifest 声明 Secret 时缺失 binding 或 `secret.use` capability 均失败关闭。
4. SQLite 与 PostgreSQL 在 materialized revision INSERT 边界增加触发器，拒绝畸形 Secret 声明、未解析 placeholder、缺失/不匹配 binding 和 binding 外 SecretRef，防止绕过 core repository 直接写库。
5. SQLite 的触发器 SQL 真源位于非执行型 schema contract；migration 与 readiness 共同引用，保持只读 readiness 和 rollout-safety 不加载 DDL 模块。Local contract 升至 v47，Cluster 升至 v59。
6. 实现复用既有 SQLite authority、PostgreSQL pool、Task Secret resolution 与 Worker delivery，不增加 package、表、索引、连接、timer、watcher、cache、Pod 或 daemon。Local 仅增加一个 INSERT trigger，Cluster 增加一个 trigger function 与一个 INSERT trigger。

## 生命周期与阶段边界

- binding 与 materialized revision 均按 generation 不可变；Secret 新版本不会静默改变既有 generation。
- Package disable/quarantine/uninstall 继续由现有 generation/lifecycle start guard 阻止新执行；已开始执行仍遵循既有 Run/Worker 清理语义。
- D-306A 完成 runtime consumption 和数据库防绕过，不宣称产品授权闭环完成。面向用户的 Local bind/rebind 命令、Cluster Approved Action/API，以及通过新 generation 执行 rotation/rebinding/revocation 的编排属于 D-306B。

## 资源与部署影响

| Profile | 增量 | 常驻开销 |
| --- | --- | --- |
| Edge / Standalone | 一个 INSERT trigger；启动发布按需点查一个既有 binding row | 无新增进程、连接、缓存、timer 或 watcher |
| Cluster | 一个非 `SECURITY DEFINER` trigger function 和一个 INSERT trigger；复用 executor pool | 无新增角色、连接、workload、sidecar 或 worker |

## 验证

- core：placeholder 编译、optional-null、省略、直接 SecretRef/缺失 binding/越权引用拒绝、revision digest 与 normalize round-trip。
- SQLite：真实 migration、畸形声明与未绑定 SecretRef 直接 INSERT 拒绝、readiness DDL lazy boundary、rollout safety、edge/standalone contract。
- PostgreSQL：migration checksum、trigger/function、固定 search path、权限撤回、schema/readiness 与 physical-streaming HA gate。
- 完整 18-package clean build/test 退出 0；backend 共 1,190 项，1,188 pass、2 条件 skip、0 fail。
- package boundary、cluster dependency、edge import、service-manager bridge import、local image 五项审计零 finding；workspace 保持 18 package、1,090 source、1,072 nested source，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。两个经审查的 `ordered_ledger` 目录精确为 PostgreSQL 61 与 SQLite 95 个 migration source，通用密集目录门禁未放宽。
- PostgreSQL 18.4 arm64 HA Docker gate 共 125 项全绿，timeline `1→2`；私有报告 SHA-256 为 `f9107e8e54892a788779758f0573ac8d6a80f6d086516a1f5f5bbacb59bbb4be`。
