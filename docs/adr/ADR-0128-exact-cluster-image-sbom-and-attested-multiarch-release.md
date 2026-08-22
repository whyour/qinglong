# ADR-0128：精确 Cluster 镜像 SBOM 与证明化多架构发布

- 状态：Accepted（control/admin 双镜像的精确 SBOM、原生双架构 CI、OCI
  digest graph 与独立 GHCR/Cosign/GitHub attestation 发布契约已完成；control
  已有本地 arm64 inventory 与 amd64/arm64 OCI 实证，admin 已有本地 arm64
  inventory，真实 admin 双架构 OCI 和远端受保护发布记录仍是 Release Gate）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-14、D-61、D-85、D-105、D-124、D-126
- 关联 ADR：ADR-0038、ADR-0042、ADR-0062、ADR-0088、ADR-0090、ADR-0126

> ADR-0196 已把该供应链扩展为 `control|admin|local` 三个 profile，并将唯一
> 发布入口迁移到 `.github/workflows/ql3-image-release.yml`。本 ADR 以下
> control/admin 数字保留为建立该机制时的历史证据。ADR-0254 随后删除 control/admin 可覆盖的
> `NODE_IMAGE` build arg，并增加跨架构 OS vulnerability pre-publish gate。2026-08-22 的 ADR-0254 修订进一步把
> build stage 保留在固定 Bookworm digest、runtime stage 切到零 HIGH/CRITICAL 的固定 Alpine 3.23 digest，覆盖
> `control|control-ai|admin|local|worker` 十个 native image。

## 背景

ADR-0126 已建立可构建的 Cluster 镜像，但“存在 lock”和“生成 SBOM”都不能单独
证明实际运行时闭包。对 builder/runtime 共用、同时声明 `@types/pg` 的 npm
manifest 执行 `npm ci --omit=dev` 时，Drizzle 的 optional peer 会让
`@types/pg`、`@types/node` 和 `undici-types` 仍进入生产镜像。另一方面，
`npm sbom --package-lock-only --omit=dev` 又会漏掉 lock 中标为
`devOptional`、但通过 `pg` 实际运行时可达的八个包。

发布侧如果只推 tag，则无法证明部署拿到哪个 manifest；只生成 CI 文件也不能
证明它已经在远端成功签名。因此需要把源码闭包、实际镜像清单、不可变 digest、
签名和证明拆成可独立判定的证据。

## 决策

### 1. Builder 与 production dependency root 分离

每个镜像分别保留两个 npm dependency root：

- builder manifest/lock 包含 TypeScript 和受审的 exact type dependency；
- `runtime-dependencies/package.json` 与 lock 只包含五个 exact production
  root dependency。

两者的 package name、version 和 production dependency map 必须完全相同。
production stage 只能对 production lock 执行 `npm ci --omit=dev`。不能依靠
`npm prune`、手工删除目录或 SBOM allowlist 隐藏 builder 泄漏。

control 与 admin 不能共用一个 production root：control 的第五个根是
`@aws-sdk/client-s3`，admin 的第五个根是 `@kubernetes/client-node`。两者拥有
独立 manifest/lock、Dockerfile、image repository 和 digest，防止短生命周期
Kubernetes/admin authority 进入常驻 control 镜像。

该目录是镜像构建输入，不是 workspace package，不增加 21 importer hard cap。

### 2. SBOM 从生产锁的可达图生成，并与实际镜像逐包对账

`ql3-cluster-image-sbom.cjs` 从五个 root dependency 遍历 npm v3 lock 中
`dependencies + optionalDependencies` 的实际解析位置。任何可达节点即使被 npm
标成 `devOptional` 也进入图；peer dependency 不因出现在 builder lock 就自动
进入生产图。

SBOM 必须显式选择 exact `control|admin` profile，生成的 CycloneDX 1.5 文档
分别固定包含：

- control：43 个外部 runtime component，`runtime-core`、`cluster-postgres`、
  `cluster-control` 三个内部 component，一个 image dependency root，47 个
  dependency node；
- admin：85 个外部 runtime component，`runtime-core`、`cluster-postgres`、
  `cluster-admin` 三个内部 component，一个独立 image dependency root，89 个
  dependency node。

组件使用 `name@version` purl 作为 `bom-ref`，registry 包携带 lock integrity 的
SHA-512 和 distribution URL。内部 `workspace:*` 必须解析到 exact version。
重复 ref、缺边、多包、少包、版本漂移、`typescript`、profile/lock 错配或
closure 外的类型包全部失败关闭。admin production graph 中
`@kubernetes/client-node` 自身把 `@types/js-yaml` 声明为 runtime dependency；
该节点必须因 exact lock 可达而保留，不能继续用 `@types/*` 名称前缀冒充依赖
可达性判断。

