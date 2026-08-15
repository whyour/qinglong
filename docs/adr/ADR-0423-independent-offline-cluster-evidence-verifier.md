# ADR-0423：独立、离线且无 Authority 的 Cluster Evidence Verifier

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-331、Phase 2
- 扩展：ADR-0422

## 背景

ADR-0422 的浏览器生成器能计算 evidence bundle 顶层 SHA-256，但同一段浏览器代码自验只能发现传输后的普通改写，不能独立证明固定结构、脱敏字段和 typed alias 约束没有被放宽。把 bundle 上传到 Cluster、第三方 SaaS 或新的服务端 verifier 会重新引入网络、credential、持久化和来源混淆；为一个文件校验器再拆 workspace package 也会扩大低配设备元数据与供应链审计面。

## 决策

1. 在既有 `@qinglong/cluster-admin` 的 `copilot-console/` 职责目录实现独立 TypeScript verifier，通过 `ql3-cluster-admin evidence-verify --bundle=/absolute/evidence.json` 和同包 direct binary `ql3-copilot-evidence-verify` 交付。它是第 11 个静态产品命令，不新增 package、生产依赖、route、listener、数据库、对象存储、Kubernetes workload 或常驻进程。
2. verifier 只读取一个用户显式给出的 canonical absolute regular file。它使用 read-only、no-follow descriptor，限制路径为 4 KiB、文件为 512 KiB，并在读取前后复验 device/inode/mode/owner/size/time；不读取 stdin、environment 或 operator context，不建立网络连接，不写文件。
3. 输入必须是 fatal UTF-8、无 BOM、固定 two-space pretty JSON 且带单个末尾换行。JSON round-trip 必须逐字节相等，从而拒绝 duplicate key、CRLF、minified/alternate whitespace 和非规范序列化。
4. verifier 独立重写并固定校验 `qinglong/cluster-console-redacted-evidence-bundle@v1` 的 exact shape、13 个 operation/request field 集合、1..16 entries、8 MiB raw canonical 总量、64-item array、16-depth/256-key 上限、安全 enum/boolean/number/container allowlist、顺序 typed alias 与固定无 authority 声明。未知字段、自由文本、错误/message、路径、credential、model output 或虚假 signature/attestation 均失败关闭。
5. verifier 独立 canonicalize 不含 `contentDigest` 的 bundle 并重算 SHA-256，返回 `qinglong/cluster-console-evidence-verification@v1`。结果只声明 `bundleDigest=verified`；由于 bundle 刻意不携带原始 fact，逐条 `rawFact.sha256` 明确为 `not_recomputed_without_raw_facts`。`serverSignature|attestation|durableAudit` 均为 `not_verified`，`actionAuthority=none`。
6. 成功输出只含 schema、digest、entry/byte count 与上述 limitation；失败输出只含稳定 code 和通用消息，不回显文件路径、原始标识或输入内容。usage/invalid 分别退出 64/65。
7. verifier 只随 Cluster Admin npm/OCI 分发，继续不进入 Edge、Standalone、AI 或 MCP Local artifact closure。它不把浏览器观察升级为集群来源证明，也不替代 release signature/provenance 或人工审阅。

## 不选择

- **复用浏览器生成器作为 CLI verifier**：会让生成和验证共享同一实现错误，缺少真正的交叉实现证据。
- **把原始 fact 一并放进 bundle 以复算逐条 digest**：会重新泄漏本门刻意剔除的用户命名、路径、错误和模型文本。
- **服务端上传验证**：需要新 route、网络和保存策略，并容易被误解为服务端背书。
- **单独拆 `@qinglong/evidence-verifier` package**：没有独立部署或依赖边界，反而违反 18-package 硬上限和包内领域目录策略。

## 验收

1. 浏览器生成器输出必须由独立 verifier 接受；digest 改写、即使重新签顶层 digest 的结构扩宽、alias gap、虚假证明、总量/sequence 漂移必须拒绝。
2. BOM、CRLF、minified、duplicate-key、relative path、symlink 和超限文件必须拒绝；成功/失败 CLI 都不得回显输入路径和私有样本。
3. Console 架构审计必须拒绝 verifier 的 network、write、stdin 和 environment authority；package boundary 必须保持 18 packages、零 single/shallow package。
4. 真实 Admin image 必须在 non-root、read-only root、network none、drop ALL、no-new-privileges、128 MiB、0.25 CPU、32 PIDs 下完成有效验证、tamper rejection 和零 verifier file write。
5. Cluster Admin、18-package、backend、npm pack、dependency/deployment/release 与全部 Local artifact 门通过后才接受本决策。

## 验收结果

2026-08-16，D-331 完成以下发布门并接受本决策：

- 生成器/独立 verifier 与产品/架构审计定向门 18/18；Cluster Admin 完整测试 387 pass、3 条件 skip、0 fail，18-package clean build/test 退出 0，backend 1,225 pass、2 条件 skip、0 fail。
- 有效浏览器 bundle 的结构、typed alias、顶层 digest 与 limitation 由独立 TypeScript 实现验证；tamper、重新计算顶层 digest 后的自由文本扩宽、alias gap、虚假 server signature、raw byte/sequence 漂移，以及 BOM/CRLF/minified/duplicate-key/symlink/relative/oversize 输入全部失败关闭。成功和失败输出均未泄漏私有文件名、路径或原始标识。
- 真实 arm64 `qinglong3-cluster-admin:d331-local` 为 344,567,527 bytes；在 UID/GID 10001、只读根、network none、drop ALL、no-new-privileges、0.25 CPU、128 MiB 与 32 PIDs 下通过 11 个产品命令、原生/host-published Console、有效验证、tamper rejection 和 verifier 零额外文件写。
- npm pack dry-run 为 250 files、271,238-byte tarball、1,690,196-byte unpacked。package/dependency/Edge import/Cluster deployment/image release/Console/distribution 审计零 finding；workspace 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`，1,201 个源码中 1,183 个位于职责目录，Cluster Admin 为 122/121。
- 14 档 Local artifact 全部 compatible；默认 Edge/Standalone 精确保持 2,589,890/2,589,968 bytes、315 files、56 modules，application+AI 保持 4,493,043/4,493,175 bytes，MCP 保持 7,315,930/7,316,038 bytes，证明 verifier 没有进入路由设备闭包。
- 本门没有 schema、migration、SQL、role、Pool 或连接拓扑变化，因此不重复冒充执行 PostgreSQL HA；复用紧邻 D-330 已完成的 PostgreSQL 18.6 arm64 142/142、timeline `1→2` 物理 HA 基线。下一独立门仍是公开 release digest 的外部工作站验证 ceremony，而不是给 verifier 增加上传、签名或行动能力。
