# ADR-0355：强人类认证、摘要绑定的 Approval 决策产品门

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-259、D-260、D-263、D-265、D-266、D-267
- 关联 ADR：ADR-0031、ADR-0138、ADR-0353、ADR-0354

## 背景

MCP 已能列出 Approval 并读取一个经过 redaction contract 的 preview，但仍故意没有写 authority。若把 approve/reject
直接加入同一 MCP 进程，Agent、API credential、Artifact read 和人类决定会混在一个 authority 中；若本机 Owner CLI
只接受 request ID，则人类无法证明决定针对自己实际检查过的 action/preview。Edge 路由器还不能为一次人工决定常驻新的
Web 服务，而 Cluster 也不能为每个决定建立新 Pool 或绕过既有 mTLS/OIDC 管理边界。

## 决策

1. Profile-neutral `ApprovalDecisionService` 只接受强认证 User，允许的 assurance 固定为 `multi_factor`、`hardware` 或
   `local_console`，并重新执行当前 Project 的 `approval.decide` Policy。
2. 决策命令除 request/project/version/decision/reason 外，必须携带完整 `expectedAction`：permission、action type、action
   reference、action digest 和 preview digest。服务从 durable Approval 重新读取 canonical binding，任何一项漂移均在写前拒绝。
3. `expectedVersion` 固定为 1；success 把 allowed Security Audit 与 Approval version 1→2 放在同一 storage transaction。
   同一 decision ID、决定、reason 和 User 的重试返回 `existing`，不重复写 audit；不同语义复用 ID 失败关闭。
4. 本机产品面是独立 `ql3-approval` 私有 command-file CLI，提供 `approval.inspect` 和 `approval.decide`。inspect 同时要求
   `approval.read`、`artifact.read`，返回 canonical `expectedAction` 和有界 redacted preview；decide 必须把该 binding 原样带回。
5. 本机认证继续复用 POSIX private-path proof、Owner Pepper、active User credential 和 `local_console` principal。写前复验
   command proof/credential file，SQLite Approval repository 又在 `BEGIN IMMEDIATE` 后、读取或写入任何 Approval 前复验同一
   credential fence，从而关闭 revoke 与写事务之间的竞态。认证、Policy、binding、state/fence 失败使用独立 failure event 审计。
6. MCP 保持纯只读，不 import decision service、不新增 Tool，也不取得 `approval.decide`。consume、dispatch 和 execute 仍由
   各自的受信执行面完成，人工决定不能直接产生外部副作用。
7. Cluster 复用同一 Profile-neutral service，由 `@qinglong/cluster-admin/approval-decision-management` 在调用方拥有的
   PostgreSQL Pool 上组合现有 Approval repository 与 Project Policy repository。它不建立 listener、Pool、timer 或认证协议；
   未来远程 route 必须接在既有强认证管理 transport 后，并在 transport 层重新确认认证。

## 资源与 Package 裁决

- Edge/Standalone CLI 是短进程、单 SQLite connection、无后台 timer/listener/cache；未调用时资源为零。
- Cluster factory 复用调用方 Pool，不创建 per-request Pool，也不改变 HA schema 或连接拓扑。
- 公共协议归 Runtime Core 的 `approved-action/` domain；SQLite 短期 authority 归现有 adapter；本机命令归 Local Owner CLI；
  Cluster 组合归 Cluster Admin。没有独立制品、依赖或生命周期理由，因此不新增 workspace package。

## 被否决方案

1. 给 `qinglong.approval.get` 增加 approve/reject：混合 Agent read authority 与 Human write authority。
2. 决策只带 request ID/version：不能证明人类决定与已检查 preview/action binding 相同。
3. 交互式 CLI 从 stdin 询问 yes/no：难以审计、重放和自动生成受保护的变更单，且容易被终端注入或默认值误导。
4. 为 Approval CLI/decision service 新建 package：会制造用户已质疑的微包，没有新的部署或 authority 边界。
5. 为本切片新建表或队列：现有 Approval/audit/preview schema 已满足 exact binding 与原子决定。
6. 同时开放通用 consume/execute：会把人类审查与外部副作用重新耦合，越过独立 start/recovery 门禁。

## 发布边界

本 ADR 完成本机 Owner 的 inspect/decide 产品门和 Cluster 的可复用组合边界，但不声称已开放 Cluster 远程管理 API/UI。
Cluster route 仍须完成 transport principal、独立限流、失败审计、部署配置和端到端 PostgreSQL 测试后才能注册。MCP 永久保持
只读；任何通用消费或执行入口必须另立 ADR。

## 验证证据

- Runtime Core 455/455、Local SQLite 209/209、Local Owner CLI 137/137、Cluster Admin 258 pass/2 条件 skip、
  PostgreSQL 290 pass/1 条件 skip。
- package boundary、cluster dependency、edge import 与十二档 artifact 门全部 compatible；17 个 package、1004 个源码文件中
  978 个位于领域子目录，root 仅 26 个，没有单文件或浅目录微包。
- 默认 Edge/Standalone Application loaded module 仍为 120，MCP 为 203；新增决策语义只有显式 Owner/Cluster composition
  import 时才加载。Standalone Application AI 为 6,275,925 bytes/639 files，距 6 MiB 上限余 15,531 bytes；Standalone
  MCP 为 9,872,053 bytes/949 files/203 modules，RSS 38,404,096 bytes，均未放宽预算。
