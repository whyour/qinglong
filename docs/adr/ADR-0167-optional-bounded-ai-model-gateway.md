# ADR-0167：可选、受预算约束的 AI Model Gateway

- 状态：Accepted
- 日期：2026-07-26
- 关联：RFC D-07、D-12、D-13、D-156；ADR-0156、ADR-0157

## 背景

QingLong 3.0 必须同时覆盖低配路由设备和集群节点。AI 能力如果直接进入
`runtime-core`、本机 application 或 cluster-control 的默认依赖闭包，即使用户关闭
AI，也会承担 SDK、加载、内存和供应链成本；如果为每个 Provider、Gateway、Copilot
分别建立只有一个文件的 package，又会继续放大 workspace 拓扑和维护负担。

第一条 Phase 2 切片需要先建立真实、可测试的远程模型调用边界，但不能冒充产品
Copilot、MCP、credential 管理、持久化 Trace 或 UI 已经完成。

## 决策

### 1. 新增一个能力族 package，而不是多个技术层 package

新增 `@qinglong/ai`，当前包含：

- ModelProvider、request/result/chunk/usage、policy 与 audit contract；
- 请求驱动的 `BoundedModelGateway`；
- 零第三方 SDK 的 `OpenAiCompatibleProvider`；
- 复用 runtime-core StepRun 的 durable ModelInvocation contract；
- 双方言 feature migration、原子 repository、durable coordinator 与 bounded
  recovery；
- Project-bound provider credential binding、content-free credential audit 与
  可清零 authorization material lease；
- 非流式、SSE 流式和安全/资源契约测试。

这是新增 workspace package 的例外：它是可独立排除的安装、发布、加载和依赖边界，
且承载一个完整能力族，不按 interface、adapter 或厂商继续拆包。workspace importer
预算从 21 显式调整为 22，未知第 23 个 QL3 package 仍被 fail-closed 门禁拒绝。

该 package 只有一个 `@qinglong/runtime-core` workspace production dependency，没有
第三方 production dependency。依赖方向固定为 AI → runtime-core，以复用唯一
`StepRun.kind=model` 状态机；runtime-core 不得反向依赖 AI。源码审计继续禁止它导入
legacy 根、local、cluster、worker、数据库、Kubernetes、S3 或 HTTP SDK。现有
edge/standalone Profile 与 cluster image 都不依赖 AI，因此这个 workspace 依赖不会把
AI 带入默认产物。

### 2. 每次调用必须带完整运行身份与受信策略

每次 `generate` 或 `stream` 必须绑定：

- `projectId`；
- `runId` 与 `stepRunId`；
- `traceId` 与 `requestId`；
- 最长 5 分钟且可取消的绝对 deadline。

调用方不能在 request 中自报预算。Gateway 从 composition 注入的 policy provider
解析 provider/model allowlist、输入/输出字节、输出/总 token 和费用上限。费用策略
开启时，Provider 未返回费用也必须失败关闭，不能将 missing 解释为 zero。

进程内并发是资源盾牌，不是分布式 quota：达到上限立即返回
`MODEL_GATEWAY_BUSY`，不建立无界等待队列。Project 级 durable quota、跨副本费用和
并发裁决仍属于后续 repository/management plane。

### 3. 字节、token、流和审计都必须有硬边界

首版硬上限为：

- 最多 64 条 message；
- 每条 content 最多 64 KiB；
- 全部输入最多 256 KiB；
- 输出最多 1 MiB；
- 请求最多 32,768 output token；
- deadline 最长 5 分钟；
- 每个 Gateway 最多 8 个 Provider，进程并发配置最多 64。

策略只能在这些硬上限内进一步收紧。非流式结果必须返回一致的 usage；流式结束必须
提供 final usage，否则不能证明 token/费用预算，调用以协议错误收敛。Gateway 对每个
delta 累计 UTF-8 字节，不把完整输出缓存在内存。

Audit sink 只接收 Project/Run/StepRun/Trace/request identity、policy revision、
domain-separated request digest、输入/输出字节、usage、阶段与固定 error code。
Prompt 和模型输出不进入 audit record。admission audit 提交失败时，外部请求不得
开始；模型已经返回后 completion audit 失败时，结果不交给上层，不能把未审计调用
伪装为成功。

