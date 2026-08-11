# ADR-0202：显式、可重放的 Compose 恢复证据收集

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-175、D-190、D-191、D-192
- 关联 ADR：ADR-0185、ADR-0200、ADR-0201

## 背景

ADR-0200/0201 将 rollout backup 与 restore safeguard 作为不可变恢复证据保留，
并分别设置 8/4 份目录上限。该策略避免了自动恢复和无界增长，但如果没有受审的
空间回收入口，低闪存路由器最终只能停止升级或恢复。

直接删除 `.sqlite` 也不安全。旧 `compose-apply` 和
`compose-restore-commit` 的精确回放会重新检查原快照；文件消失后，调用方无法
区分“已经受审收集”与“意外丢失”，甚至可能把响应丢失误判为需要再次启动或恢复。
收集过程还可能在 rename、tombstone、commit receipt 或 unlink 之间崩溃。

## 决策

### 1. 收集是显式、短生命周期的两阶段操作

既有 `ql3-local-deploy` 增加：

- `compose-evidence-collect-prepare`
- `compose-evidence-collect-commit`

命令只接受当前 UID 私有的 exact command file，不接受通配符、目录、任意路径、
自动年龄阈值或调用方提供的 snapshot digest。prepare 显式列出 rollout/restore
UUID，只验证候选、当前 generation、Profile、保留底线和 immutable receipt/snapshot
绑定，并发布 collection lock 与 prepare receipt；它不删除或移动任何大文件。

commit 必须使用同一 collection ID/generation，且时间不早于 prepare。

### 2. Profile 固定保留底线和单次预算

- Edge：每次最多收集 1 个文件；至少保留 2 个 rollout backup、1 个 restore
  safeguard。
- Standalone：每次最多收集 4 个文件；至少保留 4 个 rollout backup、2 个
  restore safeguard。

每一类只能选择按 durable receipt `recordedAtMs + UUID` 排序后的最老前缀，不能
跳过旧证据先删较新的恢复点。某一类没有收集候选时，不要求部署人为制造该类最低
数量。restore safeguard 只有存在 terminal commit receipt 时才是候选。

这些底线不是自动 retention policy。系统没有 timer、watcher 或磁盘水位触发器；
达到 8/4 上限时仍由 operator 明确审查并执行。

### 3. Tombstone 保持旧命令的精确回放语义

每个已收集大文件对应一个小型、append-only、`0600` tombstone，绑定：

- artifact kind 与 UUID；
- collection ID、generation、Profile 和 commit 时间；
- 原 rollout/restore terminal receipt 的 SHA-256；
- SQLite contract、SHA-256、bytes、page count 和 page size。

旧 apply/restore 回放在大文件存在时继续检查物理 snapshot；文件不存在时只接受与
当前不可变 source receipt 和原 snapshot facts 全部匹配的 tombstone。否则失败
关闭。restore 回放明确返回 `source|safeguard=collected`，并保持
`service.state=unchanged`；collection 不获得 Docker authority。

Tombstone 和 prepare/commit receipt 体积有硬上限，但当前版本不自动压缩或删除
tombstone 历史。它解决大 SQLite 文件的闪存占用，不宣称元数据永远有界；后续若
需要压缩，必须有独立的摘要归档协议。

### 4. Commit 使用 rename → tombstone → receipt → unlink

每个 snapshot 在原目录被 rename 到确定性的
`.ql3-collection-stage`，复验完整 SQLite evidence 后发布 tombstone。全部
tombstone durable 后发布 collection commit receipt，最后 unlink stage 并删除
collection lock。

原命令重放必须覆盖：

- final 已 rename、tombstone 尚未发布；
- tombstone 已发布、commit receipt 尚未发布；
- commit receipt 已发布、stage 或 lock 尚未清理；
- response 已丢失但 durable commit 已完成。

收集前后都验证 source receipt digest。final/stage 冲突、receipt/tombstone 漂移、
generation 变化、权限异常或未完成的其他 operation 都失败关闭。

### 5. 与 revision、rollout、restore 双向围栏

collection prepare 在发布自己的 lock 前后检查 revision、rollout 和 restore lock。
revision/apply/restore 在 mutation 前检查 collection lock，并在发布自身 lock 后
再次检查。竞争中只能有一方保留 durable authority；失败方在任何 image、Docker
或 SQLite mutation 前释放自己的新 lock。

### 6. 不新增 package 和常驻成本

实现位于现有 `@qinglong/local-owner-cli/local-deployment` 的 package 内部目录，
复用 `@qinglong/local-sqlite/rollout-safety` 检查 snapshot。没有新增 workspace
package、第三方生产依赖、daemon、端口、listener、timer 或 watcher。该选择也落实
ADR-0185：小能力优先用包内 subpath 表达，只有独立交付/权限/依赖边界才拆 package。

## 验收证据

- `local-owner-cli` 48/48，通过现有部署、rollout、restore 与新增 collection
  回归；
- 专项覆盖 Edge 最老前缀、保留底线、rename 后崩溃恢复、commit 精确重放、
  collection/revision 围栏；
- rollout backup 收集后，旧 apply 只读 tombstone 并且不产生新的 Compose up；
- restore safeguard 收集后，旧 restore commit 返回
  `safeguard=collected, service.state=unchanged`；
- TypeScript build 通过，workspace 仍为 22 个 package且没有新增生产依赖。

真实断电、闪存 wear/写放大和长周期 tombstone 压缩仍是独立门禁。

> 2026-08-01 补充：SQLite write contract 已推进到 v42。Tombstone v1 的 snapshot
> contract 不能固定为创建本 ADR 时的 v40，否则当前证据不可收集；也不能只改成 v42，
> 否则升级前的 v40/v41 证据无法回放。当前 reader 接受受审历史窗 `40..42`，最大值由
> 已经合法持有 `local-sqlite/rollout-safety` authority 的 apply/collection/restore 调用方
> 显式传入；evidence 模块自身不新增 storage import，未来版本仍默认拒绝。v42 部署专项
> 23/23、local image audit 7/7、19-package 全量门和 dependency boundary 均通过。

## 被拒绝的替代方案

- **按 mtime 自动删除**：mtime 不是恢复 authority，且会引入后台资源和竞态。
- **删除 receipt 与 snapshot**：破坏精确回放和审计链。
- **只留下“已删除”布尔值**：不能绑定原文件内容和 source receipt。
- **先 unlink 再写 tombstone**：进程崩溃会把受审收集变成不可区分的数据丢失。
- **另建 backup/GC package 或 daemon**：没有独立交付边界，并增加低配节点安装和
  idle 成本。
