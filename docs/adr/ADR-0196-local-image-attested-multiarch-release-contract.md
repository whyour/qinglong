# ADR-0196：本机镜像证明化多架构发布契约

- 状态：Accepted（共享发布契约、CycloneDX、许可证/漏洞门与 CI 接线已实现；
  本机双架构 OCI 和远端 GHCR 发布记录尚未取得）
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-14、D-42、D-61、D-126、D-128、D-175、
  D-184、D-185、D-186
- 关联 ADR：ADR-0042、ADR-0090、ADR-0128、ADR-0185、ADR-0194、
  ADR-0195

## 背景

ADR-0195 已证明同一个 AI-excluded image 能在 Edge 128 MiB/64 PID 和
Standalone 256 MiB/256 PID envelope 中完成真实 SQLite 生命周期，但候选
image ID 不是发布 authority。仓库已有 control/admin 的双架构、SBOM、
provenance、签名和远端回读流程；为本机镜像复制一套 privileged workflow
会产生独立 action pin、OIDC identity、漏洞策略和验证漂移。

本机 build manifest 还比 production manifest 多一个只用于 Drizzle schema
类型编译的 `drizzle-orm`。直接套用“两个 manifest dependencies 完全相同”的
Cluster 假设会迫使 build-only dependency 进入 runtime，或让 SBOM 隐藏真实
差异。

## 决策

### 1. 三个镜像共用一个发布 authority

`.github/workflows/ql3-image-release.yml` 是 QingLong 3.0 唯一 backend image
发布 workflow，精确矩阵固定为：

- `control → qinglong3-cluster-control`；
- `admin → qinglong3-cluster-admin`；
- `local → qinglong3-local-application`。

每项分别绑定 exact Dockerfile、production dependency root 和最终 digest。
不得增加第四个 repository、让三个 profile 共用 digest，或为本机镜像复制
第二套 OIDC workflow。原 `audit:cluster-image-release:ql3` 作为兼容命令保留，
新的主命令是 `audit:image-release:ql3`；这不增加 workspace package。

ADR-0253 已收紧入口：发布只接受显式 dispatch 到与输入 QingLong 3 SemVer 完全一致的 protected `v3` tag，
不再由 tag push 自动发布。私密 Worker management source-aware gate 先在受保护 ephemeral runner 只读执行；
registry/OIDC/attestation 写权限只存在于依赖该 gate 的 GitHub-hosted publisher。workflow 没有 `pull_request`
trigger；所有第三方 action继续固定完整 commit SHA。

### 2. 本机 SBOM 明确区分 runtime root 与 build-only root

本机 build/runtime manifest 共享制品身份
`@qinglong/local-application-image@3.0.0-alpha.0`。production root 只允许
`croner@7.0.8`、`semver@7.7.4`；build root 必须精确等于 production root 加
受审的 `drizzle-orm@1.0.0-rc.4`，其他差异失败关闭。

共享 CycloneDX 1.5 生成器只从 production lock 遍历运行时可达图，再在 builder
lock 中从相同 production roots 复算并比较。因此 build-only Drizzle、TypeScript、
types 与 AI 均不能进入本机 SBOM。当前本机图固定为：

- 2 个外部 component；
- 10 个内部 component；
- 12 个 component、13 个 dependency node；
- root 为
  `pkg:npm/%40qinglong/local-application-image@3.0.0-alpha.0`。

实际 read-only image inventory 必须与 12 个 component 精确对账，并继续通过
ADR-0195 的 640 files/5 MiB、无 symlink/special file 门。

### 3. 许可证、漏洞和容量都必须失败关闭

每个 runtime component 必须携带且只能携带一个受审 SPDX license ID。共享
allowlist 当前为 `0BSD`、`Apache-2.0`、`BSD-2-Clause`、`ISC`、`MIT`、
`Python-2.0`、`Unlicense`；新增或缺失 license 必须先修改 ADR 与变异测试。
本机实际闭包只使用 Apache-2.0、ISC、MIT。

每个 release matrix 项在 build/push 前对自己的 production lock 执行
`npm audit --omit=dev --audit-level=high`。安全公告服务不可用、high 或
critical advisory 都使发布失败。ADR-0254 已补充独立 OS/base image CVE scanner：三个 image 的两个 native
architecture 都在 publish 前以 digest-pinned base、Trivy 0.70.0、HIGH/CRITICAL、OS-only、unfixed 不忽略执行，
例外必须经过最多 30 天的 owner/ticket/purl/image-scoped 生命周期。

