# ADR-0465：版本化 Worker 支持等级准入

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-372、D-14、D-16、D-107
- 关联 ADR：ADR-0006、ADR-0012、ADR-0108、ADR-0464
- Amends：ADR-0012 的 Worker capability 与 Placement 契约

## 上下文

D-371 已把 QingLong 3.0 完整核心的架构支持分为 Tier 1、candidate、experimental blocked 与 legacy-only，
但 Worker Session 快照仍只声明 architecture、executor、runtime 和资源。控制面无法判断节点使用哪个 Worker
协议，也无法区分一个完整支持节点、候选节点与只允许受限兼容的旧设备。默认 Placement 因此只检查
`remote-worker`，不能机器化执行 ADR-0006 要求的 support Tier 与 protocol version 边界。

审计还发现生产 Worker fixture 与两个资源/部署门只声明 `local_process`，而 Cluster execution revision 的默认
Placement 精确要求 `remote-worker`。这种配置可以启动并注册，却永远不能领取任务；同时部分 Worker 使用 Node
的 `x64` 名称，发布身份使用 OCI 的 `amd64`，架构词汇也会漂移。

3.0 尚未正式发布，可以在当前孵化分支升级 Worker Session capability schema；但已经持久化的 immutable
execution revision 摘要不能因默认政策变化而被静默重写。

## 决策

1. 在既有 `@qinglong/runtime-core` 的 `remote-execution` 领域目录内增加
   `remoteWorkerCompatibility.ts`，不新增 workspace package。该文件拥有 Worker protocol、support Tier、发布架构
   词汇与 Node runtime architecture 映射；避免把一个小契约再次拆成单文件微包。
2. Worker capability 现在必须精确包含 `protocolVersion` 与 `supportTier`。当前协议版本为 `1.0.0`，控制面支持
   范围为 `>=1.0.0 <2.0.0`。未知字段、缺失字段、非法 SemVer、未知 Tier 或非 canonical JSON 在 Session register
   进入 Repository 前失败关闭。
3. 架构词汇与 `qinglong/release-identity@v2` 保持同一映射：Tier 1 为 `amd64/arm64`，candidate 为
   `ppc64le/s390x`，experimental 为 `arm/v7`，legacy-only 为 `arm/v6/386`。测试直接读取根 release identity
   比较映射，阻止两份政策静默漂移；capability 声明的 architecture 与 supportTier 不一致时拒绝。
4. Node runtime 名称必须先归一化为发布名称：`x64→amd64`、`ppc64→ppc64le`、`ia32→386`，ARM32 必须有明确
   `arm_version=6|7`，未知或含糊架构拒绝。生产 Worker 配置把 capability architecture 与当前 Node 进程再次
   比较，不能通过文件把一台机器伪报成另一种架构。
5. Placement `required` 新增可选 `supportTiers` 与 `protocolVersionRange`。未声明 `supportTiers` 的普通任务只匹配
   Tier 1；candidate、experimental 或 legacy-only 必须由新的 immutable Task revision 显式选择。无论任务是否
   声明范围，Worker protocol 都必须先满足控制面 v1 全局范围，任务不能放宽控制面兼容政策。
6. Tier 1 与 protocol v1 的默认策略只在 `evaluateRemoteWorkerPlacement` 中执行，不写回
   `effectiveRemoteWorkerPlacement`。因此旧 execution revision 的 canonical content 与 digest 保持不变；只有新任务
   显式声明 support/protocol 要求时才产生新的 revision digest。
7. 生产 Worker capability 必须包含 `remote-worker` executor。仅声明 `local_process` 的配置在启动读取阶段拒绝，
   不再允许“注册成功但永远领不到任务”的假健康状态。资源基准、PostgreSQL live contract 与 Kubernetes rollout
   fixture 一并迁移到同一契约。
8. legacy-only 的显式 Placement 只建立调度准入槽位，不表示 2.x Worker adapter 已实现，也不授予 Plugin Host、
   任意 Tool、控制面数据库、管理 API 或 Secret 明文权力。未来 adapter 必须继续使用现有 mTLS identity、Session、
   Run Lease、bounded Pull 与 Artifact/Completion fence，并提交独立 ADR、EOL 和资源证据。
9. 本变更不新增 dependency、服务、端口、timer、连接池、数据库表或后台扫描。兼容性检查只发生在 Worker 配置
   读取、Session register 和已有 Placement 计算上；禁用 Worker 的 Edge/Standalone 路径仍不读取配置或加载运行时。

## 升级与回滚

