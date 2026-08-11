# ADR-0169：Project-bound AI Provider Credential Binding 与可清零 Secret Material

- 状态：Accepted
- 日期：2026-07-26
- 关联：RFC D-08、D-12、D-156、D-159；ADR-0073、ADR-0167、ADR-0168

## 背景

Model Gateway 已能在 durable `StepRun.kind=model` fence 下调用远程 Provider，但原有
OpenAI-compatible credential port 只返回一个无上下文的 authorization string：

- Provider 无法证明 credential 属于当前 Project；
- `listModels`、`generate` 和 `stream` 可能意外共用进程级 token；
- string 没有明确 material owner 或释放时点；
- Secret 轮换容易引入 cache、watcher 或重启要求；
- credential 获取失败和审计失败是否发生在网络请求前没有契约保证。

QingLong 3.0 同时面向低配路由设备与多副本 Cluster。解决方案不能把 AI contract
放入 `runtime-core`，也不能为 credential 再拆一个 workspace package。

## 决策

### 1. Binding 留在同一个 `@qinglong/ai` 能力包

新增显式 subpath `@qinglong/ai/provider-credential`，不新增 workspace package。
`ModelProviderCredentialBinding` 使用 exact-shape v1 contract，固定包含：

- `projectId`；
- Provider identity；
- binding revision；
- canonical Project-bound `SecretRef`；
- 首版唯一允许的 `bearer` scheme。

Binding 不保存 Secret 明文、token digest、authorization header、URL 或模型内容。
`SecretRef.projectId` 必须与 binding Project 完全相同。binding 的
domain-separated SHA-256 digest 可进入低敏审计，但不能据此恢复 Secret 名称或值。

### 2. Secret material 必须有单一 owner 和显式 dispose

AI package 只定义 structural `ModelProviderSecretMaterialProvider`：

- 输入是 exact Project 与 SecretRef，可携带 AbortSignal；
- 输出必须回显 exact SecretRef；
- plaintext 使用 consumer-owned `Uint8Array`；
- Provider 必须提供 `dispose()`；
- 缺失、身份漂移、形状漂移和 disposal 失败全部 fail closed。

`@qinglong/local-secret` 的 `EncryptedLocalSecretService` 提供结构兼容的
`resolveProjectSecretMaterial`：

- 复用既有 AES-256-GCM envelope、外置 keyring 和 canonical SecretRef；
- pinned ref 解析指定 version，unpinned ref 解析当前 version；
- 解密 key 在返回前清零；
- 返回的 plaintext bytes 由调用方 lease 最终清零；
- Project 不匹配、已取消、缺失 key/envelope 和 storage 错误均不返回明文。

Cluster 不复用本机 keyring；未来 KMS/Vault adapter 实现同一 structural port。

### 3. 每次调用重新解析，不缓存 credential

`BoundModelProviderCredentialProvider` 对每个 `list_models`、`generate` 或 `stream`
操作重新执行：

1. 以 Project + Provider 解析 binding；
2. 复验 exact binding 和 SecretRef Project；
3. 解析一次 Secret material；
4. 复制到短生命周期 bearer token buffer，并立即释放上游 material；
5. 写入 content-free credential audit；
6. 只在 audit 成功后交付 authorization lease。

未固定 version 的 SecretRef 因而在下一次调用自然取得当前 Secret version，不需要
watcher、timer、cache invalidation 或进程重启。每次调用最多解析一次，不自动 retry。

### 4. Authorization lease 只覆盖请求建立阶段

首版只接受 ASCII bearer token，完整 authorization header 不得超过 4 KiB。CR/LF、
空值、非 ASCII、空格、未知 scheme 和超限 material 都在网络前拒绝。

OpenAI-compatible adapter 向 credential provider 传递 operation、Provider、
Project、requestId 和 AbortSignal：

- credentialed `listModels` 缺少 Project 或 requestId 时 fail closed；
- adapter 在 `fetch` Promise 收敛后立即 dispose authorization lease；
- fetch 失败、HTTP 失败和 malformed lease 同样执行 dispose；
- disposal 失败时丢弃 response，不能把结果交给调用方；
- disposed lease 不再返回原 authorization string。

