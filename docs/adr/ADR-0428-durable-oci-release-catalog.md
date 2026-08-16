# ADR-0428：持久化 OCI Release Catalog 与独立部署验真

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-333、D-334、D-335、D-336

## 上下文

ADR-0427 已用 canonical `qinglong/release-set@v1` 闭合一个 deployment family 的全部镜像 digest，
但唯一分发路径仍是保留 90 天的 GitHub Actions artifact。稳定版本可能在该窗口之后才部署或恢复；同时，原
release-set 完整审计依赖同一次 workflow attempt 的短期 image record，部署者无法在记录过期后独立复验文件的
结构、身份与自身 digest。

低配路由设备不应为了发布验真安装 registry、Cosign、GitHub CLI 或 Cluster 依赖；Cluster 运维者则必须从同一个
可发现入口得到 control、control-ai、worker、admin 四个角色的完整 digest lock。两类部署需要同一发布事实，但不应
承担相同的本机工具和运行时成本。

## 决策

1. 成功生成并完整审计 release set 后，发布 workflow 把原始 canonical JSON 作为单层 OCI artifact 发布到独立的
   `ghcr.io/<owner>/qinglong3-release-catalog` repository。artifact/file media type 固定为
   `application/vnd.qinglong.release-set.v1+json`。
2. 发现入口固定为 `v<version>-<scope>`，但 discovery tag 的 authority 明确为 `none`。部署与恢复只接受解析并验证
   后的 `ghcr.io/<owner>/qinglong3-release-catalog@sha256:<manifest-digest>`；不能把 tag 直接写入生产 rollout。
3. publication plan 必须绑定 source repository、release identity、release-set self digest、内容 SHA-256、字节数、
   确定性 basename、OCI media type、四个精确 annotation 与恢复策略。publisher 必须同时使用 `--file-title` 和
   `--strip-dirs`，禁止 runner 的绝对临时路径进入 layer title，从而保证跨 runner manifest digest 确定性。
4. 发布后必须从 immutable catalog reference 按确定性 filename 取回文件并逐字节比较，再读取 raw manifest。契约只
   接受一个 exact layer、empty OCI config、预期 title/annotation、内容 digest/size 和 raw manifest SHA-256。
5. catalog immutable digest 必须获得 exact workflow identity 的 keyless Cosign signature 与绑定 source tag、source
   revision 的 GitHub OCI provenance，并在生成 receipt 前完成远端验证。canonical
   `qinglong/release-catalog-receipt@v1` 冻结 plan、manifest digest、immutable reference 和验证结论；receipt 本身再获得
   GitHub file provenance。
6. release-set 新增独立 `inspect` 模式。它无需已过期的 candidate/image-record 文件，仍会 exact-shape 校验 release、
   scope、owner、镜像集合、双架构、全部 digest reference、Local/Cluster family，并重算 self digest。结果必须显式
   声明 `sourceRecordsReplayed=false`，不能冒充发布阶段的完整 source-record replay。
7. 90 天 workflow artifact 继续作为便利 bundle，包含 release set、catalog plan 和 receipt；它不再承担长期唯一归档
   职责。OCI catalog 也不被宣称为 WORM：组织仍须保留 GHCR package/repository 的读取权限和保留策略，发布 workflow
   不获得删除 catalog 的 authority。

## 部署与资源影响

- Edge/Standalone 的推荐路径是在可信维护工作站解析 discovery tag、验证 immutable catalog 的 Cosign/GitHub
  provenance、取回并独立 inspect `local` release set，然后只把 canonical JSON 和其中的 Local image digest 交给
  设备。设备无需安装 Node、regctl、Cosign、GitHub CLI、Kubernetes 或 PostgreSQL 依赖，运行时 artifact、模块数和常驻
  内存保持不变。
