# ADR-0403：有界、脱敏且不授予行动权的 Run 日志尾部 Tool

- 状态：Accepted
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-311、Phase 2
- 关联 ADR：ADR-0347、ADR-0377、ADR-0400、ADR-0401、ADR-0402

## 问题

失败日志解释需要向模型提供足够的执行上下文，但 Run 日志同时具备四类风险：体积可能无界，
可能包含 credential 或任意业务敏感数据，内容本身可能携带 Prompt 注入指令，而且日志在读取
过程中仍可能增长。把文件路径、Artifact ID、任意 offset/length 或 cursor 交给模型，会使读取
成本和泄露面不可证明；把整份日志读入内存再截断，也不适合只有很少内存与闪存的路由设备。

ADR-0377 已提供 profile-aware、Project-scoped 的 Run Attempt 日志 range reader：Local 使用私有
Artifact 文件，Cluster 使用 S3 兼容对象存储。为 AI 再建设一套 SQLite/PostgreSQL/对象存储
reader 会形成双重真源、额外连接与 package 碎片；直接把原始 range reader 暴露给模型则绕过了
脱敏和不可信内容边界。

## 决策

1. 增加 `qinglong.run.log.excerpt@1.0.0`。输入精确为 `runId`、`attemptId`，Project 只来自
   受信 execution context；不接受 Artifact ID、路径、URI、bucket/key、offset、length、limit、
   cursor 或查询表达式。Definition 固定为 `read/medium`、`artifact.read`、5 秒 deadline。
2. Tool 只选择日志尾部。第一次以 `Number.MAX_SAFE_INTEGER` 和 1 byte 对既有 range reader 做
   总长度探测，第二次从 `max(0, probedTotalBytes - profileWindow)` 读取固定窗口；单次调用最多
   两次读取，不循环、不分页，输出也不提供 `nextOffset`。窗口固定为 Edge 4 KiB、Standalone
   8 KiB、Cluster Control 16 KiB；Worker profile 拒绝装配。
3. 输出以 `consistency=bounded_tail_probe_then_range_read` 明确表达两次独立读取，不声称事务
   快照。若第二次读取时日志增长或长度发生变化，`selection.tailComplete=false`；调用方不得把
   该片段解释为当时完整尾部。
4. 原始 bytes 先以非致命 UTF-8 解码，并显式报告 invalid UTF-8；CRLF/CR 归一为 LF，终端 C0、
   DEL、零宽字符和双向文本控制符替换为 U+FFFD，避免终端控制与视觉重排。最坏情况下每个
   source byte 可扩张为三字节 U+FFFD，因此模型文本硬上限分别为 12/24/48 KiB。
5. `recognized_credentials_v1` 以确定性、保持或缩短字符数的掩码处理 Authorization、常见
   credential assignment、PEM private key、URL userinfo、JWT、云访问密钥和常见 opaque token。
   输出必须携带命中的类别与次数，同时永久标记
   `residualSensitivity=potentially_sensitive`：该规则只能识别约定格式，不能宣称任意业务秘密
   已被证明移除。
6. 所有日志内容无条件标记为 `untrusted_execution_output`、
   `data_only_never_execute`、`actionAuthority=none`。启发式检测 instruction override、role
   impersonation、secret exfiltration 与 tool coercion 只用于提示与审计；真正安全边界是日志
   永远只作数据、Tool Policy/Approval 独立裁决，不能让日志文字授予任何 Tool 或命令权限。
7. Trusted adapter 必须同时绑定 reviewed Definition、显式 profile、`artifact.read` 与
   `database.read` authorities、redaction/audit contract，恢复模式为 retry-safe read。任何
   binding 漂移、跨 Project/Run/Attempt 返回、畸形 range、超预算内容或底层错误均失败关闭。
8. 复用 Runtime Core 的 `RunAttemptLogReadService`、Local 的
   `LocalRunAttemptLogRangeReader` 与 Cluster 的 `S3ClusterRemoteWorkerArtifactStore`；本阶段
   只交付共享 Trusted Tool kernel，不提前开放 MCP、HTTP 或 Cluster Copilot 产品入口。后续
   composition 必须重新经过认证、Policy、durable audit、credential fence 与完整 Trusted Tool
   completion 门禁。