JavaScript/Fetch 内部不可证明所有 string copy 被原地清零，因此这里不声称拥有该能力。
受控边界是：原始 Secret 与 bearer buffer 可清零，authorization string 不持久化、不
进入 audit、repository 或日志，并只存活到请求建立完成。

### 5. Credential audit 必须先于外部网络

credential audit 只包含：

- schema、operation；
- Project、Provider、request identity；
- binding revision 与 binding digest；
- occurrence time。

不包含 SecretRef、Secret name、token、header、Prompt、模型输出或 raw error。
Audit sink 失败时，material 和 token buffer 都必须释放，OpenAI-compatible fetch
调用次数必须为零。

该 port 要求产品 composition 注入 durable sink；当前没有产品 importer，因此不能把
测试 sink 当成生产审计已经完成。

## 被否决方案

1. **进程级静态 API key**：无法按 Project 隔离，也无法证明 Run 使用了哪一条授权。
2. **把 token 放进 GenerateRequest 或 ModelInvocationContext**：transport、Trace 和
   replay record 会取得 plaintext authority。
3. **缓存解密后的 token 并监听轮换**：扩大常驻内存、后台任务和 stale credential
   窗口，低配设备也要付费。
4. **把 material contract 放进 runtime-core**：即使只有 `.d.ts`，默认 Edge archive
   也实测从 3,902,728 增至 3,903,377 bytes；该边界已撤回 AI package，默认基线恢复。
5. **为 credential 新增 workspace package**：没有独立部署收益，会再次产生过细包。
6. **声称 JavaScript string 可可靠清零**：不符合运行时事实；只约束可拥有的 byte
   buffer 和 string 生命周期。

## 验证

- `@qinglong/ai`：50 pass、1 条 PostgreSQL 条件 skip；
- `@qinglong/local-secret`：6 pass；
- binding normalization、Project fence、stable digest、exact subpath 通过；
- unpinned SecretRef 连续两次解析取得两个版本，没有 cache 或 watcher；
- missing/drifted binding、非法/非 ASCII/超限 material 全部 fail closed；
- audit failure 时 Secret material 已 dispose，OpenAI-compatible fetch 为 0；
- fetch failure 和 malformed authorization lease 均执行 dispose；
- cluster dependency audit 覆盖 22 importers、AI 14 个 TypeScript source，
  `findings=[]`；
- disabled Edge/Standalone/Cluster 仍只加载 1 个 AI module，storage/provider loader
  为 0；8 MiB RSS/50 ms 门通过；
- 默认 Edge archive 恢复并保持 3,902,728 bytes、478 files、40 modules；
- edge-ai 为 4,212,508 bytes、508 files、41 modules；
- standalone-ai 为 4,212,580 bytes、508 files、41 modules；
- edge/standalone application 为 4,547,398/4,547,530 bytes、589 files、87
  modules，仍低于 5 MiB/640 files 门。

## 后续门禁

> 2026-08-02 更新：第 1 项的 PostgreSQL durable catalog/audit、第 3 项的 projected
> Cluster material adapter，以及显式 Cluster AI 产品组合和独立供应链 artifact 已由
> [ADR-0263](./ADR-0263-explicit-cluster-ai-composition-and-provider-credential-authority.md)
> 完成。以下列表保留当时的演进上下文；仍未完成的是管理 ceremony、最终 KMS/Vault/HSM
> custody、真实 Kubernetes 纵切面与更广产品 route。

1. 为 credential audit 提供双方言 durable repository，并把 binding revision/digest
   与 ModelInvocation Start/Completion 查询关联；
2. 本机产品 importer 通过 `secret.use` Policy authority 注入
   `EncryptedLocalSecretService`，不得把 raw service 暴露给 transport；
3. Cluster 提供 PostgreSQL binding catalog 与 KMS/Vault material adapter；
4. binding 配置、轮换、撤销、测试连接和审计查询 ceremony；
5. durable usage/cost ledger、Project quota 和费用表；
6. 上述门完成前继续关闭 HTTP/MCP/UI 产品 route。
