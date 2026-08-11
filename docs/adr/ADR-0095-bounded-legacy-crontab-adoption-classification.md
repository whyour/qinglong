# ADR-0095：有界 Legacy Crontab adoption 分类与内容绑定计划

- 状态：Accepted（只读分类、plan/manifest/fence、内部 canonical candidate、receipt/HMAC carrier 与 ADR-0098 原子 publisher 已实现；产品 issuer ceremony 与 Scheduler 接管待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-03、D-04、D-08、D-17、D-23、D-62、D-70、D-88、D-90、D-91、D-92、D-93、D-94
- 关联 ADR：ADR-0087、ADR-0088、ADR-0089、ADR-0091、ADR-0092、ADR-0093、ADR-0094

## 背景

ADR-0094 建立了正式 Trigger revision，但原 adoption plan 只覆盖 SQLite 文件身份与 `sqlite_schema` catalog。只要 `Crontabs` 行内容变化而表结构不变，旧 plan 的摘要就不能证明维护者审阅的是哪一批任务；backup 校验也只比较 catalog，因而不能作为后续 TaskDefinition、execution facts 与 Trigger 写入的输入凭据。

Legacy Crontab 还包含 3.0 不能静默猜测的行为：`task`/`ql` shell wrapper、`task_before/task_after/work_dir/log_name`、隐式主机时区、`@once/@boot`、额外 schedule、system task、labels、Subscription binding 和单实例/多实例策略。路由设备不能为了预检而一次载入全部任务或启动 Scheduler；集群节点又要求同一输入在不同节点产生相同的 canonical 结果。

## 决策

### 1. 分类器是 local-admin 内部能力，不新增 package 或常驻进程

分类器放在既有 `@qinglong/local-admin` 内，并直接声明对 `@qinglong/runtime-core` 的 workspace 依赖。它复用冻结的内建 TaskSpec/TriggerSpec semantic registry，对候选 `qinglong/command@v1` 与 `qinglong/cron@v1` 做 canonical validation；不复制一套更宽松的 3.0 schema authority。

该入口只打开 `query_only`/defensive SQLite connection，不创建 timer、watcher、线程、sidecar、Run、TaskDefinition 或 Trigger，也不调用 Scheduler。classifier 由管理函数按需加载；production activation subpath 既不载入 migration SQL，也不载入 classifier。

### 2. plan v2 必须绑定逐行任务内容与分类结果

`LegacySqliteAdoptionPlan` 升级为 schema v2，新增任务 inventory：canonical timezone、行数、四类计数、inventory digest 与 `mutationReady`。inventory digest 使用域隔离 SHA-256，按稳定行序覆盖每行低敏 source digest、分类、固定 reason codes、enabled、候选 trigger 数量以及 canonical task/trigger spec digest。

source 文件身份在 catalog 与 task scan 前后各读取一次；扫描期间 device/inode/size/mtime 变化即失败关闭。staging 后的 recovery backup、manifest verification 和 activation write fence 都使用同一 timezone 重算 task inventory；只比较表结构不再足够。

Adoption manifest 同步升级为 schema v2 并保存 inventory。旧 schema v1 文档不能被新 authority 当作已经审阅任务内容的凭据。

### 3. 分类和诊断必须有界、稳定且低敏

扫描使用 SQLite statement iterator，最多接受 100,000 行，不把全表放入内存。公开诊断每页最多 128 条并使用 `rowOrdinal` cursor；每页都要求 `expectedPlanDigest`，重新核对完整 inventory 后才返回，防止分页期间把不同 source snapshot 拼成一次审阅。

单任务诊断只返回 legacy ID、稳定 task ID、分类、固定 reason codes、enabled、候选 trigger 数与摘要。不得返回原始 command、hook、路径、label 或环境值，因为旧脚本可能内嵌 credential。超长文本只进入长度与摘要证据，不进入 manifest 或响应。

### 4. 四类结果有固定优先级，不把“不理解”伪装成无损

分类固定为：

1. `lossless`：现有 `task ` 或 `ql ` wrapper、cron 和字段都能按已冻结规则 canonicalize；
2. `requires_shell_compatibility`：需要补 legacy `task` wrapper，或依赖 hook、work directory shell variable、log name；
3. `requires_manual_action`：缺少显式 timezone、使用 `@once/@boot/其他 macro`、system task、legacy labels、Subscription `sub_id` binding，或存在尚未由 Trigger v1 表达的并发策略；
4. `malformed`：ID、command、field、schedule 或 JSON 无法按有界 legacy shape 解释。