- Cluster 运维者用相同 ceremony 验证 `cluster` release set，并要求 control、control-ai、worker、admin 四个角色精确
  闭合。catalog 只存在于外部 registry 与短生命周期发布 CI，不增加 Pod、controller、listener、timer、watcher、Pool、
  schema、migration 或 SQL。
- `all` 仍只是同时发布两族的维护者入口；设备按所选 deployment family 消费，不因 catalog 耦合 Local 与 Cluster
  运行时。

## 恢复模型

同一 source/version/scope 重跑时允许向 discovery tag 重发相同内容，但每次都必须重新解析 tag、按 immutable digest
取回、逐字节比较并完成签名与 provenance 验证。若 tag 被外部改写，旧 receipt 中的 immutable reference 仍是历史部署
事实；新部署不得信任 tag 的当前值，必须重新执行完整验证并取得新的 receipt。registry 删除、repository visibility 或
组织 retention 变更属于外部治理事件，不能由 release contract 隐藏。

## 被拒绝的替代方案

### 仅延长 Actions artifact retention

拒绝。它仍把长期部署入口绑定到 workflow run 生命周期，且不能提供 registry-native 的 immutable discovery 与
signature/provenance 验证。

### 让 discovery tag 成为部署 authority

拒绝。tag 可被改写，不能替代 manifest digest；它只能帮助发现候选 immutable reference。

### 在路由器上执行完整供应链工具链

拒绝。验证可以在可信工作站完成。把 registry、签名与 GitHub 客户端带入低配设备会扩大镜像、内存、网络和密钥面，
但不会增强设备实际消费的 digest lock。

### 增加常驻 release-catalog 服务

拒绝。OCI registry 已提供所需的存储、digest addressing 和 referrer 能力；常驻协调服务会引入新的可用性与运维故障域。

## 验证

- release-catalog contract 覆盖 Local/Cluster/All plan、receipt、owner/release drift、OCI media/blob/title/annotation/raw digest
  drift、closed CLI、canonical no-replace、rename/symlink/open-mode 拒绝；release-set 同时覆盖独立 inspect 与 drift 拒绝；
- workflow 静态门要求 standalone inspect、catalog plan、checksum-pinned regctl、`--strip-dirs`、immutable get、byte-exact
  compare、raw manifest、catalog Cosign/GitHub provenance、先验证后 receipt、receipt provenance 和 90 天 bundle 的精确顺序；
- 使用官方 regctl v0.11.5 在本机 `ocidir://` 进行真实实验：相同 canonical release set 从两个不同绝对目录发布时，
  `--file-title --strip-dirs` 得到相同 manifest digest
  `sha256:0443422e34edd448499a61f4580b01b9578dc35a117668c948c51a16638e4e9d`，按 basename 从 immutable reference 取回后
  与源文件逐字节一致；仅使用 `--file-title` 会泄漏绝对路径并破坏该性质；
- 定向发布契约、静态 workflow 与 Console distribution 联动测试 93/93；backend 1282 项为 1280 pass、2 条件 skip、
  0 fail；18-package clean build/test 退出 0；release version、package boundary、dependency、Edge import、Cluster/Worker
  deployment、image release、Local image 与 Console distribution 审计全部 compatible；
- package boundary 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；14 档 Local artifact 全部
  compatible，默认 Edge/Standalone 为 2,589,890/2,589,968 bytes，MCP 为 7,315,930/7,316,038 bytes；Cluster Admin
  pack 保持 250 files、271,238-byte tarball、1,690,196-byte unpacked；
- 本 Gate 不修改 schema、migration、SQL、role、Pool、连接或 HA 拓扑，复用 D-331/D-333 PostgreSQL 18.6 arm64
  142/142、timeline `1→2` 基线，不把未重跑的数据库门冒充本阶段新证据；
- 本 ADR 接受源码、契约、静态 workflow 门与本地 OCI 互操作证据。公开 tag 尚未运行，因此不宣称真实 GHCR catalog
  push、Cosign 或 GitHub attestation 已成功；它们必须由实际 release run 取得。
