# ADR-0431：Catalog-bound Deployment Lock 证据链

- 状态：Accepted（实现与定向契约门完成；真实公开 catalog 运行待实际 release tag）
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-337、D-338、D-339
- 关联 ADR：ADR-0427、ADR-0428、ADR-0429、ADR-0430

## 上下文

ADR-0430 已把 discovery、签名、provenance、release-set 与 OCI manifest 收敛到一个可离线复验的 three-file
consumption bundle；ADR-0429 的 deployment-lock materializer 却仍接受任意独立 `--release-set` 文件。两份文件即使内容相同，
materializer 也无法证明它读取的是刚刚通过 catalog ceremony 验真的那份 byte authority，输出中也没有 catalog immutable
reference、manifest digest 或 consumption report digest。文档约定不能替代机器约束。

直接让 release workflow 部署，或让 deployment lock 重新联网验签，都会混合发布、部署与网络 authority。把完整 Node、Cosign、
GitHub CLI、regctl 或 Kustomize 下沉到低配路由器同样不成立。

## 决策

1. `ql3-deployment-lock-contract.cjs` 的 Local/Kubernetes create/audit CLI 删除松散 `--release-set` 输入，改为同时要求
   `--consumption-bundle` 与 exact `--source-repository`。旧参数是失败关闭的非法开放输入，不提供兼容旁路。
2. materializer 首先调用 ADR-0430 的完整 offline bundle audit：目录必须是 canonical、current-owner、`0700`，且只能包含三项
   canonical/current-owner `0600` 文件；release-set、raw OCI manifest、reconstructed plan/receipt、六步 argv/transcript digest 与
   self-digest report 必须重新闭合。只有同一次 audit 实际读取的 release-set 对象可以继续进入 lock materialization，避免审计后
   再从松散路径读取造成新的 TOCTOU 窗口。
3. Local selection 与 Kubernetes lock schema 升为 v2，并写入同一 catalog authority：consumption schema、source repository、
   exact workflow identity、immutable catalog reference、manifest digest、consumption report digest、release-set digest 和
   `discoveryTagAuthority=none`。任一 identity、scope、owner、image count 或 digest 不一致均失败关闭。
4. Kubernetes 被改写的 workload/Pod template 与固定 Plugin Package admission ConfigMap 除 release-set/version/revision 外，还写入
   catalog manifest 与 consumption report digest annotation。最终 apply 的 YAML 因而不能脱离其验真来源；lock report 继续绑定
   输入/输出 manifest digest、角色闭包与自身 digest。
5. offline audit 明确记录 `catalogConsumption=offline_reconstructed` 和 `externalToolResultsReplayed=false`。它验证已保存证据的一致性，
   不谎称重新执行过网络签名或 provenance verifier。
6. 本 Gate 仍没有部署 action authority：不访问 registry/GitHub/Kubernetes API，不执行 Compose rollout 或 `kubectl apply`，不修改
   数据库。Local/Cluster 的最终行动继续由独立、显式授权步骤完成。

## 部署与资源影响

- 不新增 workspace package、生产依赖、数据库、migration、SQL、Pool、Pod、controller、CRD、RBAC、listener、timer 或 watcher。
- Node、regctl、Cosign、GitHub CLI 和 Kustomize 只存在于可信维护工作站。低配设备只接收 catalog-bound Local v2 selection 与
  immutable Local image reference，不下载 Cluster 镜像或加载集群依赖。
- Cluster 复用既有离线 post-render 路径；新增字段只增加少量 JSON/YAML 字节，不增加运行期 CPU、内存或网络开销。

## 失败与恢复

- bundle 缺项、多项、symlink、权限/owner/路径漂移，release-set/manifest/report 任一字节漂移，以及 source identity 或 catalog
  binding 不一致，都会在任何 output 创建前失败。
- create 输出保持 `0600`、no-replace；结果未知时使用同一 bundle、identity、原 render 和原输出路径执行 audit，不改用裸
  release-set，也不手工删除或覆盖证据。
- catalog discovery tag 移动不改变已绑定 immutable reference；若需要发布另一 digest，必须执行新的 online ceremony 并生成新的
  bundle/selection/lock，而不是修改旧报告。

## 被拒绝的替代方案

### 继续依赖文档规定同一 release-set 路径

拒绝。路径约定无法证明文件属于已验真的 three-file bundle，也无法被 CI 或 offline audit 强制执行。

### 在 materializer 中重新联网验签

拒绝。会扩大网络、凭据和工具面，并让离线重放不可用；ADR-0430 已提供职责单一的在线 ceremony。

### 把 catalog 工具安装到路由设备

拒绝。低资源目标不应承担供应链工作站成本；设备只消费由工作站生成的最小、digest-bound 结果。

### 验真成功后自动 apply

拒绝。可信输入不等于部署授权，发布/验真身份不能自动获得生产 Local 或 Kubernetes mutation authority。

## 验证

- deployment-lock 与 catalog-consumption 联合正负契约覆盖 Local/Cluster、真实 four-overlay Kustomize render、bundle symlink/open
  arguments、旧 `--release-set` 旁路、catalog/release-set mismatch、no-replace 与 output alias；完整定向发布链 123/123；
- 共享 supply-chain CI 已固定运行两个测试文件，删除任一门都会使 image-release 静态审计失败；
- 完整 backend 共 1,317 项，1,315 pass、2 条件 skip、0 fail；18-package clean build/test 退出 0，package boundary 仍为
  18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；
- release version、deployment lock surfaces、package boundary、cluster dependency、Edge import、Cluster/Worker deployment、image
  release、Local image 与 Console distribution 共 10 项审计全部 compatible；14 档 Local artifact 全部 compatible，默认
  Edge/Standalone 为 2,589,890/2,589,968 bytes，application+AI 为 4,493,043/4,493,175 bytes，MCP 为
  7,315,930/7,316,038 bytes；
- Cluster Admin pack dry-run 保持 250 files、271,238-byte tarball、1,690,196-byte unpacked；
- 本 Gate 不改变数据库或 HA 拓扑，复用紧邻发布 Gate 的 PostgreSQL 18.6 arm64 physical HA 基线，不把未重跑结果声明为本阶段
  新证据。
