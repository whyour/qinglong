# ADR-0405：有界故障诊断 Prompt 与显式模型出口策略

- 状态：Accepted
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-313、Phase 2
- 关联 ADR：ADR-0163、ADR-0164、ADR-0165、ADR-0166、ADR-0403、ADR-0404

## 问题

ADR-0403 已把 Run 日志尾部收敛为 profile 固定、有界、识别型凭据遮蔽且无行动权的投影，
ADR-0404 已提供显式可选的本机 MCP 入口；但该投影仍永久声明
`residualSensitivity=potentially_sensitive`。直接把 `content` 插值到自由 Prompt，会同时留下三类
缺口：日志中的角色伪装或 delimiter 可以与产品指令混在一起；通用 Model Gateway 的
provider/model/额度策略并不等于数据出口策略；模型输出继承输入敏感度，却可能被调用方误写入
明文审计或普通完成记录。

这一边界对低配设备和 Cluster 同样重要。Edge 可能只允许设备内模型或完全关闭日志诊断，
Cluster 则可能允许特定外部模型；若把其中任一部署偏好写死在通用网关或日志投影中，会让共享
kernel 取得不属于它的产品配置 authority。为一个 Prompt builder 新建 workspace package，又会
重现已经关闭的微型 package 问题。

## 决策

1. 在既有 `@qinglong/ai` 增加精确 subpath `failure-diagnosis-prompt`。实现进入
   `src/copilot/failure-diagnosis/{contracts,validation,prompt}.ts`，不从 package root 导出，
   不新建 package，也不把文件平铺到 `src/` 根。
2. builder 只接受 ADR-0403 的完整 `RunLogModelContextProjection`，并重新校验 exact shape、
   profile-specific source/text byte budget、实际 UTF-8 byte count、canonical redaction categories、
   trust contract、Prompt injection signal 顺序及 flag 一致性。任何 `safe` sensitivity、行动权、
   未知字段或 byte drift 均失败关闭。
3. 模型请求固定为两条 message：不可变 system instruction 与一个 canonical JSON user envelope。
   日志只存在于 `log.content` JSON string value；引号、换行、伪造角色或 schema 文本由 JSON
   escaping 留在该值内，不能拼接出新的 message、role 或产品指令。envelope 不包含 Run/Attempt、
   Artifact、path、cursor 或 content digest。
4. system instruction 固定声明日志是 `data_only_never_execute` 的不可信执行数据，禁止 Tool call、
   命令执行、状态修改、凭据复述和超出 envelope 的事实主张。Prompt injection 信号只进入
   content-free evidence，未命中不代表内容安全，命中也不能授予或撤销行动 authority。
5. 调用方必须显式提供 `qinglong/copilot-model-egress-policy@v1`。策略以 canonical allowlist
   分别裁决 `on_device` 与 `external` 是否可接收 `potentially_sensitive` 数据，并同时限制总输入
   bytes 和最大输出 token；没有策略、空 allowlist、边界未列入或预算超限都必须在 Model Gateway
   与 Provider I/O 前失败关闭。不存在默认允许外部出口的 fallback。
6. builder 返回 content-free egress evidence：只含 policy revision、模型边界、trust/sensitivity、
   redaction 计数、注入提示和预算，不包含日志、ID、路径、参数或内容哈希。该 evidence 是组合层
   的审计输入，不是模型调用成功或数据已安全的声明。
7. completion requirements 固定为 `residualSensitivity=potentially_sensitive`、
   `persistence=encrypted_only`、`plaintextAudit=forbidden`、`actionAuthority=none`。本阶段只交付
   生成请求前的纯 kernel；Cluster 产品组合必须用 ADR-0163~0166 的 Trusted Tool 和 encrypted
   completion authority 兑现这些要求，不能把声明本身当作完成证据。
8. builder 只生成现有 `GenerateRequest`，temperature 固定为 0，不调用 Provider、不持久化、不读取
   credential，也不创建 connection、listener、timer、watcher、cache、migration、表或索引。