admission sink 可能是 durable start barrier，因此不得用 Abort race 让其在后台继续
提交。deadline 在 admission 期间到达时，Gateway 等待有自身数据库 timeout 的 sink
收敛；如果 start 已 durable，则立即追加 `timed_out` completion，且 provider I/O
保持为零。provider 调用期 deadline 与 caller abort 分别使用
`MODEL_INVOCATION_DEADLINE_EXCEEDED` 和 `MODEL_INVOCATION_ABORTED`，不能把两者
混为同一个失败事实。

durable admission 返回 `existing` 时 Gateway 必须抛出
`MODEL_INVOCATION_REPLAY_BLOCKED`，不得再次执行 provider。这个保守规则同时覆盖并发
重复请求、进程崩溃和 COMMIT 响应丢失；未知结果只由显式 recovery 收敛为
`lost/outcome_unknown`。

### 4. OpenAI-compatible adapter 保持远程、单次和有界

远程 endpoint 默认必须使用 HTTPS。只有显式配置的 loopback endpoint 可使用 HTTP，
用于本机模型服务；URL 不接受内嵌 credential、query 或 fragment。

Adapter：

- 每次从 credential provider 取得短生命周期 authorization header；
- authorization header 最多 4 KiB，拒绝 CR/LF；
- 每次 `generate` 只发送一个请求，不自动 retry；
- 不实现默认 fallback、cache、circuit breaker、timer、watcher 或后台 worker；
- 单响应或完整 SSE wire bytes 最多 8 MiB；
- `listModels` 最多接收 256 项；
- SSE parser 支持任意网络分片与 LF/CRLF event boundary，要求 `[DONE]`；
- stream 请求显式开启 usage，保留最后的 usage 供 Gateway 复验。

retry/fallback 会改变计费与副作用语义，必须在后续 durable invocation identity、
预算 ledger 和 Provider capability 完成后由 Gateway 决策，不能由 adapter 静默执行。

### 5. Profile composition 必须 disabled-first 且按部署规模付费

`@qinglong/ai/profile` 是同一能力包内的显式组合入口，不新增 workspace package。
它只接收 structural storage/provider loader，不反向依赖 local-sqlite、
cluster-postgres、local-application 或 cluster-control：

- disabled 时只验证 Profile 边界并记录 `disabled`，storage、provider 和 credential
  loader 调用次数必须为零；
- enabled 时固定执行 storage load/readiness → bounded incomplete recovery →
  provider/credential load → active，recovery 截断或失败时 provider credential
  仍不可达；
- Edge、Standalone、Cluster 默认并发分别为 1、4、32，单次 startup recovery 上限
  分别为 4、32、128；
- stop 先撤销新 admission。仍有 active operation 时只返回 `draining`，不创建
  timer/watcher；active operation 归零后按 provider → storage 反向释放；
- active result 只暴露受 gate 保护的 generate/stream/manual-resolution seam，不把
  raw repository、provider credential 或网络 authority 交给 transport。

这让小路由器保持 1 个并发、零后台任务，也允许 Cluster importer 注入共享
PostgreSQL authority。默认 Edge/Standalone application 和现有 cluster image 仍未
import 该入口；启用 AI 使用独立产物与门禁。

### 6. Credential 必须经过 Project-bound SecretRef 与短生命周期 lease

`@qinglong/ai/provider-credential` 在同一能力包内建立 exact binding、Secret
material structural port 和 content-free audit，不新增 workspace package。每次调用
按 Project + Provider 重新解析 binding 和 SecretRef；未固定 version 的 SecretRef
自然取得当前版本，不缓存 token、不创建 watcher。

material 使用 consumer-owned bytes 和显式 dispose。OpenAI-compatible adapter 只在
请求建立阶段持有 authorization lease，fetch 收敛后立即释放；audit 失败、malformed
lease 或 fetch 失败都不能遗留 material。credentialed `listModels` 必须提供 Project
与 request identity。

本机 `EncryptedLocalSecretService` 已提供结构兼容的可清零 material 解析，但正式
产品 importer、`secret.use` authority、durable credential audit，以及 Cluster
KMS/Vault adapter 仍属于后续门禁。详见 ADR-0169。

## 被否决方案

1. **把 ModelProvider 放进 runtime-core root**：禁用 AI 的设备仍承担依赖与加载耦合。
2. **为 Gateway 和每个厂商拆 package**：没有独立部署收益，继续制造单文件包。
3. **把 Provider 塞进 local-application 或 cluster-control**：两种 Profile 复制实现，
   并让常驻组合根默认取得外部网络与 credential authority。
