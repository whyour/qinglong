# ADR-0506：源码绑定的 Local Alpha 验证证据

- 状态：Accepted
- 日期：2026-08-27
- 决策：D-411
- 关联：ADR-0503、ADR-0504、ADR-0505

## 背景

ADR-0504 把 Local Trial Kit 的写入与离线审计收敛为一个 materializer，但 v1 manifest 在 `create` 时会无条件写入九个 `passed` 字段。调用者只需提供可构建镜像和 SBOM，即可得到一份声称已经通过漏洞扫描、fresh Owner、Edge/Standalone lifecycle 与原生 cancellation 的 manifest；materializer 并未收到这些 gate 的任何证据。

提交 `4239464a` 的 macOS Docker Desktop 复验进一步暴露了该语义错误：bundle 内容、checksum、reload 和入口 smoke 均通过，但完整 Owner 旅程因 bind-mount UID 语义失败；同提交的原生 Linux CI 后续通过。内容完整性、源码实现通过和 exact artifact 已被验证是三种不同事实，不能由一个常量同时代替。

## 决策

### 1. Alpha bundle 必须消费独立的 verification evidence

Local Alpha schema 升为 `qinglong/alpha-local-trial-kit@v2`。`create` 新增必需的 `--verification-evidence`，并把 `verification` 从九个常量改为 `verification-evidence.json` 的文件记录。闭合目录从六个文件增加为七个，evidence 同时进入 manifest byte/SHA-256 绑定与 `SHA256SUMS`。

缺少 evidence、旧 v1 manifest、额外文件、evidence mutation 或 subject 漂移全部失败关闭。旧 schema 尚未公开发布，因此不保留会继续接受无来源 `passed` 声明的兼容分支。

### 2. evidence 绑定 exact workflow 与 artifact subject

新增同一 materializer 的 `record-verification` 模式，只接受：

- repository `whyour/qinglong`；
- workflow ref `whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next`；
- `workflow_dispatch` event 与 `local-image` job；
- 完整 source/workflow SHA、十进制 run ID/attempt；
- Tier-1 architecture，以及从 Docker inspection 获得的 Application/operator exact image ID。

evidence 的 subject 同时绑定版本、源码、架构和两个不同镜像 ID；九个 gate 保持 exact closed set。bundle create 与 offline audit 都重新匹配 evidence subject 和 manifest，不允许把另一架构、另一镜像或另一 run 的 evidence 复制进来。

GitHub workflow 只能在 Trivy、inventory、SBOM、128 MiB entrypoint、fresh lifecycle、完整 Trial Kit journey 与原生 cancellation 均成功之后记录 evidence；静态审计固定 `journey → cancellation → record-verification → create → audit → upload` 顺序。

### 3. workflow provenance 不是公开发布签名

evidence 提供可定位、可交叉检查的 GitHub run identity，不声称调用者无法伪造 JSON。下载者仍需到 GitHub 检查该 run 的 source、attempt 和结论。公开 Release Set 继续使用独立的 immutable digest、Cosign 与 GitHub attestation，不以 Alpha evidence 替代供应链签名。

普通 push/PR 不生成或上传 Alpha artifact；本地构建、push CI 通过或 source-equivalent native gate 只能支持工程候选判断。只有显式 milestone dispatch 产生的 exact-image evidence 才允许 materializer 声称 Local Alpha Trial Kit。

## 被拒绝的替代方案

### 保留 manifest 内的固定 `passed` 字段

拒绝。它把“脚本知道有哪些 gate”错误提升为“这些 gate 已对当前 artifact 执行”。

### 仅加入 GitHub run URL，不绑定镜像 ID

拒绝。同一源码可以因基础 package、构建平台或配置产生不同镜像；source-level run 不能自动证明另一个本地 archive 的 exact bytes。

### 在 Alpha 阶段实现第二套签名系统

拒绝。正式 release workflow 已承担签名和 attestation；Alpha 需要的是诚实、可定位的阶段证据，不应复制生产发布 authority。

## 影响

- 本地无 evidence 的 archive 不再冒充用户 Alpha，只能按工程候选处理；
- 手动 milestone artifact 多一个小型 JSON 文件，不增加 Docker archive layer、workspace package、设备常驻 RSS、端口或依赖；
- 下载者可从 bundle 确定 exact GitHub run/attempt，并验证 evidence 与 image ID/source/architecture 一致；
- 旧的本地 `2620be05` 与 `4239464a` v1 bundle 保留为历史工程证据，但不能通过 v2 auditor。

## 验证

- 聚焦测试覆盖 v2 七文件正常物化、非 milestone provenance、detached workflow、archive/SBOM/evidence mutation、额外文件和闭合 CLI grammar；
- Local operator workflow audit 要求 GitHub workflow identity contexts、evidence input和严格 gate 顺序；
- `record-verification` 和 `create` 都从 image inspection 绑定两个不同 image ID；offline audit 不调用 Docker或网络；
- 首个真实可下载 v2 双架构 Trial Kit 仍需维护者授权的 `produce_alpha_artifacts=true` workflow 生成。
