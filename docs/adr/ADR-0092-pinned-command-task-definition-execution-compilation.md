# ADR-0092：Pinned Command TaskDefinition 执行编译

- 状态：Accepted（纯编译契约与本机 plan 映射已实现；原子发布、Run/Trigger/Adoption 接入和 execution revision digest 升级待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-03、D-04、D-08、D-17、D-70、D-79、D-88、D-90、D-91
- 关联 ADR：ADR-0022、ADR-0023、ADR-0024、ADR-0071、ADR-0089、ADR-0091

## 上下文

ADR-0091 使 `qinglong/command@v1` 可以在 TaskDefinition append 前经过唯一语义 authority，但“可保存”仍不等于“可执行”。现有 local dispatch 表消费 opaque string `taskRevision`、command 与 content-addressed context recipe，过去由测试或旧桥接直接构造；如果 Scheduler、Crontab adoption、HTTP 和插件分别把 TaskDefinition 转成这些记录，会再次产生字段漂移、禁用任务误执行和 Secret 明文落入静态 revision 的风险。

同一个 TaskDefinition command 还需要同时服务 edge/standalone 的 `local_process` 与未来 cluster Worker。编译核心不能直接打开 SQLite、分配 Artifact、解析 Secret 明文或调用 Executor，也不能把本机 adapter 的持久化步骤伪装成跨 Profile 的通用事务。

## 决策

### 1. 编译以完整 immutable TaskDefinition revision 为唯一输入

`compileCommandTaskDefinition()` 接受经 content digest 验证的完整 `TaskDefinitionRecord` 与调用方显式提供的同一个冻结 semantic registry。它固定执行：

1. 重算 TaskDefinition envelope/content digest；
2. 只接受 enabled、`kind=command`、`qinglong/command@v1`；
3. 通过 registry 再次做 semantic normalize；
4. 要求 normalize 后 JSON 与 durable spec 完全相同；若 provider 在未升级 schema 版本的情况下改变规范化结果，则以 drift 失败，而不是静默重新解释；
5. 产出冻结的 Profile-neutral `CommandTaskExecutionPlan`。

编译结果只含 Project/Task/source revision identity、command、SecretRef/public environment、working directory、timeout 和源更新时间；不含 Task 名称/标签、Secret 明文、Run/Attempt、Artifact、callback、Worker lease 或进程 handle。disabled、未知 kind/schema、损坏记录和非 canonical 旧记录均使用低敏稳定错误拒绝。

### 2. Pinned revision reference 同时绑定序号与摘要

下游 `taskRevision` 使用 canonical `qltd:v1:<revision>:<contentDigest>`。revision 限制为 1–2147483647，digest 为 64 位小写 SHA-256；parser 拒绝前导零、越界、大小写漂移与未知前缀。

该 reference 让 Run/Attempt 与 execution revision 同时指向用户可见 revision 序号和完整 TaskDefinition 语义摘要。即使同一 Task 的非执行字段变化也会创建新 reference，以保证历史 Run 能回到精确源 revision；不得用 latest、名称、当前 head 或单独的 command hash 替代。

### 3. 本机映射只创建纯值，不产生副作用

`compileLocalCommandTaskDefinition()` 在 Profile-neutral plan 之上确定性创建：

- content-addressed `LocalExecutionContextRecipe`，仅包含 public value 与 Project-bound SecretRef；
- `local_process` immutable execution revision，引用 recipe 并携带 command/working directory/timeout。

两者 `createdAtMs` 使用 source revision 的 `updatedAtMs`，相同输入重复编译字节一致，不读取当前时钟。argv 必须保留合法空参数；这与 POSIX argv 语义一致，且 local dispatch validator 已同步接受空字符串但仍拒绝 NUL、单项/总字节越界。

编译函数不写数据库、不读取 Secret、不创建 Artifact、不启动进程，也不决定 Run。semantic/compiler 只通过显式 package subpath 发布，不进入 runtime-core root barrel，未使用该能力的常驻 Profile 不应 eager-load 它们。

### 4. 持久化与 adoption 仍是独立 Gate

当前 `LocalDispatchDefinitionWriter` 分两步 append recipe 与 execution revision，尚不能和 TaskDefinition append、Trigger/Run 创建组成一个原子事务；因此本 ADR 不把 compiler 接入管理入口或 Scheduler。

同时复核发现既有 `QingLong3LocalTaskExecutionRevisions` 只依赖字段规范化和 immutable key，尚没有 ADR-0023 所描述的独立 execution-template content digest。TaskDefinition reference 可追溯源摘要，但 adapter 当前不能在只读 execution row 上独立重算并核对完整 template。正式 adoption 前必须新增可迁移、可回填的 digest contract，或提供读取时绑定 TaskDefinition source 的等价证明；不能用“表是 append-only”替代损坏检测。

## 被否决的替代方案

1. **TaskDefinition append 时直接调用 Executor**：混淆管理事实与执行副作用，拒绝。
2. **Scheduler 直接读取 current TaskDefinition 并解释 config**：绕过 pinned revision/compiler，拒绝。
3. **编译时自动填充当前时间或 Secret 明文**：破坏确定性、重放和静态保密边界，拒绝。
4. **只把 revision 数字作为 opaque identity**：无法绑定源内容，也难以诊断错误映射，拒绝。
5. **provider normalize 后自动改写旧 durable spec**：同一 schema 版本含义会随部署漂移，拒绝。
6. **立即把两次 append 当作 adoption 事务**：可能留下无法运行的新 Task revision 或没有来源的 execution revision，拒绝。

## 影响

- edge/standalone 已有确定性的 command→local plan 核心，后续无需在 SQLite adapter、Scheduler 或 CLI 复制映射。
- cluster 可以复用 Profile-neutral plan，再由受审 Worker compiler 映射 transport/offer；不能依赖本机 context table。
- 结构合法但早于 ADR-0091、缺少 canonical defaults 的 command revision 会拒绝编译，必须经显式 migration/new revision 规范化。
- 编译器自身不改变数据库 capability、migration 数或常驻 lifecycle。

## 验收证据

1. runtime-core test 覆盖 digest-bound revision ref 的 canonical/越界、完整 record 重验、disabled/unsupported/provider drift/旧结构记录失败关闭。
2. 同一 canonical command 重复编译产生完全相同的 Profile-neutral plan、context recipe 和 local execution revision。
3. argv 空参数、排序 environment、同 Project SecretRef、working directory、timeout 与 contextRef 绑定通过既有 local dispatch validator。
4. package boundary 与 artifact audit 证明 subpath-only compiler 没有继续扩大未使用 Profile 的 loaded-module 闭包；六种生产制品当前最大为 1,691,009 bytes、267 files、61 loaded modules 与 11,780,096 bytes RSS delta，低于 4 MiB/512 files/16 MiB 门禁。

## 后续约束

下一切片先修复 local execution revision 的独立 digest/迁移与跨 Repository 原子发布边界，再定义 Legacy Crontab→`command@v1` 的字段分类：无损映射、需显式 shell compatibility、不可迁移/需人工处理。Adoption 必须先生成只读 plan digest 和逐任务诊断，再在 TaskDefinition、execution revision、Trigger/Run 引用可共同裁决后开放 mutation；不得直接批量写入当前 head。
