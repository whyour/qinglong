# ADR-0424：外部工作站 Cluster Admin Release Ceremony

- 状态：Proposed
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-332、Phase 2
- 扩展：ADR-0420、ADR-0423

## 背景

ADR-0420 已固定 Cluster Console 只随 signed multi-architecture Admin OCI
分发，ADR-0423 已在真实本地镜像中证明离线 evidence verifier 能在严格资源与
authority 边界内运行。但源码审计、stub release verifier 测试和本地构建镜像都
不能证明一个公开发布 digest 确实由预期 GitHub Actions workflow 生成，也不能
证明签名、provenance、SBOM、OS vulnerability evidence 与最终拉取的镜像是同一
对象。

公开 release 的验证发生在 operator workstation，具有 registry、GitHub
attestation service、transparency log、本地 Docker daemon 和短期 GitHub token
等外部条件。它不能伪装成可离线复现的单元测试，也不能把本地执行报告升级为
服务端证明或行动权限。

## 决策

1. 在 exact reviewed `v3.*` source tag 提供
   `ql3-cluster-admin-release-workstation-ceremony.cjs`。输入必须精确绑定
   `ghcr.io/<owner>/qinglong3-cluster-admin@sha256:<digest>`、`owner/repo`、40-hex
   source revision、完整 `refs/tags/v3.*` ref，以及 canonical absolute
   `cosign`、`gh`、`docker`、短期 token file 和新 report path；mutable tag、branch
   ref、owner 漂移、symlink、group/other-writable executable 或已存在输出均失败关闭。
2. 三个外部工具按绝对路径直接执行，不经 shell 或 ambient `PATH`。GitHub token
   必须来自 current-owner `0600` bounded file，只注入三个 `gh attestation verify`
   子进程；不得进入 argv、`cosign`/`docker` 环境、报告或失败输出。工具在执行前后
   复验 device/inode/size/SHA-256，降低 ceremony 中途替换风险。
3. ceremony 精确执行一次 keyless signature 验证，以及绑定 release workflow、
   source digest、source tag、非 self-hosted runner 和 OCI bundle 的 provenance、
   CycloneDX、OS-vulnerability 三类 GitHub attestation 验证。随后拉取同一 digest，
   要求本地 image inspection 的 Linux `amd64|arm64` `RepoDigests` 包含精确输入。
4. ceremony 使用固定、非敏感、单条 `run_read` redacted evidence vector 检验最终
   release image 内的第 11 个 `evidence-verify` 产品命令。该容器使用 non-root
   UID/GID 10001、read-only root、network none、drop ALL、no-new-privileges、
   128 MiB、0.25 CPU 与 32 PIDs，只读挂载 vector；输出必须与独立 verifier 的
   exact no-authority result 一致，vector inode/size/mtime/digest 前后不变。
5. 成功只新建一个 current-owner `0600`、two-space canonical JSON 报告。报告保留
   public release identity、工具 SHA-256/size、七步 argv/stdout/stderr digest 与字节数、
   verification/isolation 结果和自身 canonical SHA-256，不保留原始工具输出、token、
   executable path 或 workstation identity。它明确声明
   `reportAttestation=none`、`actionAuthority=none`。
6. 独立 offline audit 使用 no-follow stable read 校验报告 canonical encoding、exact
   shape、expected release identity、工具与七步 transcript digest、一致的 isolation/
   limitation 以及顶层 digest。其结果固定为 `externalResults=not_replayed`；离线审计
   不能证明外部命令确实运行，也不能重放某一历史时点的 registry、GitHub 或
   transparency-log 状态。
7. ceremony 与 auditor 保留在根 `scripts/`，不新拆 workspace package、不加入
   Admin image，从而避免“用待验证镜像验证自身”的循环，也不进入 Edge、Standalone、
   AI、MCP Local artifact、Kubernetes workload、数据库或常驻服务闭包。

## 不选择

- **只保留 `verify-release.sh` 的布尔输出**：适合人工快速检查，但缺少工具固定、
  最终 pull/inspect、镜像内 verifier smoke 与可独立审计的 digest-level transcript。
