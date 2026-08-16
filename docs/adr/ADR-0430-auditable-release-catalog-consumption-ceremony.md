# ADR-0430：可审计的 Release Catalog 消费工作站 Ceremony

- 状态：Accepted（实现与本地契约门完成；真实公开 catalog 结果待实际 release tag）
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-333、D-335、D-336、D-337、D-338
- 关联 ADR：ADR-0424、ADR-0425、ADR-0427、ADR-0428、ADR-0429

## 上下文

ADR-0428 已让发布 workflow 生成持久 OCI release catalog，ADR-0429 已能把验证后的 release set 离线物化为 Local
selection 或 Kubernetes locked manifest。但部署者侧仍依赖手工 shell 串联 discovery tag 解析、Cosign、GitHub
attestation、`regctl artifact get`、raw manifest 读取和 standalone inspection。该流程会把文件写入安全性留给调用者的
umask/重定向语义，也不检查 discovery tag 是否在 ceremony 中途移动，不保留工具身份、命令边界或可离线复验的 manifest。

因此，发布端已经有机器化证据，并不等于部署端消费同一 immutable catalog 的过程已经机器化。直接在 release workflow
内自动部署又会把发布写权限与生产部署权限合并，破坏显式运维授权边界。

## 决策

1. 新增根级 `ql3-release-catalog-consumption-ceremony.cjs`，只在可信维护工作站显式运行。`create` 模式从
   source-derived version、40-hex revision、exact tag ref、closed `local|cluster|all` scope、owner/source repository 和
   三个 canonical absolute executable 推导唯一 catalog discovery reference，不接受任意 registry/repository/ref。
2. ceremony 对 discovery tag 解析两次；两次都必须返回同一 lowercase SHA-256 digest。所有后续命令只使用第一次得到的
   `ghcr.io/<owner>/qinglong3-release-catalog@sha256:...`。tag 在验证窗口中移动时失败且不发布 bundle；tag 永远没有部署
   authority。
3. immutable catalog 必须通过 exact workflow identity 的 keyless Cosign verification，以及绑定 source repository、
   workflow、tag、revision、非 self-hosted runner 和 OCI bundle 的 GitHub provenance verification。owner-private token 只注入
   单个 `gh attestation verify` 子进程；`regctl` 与 `cosign` 不接收该 token，也不继承 ambient environment。
4. ceremony 直接捕获而不是 shell 重定向 release-set 与 raw manifest bytes。release set 必须是 bounded canonical UTF-8 JSON，
   通过 standalone structure/identity/family/self-digest inspection；raw manifest 必须与 immutable digest、单层 media type、
   empty config、basename、size/content digest 和四项 annotation 完全一致。工具在每一步前及 ceremony 结束前按
   path/dev/inode/size/SHA-256 复验。
5. 成功后才创建一个此前不存在的 owner-private `0700` bundle directory，并以 `0600`、no-replace、fsync 写入三项精确文件：
   原始 canonical release set、原始 raw catalog manifest、canonical consumption report。report 绑定 source/release/catalog、
   reconstructed plan/receipt digest、文件 digest、镜像闭包、工具 digest、六步 argv/stdout/stderr digest 和自身 digest；不保存
   token、原始 transcript、本机路径或 workstation identity。
6. `audit` 模式完全离线，不调用外部工具。它要求 bundle 只有上述三项文件，重新执行 release-set inspection、catalog plan、
   raw manifest 与 receipt reconstruction，并精确重建 report；外部 Cosign/GitHub 结果只作为 digest transcript 记录，明确
   `externalToolResultsReplayed=false`，不能冒充离线重验了网络证明。
7. 外部工具的 cache/config/tmp 只能写入 bundle parent 下的 ceremony 私有临时目录，成功或失败后 best-effort 清理。ceremony
   不执行 registry/GitHub mutation、不运行 Compose/Kubernetes apply、不连接数据库，也不取得部署 action authority。D337
   materializer 只消费 audit 成功 bundle 中的 release set，部署仍是后续独立人工授权步骤。