4. **直接引入厂商 SDK**：首版协议简单，SDK 会显著扩大 edge 依赖与漏洞面。
5. **Provider 内自动 retry/fallback**：可能重复计费，也绕过 Project 预算与审计。
6. **只限制 token**：Prompt、HTTP response 和 SSE buffer 仍可按字节耗尽内存。
7. **记录 Prompt/输出以便调试**：默认扩大 Secret、日志和个人数据泄露面。

## 验证

- `@qinglong/ai` build/check/test 通过；
- 默认 suite 为 50 pass、1 条 PostgreSQL 条件 skip，另有 PostgreSQL 真库 1 pass，
  覆盖 generate、split-CRLF SSE、final usage、策略拒绝、字节/token
  budget、policy/provider deadline、无隐藏队列并发、consumer cancellation、
  cancellation-audit failure cleanup、durable admission 不脱离、provider identity、
  content-free audit、HTTPS/explicit loopback、单请求/响应上限，以及 ModelInvocation
  与真实 StepRun mutation chain、双方言原子 repository、独立 feature history、
  replay block、bounded recovery 和 PostgreSQL COMMIT-response-loss；
- frozen lockfile 已登记一个 runtime-core workspace dependency、零第三方生产依赖的
  importer；
- cluster dependency audit 覆盖 22 个 QL3 importer、AI 的 14 个源码文件且
  `findings=[]`；
- QL3 CI 在 runtime-core 后独立运行 AI contract suite，并在角色迁移后运行 AI
  PostgreSQL 真库门。

为证明“默认不包含 AI”，本轮重新执行了真实 package archive → offline production
install → import closure 门。原先所有 Profile 共用 4 MiB/512 files 会把基础 runtime
和完整 application 错当成同一档位：当前完整 application 已包含 Tool/Result 等现有
能力，实际超过 4 MiB，而这与 AI package 无关。因此基础 Profile 继续保持
4 MiB/512，`edge-application` 与 `standalone-application` 使用显式
5 MiB/640 files 门，RSS 上限仍保持 16 MiB：

- edge：3,902,728 bytes、478 files、40 loaded modules、10,878,976 bytes RSS
  delta；
- edge-application：4,544,802 bytes、589 files、87 loaded modules、
  16,187,392 bytes RSS delta；
- standalone-application：4,544,934 bytes、589 files、87 loaded modules、
  15,925,248 bytes RSS delta。

三份 package 清单都不含 `@qinglong/ai`。application RSS 已接近 16 MiB 门，因此后续
不能把 AI 直接接入默认 application；启用 AI 必须有独立产物/RSS 门，现有 application
继续增长前还应评估 runtime bundling、declaration pruning 或更窄的部署闭包。不能再
用提高同一个默认上限掩盖能力增长。

独立 AI Profile 制品和 disabled resource 门现已补齐：

- edge 基线重跑仍精确为 3,902,728 bytes、478 files、40 loaded modules；
- edge-ai 为 4,212,508 bytes、508 files、41 loaded modules、10,993,664 bytes
  RSS delta；
- standalone-ai 为 4,212,580 bytes、508 files、41 loaded modules、
  10,780,672 bytes RSS delta；
- 直接加载 `@qinglong/ai/profile` 只新增 1 个模块，本机观测 RSS 增量 409,600
  bytes；Edge/Standalone/Cluster disabled activation 最慢 0.159 ms，三者
  storage/provider loader 均为零；
- cluster dependency 与 deployment audit 均 `findings=[]`/`compatible=true`。

## 后续门禁

当前实现不进入任何 production Profile，也不开放 HTTP/MCP/UI route。进入产品前仍需：

1. credential binding 的双方言 durable audit、`secret.use` 产品 authority，以及
   Cluster KMS/Vault material adapter；
2. durable usage/cost ledger、低敏查询与 retention；
3. Project quota、费用表、路由、fallback 与 circuit breaker；
4. read-only Copilot 与 MCP Resource/Prompt/Tool 的授权入口；
5. cluster 多副本并发 quota 与 AI invocation 数据行级 HA fault；
6. 正式 Edge/Standalone/Cluster 产品 importer、配置 ceremony 与 route authority。