CI 还必须在 UID 10001、只读根、`no-new-privileges` 容器中枚举实际
`/opt/qinglong/node_modules`，并要求其 `name@version` 集合与所选 profile 的
control 46 或 admin 87 个 SBOM component 完全相同。源码 SBOM 成功不能替代这一步，也不能
拿 control 的 46-component 文档证明 admin 镜像。

### 3. CI 原生验证 amd64 与 arm64

`ql3-ci.yml` 使用 `control|admin × amd64|arm64` 四项矩阵，在 GitHub 原生
`ubuntu-24.04` 与 `ubuntu-24.04-arm` runner 分别构建所选 production
Dockerfile，验证：

- runner Node architecture；
- image architecture 和 `10001:10001`；
- SBOM 正/负向测试；
- 部署与发布静态契约；
- 实际镜像 46/88 包闭包。

该 job 成功后只证明两个单架构构建；它不等同于 registry 已存在一个多架构
manifest。

另一个独立 OCI evidence job 同样以 `control|admin` 为矩阵，必须使用 QEMU +
Buildx 分别构建 `linux/amd64,linux/arm64`，同时启用 SPDX SBOM 与 maximum
SLSA provenance，再离线审计每个完整 OCI layout。审计必须：

- 对每个 content-addressed blob 流式复算 SHA-256 并核对 descriptor size；
- 拒绝未引用 blob、缺平台、重复/未绑定 attestation 和超出容量的图；
- 分别复验两个 config 的 architecture、UID/GID、entrypoint、工作目录、端口、
  production env、OCI label 和 source revision；
- 要求每个平台恰有一个 attestation manifest，且包含 SPDX 与 SLSA 两个
  in-toto predicate；
- 从 Syft SPDX 中只选择 `/opt/qinglong/node_modules`，与所选 CycloneDX 的
  control 46 或 admin 87 个 npm purl 精确对账；
- 只允许 source revision 和无 credential 的标准 proxy build arg 进入
  provenance。

本地 2026-07-24 证据的 root index 为
`sha256:7859b32b136f7d82f4504b0e0895c560348e4acab460d4ece0127d47a62bea5e`：

- amd64 manifest
  `sha256:d6cecd239953d0ed4791c58ee769d78656f913e7e158cdab373db468d6fb2814`，
  compressed layer bytes 83,746,881；
- arm64 manifest
  `sha256:f7b0b7e1ab868e09617527ca0d28ff8becab27d81ce008af685597dc1be768b7`，
  compressed layer bytes 83,624,682；
- layout 共 27 个 blob、172,835,866 bytes；两个平台都对账 46 个应用 npm
  package，并各自拥有 SPDX-2.3 与 SLSA provenance v1。

admin 历史本地 arm64 镜像已在 UID/GID 10001、只读根、
`no-new-privileges` 下完成实际 inventory 对账。ADR-0218 删除未使用的 Croner 后，
当前 lock/SBOM 为 84 external + 3 internal、87 component/88 dependency node；
更新后真实镜像 inventory 仍待依赖物化复验。本机 admin 双架构 OCI 实证尚未取得：
2026-07-25 两次 Buildx
尝试均在拉取官方 `docker/buildkit-syft-scanner:stable-1` 的 Docker Hub OAuth
token 阶段超时，未进入项目 Dockerfile 构建；该外部失败不能记为 OCI 通过。

### 4. Release 只围绕每个 pushed digest 建立 authority

独立 release workflow 只接受 `v3.*` tag 或显式 QingLong 3 SemVer dispatch。
它以 exact matrix 分别把 `qinglong3-cluster-control` 与
`qinglong3-cluster-admin` 的 `linux/amd64,linux/arm64` manifest 发布到不同
GHCR repository，并以每个 build 返回的 `sha256:*` digest 作为该镜像唯一证明
subject。两个 job 不共享 digest、SBOM 或证明；tag 只用于发现，Kubernetes
生产 overlay 必须分别 pin 两个 digest。

提交的 CloudNativePG control/recovery overlay 使用不可拉取的全零 digest 作为
fail-closed 占位。私有部署输入必须分别替换 control/admin digest；静态部署门禁
拒绝任一 production-oriented overlay 回退到 `newTag`，也不允许用同一份
control 证明替代 admin Job。

每个 digest 必须同时具备：

1. BuildKit `sbom: true`；
2. BuildKit `provenance: mode=max`；
3. Cosign GitHub OIDC keyless signature；
4. `actions/attest` 生成并推送的 SLSA provenance；
5. `actions/attest` 生成并推送的受审 CycloneDX 应用 SBOM。

