# ADR-0091：不可变 TaskSpec 语义注册表与 Command v1

- 状态：Accepted（runtime contract、本机写入门禁、纯 command compiler 与物理规模路径已实现；原子发布、非 command kind 与管理入口待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-01、D-03、D-04、D-05、D-06、D-17、D-70、D-72、D-88、D-90
- 关联 ADR：ADR-0022、ADR-0023、ADR-0024、ADR-0071、ADR-0073、ADR-0088、ADR-0089、ADR-0090

## 上下文

ADR-0089 冻结了 TaskDefinition 的版本化 envelope、摘要与 Repository，但 `{schema,config}` 的通用 JSON 约束只能限制资源占用，不能证明字段含义、安全边界或可执行性。若 SQLite adapter、Executor、插件和 API 各自解释同一 schema，未知版本可能被猜测执行，SecretRef 可能跨 Project，更新后的插件也可能静默改变历史 revision 的含义。

QingLong 同时面向小型路由设备和集群节点。语义扩展不能依赖目录扫描、常驻 watcher、每任务 sidecar 或无界 validator 集合；但又必须允许受信部署组合显式提供额外 schema，而不是把所有脚本、工作流、Agent 和工具语义硬编码进 Runtime Kernel。

## 决策

### 1. Registry 是启动时冻结的组合依赖

`TaskSpecSemanticRegistry` 接受 1 至 32 个 exact descriptor；每个 descriptor 只包含版本化 schema、唯一 TaskDefinition kind 和纯 `normalizeConfig`。构造时拒绝重复、通配或畸形 schema，生成排序后的只读 metadata，并通过 ECMAScript private field 隐藏内部 Map。对象没有 `register()`、自动发现、卸载或热更新能力。

内建工厂当前只注册 `qinglong/command@v1`；extension factory 在保留内建 descriptor 的基础上追加 provider，并拒绝第三方占用保留的 `qinglong/*` namespace。额外 provider 只能由受信 composition root 显式组装并一次性注入 adapter；插件目录、环境变量、Task payload 或数据库记录都不能自行获得注册 authority。validator 的任意内部异常统一映射为低敏 semantic-invalid，不向调用方暴露 provider 细节。

### 2. `qinglong/command@v1` 是首个可写语义

该 schema 只能用于 `kind=command`，config 只能包含必需的 `command` 与可选的 `environment`、`timeoutMs`、`workingDirectory`：

- argv 模式固定为 `{kind:"argv",file,args}`；`file` 必须是有界绝对路径，参数最多 256 个且总命令预算 64 KiB，空参数保留；
- shell 模式固定为 `{kind:"shell",command,shell?}`；shell 缺省规范化为 `/bin/sh`，当前只允许 `/bin/sh` 与 `/bin/bash`；
- environment 最多 256 项、总预算 64 KiB，名称唯一并拒绝保留前缀 `QL3_`；public 值允许空字符串，secret 只保存 canonical Local SecretRef 且必须属于同一 Project；
- working directory 必须是有界绝对路径；timeout 必须为 1 ms 至 365 天的安全整数；
- environment 按名称排序，缺省规范化为空数组，最终 spec 再经过 canonical JSON envelope 校验并冻结。

`script`、`workflow`、`agent` 和 `tool` 当前没有内建语义，写入必须返回 `TASK_SPEC_UNSUPPORTED`。不得为了兼容旧 Crontab 而把任意 shell 字符串伪装成已受审 schema。

### 3. 写入、历史读取和执行物化是三个边界

本机 `LocalSqliteTaskDefinitionRepository.appendTaskDefinitionRevision()` 在进入 SQLite queue/transaction 前先执行 envelope 与 registry 语义规范化；未知 schema、kind 漂移、跨 Project SecretRef 或不安全命令不会产生 head/revision 行。默认 runtime 使用内建 registry，部署组合可以通过第二个显式 dependencies 参数注入冻结 registry。

历史/current read 仍只验证 durable envelope 和 content digest，不要求当前进程仍安装原 provider。这样插件移除后，历史 revision 仍可查看、审计和迁移；读取成功不表示当前可执行。

