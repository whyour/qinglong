# ADR-0253：私密 Worker 管理证据的镜像发布门

- 状态：Accepted（workflow、freshness gate、静态审计与负向测试已实现；生产 JIT runner 成功记录待取得）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-235、D-236
- 关联 ADR：ADR-0128、ADR-0196、ADR-0252

## 背景

D-235 已能用 final report 与四份 source 独立重判 Worker management 的 external ceremony、durable audit、leaf
revocation 和 client CA rollover，但镜像发布 workflow 尚未消费该结论。直接接入存在四类风险：

- 把 source 上传为 GitHub artifact/cache 会复制受限生产证据并扩大 retention 与读取主体；
- 只上传低敏 final 后检查 `passed=true` 会丢失 D-235 的 source-aware 重判能力；
- tag push 自动发布会绕过生产证据准备、双人复核和受保护 environment；
- 在 GitHub-hosted builder 上读取 source，会把生产证据与 registry/OIDC 写 authority 放进同一安全域。

## 决策

1. `.github/workflows/ql3-image-release.yml` 只接受显式 `workflow_dispatch`。dispatch 必须选择 exact protected
   `v3` tag，输入 version 必须与 tag 名完全一致；普通 branch、自动 tag push、PR 和 schedule 均不能发布。
2. 发布前增加唯一 `worker-management-release-evidence` job。它固定运行在带
   `ql3-release-evidence-ephemeral` 标签的 Linux self-hosted JIT runner，并受
   `ql3-production-release-evidence` environment reviewer 保护。标签只是调度条件；真正的隔离必须由 runner
   provisioner 保证每个 job 一次注册、一次执行、随后销毁。
3. 私密文件由 runner provisioner 以当前 runner UID、canonical `0700` 目录和 `0600` regular file 预挂载到
   `/run/qinglong3-release-evidence/$GITHUB_SHA`。文件名固定为 final、ceremony、durable、PKI v2 和 CA rollover
   五个名称；workflow 不接受用户提供的路径、目录扫描、glob、URL 或 artifact download。
4. gate 重新执行 D-235 source-aware auditor，并额外要求 final `observedAt` 不超过 24 小时、不得比 runner clock
   超前 5 分钟。成功摘要只包含 fixture、commit、version、final SHA-256 和最大年龄，不输出 source 内容。
5. workflow 顶层和 evidence job 只有 `contents:read`。GHCR、OIDC、attestation 与 artifact-metadata 写权限只授予
   `publish` job，且 `publish` 必须无条件 `needs: worker-management-release-evidence`。证据 job 失败、超时、未获
   environment approval 或 runner 缺失时，三个 image matrix 均不得启动。
6. 整个 release workflow 禁止 `actions/upload-artifact` 与 `actions/cache`。证据挂载不进入 workspace、job output、
   workflow artifact、BuildKit context、SBOM、provenance 或 OCI attestation。runner 销毁/卸载由外部 provisioner
   执行；workflow 不删除作为审计事实来源的外部归档。
7. environment reviewer 必须确认 tag protection、tag commit、workflow 与 gate script 均来自已审发布提交。
   自托管 runner 不参与镜像 build、签名或 attestation；实际 publisher 继续使用 GitHub-hosted runner，既有
   `--deny-self-hosted-runners` provenance 验证保持不变。
8. 本能力是 repository-level 短期发布逻辑，不新增 workspace package、第三方依赖、数据库 migration、Profile
   artifact、daemon、controller、watcher、timer、listener、Pool 或设备常驻资源。

## 失败与恢复

- 没有匹配 JIT runner 或 environment 未批准：发布保持 pending/失败，不回退到 GitHub-hosted evidence audit；
- 任一文件缺失、owner/mode/symlink/大小不合法：gate 在 publish 获得写 token 前失败；
- source 被替换、final claimed gate 被修改或 schema 不兼容：重新采集/聚合，禁止手工修补 final；
- evidence 超过 24 小时：重新执行生产 ceremony 与必要的证据协议，生成新的 no-replace final；
- runner clock 超前/落后：修复可信时间源后重跑，不扩大 future skew；
- tag/version 不一致：以正确受保护 tag 重新 dispatch，不允许 branch fallback；
- runner 执行后未被 provisioner 销毁：视为基础设施事故，停止后续 dispatch，隔离 runner 并轮换其注册凭据。

## 被拒绝的替代方案

### 上传五个 JSON 为私有 GitHub artifact

拒绝。repo 私有性不等于最小 custody；artifact 会新增复制、下载主体、retention 和误传风险。

### 只把 final report 放进 repository secret

拒绝。final 不能替代四份 source，且 GitHub secret 的大小/轮换模型不适合有界文件归档。

### 在 publisher job 内直接审计

拒绝。它会让同一个 job 同时持有生产 source、GHCR write、OIDC signing 和 attestation authority。

### 保留 tag push 并异步查询另一 workflow 的成功状态

拒绝。跨 workflow run/commit/tag 的竞态和重放关系更复杂；同一 dispatch 内的强 `needs` 提供更直接的失败关闭。

## 验证

- D-235 + D-236 定向 11/11：source-aware happy path、stale/future、source replacement、exact identity arguments；
- image release 静态/变异契约 26/26，覆盖自动 tag push、缺失 dependency、persistent runner、artifact upload、
  非 commit-scoped mount、evidence write authority 与 movable action；
- `audit:image-release:ql3` 返回 `sourceAware=true`、`privateEphemeralRunner=true`、
  `maximumAgeSeconds=86400`、`artifactUpload=false`；
- workspace 仍为 19 个 QL3 package，未新增第三方依赖或 Profile 稳态资源。
