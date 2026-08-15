# ADR-0417：有界 Cluster Copilot MCP stdio 产品面

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-325、Phase 2

## 背景

D-324 已提供受审的 Cluster Copilot 共享客户端与一次性 CLI，但 Agent/MCP host 若只能启动 CLI 子进程，就会复制 command 文件、错误投影与进程生命周期，并可能把 credential 放进 argv、环境变量或临时文件。现有 `@qinglong/local-mcp-server` 明确拥有 Edge/Standalone 的本地 SQLite、Owner credential 与 Artifact authority；让它依赖 Cluster Admin 会把 Kubernetes、PostgreSQL 和 Cluster 客户端闭包带进低配 MCP 制品，也会混淆本地 Owner 与远程 Project API credential 两种安全域。

QingLong 3.0 尚无独立的 Cluster Web UI ownership。此时直接修改 2.x 前端会让新 API 重新依赖旧 controller/session 语义。Cluster Copilot MCP stdio 是更小但完整的产品面：它能直接复用 D-324 library 和 D-321 至 D-323 的服务端认证、Policy、audit、quota 与 durable state，同时保持 UI 以后也只能走同一 HTTP contract。

## 决策

1. 在既有 `@qinglong/cluster-admin` 的 `copilot-mcp/` 嵌套职责目录增加 `ql3-copilot-mcp`；不新增 workspace package，不修改 `@qinglong/local-mcp-server`，也不让任何 Edge/Standalone importer 依赖 Cluster Admin。
2. MCP server 使用已固定版本的 `@modelcontextprotocol/server` 和 stdio transport，不监听网络端口。进程只接受一个 owner-private 0600 配置文件路径；配置只含 D-324 client config 路径、API credential 文件路径和显式 `1..16` 并发上限，不含 credential value、Project、Run、Prompt、输出或 Policy。
3. 暴露四个静态 Tool：`qinglong.cluster.copilot.failure_diagnose`、`qinglong.cluster.copilot.failure_diagnosis.get`、`qinglong.cluster.copilot.failure_diagnosis.output.get`、`qinglong.cluster.copilot.failure_diagnosis.cancel`。输入只含构造 D-324 exact command 所需的 Project、source Run、diagnosis request、trace 或 mutation identity；调用者不能提交 URL、header、credential、diagnosis Run、Artifact、Model/Provider、reason、outcome、usage、cost 或服务端 Policy fence。
4. MCP handler 直接调用共享 TypeScript client，不启动 CLI 子进程、不写 command 临时文件、不直连 application capability、AI repository 或数据库。D-324 文件型 CLI 继续兼容；共享 client 新增 command-object 入口并与文件入口复用同一 TLS、credential、request identity、response validation 和内存清理实现。
5. API credential 文件在每次 Tool call 重新执行 canonical/private/TOCTOU 与 token 格式校验；进程只保留路径，不缓存 secret。credential rotation 因此在下一次调用生效，失效或权限漂移立即失败关闭。
6. 并发达到配置上限时立即返回 `copilot_mcp_busy`，不建立隐藏队列、timer、poller、retry、watcher、cache 或后台任务。每个请求仍受 D-324 的 TLS request timeout、2 MiB response cap 与服务端 quota 约束。
7. 所有成功结果都使用 exact `qinglong/cluster-copilot-mcp-result@v1` envelope，标记 `instructionPolicy=data_only_never_execute`、`actionAuthority=none`。diagnose/inspect/cancel 标记 `low`；output 明确标记 `potentially_sensitive` 与 `untrusted_model_output`，只有调用该 Tool 才返回诊断文本。MCP annotation 将 diagnose 标为有成本的非只读调用、cancel 标为 destructive，read/output 标为只读。
8. MCP 失败只返回稳定 code；远端拒绝可附带 bounded status、response code、request identity 与 Retry-After，不返回 response body/header、credential、路径、TLS/文件异常或 output。stdio transport 错误与启动错误也只写低敏 stderr fact。
9. 本 Gate 不新增 route、数据库 schema/migration/role/Pool/连接、Kubernetes Pod/Service/RBAC 或 Cluster Control 进程。Cluster Admin 生产依赖允许复用 workspace 已固定的 MCP server 版本；Cluster deployment audit 必须显式记录新增依赖闭包，Local 14 档 artifact 必须证明低配闭包字节数不变。

## 不选择

- **让 MCP host 调用 `ql3-copilot-client` 子进程**：重复文件和进程协议，难以稳定标注 potentially-sensitive output，也绕开共享并发边界。
- **扩展 `@qinglong/local-mcp-server` 支持 Cluster**：会污染 Edge/Standalone MCP 依赖与本地 Owner 安全域。
- **新建 `@qinglong/cluster-mcp-server` package**：当前只有四个同域 Tool，会再次形成过细 package 并突破 18-package 硬上限。
- **直接接入旧 Web UI controller/session**：3.0 尚未冻结 Cluster UI ownership，会把新 API 绑定回 2.x 语义。
- **在 MCP 进程缓存 credential 或自动轮询 diagnosis**：扩大 secret 生命周期和隐藏资源消耗，并混淆 transport timeout 与 durable 状态。

## 验收

1. 覆盖四个 Tool 的 exact discovery/input/annotation、command mapping、成功 trust/sensitivity envelope、远端低敏错误、并发立即拒绝和未知字段失败关闭。
2. 真实 TLS 1.3 fixture 证明 MCP 直接复用 client、每次重读 credential、无 client certificate、无 CLI 子进程，并覆盖 diagnose/inspect/output/cancel。
3. stdio E2E 覆盖 initialize、tools/list、四个 tools/call、potentially-sensitive output、低敏 stderr 与 graceful close；进程退出后不得残留 listener、timer 或 child process。
4. Cluster Admin、18-package clean build/test、backend、package/dependency/Edge import/Cluster deployment 和 14 档 Local artifact 全部通过后才允许 D-325 阶段提交；本 Gate 无数据库变更，不重复物理 HA，继续引用 D-323 基线。
