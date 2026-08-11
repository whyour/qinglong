# ADR-0347：可选、受认证的本机 MCP Run 读取入口

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-260
- 关联 ADR：ADR-0028、ADR-0049、ADR-0052、ADR-0087、ADR-0155、ADR-0195、ADR-0276、ADR-0345、ADR-0346

## 背景

QingLong 3.0 已有 immutable Tool Definition/Registry、Project Policy、API Credential、durable Security Audit、双方言 Run reader，以及 Cluster `run.get` HTTP 路由，但没有可由桌面 Agent 或本机 AI Client 实际连接的 MCP 产品入口。直接把 MCP SDK 加到 `local-application` 会使所有 Edge/Standalone 部署承担一个与默认调度无关的协议闭包；复用 Owner CLI 则会把一次性管理 authority 与常驻 stdio session 混为一体。

官方 `@modelcontextprotocol/server@2.0.0` 具有独立协议和依赖闭包。实测只加载 SDK 即增加约 28 MiB RSS；完整认证、Policy、Audit 与 SQLite composition 的 import RSS 增量约 41 MiB。因此 MCP 不能成为路由设备默认 Profile 的隐式能力，也不能用“只有四个源文件”为理由并入 application。另一方面，它拥有独立 binary、生命周期、输入协议、第三方依赖和安全 admission，符合 workspace package 的 deployable、authority 与 dependency-isolation 三项边界理由。

实现中还发现两个既有架构问题：新建 Run 的合法初始 `version=0` 被本机 Tool schema 和 Cluster projection 错误拒绝；`builtInRunReadTool` 将轻量 Run 投影与 Trusted Tool/Plugin Package adapter 链放在同一 import closure，使 MCP 无谓加载约 25 个模块。前者属于双方言公开读取契约错误，后者属于 package 内部职责耦合，不应通过继续拆 workspace package 解决。

## 决策

新增可选 deployable package `@qinglong/local-mcp-server`，只提供 `ql3-mcp --config /absolute/private-config.json` stdio 进程。它不进入默认 Edge/Standalone application、镜像或启动图；只有部署者显式安装和启动 `edge-mcp`/`standalone-mcp` sidecar 才产生资源成本。进程不得监听 TCP/Unix socket，不拥有 timer、watcher、scheduler、migration、repair、management、Secret mutation 或 destructive Pepper authority，stdout 只允许 MCP JSON-RPC，诊断只写低敏 stderr。

首个且唯一 Tool 为 `qinglong.run.get@1.0.0`。每次调用必须重新执行以下顺序：

1. 从当前 UID、`0600`、no-symlink 私有 credential file 建立 API Credential principal，并绑定 exact Pepper provenance；
2. 由共享 Tool Registry 解析 exact Definition，依次授权 `tool.call:qinglong.run.get` 与 `run.read`；
3. 将 admission outcome 持久写入 Security Audit；
4. 调用 credential `confirm()` 关闭认证到读取之间的撤销窗口；
5. 执行一次 Project-scoped Run point read，只返回共享低敏 projection；缺失和跨 Project 均返回 `found=false`。

认证、Policy 或 Audit 不可用时不得读取 Run。配置、input、output 和错误均有 exact shape/长度上限；不得回显 credential、Pepper、路径、Principal、Policy reason、数据库错误、Task snapshot、input/output reference 或原始运行错误。

`@qinglong/local-sqlite/mcp-read-database` 只组合 readiness 后的单个 SQLite connection，并只暴露 Run point reader、credential resolve、Pepper exact-key resolve、Project Policy resolve 与 Security Audit append。它不暴露 migration、administration 或任意 repository root。`ProjectPolicyEngine` 的构造依赖收紧为 `Pick<ProjectPolicyRepository, 'resolve'>`，不再要求调用者持有写接口。