## 部署与资源影响

- 不新增 workspace package、生产 dependency、镜像层、数据库、migration、SQL、role、Pool、Pod、controller、listener、timer
  或 watcher；18-package 边界保持不变。
- Edge/Standalone/低配路由设备不安装 Node、regctl、Cosign、GitHub CLI 或 ceremony。可信工作站只把审计后的 Local release set、
  selection 和 immutable image 交给设备。
- Cluster 工作站可消费 `cluster|all` 的四角色闭包，再把 release set 交给离线 Kubernetes post-render materializer；ceremony
  本身没有 Kubernetes client 或 API authority。
- 公开 GHCR、Fulcio/Rekor 与 GitHub Attestations 的实际可用性只由真实 release/consumption run 证明。本地 fake tool 测试只证明
  命令、隔离、输入输出和失败关闭契约。

## 失败与恢复

- discovery 两次解析不同：丢弃本次结果，以新的未使用输出目录重新开始；不能把任一 tag 值当成部署 authority。
- Cosign/GitHub/registry 失败：不发布 bundle，不降级为仅检查 JSON 或 tag。
- tool inode/bytes、token file、output parent 在运行中漂移：失败关闭；不从 ambient PATH 换用另一个 executable。
- 创建最终目录后发生进程/文件系统失败：保留不完整目录供调查，但该目录无法通过 exact-three-file audit；恢复必须使用新目录，
  不覆盖或补写旧 bundle。
- offline audit 失败：重新执行在线 ceremony；不得手工修复 report/digest 声称通过。

## 被拒绝的替代方案

### 保留文档中的 shell 重定向即可

拒绝。它无法统一 no-replace、mode、symlink、输出上限、tool mutation、tag 中途移动和持久 manifest 证据，且容易把调用者的
ambient credential/environment 带入工具。

### 只保存下载后的 release-set JSON

拒绝。release-set self digest 不能证明 OCI manifest 的 media type、layer、title、annotation 或 immutable digest；raw manifest
是离线重建 publication plan/receipt 的必要证据。

### 在 release workflow 成功后自动部署

拒绝。发布 OIDC/package 写权限与生产集群/路由设备 authority 必须分离；验证成功只生成无行动权的部署输入。

### 在路由设备上运行 ceremony

拒绝。该工具依赖 Node、regctl、Cosign 与 GitHub CLI，并执行网络验真；这些成本和凭据面不应进入低资源运行设备。

## 验证

- ceremony 正负门覆盖 Local/All scope、六步工具与 token 隔离、双次 discovery、canonical release set、raw manifest、工具
  mutation、external failure、no-replace、private mode、symlink/open CLI，以及 release-set/manifest/report/目录漂移；独立
  ceremony 测试 20/20；
- 与 deployment lock、release candidate、release set、release catalog 和 image release workflow 的定向发布链联动 121/121；共享
  supply-chain CI 显式运行新测试，删除该测试会失败关闭；
- 完整 backend 共 1,315 项，1,313 pass、2 条件 skip、0 fail；18-package clean build/test 退出 0，package boundary 仍为
  18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；
- release version、deployment lock surfaces、package boundary、cluster dependency、Edge import、Cluster/Worker deployment、image
  release、Local image 与 Console distribution 共 10 项审计全部 compatible；14 档 Local artifact 全部 compatible，默认
  Edge/Standalone 为 2,589,890/2,589,968 bytes，application+AI 为 4,493,043/4,493,175 bytes，MCP 为
  7,315,930/7,316,038 bytes；
- Cluster Admin pack dry-run 保持 250 files、271,238-byte tarball、1,690,196-byte unpacked；
- 本 Gate 不改变数据库或 HA 拓扑，除非完整回归发现相关漂移，否则复用紧邻发布 Gate 的 PostgreSQL 18.6 arm64 physical HA
  基线，不把未重跑结果声明为本阶段新证据。