- **保存完整 `cosign`/`gh` 输出**：会不必要地扩大身份、registry metadata 和未来
  输出格式的泄漏面，也让报告兼容性依赖外部工具展示层。
- **把 token 交给全部子进程或继承完整环境**：扩大 credential 与 ambient authority
  暴露，且降低 ceremony 可解释性。
- **把 runner 烘焙进 Admin image**：产生自验证循环，并迫使运行容器获得 Docker
  daemon 与 registry authority。
- **把本地报告签成 QingLong authority**：工作站报告只记录一次观察，不是 release
  workflow attestation、Cluster durable audit 或 action approval。

## 验收

1. stub ceremony 必须证明精确 1 次 signature、3 次 attestation、1 次 immutable
   pull、1 次 digest inspection、1 次隔离 verifier；token 只出现在 `gh` 环境，报告
   为 `0600`、不泄漏 token 且不覆盖现有文件。
2. mutable image、branch ref、source revision/owner drift、tool failure、executable
   drift、非私有 token/report、verifier 输出漂移或 vector mutation 必须失败关闭，
   失败输出不得包含路径、输入或外部工具 transcript。
3. offline audit 必须接受真实 canonical report，并拒绝 tamper、即使重新计算顶层
   digest 的 claim/isolation/shape 扩宽、expected release swapping、noncanonical JSON、
   symlink 与权限漂移。
4. Console distribution audit、Cluster Admin、18-package、backend、npm pack、依赖/
   deployment/release 以及 14 档 Local artifact 门必须通过；package 总数与低配设备
   默认 Edge/Standalone artifact 必须保持不变。
5. 必须从公开 `v3.*` release 获取真实 immutable Admin digest，并在装有真实
   `cosign`、authenticated `gh` 和 Docker 的外部工作站完成 ceremony 与独立 audit，
   才能把本 ADR 从 Proposed 改为 Accepted。

## 当前状态

截至 2026-08-16，本地仓库没有 `v3.*` tag，开发工作站未安装 `gh` 与 `cosign`，
且项目公开 GitHub Releases 尚无可供输入的 3.0 release digest。因此本门只可完成
runner、auditor、negative contract、资源与 artifact 回归；不得用 stub 或本地
`d332-local` 镜像伪造第 5 条外部验收。发布 digest 可用后，按本 ADR 记录真实 report
digest、工具 digest 与外部审计结果，再独立接受本决策。

## 实现门结果

2026-08-16，D-332 已完成可在发布后直接执行的实现门，但没有改变本 ADR 的
`Proposed` 状态：

- runner/stub tools、独立 offline auditor、原 release verifier 与 Console
  distribution 定向门全部通过；覆盖精确 signature/attestation/pull/inspect/run
  argv、token 仅注入 `gh`、tool drift、权限扩宽、no-replace、结构重签与 expected
  identity swapping 等正负路径。
- backend 全量为 1,233 pass、2 条件 skip、0 fail；Cluster Admin 为 387 pass、
  3 条件 skip、0 fail；18-package clean build/test 退出 0。沙箱内 loopback listener
  的 `EPERM` 已通过同命令非沙箱重跑消除，不记作产品失败。
- workspace 继续为 18 packages，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`；Cluster dependency、Edge import、Cluster deployment、
  image release、OS vulnerability、Console 与 distribution 审计均 compatible。
- Cluster Admin npm pack 保持 250 files、271,238-byte tarball、1,690,196-byte
  unpacked；D-332 的根脚本和 ADR 没有进入 npm/OCI 产品内容。
- 14 档 Local artifact 全部 compatible。默认 Edge/Standalone 精确保持
  2,589,890/2,589,968 bytes、315 files、56 modules；application+AI 保持
  4,493,043/4,493,175 bytes，MCP 保持 7,315,930/7,316,038 bytes。
- 本门没有 schema、migration、SQL、role、Pool 或连接拓扑变化，因此不重复冒充
  PostgreSQL HA 执行；继续复用紧邻 D-331 已通过的 PostgreSQL 18.6 arm64
  142/142、timeline `1→2` 物理 HA 基线。唯一未满足项仍是第 5 条真实公开 release
  digest 外部 ceremony。