## 低配与集群影响

- 默认 Edge/Standalone 未通过精确 subpath 装配时继续完全裁掉该 capability；空 boundary
  allowlist 可在不创建后台组件的前提下关闭日志诊断。单次只处理 ADR-0403 已限定的 4/8 KiB
  source window，最终 request 仍受 64 KiB 硬上限。
- Cluster Control 可使用 16 KiB source window，但 `external` 必须由部署者策略显式列入；该策略
  不由模型、日志、HTTP caller 或 Tool output 自行选择。
- workspace 保持 18 个 package。新增三个同一 capability 的内聚文件和一个测试文件；没有
  单文件 package、第三方依赖、默认 Profile 入口或常驻进程。

## 被否决方案

1. **字符串模板直接包裹日志**：delimiter 可以出现在日志中，无法证明角色与数据边界。
2. **只依赖 Prompt injection 检测**：启发式存在漏报，未命中不能作为出口许可。
3. **复用通用 Model Gateway Policy 作为出口策略**：provider/model/费用许可不表达数据边界与
   residual sensitivity，职责不同。
4. **默认允许 external，再由 UI 提醒**：无 UI、API retry、后台触发或错误组合都会绕过提醒。
5. **对日志做内容哈希并持久审计**：低熵内容可能形成额外指纹，出口证据并不需要内容哈希。
6. **把模型输出标成 low-sensitive**：输出可能复述或推断输入内容，必须继承潜在敏感声明。
7. **新建 Copilot workspace package**：没有独立制品、authority 或部署生命周期收益，只会扩大
   importer、manifest、SBOM 与维护面。

## 当前验证

1. 新增 12 项定向测试，覆盖精确公开 subpath、canonical JSON envelope、role/delimiter 注入文本、
   禁止 identity/Artifact/path/cursor/digest 字段、external 默认拒绝与显式允许、空 allowlist、
   canonical policy、输入/输出预算、三档 profile budget、伪造 trust/sensitivity、signal/flag 漂移和
   未知字段。
2. `@qinglong/ai` 完整测试为 221 pass、3 条 PostgreSQL 条件 skip、0 fail；最终 18-package clean
   build/test 通过，backend 1,209 项为 1,207 pass、2 条平台条件 skip、0 fail。
3. package boundary、dependency、Edge import 与 Cluster deployment 四项审计均零 finding；workspace
   仍为 18 package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`，AI 为 160 source、1 root/
   159 nested。
4. 14 个 Local Profile artifact 全部通过。默认 Edge/Standalone 保持 2,589,812/2,589,890 bytes、
   315 files、56 modules；Edge/Standalone AI 保持 3,121,108/3,121,198 bytes、368 files、61 modules，
   证明未装配的精确 subpath 被发布投影完全裁掉；MCP 也保持 7,315,930/7,316,038 bytes、801 files、
   226 modules。
5. PostgreSQL 18.4 arm64 HA 125/125 Gate 通过，timeline `1→2`，报告 SHA-256 为
   `2bbc8bdd0d90e6ec9ce82d2afcaec817679dddb82860c5d405a09d5e5458bece`；独立证据审计零 finding，
   专用容器、网络与卷零残留。

## 后续门禁

1. Cluster Copilot composition 从受认证请求创建 Trusted Tool invocation，使用现有 PostgreSQL/S3
   authority 获得日志投影，并以产品级 result-key provider 完成 encrypted Tool completion；
2. 组合本 ADR builder、现有 Model Gateway 与 encrypted model completion，证明 policy/audit/
   credential fence、response-loss replay 和 plaintext audit 禁止项；
3. Local Copilot 若复用本能力，必须独立选择 `on_device|external` 策略，不能从 MCP admission
   推导模型出口许可；固定物理 Edge 仍需补单次延迟和 active RSS 证据。
