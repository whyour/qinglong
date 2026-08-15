# ADR-0420：以签名 Admin OCI 分发 Cluster Copilot 工作站 Console

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-328、Phase 2

## 背景

D-327 已把首个 QingLong 3.0 浏览器产品面冻结为 `@qinglong/cluster-admin` 内聚的短生命周期、只读 Console，但只证明了本机 loopback 进程与 Admin image 内运行。运维者仍需要一条可以独立验证、在 amd64/arm64 工作站一致部署、不会另造依赖树的分发路径。

当前 release workflow 已对 Admin OCI 的两个原生架构执行 production dependency audit、SBOM 生成、OS vulnerability scan、OCI 合并复验、keyless Cosign 签名和三类 GitHub attestation，并在提升 immutable tag 前从 registry 独立复验。再发布 Node tarball、安装器镜像或第 19 个 workspace package，会产生第二份版本/签名/依赖闭包，也会重新引入用户已指出的薄包问题。

容器内部不能监听宿主 `127.0.0.1` 后再由 Docker publish；若要提供宿主 loopback 入口，容器内必须监听其 network namespace 的 all-interface 地址。因此需要把“容器内部 listener”与“宿主可达边界”拆成两个显式、可审计的概念，不能把原生默认 listener 静默改宽。

## 决策

1. 唯一工作站分发物是 `qinglong3-cluster-admin@sha256:…` 多架构 OCI；不新增 archive、安装器 image、workspace package 或生产依赖。镜像签名覆盖 Console 代码、digest-bound assets、启动器、验签器、配置模板与部署文档。
2. 镜像内 `/opt/qinglong/share/ql3-copilot-console/` 固定携带只读文档/模板和 `0555` 的 `docker-loopback.sh`、`verify-release.sh`。运维者从 exact reviewed tag 使用脚本，或从已验证 digest 的 image filesystem 提取同一副本。
3. `verify-release.sh` 只接受与 repository owner 一致的 Admin image digest、40-hex source revision 和 `refs/tags/v3.*`。它必须验证 exact release workflow certificate identity、GitHub OIDC issuer，以及绑定 repository、workflow、commit、tag 的 provenance、CycloneDX SBOM 和 OS vulnerability attestation；拒绝 tag image、branch ref、self-hosted builder 和非 OCI bundle。
4. 原生 CLI 默认仍为 `host-loopback`，只监听 `127.0.0.1` 且允许 ephemeral port。只有显式 `--container-published-loopback` 加固定 `1024..65535` port 才让容器内监听 `0.0.0.0`；start/preflight fact 始终声明 `publishedHostAddress=127.0.0.1`，该 mode 不能被普通原生启动隐式选择。
5. image launcher 只使用 immutable digest 和显式命名网络，拒绝 `bridge|default|host|none`。`serve` 只能添加 `--publish 127.0.0.1:<port>:<port>/tcp`；`check` 不开放 listener 或 publish。任意 LAN/all-interface 宿主发布不在受支持面内。
6. launcher 固定 non-root `10001:10001`、read-only root、drop ALL、no-new-privileges、8 MiB noexec tmpfs、一个只读 private authority mount、`--pull never` 和 3 秒 stop ceiling。`compact` 为 192 MiB/0.25 CPU/32 PIDs，`standard` 为 512 MiB/1 CPU/64 PIDs；两档均继承 Console 2 reads/no queue 的应用边界。
7. 宿主必须给 Console 建独立命名网络，并在宿主 firewall 将 egress 收窄到 DNS 和 exact Cluster API。launcher 不挂载 Docker socket、Kubernetes token、数据库 credential 或可写工作目录，也不声称 Docker bridge 本身提供 egress allowlist。
8. Console 继续排除在 Kubernetes YAML、Edge/Standalone、Local MCP、Cluster Control/AI closure 和 2.x Web 中；因此低配路由设备默认制品不承受新增字节、module、进程或常驻资源。

## 不选择

- **独立 Node tarball/桌面安装器**：会复制依赖闭包、签名与升级通道，当前没有独立 consumer 或 package 边界价值。
- **新增 Console workspace package**：实现仍由同一个 Cluster Admin consumer、release image 和权限域拥有，拆包只会得到浅目录或单职责文件包。
- **容器使用 host network**：绕过明确的 port binding，并扩大到宿主全部网络面。
- **直接发布容器 `0.0.0.0` 到宿主**：使局域网可达性依赖 daemon 默认，违反短生命周期受信工作站边界。
- **常驻 Kubernetes Console**：会把 Project credential、listener 和资源成本变成长生命周期集群工作负载。

## 验收

1. launcher 单测精确比较 compact check 与 standard serve 的 Docker argv，并证明 tag、ambient network、低端口、非 canonical/注入式 private root 和未知资源档在调用 Docker 前低敏失败。
2. verifier 单测用独立 fake `cosign`/`gh` 证明一次 signature 与三次 attestation 调用的 exact identity/source/predicate 约束，并证明 mutable/unbound 输入不会触发 trust tool。
3. 分发审计锁定镜像内文件 mode/path、双架构 release workflow、signature/attestation、显式 network boundary、host loopback publication 和 Kubernetes/Edge 缺席。
4. 真实 Admin image 必须在受限容器内证明嵌入文件与 mode，并先选择一个空闲高端口、再通过 named network + Docker `127.0.0.1:<port>:<port>` 现场证明唯一 loopback publication、exact Host/Origin 页面可读、read-only/non-root/no-capability 边界与干净回收。
5. Cluster Admin、18-package clean build/test、backend、release/SBOM/package/dependency/Edge 审计与 14 档 Local artifact 全部通过后，本 ADR 才转为 Accepted 并进行 D-328 阶段提交。
6. 本 Gate 不修改 schema、migration、SQL、role、Pool、连接或 PostgreSQL HA 拓扑；继续引用 D-323 PostgreSQL 18.6 arm64 physical HA 基线，不以重复数据库门代替本阶段的分发验证。