ADR-0092 已实现 TaskDefinition 到 immutable execution plan 的纯 compiler：它对 pinned Project/task/revision 使用同一受信 registry 再次规范化，要求 durable spec 已是 semantic canonical，并把 source revision/content digest 绑定到 `qltd:v1` reference。本机映射可生成 context recipe 与 local execution revision 纯值，但跨 Repository 原子发布尚未实现；Executor 仍不得直接解释 TaskDefinition spec，也不得因记录曾成功写入就跳过当前 provider/版本检查。

### 4. 资源与证据边界

registry 不创建连接、timer、watcher、线程或进程；查找为单个有界 Map lookup，validator 输入仍受 TaskDefinition 64 KiB/深度/节点/entry 上限约束。物理 Edge 100/1000/10000 规模记录器已改为通过默认 Repository 写入 `qinglong/command@v1`，因此报告可声明测量内建 command semantic validation，但仍不证明其他 kind、execution compilation、scheduler 吞吐或 Crontab adoption。

## 被否决的替代方案

1. **Executor 按 schema 字符串动态猜测配置**：会绕过单一语义 authority，使保存、预览和执行产生漂移，拒绝。
2. **运行期全局 mutable registry**：插件加载顺序、热卸载和并发写入会改变同一 revision 的裁决，且增加常驻状态，拒绝。
3. **扫描 `node_modules` 或插件目录自动注册**：不可审计，也让 edge 为未启用扩展支付启动 I/O 与内存成本，拒绝。
4. **历史读取强制 provider 存在**：插件移除会使既有事实失读并阻断审计/迁移，拒绝。
5. **一次写入验证后由 Executor 永久信任原始 spec**：不能约束部署变更，也没有冻结执行输入，拒绝。
6. **立即为五种 kind 定义宽泛 v1**：没有真实 compiler、权限与 adoption 映射时会过早固化错误语义，拒绝。

## 影响

- 本机默认只能新建/更新 `qinglong/command@v1` TaskDefinition；ADR-0089 测试里的结构性 `script@v1` envelope 仍可用于纯领域边界测试，但不能通过生产 Repository 写入。
- provider 扩展是部署组合能力，不是面向任务作者的自注册插件 API；插件安装、签名、兼容矩阵和进程隔离仍需后续 Extension Host ADR。
- PostgreSQL TaskDefinition adapter 以后必须复用同一 runtime registry contract，不能在 cluster-control 复制另一套 schema 解释器。
- 管理 CLI/HTTP/UI 仍未开放。其 dry-run、写入、审计和 Approval 必须共享同一 registry 结果。

## 验收证据

1. runtime-core test 覆盖 registry 冻结、descriptor 上限/重复、未知 schema、kind drift、低敏 validator failure，以及 command/shell/environment/SecretRef/路径/timeout 的 canonical 与失败关闭边界。
2. local-sqlite test 证明未知 schema 在数据库 mutation 前拒绝、默认 command 可版本化、自定义 registry 只能经显式 composition 注入且保存规范化结果。
3. 物理规模报告与基础 evidence importer 使用 exact measure/exclusion 列表，声明 `built_in_command_v1_semantic_validation`，并保留非 command 语义与 execution compilation 排除项。
4. runtime-core 与 local-sqlite package test、物理 evidence contract test、全量 package/backend/audit/artifact gate 必须通过；本 ADR 切片的六种生产制品最大为 1,682,183 bytes、265 files、61 loaded modules 与 11,747,328 bytes RSS delta，后续当前值由 ADR-0092/RFC 快照记录。

## 后续约束

下一结构切片应先补齐 local execution revision 的独立 digest/迁移和 TaskDefinition/context recipe/execution revision 的原子发布边界，再让 scheduler/adoption 事务只引用编译成功的 pinned revision；随后定义 Legacy Crontab 到 `command@v1` 的无损/有损字段矩阵与 dry-run plan digest。`script/workflow/agent/tool` 必须各自通过独立语义和权限评审后再加入内建或受信 provider，不能以一个万能 config 抢跑。

## 后续更新（2026-08-01）

ADR-0256 已让 `ql3-task` 通过同一 immutable registry 创建和更新 production `command@v1`，并把
allowed audit、Policy fence、Task revision 与 execution publication 收进单 SQLite 事务。该入口不扩大
registry：`script/workflow/agent/tool` 仍然失败关闭，Cluster HTTP/UI 管理入口也仍未开放。
