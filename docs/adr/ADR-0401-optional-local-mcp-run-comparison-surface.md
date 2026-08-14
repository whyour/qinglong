# ADR-0401：可选本机 MCP Run 对比产品入口

- 状态：Accepted
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-309、Phase 2
- 关联 ADR：ADR-0347、ADR-0351、ADR-0400

## 问题

ADR-0400 已在 Runtime Core 建立 `qinglong.run.compare@1.0.0` 的稳定 Definition、低敏
projection 和受信 adapter，但尚无产品 composition 使用它。QingLong 3.0 的外部 AI 客户端
因此只能分别调用两个 Run 点查，再自行拼接差异；这无法让服务端统一执行输入约束、Project
屏蔽、差值算法和一致性声明，也没有独立的调用审计理由。

本机已经有由 ADR-0347 建立的可选 `ql3-mcp` stdio 进程。它逐调用执行认证、Tool Policy、
durable Security Audit、credential fence confirmation 和有界 SQLite read，且只在部署者显式
选择 `edge-mcp|standalone-mcp` 制品时加载 MCP SDK。新增对比能力不应再造进程、package、
数据库 authority 或后台服务，也不能把 MCP 依赖带入默认低配 Profile。

## 决策

1. 在既有 `@qinglong/local-mcp-server` 静态只读 Tool 集合中注册
   `qinglong.run.compare@1.0.0`。Definition 与执行投影必须直接来自 Runtime Core 的
   `/builtin-run-compare-projection` 显式 subpath；MCP 不复制 schema、字段裁剪或差值算法。
2. 调用沿用同一固定顺序：每次重新认证 → 授权
   `tool.call:qinglong.run.compare` → 授权 `run.read` → durable audit → confirm credential
   fence → baseline/candidate 两次有序 Project-scoped point read。允许审计理由固定为
   `tool_qinglong_run_compare`，repository/投影失败只返回稳定
   `run_compare_unavailable`。
3. MCP Tool 继续声明 `readOnlyHint=true`、`destructiveHint=false`、
   `idempotentHint=true`、`openWorldHint=false`。Project ID 只来自私有进程配置，客户端不能
   选择；找不到与跨 Project 均由共享投影输出 `found:false`。
4. 该入口属于 ADR-0347 的轻量交互式只读 surface：它持久记录安全 admission，但不冒充
   ADR-0163 的 encrypted Tool execution completion、StepRun 或模型 Trace。Agent/Copilot
   内部经 Run/StepRun 执行受信 Tool 时仍必须走完整 start/result completion 链；未来如需让
   MCP 调用本身成为 Run，必须独立设计 correlation 与重放语义，不能在本协议中静默增加写入。
5. 不新增 workspace package、依赖、migration、表、索引、连接、timer、listener、watcher、
   cache 或网络 endpoint。`LocalSqliteMcpReadDatabase` 现有
   `findRunById` authority 已足够，不扩大其读写接口。

## 低配与部署影响

- 默认 Edge/Standalone application 与制品继续不导入 MCP package；未选择 MCP 的路由设备
  没有新增安装体积、模块加载或空闲 RSS。
- 选择 MCP 的设备只增加一个静态 descriptor；单次对比最多增加两次串行 Run 点查，不产生
  并发数据库连接或后台采样。
- Cluster Control 不通过本 ADR 开放 MCP endpoint。Cluster 的受信 Tool composition、远程
  身份、限流和 PostgreSQL completion 仍须独立门禁。
- 实现留在已有 deployable MCP package 内，不为单个 adapter 创建微型 package，也不把
  MCP-only glue 移入 Runtime Core。

## 被否决方案

1. **复制 Run compare 到 MCP `tool-projection`**：该语义已有 Runtime Core adapter 和 MCP
   两个消费者，复制会产生 Definition 与差值漂移。
2. **让客户端组合两次 `run.get`**：服务端无法冻结读取顺序、一致性声明和审计语义。
3. **把 MCP Server 加入默认 Edge application**：会让不使用 AI 的低配设备承担 MCP SDK
   依赖与约 40 MiB 级加载成本。
4. **为 compare 新建 package 或数据库 adapter**：没有独立生命周期、authority 或依赖隔离
   收益，现有窄 reader 已满足需求。
5. **把交互式 MCP 读取伪装成完整 Trusted Tool completion**：缺少 StepRun/Artifact/key/
   replay correlation 事实，会给恢复和审计造成错误承诺。

## 当前验证

1. Local MCP 46/46：Tool discovery、固定 read-only annotations、双 permission、allowed audit
   reason、credential confirm、两个有序读取和共享差值投影全部通过。真实 stdio E2E 使用
   fresh production migration SQLite、真实 Owner credential 与 Project Policy，比较两个真实
   Run 后验证第九条 durable allowed audit。
2. 最终 18-package clean build/test 退出 0；backend 1,208 项为 1,206 pass、2 条平台条件
   skip、0 fail。package boundary 保持 18 个 package，`singleSourcePackages=[]`、
   `shallowSourcePackages=[]`；Cluster dependency、Edge import 与 Cluster deployment 审计
   均无 finding。
3. 默认 Edge artifact 为 2,589,812 bytes/315 files/56 loaded modules，import RSS 增量
   11,091,968 bytes，继续完全裁掉 MCP Server 与 SDK。Edge-MCP 为 7,219,977 bytes/
   792 files/217 modules、RSS 增量 38,649,856 bytes；Standalone-MCP 为 7,220,085 bytes/
   792 files/217 modules、RSS 增量 38,043,648 bytes，均低于 16 MiB/1,536 files/48 MiB 门。
4. GitNexus 对 `LOCAL_MCP_READ_TOOLS` 报告 LOW、0 上游；
   `createQingLongLocalMcpServer` 为 LOW、1 个直接产品调用方、0 条 execution flow。
   dependency firewall 的 `auditSourceImports` 为 LOW、1 个直接测试调用方、0 条 flow；
   allowlist 只增加 exact compare projection subpath，宽 authority 负向门仍通过 53/53。

## 后续门禁

1. 增加按 Task 有界选择最近成功/失败 Run 的服务端 Tool，禁止模型执行无界搜索；
2. 日志解释另建 Artifact range、redaction、prompt-injection 和字节预算协议；
3. Copilot 调用走 Run/StepRun 与 encrypted result completion，建立模型/Tool Trace correlation；
4. 固定物理 Edge MCP 延迟/RSS 和真实撤权竞态证据。
