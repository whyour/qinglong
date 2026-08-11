# ADR-0344：Model Provider Credential Test Connection 协议归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0265、ADR-0276、ADR-0338、ADR-0342

## 背景

`@qinglong/ai` 的 `model-provider-credential/modelProviderCredentialTestConnection.ts` 有 683 行，同时承载公开 schema/type/error 与 canonical primitive、HTTPS endpoint/allowlist、测试 plan，以及 execution/result 协议。它被本机与 PostgreSQL 的计划/执行 repository、Cluster management process 和 tester executor 共同消费。

这些职责属于同一个 Credential Test Connection wire protocol，不是独立部署、权限、依赖或供应链边界；拆成 workspace package 会制造微包，继续平铺则使 SSRF 边界、计划授权事实和执行结果难以分别审阅。编辑前对原文件全部 28 个 function/class/method 执行 GitNexus upstream impact：21 LOW、6 MEDIUM、1 HIGH、0 CRITICAL。共享 `invalid` helper 为 HIGH，具有 18 个直接调用、32 个上游影响并进入 1 条流程；已在编辑前告警并把本批限制为等价 ownership 移动。

## 决策

保留一个 `@qinglong/ai` package、原公共导入路径和 38 行显式 facade，在同一领域建立 package-private owner：

```text
modelProviderCredentialTestConnection.ts                  # stable explicit facade
model-provider-credential-test-connection-protocol/
├── contractProtocol.ts                                   # public schemas, types, errors and canonical primitives
├── endpointAllowlistProtocol.ts                          # HTTPS endpoint and SSRF allowlist boundary
├── planProtocol.ts                                       # actor/fence-bound immutable test plan
└── executionResultProtocol.ts                            # execution and content-free result protocol
```

不新增 workspace package、生产依赖或公开 owner subpath。原路径仍精确发布 21 个 runtime export 与 8 个 public type/interface；facade 只显式转发，不使用 wildcard export。四个 owner 分别为 187、239、142、175 行，最小文件仍拥有一套完整协议职责，没有按 validator、digest 或单个 create/normalize 操作拆成微文件。

HTTPS-only canonical URL、禁止 credential/query/hash/userinfo、endpoint 与 allowlist digest、allowlist 上限、零 retry/零 cost、deadline/response/model/plan lifetime 硬界、五个 digest domain、exact-shape/accessor 拒绝、强 User 与 Project/binding fence、immutable execution/result、错误 type/code/message 和 exact replay 均不变。本机 SQLite 与 Cluster PostgreSQL 继续经同一个 public facade 使用协议，各自的 transaction、clock、quota、audit、Pool 和 least-privilege role 保持独立。

## 小设备与集群影响

非 AI 六档制品逐字节、逐文件、逐加载模块不变，最小 Edge 仍为 3,658,234 bytes、358 files、49 modules。AI 四档增加 8,893 bytes/4 files、loaded modules 不变：Edge/Standalone AI 为 5,148,131/5,148,179 bytes、517 files、54 modules；Edge/Standalone Application AI 为 6,266,555/6,266,687 bytes、628 files、115 modules。没有新增 dependency、连接、Pool、timer、线程或常驻对象。

最紧的 Edge Application AI 距 6 MiB 门限只余 24,901 bytes；本批不提高预算。后续 owner 拆分若继续增加模块包装成本，必须先合并低收益内部边界、裁剪交付内容或引入经证明的构建裁剪，不能用放宽低端设备门限掩盖结构成本。

PostgreSQL 18.4 arm64 HA 门通过 `remote_apply`、timeline 1→2、旧主 fencing 与 `pg_rewind` 只读同步 rejoin。Credential Test Connection 的 plan/execution exact replay、completion COMMIT-response-loss convergence、同步复制、promotion survival、tester least privilege 与 durable content-free 均保持 true；最终 `gates.passed=true`。

## 被否决方案

1. 新增 Credential Test Protocol workspace package：没有独立部署、权限、依赖或 consumer release 边界，并会增加 Edge 安装拓扑。
2. 保留 683 行平铺文件：公开契约、SSRF allowlist、计划授权和执行结果无法独立审阅。
3. 每个 validator、digest、create 或 normalize 操作单独成文件：会形成一操作一文件并消耗已经偏紧的 AI 制品文件/字节预算。
4. 为 Local 与 Cluster 复制协议：会使 endpoint、allowlist、digest 和 replay 语义发生方言漂移。
5. 同批修改 schema、digest domain 或网络策略：这是 wire-format/安全行为变化，需要独立兼容和迁移评审。

## 验收证据

- facade 683→38 行；owner 为 187/239/142/175 行，最小 142、最大 239，没有微文件。
- 原路径仍精确导出 21 个 runtime symbol 与 8 个 public type/interface；没有 wildcard public facade。
- Credential Test 协议、本机/PG repository、readiness、Cluster executor/process 定向回归 24/24；AI 212 项为 209 pass/3 skip/0 fail；完整 16-package clean build/test 退出 0。
- package-boundary、cluster-dependency、edge-import 三项结构审计 compatible；workspace 仍为 16 package、959 source、25 root/934 nested，AI 为 157 source、1 root/156 nested，无单文件或浅层 package。
- 外部 profile vulnerability audit 需要发送生产依赖元数据且未获出站权限，本批不重复尝试，也不记为通过。
- 十档 artifact compatible；非 AI 六档精确不变，AI 四档 +8,893 bytes/+4 files/+0 loaded modules；最紧门仍未放宽。
- PostgreSQL HA Docker 门退出 0，Credential Test Connection 与最终 gate 全部通过。
- `git diff --check` 与新增文件尾随空白检查通过；只有稳定 facade 直接导入 owner subpath，没有 wildcard export 或外部 deep import。GitNexus 强制重建为 44,555 nodes/101,584 edges/1,741 clusters/296 flows。
- post-impact 中 `invalid` 保持 HIGH（18 direct/32 total/1 process），`exact` 与 `digest` 为 HIGH（12/25/1、8/24/1），result creator 为 HIGH（1/5/0）；公共错误为 MEDIUM（8/44/1），其余抽查的 endpoint/allowlist/plan/execution/result public operation 为 LOW。既有 `createAuthorized` 流程仍是唯一受影响流程，没有新增 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此结果只作 Git 基线补充。工作区无 staged change。

## 后续约束

`contractProtocol.ts` 不取得网络、Secret 或 storage authority；`endpointAllowlistProtocol.ts` 继续单独拥有 HTTPS/SSRF 边界；`planProtocol.ts` 只形成带 User/fence 的不可变授权事实；`executionResultProtocol.ts` 不加载 credential material，只描述执行与低敏结果。新增字段、digest domain、endpoint policy、retry/cost 或错误契约必须独立评审；新增 owner 文件必须同时满足内聚职责、非微文件和 Edge/Cluster artifact 门，不能自动新增 package。
