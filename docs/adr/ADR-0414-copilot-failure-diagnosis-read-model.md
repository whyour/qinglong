# ADR-0414：Copilot 故障诊断请求键读模型

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-322、Phase 2
- 关联 ADR：ADR-0087、ADR-0409、ADR-0410、ADR-0411、ADR-0412、ADR-0413

## 问题

ADR-0413 已提供默认关闭的故障诊断写入口，但响应只返回低敏终态和加密输出 Artifact 引用。
部署者仍缺少两个产品能力：在连接中断或重放后按原请求查看诊断状态、取消事实和实际费用，以及在
具备 Artifact 读取权限时取得诊断正文。若客户端直接提交 Artifact、diagnosis Run、Model invocation、
provider/model 或价格信息，或者 CLI/UI 直连数据库与 application service，就会扩大枚举、越权、
密钥、计费和部署边界。

低配路由设备与集群节点仍必须使用同一产品契约但保持不同闭包：默认 Edge/Standalone 不能加载
Cluster Copilot；显式 AI Cluster 也不能因为读模型增加进程、端口、连接池、后台扫描或新 package。

## 决策

1. 增加两个 caller-driven、request-keyed 的只读端点：
   - `GET /api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses/{requestId}`，
     operation `copilot.failure_diagnosis.read`，permission `run.read`；
   - 同一路径追加 `/output`，operation `copilot.failure_diagnosis.output.read`，permission
     `artifact.read`。
   `runId` 始终表示 source Run；`requestId` 必须复用创建诊断时的 HTTP `x-request-id`。
2. 调用者不得提交 body、Artifact id/digest、diagnosis Run、Step、invocation、provider/model、
   price revision、usage、terminal outcome、Policy fence、key id 或密钥。服务从 admission plan、
   pre-Model terminalization、Model finalization、usage ledger、price settlement 与 encrypted output
   Artifact 派生全部事实。
3. 状态读取只投影 request/source/diagnosis Run identity、`running|terminal`、终态
   outcome/stage/reason、output availability、timestamps，以及该次 invocation 已耐久结算的
   input/output/total tokens、USD `costMicros` 或明确的 unknown。不得返回日志、Tool output、
   prompt、diagnosis 正文、provider/model、单价、price revision、Policy reasons、内部错误或密钥信息。
4. 输出读取只有在 exact admission、Project/source Run、finalization、Artifact 与 invocation 绑定全部
   一致时才解析 key。服务在 transport `artifact.read` 之后再次使用当前 Project Policy 对认证
   principal 授权；deny、approval、absent、cross-Project、cross-Run 和不匹配统一返回 `not_found`。
   存储/Policy/key/decrypt 异常统一为 unavailable，不向调用者泄露存在性或内部 message。
5. 输出正文只返回 reference 的低敏 identity/digest/size/sealed time，以及 `text`、finish reason 和
   usage；provider/model、key id、egress evidence、nonce、ciphertext、auth tag 与 plaintext buffer
   都不进入 HTTP 响应。resolved key 和所有临时明密文 buffer 必须在成功或失败路径擦除。
6. 状态读取不估算费用，也不从当前 catalog 反推历史价格。只有 invocation usage ledger 的耐久
   token facts 可见；只有 exact price settlement 与 usage 一致时返回 `currency=USD` 和
   `costMicros`，否则返回 `currency=null,costMicros=null`。pre-Model 终态固定为零 token、零费用，
   因为未发生 Model invocation；Model 路径在 settlement 尚未形成时明确为 unknown。
7. `running` 只表示已有 admission 且尚无任一耐久终态，不推断进程存活。取消仅投影既有
   pre-Model/finalization durable fact；本 Gate 不新增取消 mutation API，也不修改 source Run。
8. 两个 route 仅随 ADR-0413 的显式 AI Copilot 配置一起注入既有 Cluster Control route registry，
   但写能力与读能力保持接口隔离：`capability` 只执行诊断，独立 `readCapability` 只提供
   `inspect/readOutput`。两者复用同一认证、Project Policy、同步安全审计、TLS、限流、body/response
   上限和 lifecycle。普通 Cluster Control、Edge、Standalone 与未启用 Copilot 的 AI 进程仍没有
   这些 route。