## 低配、集群与 package 布局

- 默认 Edge/Standalone 不新增 daemon、listener、timer、watcher、cache、连接、migration、表或
  索引；未装配 AI/MCP 时显式 subpath 应从发布制品中裁掉。单次调用只保留一个 4/8 KiB source
  window 和至多三倍的规范化文本。
- Cluster Control 使用调用方已有对象存储 client 和元数据查询链，不新建 PostgreSQL pool 或
  S3 client；16 KiB 窗口仍保持固定两次对象读取。Worker 不具备模型上下文投影能力。
- workspace package 保持 18 个。新能力放入 Runtime Core 既有
  `run/log-projection/` 与 `tool-execution/builtin-run-log-excerpt/`；Local/Cluster 只增加对既有
  adapter 的集成证明，不创建单文件微型 package，也不回到 `src` 根目录平铺。
- Runtime Core 只提供三个精确 subpath，package root 不导出日志 Tool，避免无意扩大默认入口。

## 被否决方案

1. **返回整份日志后在 Prompt 层截断**：存储、内存、网络和模型输入均可能无界。
2. **让模型传 offset/length 或 cursor**：模型可以循环扩大读取范围，低配成本与泄露面不可证明。
3. **只读固定头部**：失败原因通常出现在尾部；头部还更容易包含启动环境和 credential。
4. **只依赖正则并标记“已安全”**：任意业务秘密不可穷举，因此必须保留 residual sensitivity。
5. **把 Prompt 注入检测当授权边界**：启发式存在漏报；内容无行动权和独立 Policy 才是边界。
6. **返回原始内容哈希**：对低熵日志可形成额外指纹，不是解释失败所需字段。
7. **新建 AI Artifact reader/package**：会重复 ADR-0377 真源并加剧 package 碎片。

## 当前验证

1. Runtime Core 定向测试覆盖七类 credential、Prompt 注入 taint、invalid UTF-8、控制与 bidi
   字符、最坏三倍扩张、三档预算、Worker 拒绝、固定两次尾读、增长竞态、无 cursor、非内容
   状态、畸形存储、严格输入与 Definition/binding 漂移。
2. Local 集成以真实私有 Artifact 文件经 `LocalRunAttemptLogRangeReader` →
   `RunAttemptLogReadService` → Tool 验证只读取尾部并脱敏；Cluster 集成以真实 S3 adapter 请求
   链验证相同共享投影，不引入第二实现。
3. 最终 18-package clean build/test 退出 0；backend 1,208 项为 1,206 pass、2 条平台条件
   skip、0 fail。package/dependency/Edge import/Cluster deployment 审计零 finding；package 保持
   18 个，`singleSourcePackages=[]`、`shallowSourcePackages=[]`，Runtime Core 为 168/167 nested。
4. 14 个 Local Profile 制品门全部通过。默认 Edge 为 2,589,812 bytes/315 files/56 modules，
   证明未装配的新精确 subpath 被完全裁掉；Edge AI 为 3,121,108 bytes/368 files/61 modules，
   Edge MCP 为 7,237,187 bytes/795 files/220 modules。对应 RSS 增量分别为 10,977,280、
   11,108,352、38,010,880 bytes，均在各自 16/16/48 MiB 门内。
5. PostgreSQL 18.4 arm64 HA 125/125 Gate 通过，timeline `1→2`，报告 SHA-256 为
   `1a0df2518d39db22ecf4bbaf2e06c9e6893e1bbf507b4026b2e0ef055eb2fd90`；容器、网络与卷零残留。

## 后续门禁

1. 可选 Local MCP 与 Cluster Copilot composition 接入，分别证明认证、Policy、durable audit、
   credential fence 和 Trusted Tool encrypted completion；
2. 在最终 Prompt builder 中以结构化 delimiter 固定日志为 untrusted data，并把 residual
   sensitivity 纳入模型 egress policy；
3. 增加 SecretRef-aware 的精确脱敏与固定物理 Edge 单次读取延迟/RSS 证据，但不得因此把
   v1 的 residual sensitivity 改成“安全”。