- 这是 Worker capability 的有意破坏性升级。滚动升级必须先 drain 旧 Worker，完成所有 control replica 升级，再
  以带 v1/Tier 的新 capability 建立 Session；不能让旧控制面副本与新旧 capability 长期混跑。
- 旧 Session 行不做数据库重写。未替换记录会在 lease 到期后离线；新控制面不会把未版本化快照调度为可用节点。
- 回滚时先 drain v1 Worker，再整体回滚 control replica 和 Worker artifact。不能只回滚一侧并继续领取新任务。
- execution revision 无需 migration；本 ADR 特意不把新默认值物化到历史 Placement，回滚不会改变既有 digest。

## 被拒绝的替代方案

### 根据 architecture 在 UI 临时推断 Tier

拒绝。UI 推断不能约束 Scheduler，也不能证明 Worker 协议与实际 Node runtime；控制面副本仍可能把任务发给不兼容节点。

### 把 Tier 与 protocol 作为普通 label

拒绝。label 可由任务任意匹配、没有固定词汇或 SemVer 语义，也不能表达不可被 Task 放宽的全局协议范围。

### 把新的默认字段写入所有 execution revision

拒绝。这会改变已持久化 revision 的 canonical content 与 digest，违反 append-only immutable execution authority。

### 保留只声明 `local_process` 的 Worker

拒绝。Cluster Planner 要求 `remote-worker`；接受不可能命中的节点只会制造错误健康信号和无界排障成本。

### 立即实现一个完整 2.x legacy Worker

拒绝。身份、最小命令集、Secret、日志、Artifact、EOL 和 ARM32 资源预算需要独立设计与实机证据。本切片先关闭
控制面会默认误调度的协议漏洞，不能用一个适配器名义扩大旧设备权限。

## 验证与证据

- runtime-core 聚焦测试覆盖默认 Tier 1、显式 legacy-only、全局 protocol v1、任务范围、未知/重复 Tier、非法
  SemVer、未版本化快照、architecture/Tier 漂移、release identity 映射和历史 non-canonical snapshot。
- Worker Runtime 聚焦测试覆盖 Node runtime architecture 绑定、`remote-worker` executor 必需条件、禁用路径零读取、
  edge/node 配置和 Session canonical register。
- Cluster ingress 聚焦测试证明未版本化 capability 在 Repository 调用前返回固定 400，Dispatcher 只为匹配 Tier/
  protocol 的 Session claim offer。
- runtime-core 全量 `574/574`、Worker Runtime 全量 `134/134`、完整 backend 工作区
  `1,503 total / 1,501 pass / 2 conditional skip / 0 fail`，18-package clean build 与逐包测试退出 0。backend 总数包含
  一条不会进入本阶段提交的既有用户测试。
- PostgreSQL 18.6 arm64 HA `146/146`、timeline `1→2`，报告 SHA-256 为
  `e94d48f0bbe5d5af6f6fd18f94572ead40d7155c38d194dce958712d968efeed`。真实 Linux Worker + PostgreSQL 门进一步证明
  TLS 1.3 mTLS、证书与 credential rotation、同 Session 保持、remote execution、Artifact completion 与最小数据库权限；
  迁移前角色 fixture 和 cancellation dispatch owner 的既有漂移在本切片一并修复。
- 本机 arm64 Worker 回归基准通过：edge active/max RSS 为 `72,073,216 / 72,466,432` bytes，node 为
  `71,991,296 / 72,417,280` bytes；它们是本地回归基线，不是 ARM32 路由器实机支持证明。
- release version、package boundary、cluster dependency、Edge import、cluster deployment、Worker deployment 与 image release
  七项审计全部 compatible。14 档 Local artifact audit 全部 compatible；基础 Edge/Standalone 为
  `2,598,669 / 2,598,747` bytes，Application+AI 为 `4,501,822 / 4,501,954` bytes，MCP 为
  `7,324,601 / 7,324,709` bytes，均保留充足预算且没有新增 package 或外部 dependency。

## 后续边界

- 设计真正的 legacy Worker adapter：固定最小 command schema、无 Plugin/Tool/DB authority、显式 EOL、可撤销身份、
  资源预算以及 ARMv6/386/ARMv7 实机证据。
- 在 Worker 管理只读面显示 architecture、supportTier、protocolVersion、Session/generation、runtime 与 capacity；
  operator 必须能区分“不兼容”“显式 legacy”“离线”和“容量为零”。
- protocol v2 必须采用并行兼容窗口或新 endpoint/schema，并先证明混合 control replica 的 rollout/rollback；不能只
  修改范围字符串让旧实现接收新语义。