创建签名和证明之后，每个 matrix job 自身还必须从 GHCR 读取自己的
`IMAGE@DIGEST` 并失败关闭：

1. `docker buildx imagetools inspect --raw` 的 root index 必须只有
   `linux/amd64`、`linux/arm64` 两个 runnable manifest，以及与二者一对一
   digest 绑定的两个 BuildKit attestation manifest；
2. Cosign verification 必须精确绑定当前 repository、release workflow path
   和 `GITHUB_REF` 组成的 certificate identity，并固定 GitHub Actions OIDC
   issuer，禁止宽泛 identity regexp；
3. GitHub SLSA 与 CycloneDX 必须作为两次独立
   `gh attestation verify` 执行，从 OCI registry 读取 bundle，绑定 repository、
   signer workflow、`GITHUB_SHA`、`GITHUB_REF`，并拒绝 self-hosted runner；
4. CycloneDX verification 必须显式要求
   `https://cyclonedx.org/bom` predicate，不能让默认 SLSA verification
   冒充应用 SBOM 已验证。

workflow 只授予 `contents: read`、`packages: write`、`id-token: write`、
`attestations: write` 和 `artifact-metadata: write`。Pull Request 不得触发
发布。digest 形态不合法时必须在签名/证明前失败。release job 的 checkout、
Node、Docker、Cosign 和 attestation action 必须固定到已核验 tag 对应的完整
commit SHA；可移动 major tag 只保留为行尾可读注释，不能作为执行 ref。

## 不代表什么

本 ADR 当前本地证据不代表：

- release workflow 已在 GitHub-hosted runner 成功；本地双架构 OCI 证据不能
  代替远端受保护发布环境；
- GHCR 已存在可拉取且彼此独立的 control/admin QingLong 3 digest；
- Cosign signature 或 GitHub attestation 已在远端 registry 可验证；
- 当前 base image 或 npm graph 没有漏洞；
- image 在目标 Kubernetes 节点满足容量、冷启动或网络策略要求；
- PostgreSQL operator、STONITH、Pod 分区和 CA 重叠轮换 Gate 已完成。

只有实际 release run、不可变 digest 拉取和独立 verify 记录才能关闭前三项。
workflow YAML 通过静态审计只证明发布意图没有被静默降级。

## 替代方案

- **直接使用 `npm sbom --package-lock-only --omit=dev`**：拒绝。当前 lock
  实测漏掉八个实际 runtime package。
- **只用 `npm ci --omit=dev` 和共用 manifest**：拒绝。optional peer 会留下
  三个类型相关 package。
- **构建后手工删除 `@types`**：拒绝。依赖变化时会静默漂移，且 lock 不再代表
  安装输入。
- **只上传 SBOM 文件**：拒绝。未绑定 pushed digest 的文件不能证明部署镜像。
- **只依赖可变 tag**：拒绝。tag 可移动，不能作为 rollout 或审计 authority。
- **PR 构建时直接发布**：拒绝。扩大 token/registry 写权限和不受信代码风险。
- **写权限 job 使用 action major tag**：拒绝。tag 可移动，release action 必须
  使用完整 commit SHA。

## 验证

- `pnpm sbom:cluster-image:ql3`
- `pnpm sbom:cluster-image:ql3 --image=admin`
- `pnpm audit:cluster-image-release:ql3`
- `node --test test/back/ql3ClusterImageSbom.test.cjs`
- `node --test test/back/ql3ClusterImageReleaseAudit.test.cjs`
- `node --test test/back/ql3ClusterOciLayoutAudit.test.cjs`
- `node --test test/back/ql3ClusterRemoteManifestAudit.test.cjs`
- `node --test test/back/ql3ClusterDeploymentAudit.test.cjs`
- 生产 Dockerfile 实际 build；
- UID 10001、只读根容器内以 `--image=control|admin --inventory-root`
  分别对账 46/88 个 component；
- CI 的 control/admin × 原生 amd64/arm64 image job；
- 每个 Buildx amd64/arm64 OCI output 后执行
  `ql3-cluster-oci-layout-audit.cjs --image=control|admin --layout=...
  --expected-revision=...`；
- release 后由 workflow 审计远端 manifest/attestation 一对一绑定，并以 exact
  workflow identity/source revision/source ref 分别执行 Cosign、GitHub SLSA
  和 CycloneDX verify；独立发布记录仍必须保存该结果。

静态负向门必须拒绝缺 admin 或 control profile、profile/SBOM 错配、缺 arm64、
缺 OIDC 权限、缺 digest 签名、缺应用 SBOM证明、缺实际 image inventory、缺
远端 manifest audit、宽泛证书 identity、证明未绑定 source、CycloneDX predicate
漂移或 PR 发布。