优先级为 malformed 高于 manual，高于 shell compatibility，高于 lossless。reason code 顺序由代码常量固定，避免数据库行顺序、对象 key 顺序或本地语言影响摘要。

### 5. 时区、cron 方言和 shell compatibility 必须显式

调用方可提供 `legacyTimezone`，由 ICU canonicalize 后进入 plan。未提供时区的普通 cron 必须标记 `timezone_required`；不得读取当前进程或宿主机默认时区。五/六 field cron 和最多 64 个 `extra_schedules` 可生成多个候选 Trigger；`?`、裸 `/N`、macro 与不受支持的特殊调度不能借由 Trigger v1 的结构正则绕过 adoption 语义门禁。

Legacy shell candidate 固定 `/bin/bash`，并按既有执行语义生成 `real_time/no_tee/ID` 以及受支持 hook/log/work-dir assignment 后再计算 spec digest。该摘要只证明候选 canonical 内容，不授予 shell 执行权限；`requires_shell_compatibility` 和所有 manual/malformed 项仍必须在未来的裁决凭据中逐项处理。

`name` 映射 Task name，缺失或空值使用稳定的 `Legacy Crontab <id>`；控制字符或超限为 malformed。`isPinned=1` 映射保留 label `qinglong.io/legacy-pinned=true`；`saved` 仅表示 2.x crontab 同步状态，不迁移。`sub_id` 绑定 Subscription，在等价模型完成前必须人工处理。包含 command 的 canonical candidate 只由 internal iterator 交给 ADR-0098 publisher，不经 package 根入口、diagnostic、receipt、decision file 或 audit 暴露。

### 6. 本 ADR 不执行任何任务 mutation

`mutationReady` 只是“没有未裁决分类”的只读事实，不是写入授权。当前 staging 仍只建立 side-by-side recovery/target snapshot；不得因此写入 TaskDefinition/Trigger head、启动 Run 或接管 2.x Scheduler。

下一阶段必须先定义不可伪造、绑定 plan digest 与逐项决策的 adoption decision receipt，再设计 TaskDefinition、context recipe、execution revision 与 Trigger 同成同败的 publisher。任何 partial commit 都必须整体回滚。

## 被否决的替代方案

1. **继续只把 schema catalog 放入 plan**：任务内容可在相同 schema 下漂移，拒绝。
2. **把所有 Crontab 行和原始 command 写入 manifest**：泄露风险与内存/文件体积无界，拒绝。
3. **预检时直接创建 3.0 head，失败再删除**：破坏只读审阅边界并留下 partial fact，拒绝。
4. **使用宿主机默认时区**：迁移到容器、路由器或集群节点后含义会变化，拒绝。
5. **把所有 cron 方言交给正则或第三方 parser 猜测**：不能证明与 2.x/node-schedule 行为一致，拒绝。
6. **为分类器新增微型 package 或常驻 migration service**：没有独立部署/所有权边界，增加 edge 依赖与启动成本，拒绝。
7. **一次性返回全部诊断**：大数据库会给路由设备制造峰值内存，拒绝。

## 验收证据

1. local-admin 测试覆盖 lossless、shell compatibility、manual、malformed 四类及固定优先级。
2. 测试覆盖显式/canonical timezone、多个 extra schedule、macro、malformed JSON 和 128 条分页门禁。
3. 诊断序列化测试证明原始 command/path 不会出现在响应中。
4. 仅修改 `Crontabs.command` 且 catalog 不变时，inventory 与 plan digest 都变化，旧 plan 在创建任何输出前被拒绝。
5. 既有 side-by-side staging、manifest tamper、recovery verification、activation fence、source/target drift 与 runtime import 测试继续通过；adopted/application 常驻 loaded-module 数保持原 37/64 基线。

## 后续约束

ADR-0096/0097 已实现绑定 schema v2 plan、逐项 source digest 与所选处置的纯 receipt，以及私有、HMAC 认证、no-replace、流式 durable decision carrier。ADR-0098 已让 publisher 只消费完整、未过期、认证有效且与 fenced source 一致的 authorization，并在目标单一 SQLite transaction 内发布 TaskDefinition/context/execution/Trigger/audit/ledger facts。产品 issuer ceremony、Scheduler/Run admission、实机写放大与 PostgreSQL 对等实现仍是后续独立 Gate。
