# ADR-0345：Tool Registry 协议归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-09、D-17、D-75、D-85、D-87、D-131、D-157、D-213、D-244、D-257
- 关联 ADR：ADR-0133、ADR-0154、ADR-0276、ADR-0344

## 背景

`@qinglong/runtime-core` 的 `tool-execution/toolRegistry.ts` 有 915 行，同时承载公开 schema/type/error、Tool Definition 与受限 JSON Schema canonical validation、immutable registry 与输入输出规范化，以及 Policy-fenced invocation admission。它被 Project Tool Definition Snapshot、Plugin Package materialization、Trusted Tool admission/execution/completion、SQLite、PostgreSQL、Cluster 与 Worker 路径共同消费。

这些职责属于同一个 profile-neutral Tool Registry bounded context，不具备独立部署、权限、依赖或供应链边界；拆成 workspace package 会制造微包。但继续用一个平铺文件承载定义协议、registry state 和 Policy admission，会让 JSON Schema 资源边界、不可变注册表与授权顺序难以分别审阅。

编辑前对原文件全部 31 个 function/class/method 执行 GitNexus upstream impact：23 LOW、1 MEDIUM、7 HIGH、0 CRITICAL。`ToolDefinitionRegistry` 为 HIGH（18 direct/43 total/2 processes），`UnsupportedToolError` 为 HIGH（15/42/2），两个公共 validation error 分别为 HIGH（22/40/0、19/39/0）；已在编辑前告警并把本批限制为等价 ownership 移动。

## 决策

保留一个 `@qinglong/runtime-core` package、原 `./tool-registry` export 与 37 行显式 facade，在既有 Tool Execution 领域建立 package-private owner：

```text
toolRegistry.ts                    # stable explicit facade
tool-registry/
├── contracts.ts                  # schemas, public types, ports and stable errors
├── definitionProtocol.ts         # Tool Definition and bounded JSON Schema canonicalization
├── registryProtocol.ts           # immutable registry plus input/output JSON normalization
└── invocationAdmission.ts        # Policy-fenced admission and action digest
```

不新增 workspace package、生产依赖或公开 owner subpath。原路径仍精确发布 22 个 runtime export 与 12 个 public type/interface；facade 只显式转发，不使用 wildcard export。四个 owner 分别为 176、391、234、165 行，最小文件仍拥有完整 admission protocol，没有按 validator、schema kind、registry method 或单个错误拆成微文件。

Tool name/canonical SemVer、0–128 immutable definitions、受限 JSON Schema 类型与 depth/node/property/enum/array 硬界、64 KiB input、256 KiB output、1–3600 秒 timeout、exact version、无 runtime registration、plain dense JSON/accessor 拒绝、canonical ordering、Policy-before-input、deny short circuit、同一 Project/RoleBinding fence、Agent approval、input/action SHA-256 domain facts，以及错误 type/code/message 均不变。Registry 仍不持 handler、filesystem、process、network、database、timer 或 execute authority。

## 小设备与集群影响

十档制品统一增加 5,827 bytes/4 files，没有新增 dependency、连接、Pool、timer、线程或常驻对象。Edge/Standalone 为 3,664,061/3,664,097 bytes、362 files、49 modules；Adopted 为 4,284,570/4,284,630 bytes、414 files、50 modules；Application 为 4,782,419/4,782,539 bytes、473 files、120 modules。Edge/Standalone AI 为 5,153,958/5,154,006 bytes、521 files、54 modules；Application AI 为 6,272,382/6,272,514 bytes、632 files、119 modules。

基础 Edge 和 AI-only loaded modules 不变；实际加载 Tool Registry 的 Application 组合增加 4 个 owner module。最紧的 Edge Application AI 距 6 MiB 门限只余 19,074 bytes，本批不提高预算。后续不能继续做只增加包装成本的协议拆分：必须优先合并低收益边界、减少交付内容、让 facade/owner 可被构建裁剪，或推进零常驻成本的真实产品能力。

PostgreSQL 18.4 arm64 HA 门通过 `remote_apply`、timeline 1→2、旧主 fencing 与 `pg_rewind` 只读同步 rejoin。Project Tool Snapshot、Invocation Artifact、非空 Result rekey、catalog rotation、completion/rekey COMMIT-response-loss convergence 与 promotion survival 均保持 true；最终 `gates.passed=true`。

## 被否决方案

1. 新增 Tool Registry workspace package：没有新的部署、权限、依赖或发布边界，会扩大 Edge 安装拓扑。
2. 保留 915 行平铺文件：Definition schema、registry state 和 Policy admission 无法独立审阅。
3. 每个 JSON Schema kind、validator 或 registry method 单独成文件：会形成一操作一文件，并直接消耗已不足 20 KiB 的最紧制品余量。
4. 把 Tool handler 放进 Registry：会把静态 definition authority 扩大为代码执行 authority。
5. 同批改变 schema/digest/Policy 顺序：这是 wire/security 行为变化，需要独立兼容和安全评审。

## 验收证据

- facade 915→37 行；owner 为 176/391/234/165 行，最小 165、最大 391，没有微文件。
- 原路径仍精确导出 22 个 runtime symbol 与 12 个 public type/interface；没有 wildcard public facade 或外部 owner deep import。
- Tool Registry 定向测试 13/13；runtime-core 445/445；完整 16-package clean build/test 退出 0。
- package-boundary、cluster-dependency、edge-import 三项结构审计 compatible；workspace 仍为 16 package、963 source、25 root/938 nested，runtime-core 为 136 source、1 root/135 nested，无单文件或浅层 package。
- 外部 profile vulnerability audit 需要发送生产依赖元数据且未获出站权限，本批不重复尝试，也不记为通过。
- 十档 artifact compatible，统一 +5,827 bytes/+4 files；只在实际加载 Registry 的 Application 组合增加 4 loaded modules，最紧预算未放宽。
- PostgreSQL HA Docker 门退出 0，Tool lifecycle 与最终 gate 全部通过。
- `git diff --check` 与新增文件尾随空白检查通过；只有稳定 facade 直接导入 owner subpath，没有 wildcard export 或外部 deep import。GitNexus 强制重建为 44,563 nodes/101,626 edges/1,735 clusters/296 flows。
- post-impact 中两个 validation error 与 unsupported error 保持 HIGH（12 direct/39 total、9/38、5/41/2 processes），definition normalizer 与 registry `resolve` 为 HIGH（5/16、7/18/2）；Registry class 因内部调用归属显式化成为 MEDIUM（6/40/2），输入/输出规范化与 admission helper 为 LOW。既有两条 Tool 流程仍连接到 Registry/resolve，没有新增 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此结果只作 Git 基线补充。工作区无 staged change。

## 后续约束

`contracts.ts` 不取得 handler 或 I/O authority；`definitionProtocol.ts` 只拥有稳定 Definition/JSON Schema vocabulary；`registryProtocol.ts` 保持 immutable、exact-version 且无 runtime registration；`invocationAdmission.ts` 必须维持 Policy-before-input、deny short circuit 和 single-fence 语义。新增 schema keyword、dynamic registration、handler、digest 字段、Policy 顺序或错误契约必须独立评审。考虑到 Edge Application AI 余量只剩 19,074 bytes，下一批不得默认继续增加 owner 文件。
