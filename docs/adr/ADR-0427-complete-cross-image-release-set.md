# ADR-0427：完整跨镜像发布集与部署 Digest Lock

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-333、D-334、D-335

## 上下文

D-333 已把发布候选拆成 `local|cluster|all` 三个 deployment-family scope，并让每个镜像在原生
amd64/arm64 build、OS 漏洞扫描、OCI 合并、Cosign 与四类 GitHub attestation 后独立回读验证。
但矩阵 publisher 过去会在各自验证完成后立即写 version/source tag。五个仓库之间没有事务，后续镜像失败时，
部署者可能看到只覆盖部分候选的同版本标签，也没有一个能同时冻结 scope、source revision 和所有镜像 digest 的
部署输入。

## 决策

1. 每个 publisher 只发布不可变 digest，不再写 version/source tag。完成远端 manifest、Cosign、四类 GitHub
   attestation 和适用的 Local profile rollout 验证后，生成一个 canonical、no-replace、mode `0600` 的
   `qinglong/release-set-image-record@v1`。
2. image record 必须绑定同一个 source-derived release candidate digest、scope、version、source ref/revision、
   lowercase repository owner、repository、双架构、immutable reference 和自身 SHA-256。矩阵 job 只保留同一
   `run_id/run_attempt` 的短期 record artifact。
3. 唯一 `release-set` job 必须等待整个 publish matrix 成功，重新从 exact tag source 创建并审计 candidate，下载
   同一次 workflow attempt 的全部 record，并要求 record 集与 candidate image 集精确闭合、无遗漏、无重复、顺序
   与 candidate 一致。
4. 聚合结果为 `qinglong/release-set@v1`，按 `local` 与 `cluster` deployment family 列出 exact digest reference、
   version/source tag、platform 和 image-record digest。`local` scope 只包含 Local image；`cluster` scope 包含
   control、control-ai、worker、admin；`all` 同时闭合两族。
5. 只有 release set 独立重算审计成功后才允许统一 promotion。promoter 先回读所有 source digest 和已有 tag：
   tag 若已指向其他 digest 则失败；缺失 tag 才执行 digest-to-tag copy；每次写入后必须再次解析为 release-set
   digest。
6. 不宣称 GHCR 跨 repository tag write 具有原子性。恢复模型明确为
   `verify_exact_digest_then_continue`：失败重跑先验证已存在 tag，只有相同 digest 才继续补齐其余 tag。
   workflow concurrency 只串行化同一 release ref，外部写入仍由 conflict preflight 失败关闭。
7. 完整 release-set JSON 使用 GitHub file provenance attestation，并作为 90 天、no-overwrite 的 deployment
   digest-lock artifact 发布。生产部署必须从该文件取 `@sha256:` reference；version/source tag 只用于发现和
   人类导航，不能成为 rollout authority。

## 部署与资源影响

- Edge/Standalone 路由设备只下载并解析 `local` release set，不需要 Cluster 镜像、Kubernetes、数据库或发布
  工具；运行时 artifact、模块数和常驻资源预算不变。
- Cluster 节点使用 `cluster` release set，同时锁定四个角色镜像；release-set job 只存在于发布 CI，不新增
  Pod、controller、listener、timer、watcher、Pool、schema、migration 或 SQL。
- `all` 是维护者同时发布两族的便利 scope，不把 Local 部署依赖于 Cluster 私有证据，也不要求单个设备拉取
  五个镜像。

## 被拒绝的替代方案

### 每个矩阵 job 验证后立即打标签

拒绝。单镜像证据正确不等于 deployment family 完整；部分成功会暴露同版本的混合状态。

### 假设多个 GHCR repository 的 tag promotion 原子

拒绝。registry 没有本 workflow 可用的跨仓库事务。显式、可重入的 digest preflight 比虚构原子性更可靠。

### 让部署继续只引用 version tag

拒绝。tag 可变且无法表达同一 source candidate 下的跨镜像闭包。生产 rollout 必须使用 release set 中的
immutable digest。

### 为 release-set 增加常驻发布协调服务

拒绝。该问题属于低频发布控制面，GitHub Actions 的有界终态 job 足够；常驻服务会给低配用户和集群都增加
不必要的新故障域。

## 验证

- contract 覆盖 Local/Cluster/All 聚合、缺失/重复/跨候选 record、owner/digest/report drift、symlink、额外文件、
  closed CLI、no-replace 与独立 audit；
- workflow 静态门要求 per-image publisher 不再 promotion、record 位于全部验证之后、same-run attempt 下载、
  publish matrix 全成功、独立 aggregate/audit、checksum-pinned copier、先全量 preflight 后 promotion、最终 file
  attestation 和 90 天 artifact；
- release-set contract/workflow 定向门 73/73，连同 Admin Console distribution 交叉审计为 77/77；backend
  1,264 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0；package boundary 仍为 18 packages、无
  single-source/shallow package，dependency、Edge import、Cluster/Worker deployment、image release 与 Local image
  审计均 compatible；
- 14 档 Local artifact 全部 compatible，默认 Edge/Standalone 为 2,589,890/2,589,968 bytes、315 files、
  56 modules，application+AI 为 4,493,043/4,493,175 bytes，MCP 为 7,315,930/7,316,038 bytes；Cluster Admin
  pack 保持 250 files、271,238-byte tarball、1,690,196-byte unpacked；
- 本 Gate 不修改 schema、migration、SQL、role、Pool、连接或 HA 拓扑，因此复用 D-331/D-333 PostgreSQL 18.6
  arm64 142/142、timeline `1→2` 基线，不把未重跑的数据库门冒充本阶段新证据；
- 本 ADR 接受的是源码、契约和 workflow 门。公开 tag 尚未运行时，不宣称真实 GHCR promotion、Cosign 或 GitHub
  attestation 已成功；它们必须由实际 release run 取得。