9. 实现放在既有 `ql3-ai/src/copilot/failure-diagnosis/read-model` 与
   `ql3-cluster-control/src/copilot/failure-diagnosis` 内部目录，允许增加显式 package export subpath，
   但不得增加 workspace package。production composition 复用 ADR-0411 已建立的 admission/model/
   terminalization repository、Project Policy、output keyring 和同一个 AI PostgreSQL Pool；admission
   receipt 提供 authoritative `admittedAtMs`，plan 只提供 immutable execution binding。不得新增
   Pool/连接预算、进程、listener、timer、watcher、queue、cache、Pod、Service 或 Kubernetes 权限。
10. CLI、UI 与 MCP 后续只能调用这两个 HTTP API；不得读取 `ql3_ai` 表、Projected keyring 或直接
    import production/application capability。

## 状态投影

| 耐久事实 | 状态 | stage/reason | usage/cost |
| --- | --- | --- | --- |
| admission，尚无终态 | `running` | `null/null` | `null` |
| pre-Model terminalization | `terminal` | receipt stage/reason | 零 token、USD 零费用 |
| Model finalization | `terminal` | `model/null` | ledger 可缺失；存在时必须 exact，价格未结算时 cost unknown |

同时出现两个终态、终态与 plan/invocation 不一致、usage/settlement 不一致或成功终态缺少 exact output
均视为存储 authority 冲突并失败关闭，不向 HTTP 暴露哪项事实异常。

## 被否决方案

1. **按 Artifact id 直接读取**：要求调用者保存内部引用，并扩大跨 Project 枚举面。
2. **一个 `run.read` 端点同时返回正文**：把低敏运行可观测性升级为 Artifact 内容读取。
3. **返回 provider/model、单价和完整 settlement**：泄露平台配置，且不是诊断消费所必需。
4. **用当前价格目录估算历史费用**：无法证明历史 revision，重放结果会漂移。
5. **新增 Copilot query service/package/数据库 Pool**：没有独立部署边界，并增加小设备和集群资源成本。
6. **后台物化查询表或轮询终态**：现有 request-keyed index 与 durable receipts 已能有界点查。
7. **本 Gate 同时增加取消写入口**：会引入新的 mutation、幂等和恢复协议，应单独评审。

## 验证标准

1. AI 单元测试覆盖 request/project/source binding、running、pre-Model cancel/failure、Model success/
   failure、usage/price exactness、双终态冲突、deny/absence/cross-target masking、未知 key、tamper、
   解密成功和 key 擦除。
2. route 测试覆盖无 body、path validation、`run.read` 与 `artifact.read` 分权、响应脱敏、404 masking、
   503 fail-closed，以及拒绝路径零 capability call。
3. production composition 测试证明三条 Copilot route 只随显式 AI capability 一起注入，复用同一
   Pool/repository/key authority；默认 route allowlist 和普通 Cluster Control 不变。
4. package/dependency/import/deployment 审计证明 workspace package、默认 Edge/Standalone 闭包、
   进程、端口、Pool、Pod、Service 与 Kubernetes 权限无增长。
5. 18-package clean build/test、完整 backend、Local artifact、PostgreSQL 18 physical HA 与
   GitNexus staged/change detection 全通过后才允许 D-322 阶段性提交。

## 接受证据

- AI：252 tests，249 pass、3 条件 skip、0 fail；Cluster Control：258 tests，256 pass、2 条件
  skip、0 fail。新增覆盖 partial admission authority、双终态冲突、跨 Project/source masking、
  current Policy deny、usage/settlement 一致性、密文 tamper、解密成功和 key 擦除。
- 18-package clean build/test 退出 0；backend 1,209 tests，1,207 pass、2 条件 skip、0 fail。
  package boundary 保持 18 个 package、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；AI
  193 个源码中 192 个、Cluster Control 62 个源码中 60 个位于嵌套领域目录。
- edge import、cluster dependency、package boundary、cluster deployment 四项审计均无 finding。
  14 档 Local artifact 全通过；默认 Edge/Standalone 保持 2,589,890/2,589,968 bytes，
  Edge/Standalone AI 为 3,069,143/3,069,233 bytes。
- PostgreSQL 18.6 arm64 physical HA 139/139、timeline `1→2`；成功 Model output 在 standby 解密读取，
  提升后按 request id exact replay 且 provider 调用为零。owner-private 报告 SHA-256 为
  `22decb54cfb8735bf787fe0665c877c201fc7b44d3c3de16fdbfdab31b7ac2cd`，独立离线审计
  `compatible=true/findings=[]`。

## 后续门禁

本 Gate 不提供诊断列表、取消 mutation、unknown outcome 人工裁决、外部 Provider 实测、CLI、UI
或 MCP。真实 Provider、双副本并发/故障注入和产品客户端必须继续保持独立 Gate。
