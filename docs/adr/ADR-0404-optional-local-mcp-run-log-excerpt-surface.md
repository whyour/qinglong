# ADR-0404：可选本机 MCP Run 日志摘录产品入口与私有文件边界

- 状态：Accepted
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-312、Phase 2
- 关联 ADR：ADR-0347、ADR-0351、ADR-0364、ADR-0366、ADR-0377、ADR-0401、ADR-0403

## 问题

ADR-0403 已交付 `qinglong.run.log.excerpt@1.0.0` 的 profile-neutral Trusted Tool kernel，
但没有产品入口。失败日志解释要成为可用的本机 AI 能力，显式启用 `ql3-mcp` 的 Edge 与
Standalone 用户需要经过现有身份、Policy、审计和 credential fence 读取同一份 Local Run
Attempt 私有日志；默认未启用 MCP 的路由设备则不能承担额外依赖、常驻内存或攻击面。

最直接的组合方式是让 Local MCP 依赖 `@qinglong/local-execution/artifact-read`。产物审计证明该
方案会把 `local-process`、scheduler 与 `croner` 一起拉入只读 sidecar：Edge MCP 达到
7,469,105 bytes、816 files、228 modules，Standalone MCP 达到 7,469,249 bytes、816 files、
228 modules。MCP 并不拥有启动、停止或调度进程的 authority，这个依赖方向既扩大低配成本，也
让只读产品边界对执行实现产生错误耦合。

同时，单独为一个 reader 新建第十九个 workspace package，或把 reader 放回 package `src` 根目录，
都会重现已经由 ADR-0364/0366 关闭的单文件微包与根层平铺问题。

## 决策

1. 把 `qinglong.run.log.excerpt@1.0.0` 注册到显式可选的 `edge-mcp|standalone-mcp` stdio
   product surface。默认 Edge/Standalone application 不安装、不导入也不启动该入口；不增加网络
   listener、daemon、timer、watcher、cache、migration、表或索引。
2. 每次调用固定执行 credential authentication → exact
   `tool.call:qinglong.run.log.excerpt` 与 `artifact.read` Policy → durable Security Audit →
   credential/Pepper fence confirm → 有界日志读取。审计 reason 固定为
   `tool_qinglong_run_log_excerpt`，失败统一收敛为 `run_log_excerpt_unavailable`；日志正文、
   Artifact ID、路径和 credential 不写入审计。
3. MCP 配置升级到 `qinglong/local-mcp-server@v2`，新增必填、规范化且位于
   `deploymentRoot` 下的 `artifactRoot`。它必须与 Local application 的 Run Attempt Artifact 根
   完全一致，并与 database、keyring、credential path 两两不同。旧 `@v1` 失败关闭；MCP 不从
   database path、当前目录或约定默认值猜测日志根。
4. SQLite MCP read authority 只增加 Project-scoped `findAttemptById` 与 retention `inspect`，
   复用同一 connection 和既有 repository；不取得 Run/Attempt mutation、目录扫描或 retention
   删除 authority。生产组合复用 Runtime Core `RunAttemptLogReadService` 和 ADR-0403 的固定
   Edge 4 KiB/Standalone 8 KiB 双读取安全投影。
5. `LocalRunAttemptLogRangeReader` 的唯一实现归入既有
   `@qinglong/local-command-file/artifact-read`。该 package 的职责收敛为“本机私有、有界文件
   authority”，根层仍只有公开转发入口，command JSON 与 Run log reader 分别位于
   `protocol/`、`artifact-read/`；它只允许导入 Runtime Core 的
   `run-attempt-log-read` 纯契约。
6. `@qinglong/local-execution/artifact-read` 保留兼容 re-export，使现有 application 与测试无需
   改写调用面；依赖方向变为 execution → private-file，而不是 MCP → execution。workspace 保持
   18 个 package，不创建单文件 package，也不把实现平铺回 `src` 根层。
7. 交互式 MCP 调用只持久化安全 admission，不冒充内部 Trusted Tool 的 StepRun、Trace、
   encrypted completion 或模型调用。日志继续无条件标记为不可信数据且无行动权；Cluster
   Copilot、最终 Prompt builder 与模型 egress policy 仍走独立 Gate。

## 低配与集群影响

- 默认 Edge/Standalone 仍为 2,589,812/2,589,890 bytes、315 files、56 modules；未启用 MCP 的
  路由设备没有新增常驻组件或制品成本。
- Edge/Standalone MCP 为 7,315,930/7,316,038 bytes、801 files、226 modules，RSS 增量为
  38,420,480/39,567,360 bytes，均低于 16 MiB/1,536 files/48 MiB 门；闭包不含
  `local-execution`、`local-process` 或 `croner`。
- Cluster 不复用本机 SQLite/file composition。后续 Cluster 产品入口应组合现有 PostgreSQL/S3
  authority，并独立证明认证、Policy、durable audit、credential fence 和 Trusted Tool completion；
  本 ADR 不让 Cluster Control 或 Worker 导入本机私有文件 package。

## 被否决方案

1. **MCP 直接依赖 `local-execution`**：实测污染只读制品并引入进程/scheduler 实现，违反
   authority 与部署闭包最小化。
2. **新建 `local-artifact-reader` workspace package**：只有一个实现文件，增加 importer、lockfile、
   SBOM 和维护面，不能证明新的独立生命周期。
3. **把 reader 平铺到 MCP 或 package 根层**：复制 Local Artifact 真源，或逆转已完成的 package
   内部领域布局治理。
4. **继续使用 v1 并推导 Artifact 根**：部署路径可能变化，猜测会读错实例或越过显式 authority。
5. **让客户端传 Artifact ID/path/range**：恢复任意读取和循环分页能力，破坏 ADR-0403 的固定预算。
6. **在 audit 中保存日志片段**：扩大 credential/业务秘密的持久泄露面，且不属于 admission 证据。

## 当前验证

1. Local MCP 48/48：覆盖 Tool 发现、真实安全顺序、双 range read、脱敏、taint、无行动权、无
   Artifact/cursor 泄露，以及真实 SQLite + 私有 Artifact stdio E2E。
2. Local Execution 41/41，证明兼容 re-export 与既有 application 日志读取不变；私有文件 package
   3/3，依赖防火墙定向 54/54。
3. package boundary 与 dependency audit 零 finding；workspace 仍为 18 package，
   `local-command-file` 为 3 source、1 root/2 nested，`singleSourcePackages=[]`、
   `shallowSourcePackages=[]`。
4. 默认 Edge/Standalone 与两档 MCP 的四个关键产物画像均通过，精确数据见“低配与集群影响”。

5. 最终 18-package clean build/test 退出 0；backend 1,209 项为 1,207 pass、2 条平台条件
   skip、0 fail。package/dependency/Edge import/Cluster deployment 审计全部零 finding。
6. 14 个 Local Profile artifact 全部通过；除两档 MCP 的显式增量外，默认与既有组合均保持门内。
7. PostgreSQL 18.4 arm64 HA 125/125 Gate 通过，timeline `1→2`，报告 SHA-256 为
   `29cd77d80737a3b1ab686c998d05a78c52deffd8add3b31d8035756d5dfcc433`；独立证据审计
   零 finding，专用容器、网络与卷零残留。

## 后续

1. 为结构化 Copilot Prompt 增加不可混淆 delimiter、residual sensitivity egress policy 与模型
   completion 证据；
2. 产品化 Cluster S3 日志摘录，但不得借机让 Worker 获得模型投影或数据库控制面 authority；
3. 在固定物理 Edge 设备记录单次日志读取延迟与 active RSS，仓库内画像不替代实机支持结论。
