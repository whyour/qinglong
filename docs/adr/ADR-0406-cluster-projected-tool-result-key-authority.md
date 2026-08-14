# ADR-0406：Cluster Projected Tool Result Key Authority

- 状态：Accepted
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-314、Phase 2
- 关联 ADR：ADR-0163、ADR-0164、ADR-0166、ADR-0263、ADR-0403、ADR-0405

## 问题

ADR-0163~0166 已完成 Trusted Tool 成功结果的加密 Artifact、PostgreSQL catalog fence、rotation/
rekey/retirement 协议和双方言 repository；Cluster runtime 也已经从同一 Pool 装配 completion、catalog
与 rekey storage。但产品组合只有 storage port，没有可部署的 result-key material provider，因此
ADR-0405 的日志 Tool 还不能在 Cluster 中兑现 encrypted completion。

直接复用 Plugin Package Prompt output keyring 会混合两种密文域和轮换 ceremony；让投影文件携带
`activeKeyId` 又会与 PostgreSQL `trusted-tool-results` catalog 形成双 active authority。把 key 写入环境
变量、数据库或常驻缓存，则分别失去文件权限/轮换证明、违反数据库不保存 material 的约束，或引入撤权
窗口。该能力也不足以形成新的部署制品或 workspace package。

## 决策

1. 在既有 `@qinglong/cluster-control` 的 `src/trusted-tool/key-management/` 中增加 Cluster Tool Result
   projected keyring，并只通过精确 subpath `trusted-tool-result-keyring` 导出。它不进入 package root、
   默认 control composition、Edge/Standalone 或普通 Worker closure。
2. manifest 固定为 `qinglong/cluster-tool-result-projected-keyring@v1`，只含 canonical `keys` map；key ID
   沿用 Runtime Core catalog 约束，material 必须是 canonical base64url 的 32 bytes。投影最多包含 16 个
   key，与 catalog 的最大 decryptable key 数一致；文件最大 64 KiB 且必须是单行 canonical JSON 加换行。
3. manifest **没有** generation、active key、state、retirement 或恢复字段。provider 只实现 `resolve(keyId)`，
   不实现 `active()`；当前加密 key 与历史可解密状态只能由 PostgreSQL catalog 的 generation/digest/
   material proof fence 决定。投影文件增删 key 不能自行改变 durable catalog 状态。
4. `verify()` 只返回 key ID、Runtime Core domain-separated material proof 和整个投影的 content-free digest，
   不返回 encoded/raw material。Trusted Tool completion 仍会在每次使用时以 catalog entry 的 proof
   重新校验 material，调用完成后由既有 coordinator 清零 owned key bytes。
5. runtime 每次 resolve 都重新打开投影，不使用 Kubernetes API、ServiceAccount、list/watch、cache、timer
   或后台进程。允许 Kubernetes atomic-writer symlink，但 resolved regular file 必须留在 direct、非 symlink
   root 下；同时校验 single-link、大小、只读/不可执行/other-inaccessible mode、dev/inode/size/mtime 和
   root/target 二次 realpath，轮换竞争失败关闭。
6. Cluster Control 内原有 mounted Secret provider 与新 keyring 共享 package-private
   `security/privateProjectedFile` primitive。原公开类、错误码、文件名、大小和权限语义不变；抽取消除两套
   TOCTOU/symlink 实现，后续安全修正只有一个真源。该 primitive 不新增公开 export。
7. 本阶段不增加环境变量、volume、route 或 AI 启动前置条件。只有后续 Cluster Copilot composition 明确
   启用并把该 provider 与 PostgreSQL catalog、Trusted Tool coordinator 连接时，部署者才需要投影它；
   adapter 存在不等于执行 authority 已开放。

## 低配与集群影响

- 默认 Edge/Standalone 和默认 Cluster Control 没有新 importer、listener、连接、timer、watcher、cache、
  migration、表或常驻内存；workspace 继续保持 18 个 package。
- Cluster AI 后续只在一次 Tool completion 时读取最多 64 KiB 的一个 manifest，内存 key 数硬限 16；
  PostgreSQL 继续是 active/decryptable state 的唯一事实源。
- 实现使用既有 package 的嵌套领域目录，不创建单文件 package，也不把文件平铺到 `src/` 根。

## 被否决方案

1. **复用 Prompt output keyring/root**：跨加密域复用 material 与 rotation ceremony，扩大单 key 泄露半径。
2. **manifest 自带 activeKeyId**：会让文件和 PostgreSQL catalog 同时选择 active generation。
3. **把 raw/wrapped key 放进 PostgreSQL**：违反 ADR-0166 的 catalog/material 分离与数据库最小泄露面。
4. **使用环境变量或进程缓存**：缺少轮换文件身份，且产生撤权窗口和长期明文驻留。
5. **为 provider 新建 workspace package**：没有独立进程、制品、权限角色或第二个生产 consumer。
6. **复制 mounted Secret 的安全读取代码**：会让 symlink、mode 与 TOCTOU 修复发生行为漂移。

## 当前验证

1. 新增 3 项 keyring 测试，覆盖无 `active()` authority、material proof、owned bytes、原子投影轮换、
   historical/missing key、非 canonical JSON、错误 key 长度、可写文件、逃逸 symlink、symlink root 和路径逃逸。
2. 共享 projected-file 抽取与既有 mounted Secret 回归合计 7/7；Cluster Control 完整测试为
   234 pass、2 条 PostgreSQL/S3 条件 skip、0 fail。
3. `pnpm run test:packages:ql3` 完成 18-package clean build/test；完整 backend 为 1,207 pass、2 条
   条件 skip、0 fail。package boundary、Cluster dependency、Edge import 与 Cluster deployment 四项审计
   均为 compatible 且零 finding。
4. workspace 仍为 18 个 package，无单文件或浅平 package；Cluster Control 共 54 个源码文件，只有
   `aiCli.ts`、`cli.ts` 两个 binary entry 位于 `src/` 根，其余 52 个均处于嵌套领域目录。
5. 14 档 Local Profile artifact 全部通过；默认 Edge/Standalone 为 2,589,812/2,589,890 bytes，
   AI 为 3,121,108/3,121,198 bytes，MCP 为 7,315,930/7,316,038 bytes。证明新增 Cluster-only
   subpath 没有进入低配设备的本地闭包。
6. PostgreSQL 18.4 arm64 HA 为 125/125 Gate、timeline `1→2`；报告 SHA-256 为
   `26c817647ed984d8d4627a7cae1c95de06017a5d6d32dd3dfd01414ba029e542`，独立证据审计零 finding，
   Docker 容器、网络与卷零残留。

## 后续门禁

1. 定义独立 Copilot diagnosis Run admission，在同一诊断 Run 中创建 Tool Step 与 Model Step；不能把 Tool
   Step 追加到已终态的源失败 Run，也不能借用 Plugin Package Prompt plan 冒充 Copilot plan。
2. 组合 Project Tool snapshot、invocation Artifact key、S3 log reader、result-key provider 和统一 Trusted
   Tool completion，证明 response-loss replay 不会重复执行 adapter。
3. 将 ADR-0405 builder 与现有 Model Gateway 连接，并建立 Copilot 专用 encrypted model completion；
   禁止把 live response、普通 model completion 或 Prompt output Artifact 冒充潜在敏感诊断完成记录。
4. 最后才开放默认关闭的认证/Policy/audit/credential-fenced Cluster route，并补多副本 HA、真实 S3、
   外部 Provider fault injection 与 plaintext audit negative evidence。