Runtime Core 在同一 package 内新增 `builtin-run-read-projection` 子路径，承载 Tool Definition、合法 `version>=0` 的低敏投影和 bounded point-read；原 `builtin-run-read-tool` 继续重导出这些符号并保留 Trusted Tool adapter，因此现有消费者兼容。Cluster `run.get` 同步接受合法 `version=0`。这不是新增领域 package，而是按 D-257 在 owning package 内切断不必要 import closure。

## Package 与资源边界

workspace hard cap 从 16 调整为 17，但这不是可复用空位。机器账本要求 MCP package 同时声明独立部署、authority 与第三方依赖隔离；source import 审计只允许 MCP Server/Core、私有 command file、authenticated-command、MCP read database 与精确 runtime-core Tool/Policy/Audit 子路径，并禁止其他 package 反向依赖该 deployable leaf。

独立 artifact gate 固定安装闭包为 MCP Server/Core、Zod、SemVer 与五个 QingLong package。构建期只从这三个外部 package 删除 `.map`、declaration 和 README，保留 runtime JavaScript、manifest 与 license；运行导入验证在裁剪后执行。当前 Edge/Standalone MCP 制品分别为 9,775,960/9,776,068 bytes、938 files，低于 16 MiB/1,536 files；完整 import RSS 增量为 43,155,456/42,696,704 bytes，低于独立 48 MiB 门。官方 SDK 本身占主要内存，因此该上限不能外推到默认 application，也不能宣称适合所有 64 MiB 设备。

## 被否决方案

1. 把 MCP 合进 `local-application`：会让不使用 AI/MCP 的路由器承担 SDK、Zod、认证 session 与协议攻击面。
2. 把 MCP 做成 Owner CLI 子命令：stdio session 是独立产品生命周期，不应继承 management/destructive authority。
3. 为 Tool projection、MCP config 或 stdio transport继续拆 package：它们没有独立部署或消费者，使用 package 内 domain/subpath 即可。
4. 直接把 RSS 门从 32 MiB 放大且不优化 import：会掩盖 Run projection 连带加载 Trusted Tool/Plugin Package 的耦合；必须先完成包内子路径提取。
5. 首批开放写 Tool、Shell、Workflow start、HTTP/SSE 或远程 MCP：这些能力需要独立审批、限流、网络身份、幂等和副作用恢复评审。
6. 在 MCP 启动时自动 migration 或创建 Owner：会把协议入口升级为部署管理 authority，并破坏 readiness fail-closed。

## 验收证据

- MCP package 6/6：私有 config、认证/Policy/Audit 顺序、跨 Project 屏蔽、单数据库 authority 与真实 stdio JSON-RPC/SQLite/audit E2E。
- Runtime Core Trusted Tool 定向 19/19；旧 `builtin-run-read-tool` export 与行为保持。
- package-boundary/dependency 定向 59/59，17-package ledger compatible，MCP 精确 authority import 负向门通过。
- Edge/Standalone MCP artifact 均 compatible，裁剪后运行 import 与 `ql3-mcp --help` 通过；默认十档 Profile 仍须在发布门证明闭包无 MCP package。
- Cluster Run read 单元覆盖合法 `version=0`；PostgreSQL HA、全包与完整后端回归必须在发布前继续通过。
- 默认十档与两个 MCP artifact 全部 compatible；默认十档清单无 MCP Server/Core/Zod。PostgreSQL 18.4 arm64 HA `gates.passed=true`，且专用 `ql3-ha` 容器、网络和卷清理后均为空。

## 后续约束

新增 MCP Tool 必须先有稳定 Tool Definition、明确 effect/risk/permission、低敏 output、双方言 repository parity、每调用认证/Policy/Audit/fence、资源预算和真实协议 E2E。任何写操作、Shell/Process、Secret plaintext、Artifact content、网络 transport、session cache、subscription 或动态 Tool registration 都需要独立 ADR。MCP SDK 升级必须重跑协议兼容、production dependency、artifact/RSS 与低配设备门；默认 Edge application 永远不得通过间接 import 加载 MCP SDK。