本机 OCI 每个平台的 compressed layer 总预算固定为 128 MiB；Cluster 既有
512 MiB 门保持不变。该值是 registry/传输门，不是路由器实际闪存容量承诺。

### 4. 原生 image gate 与 attested OCI gate分离

原生 amd64/arm64 `local-image` job 继续执行候选镜像 identity、12-package
inventory、CycloneDX 对账、router stress 以及 Edge/Standalone fresh live
contract。共享 `image-oci` job 则以 `control|admin|local` 三项 exact
Dockerfile matrix 生成 `linux/amd64,linux/arm64` OCI layout，并要求：

- 每个平台 config 固定 Linux、`65532:65532`、唯一 local application
  entrypoint、`NODE_ENV=production`；
- `edge,standalone` 与 `ai=excluded` labels、source revision 和 version
  精确匹配；
- 每个平台恰有一个 digest-bound attestation manifest；
- attestation 同时包含 SPDX-2.3 与 SLSA provenance v1；
- SPDX 中 `/opt/qinglong/node_modules` 的 npm purl 与 12-component
  CycloneDX 完全相同；
- provenance 只允许 source revision 和不含 credential 的标准 proxy args。

### 5. 远端发布只以 digest 为 subject

每个 profile 的 Buildx push digest分别接受：

1. BuildKit SBOM；
2. BuildKit maximum provenance；
3. Cosign GitHub OIDC keyless signature；
4. GitHub SLSA provenance attestation；
5. GitHub CycloneDX attestation。

发布后同一 job 必须从 GHCR 回读 `IMAGE@DIGEST`，复验双平台/双 attestation
manifest，随后以精确 `.github/workflows/ql3-image-release.yml@GITHUB_REF`
certificate identity 验证 Cosign，并以 repository、workflow、source commit、
source ref 和 OCI bundle 分别验证 SLSA 与 CycloneDX。tag 仍只是发现入口，
D-184 Compose 私有输入必须使用 digest。

## 当前证据

- 本机 CycloneDX：12 components、13 dependency nodes；
- 实际 arm64 image
  `sha256:b99e61e90c84fc113b03d8d8d237ee3f5cefc3f800d73708b30ed591ec4a94b0`
  为 `65532:65532`、251,932,346 uncompressed bytes；inventory 为
  611 files/4,897,102 bytes，并与 CycloneDX 精确一致；
- SBOM/许可证变异测试：10/10；
- OCI layout 结构/config/attestation 变异测试：9/9；
- release workflow 变异测试：19/19；
- D-185 image contract：6/6；
- control/admin/local 三份 production lock 的联网 npm audit：
  0 vulnerabilities；
- 共享 CI/release 静态审计：
  `images=[control,admin,local]`、amd64/arm64、inventory/attestation 全开启。

本机真实双架构 OCI 本轮未取得。临时 `docker-container` builder 已确认同时支持
amd64/arm64，但 BuildKit 在执行项目 Dockerfile 前，从 Docker Hub OAuth endpoint
获取 `docker/buildkit-syft-scanner:stable-1` token 超时。该外部失败与
ADR-0128 已记录的 admin 证据缺口相同，不能记作 OCI 成功；临时 builder、
BuildKit container、隔离 Docker config 与未完成 OCI 输出均已删除。

## 尚未完成的 Release Gate

- GitHub-hosted `image-oci` 三 profile 的真实成功记录；
- GHCR 中可回读的本机双架构 manifest digest；
- 对该 digest 的 Cosign、SLSA、CycloneDX 三类远端 verify 记录；
- GitHub-hosted 六矩阵 base image/OS package scan 的真实成功记录；
- 固定低配路由器的下载大小、解压占用、冷启动、断电与升级/回滚实证；
- D-184 service activation controller 使用新 digest 的升级与回退闭环。

## 验证

- `pnpm sbom:local-image:ql3`
- `pnpm audit:image-release:ql3`
- `pnpm audit:local-image:ql3`
- `node --test test/back/ql3ClusterImageSbom.test.cjs`
- `node --test test/back/ql3ClusterOciLayoutAudit.test.cjs`
- `node --test test/back/ql3ClusterImageReleaseAudit.test.cjs`
- `node --test test/back/ql3LocalImageAudit.test.cjs`
- 在实际 image 内执行
  `ql3-cluster-image-sbom.cjs --image=local --inventory-root=...`
- 在可获取 BuildKit scanner 的环境执行 CI `image-oci` 和受保护 release
  workflow，并保存最终远端 verify 记录。
