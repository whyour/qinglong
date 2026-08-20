# ADR-0464：机器化 Node 24 架构支持分层

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-14、D-16、D-371
- 关联 ADR：ADR-0006、ADR-0088、ADR-0281、ADR-0329、ADR-0463
- Accepts and operationalizes：ADR-0006

## 上下文

QingLong 部署跨度从低性能路由设备、NAS 到 Cluster control plane 与 Worker 节点。2.x 历史镜像覆盖的架构数量，
不能直接等价为完整 3.0 ql-core 的支持承诺：3.0 固定使用 Node 24 和 `node:sqlite`，而上游官方产物、镜像
variant 与原生测试资源没有覆盖 ARMv6、ARMv7 和 386。此前 ADR-0006、D-14 与 D-16 仍是 Proposed，发布脚本
虽然实际只生成 amd64/arm64，却没有一个机器可读、可审计的支持分层，因此文档、OCI manifest 与未来 matrix
可能独立漂移。

继续把所有历史架构放进一个默认 manifest 会让低配设备用户收到虚假升级承诺；反过来静默删除这些架构也会
损害现有部署。3.0 必须同时诚实声明完整核心的边界，以及 2.x legacy 和未来受限 Worker 兼容路径的边界。

## 决策

1. 接受 ADR-0006。3.0 ql-core 的唯一生产运行时基线固定为 Node `24.18.0`，engine 为
   `>=24.18.0 <25`；不同架构不能在同一个 3.0 tag 下静默回退 Node major。
2. 根 `ql3-release.json` 升级为 `qinglong/release-identity@v2`，增加 exact-shape
   `architectureSupport`，作为版本、Node、workspace 边界和架构政策的单一发布事实源。
3. 当前 Tier 1 精确为 `amd64`、`arm64`。只有它们进入默认 3.0 OCI platform 列表与原生 OS vulnerability
   matrix；每个 image 都必须在对应原生 runner 构建、扫描并绑定 immutable OCI evidence。
4. `ppc64le`、`s390x` 为 candidates，不是已支持平台。只有获得固定 Node 24 image variant、原生
   runner/设备、数据库 migration/backup/restore、任务、资源和发布证据后，才能通过新的 release identity schema
   变更进入 Tier 1。
5. `arm/v7` 当前为 experimental blocked：没有已接受的 maintainer owner、可重复 Node 24 toolchain 与设备门。
   补齐后也必须使用独立 experimental tag，不自动进入默认 manifest。
6. `arm/v6`、`386` 为 legacy-only，显式绑定 `2.x` line。它们不能被标成满足 D-16 的完整 3.0 ql-core；
   EOL、迁移、备份和受限 Worker 兼容协议分别治理，不能由本 ADR 虚构完成状态。
7. `scripts/lib/ql3-release-identity.cjs` 对 v2 字段、顺序和值失败关闭并深冻结架构列表；非 canonical JSON、
   添加未知字段或把 candidate 擅自加入 Tier 1 都会被拒绝。
8. release candidate 从 Tier 1 派生 `linux/<arch>` platforms 和每镜像原生 runner matrix，并加入
   `architecture-support-tier` 必需门。Tier 1 没有受审 runner mapping 时发布失败，而不是降级为 QEMU 或跳过扫描。
9. release identity digest 继续传入 candidate、image record、release set、catalog、publication closure 与
   deployment lock，支持矩阵变化会自然改变整条发布证据链；version audit 同时输出架构分层。
10. 本实现不新增 workspace package、生产 dependency、runtime binary、服务、timer、端口、数据库对象或
    部署 workload。它只改变离线发布权威和 CI matrix，因此 Edge/Standalone 常驻资源闭包保持不变。

## 被拒绝的替代方案

### 保留文档表格，发布脚本继续硬编码 amd64/arm64

拒绝。两份事实源会在新增架构、Node patch 或 workflow 重构时漂移，且 release set 无法证明自己遵循哪份政策。

### 为架构政策新增一个 workspace package

拒绝。该政策只有一个根发布事实源和离线 validator，没有独立生产生命周期或依赖边界；新增 package 会重现
单文件微包问题，并让低资源制品审计承担无收益的结构成本。

### 立即把 ppc64le、s390x 加入 Tier 1

拒绝。上游可能存在 Node binary 不等于当前 Debian image、数据库、恢复、资源和发布门已经完成；支持承诺必须
由同等级证据产生。

### 把 ARMv7 直接归入 legacy-only 或 Tier 1

拒绝。它仍保留 experimental 的技术路径，但当前资产不足以发布；既不能掩盖未来可能性，也不能伪造现有支持。

### 让旧设备在 3.0 tag 下运行 Node 20/22

拒绝。同一版本跨架构拥有不同 SQLite、Web API、插件 engine 与安全周期，会使 ql-core capability 不可判断。

## 验证与证据

- release candidate、version transition、release set、catalog、publication closure 和 deployment lock 聚焦回归为
  `55/55`，覆盖 v2 schema、精确支持分层、来源派生 platforms/matrix、必需门与 post-create mutation 拒绝。
- 架构漂移负向用例把 `ppc64le` 未经 schema 变更加入 Tier 1，release identity audit 必须失败关闭。
- 完整 backend 工作区为 `1,503 total / 1,501 pass / 2 conditional skip / 0 fail`；其中包含一条既有、未跟踪且
  不会提交的用户测试，因此 D-371 提交范围对应 `1,502 total / 1,500 pass / 2 skip`。沙箱首次运行唯一失败为
  loopback `listen EPERM`，允许 `127.0.0.1` 的宿主环境原样重跑后零失败，未把权限限制误判成代码回归。
- 18-package clean build 与逐包测试退出 0。release version、package boundary、cluster dependency、Edge import、
  cluster deployment 与 image release 六项审计全部 compatible；workspace 保持 18 packages、无 single/shallow
  package，证明本决策没有重新扩大 package 或依赖树。
- 14 档 Local artifact audit 必须串行执行，因为并行 build/pack 会争用相同 package `dist`、产生不可信的短暂
  字节差；串行复核全部 compatible。基础 Edge/Standalone 为 `2,589,998 / 2,590,076` bytes，Application+AI 为
  `4,493,151 / 4,493,283` bytes，MCP 为 `7,315,930 / 7,316,038` bytes，与 D-370 稳定基线一致。

## 后续边界

- 制定 2.x legacy line 的可见 EOL、备份/迁移说明，不能只在内部 RFC 中声明。
- 为旧设备参与 3.0 设计最小 capability、身份、调度限制和 EOL 明确的受限 Worker 协议；legacy Worker 不获得
  Plugin Host、任意 Tool 或控制面数据库访问权。
- ppc64le/s390x 进入 Tier 1 或 ARMv7 进入 experimental 前，必须先提交独立 ADR、runner/toolchain owner 与原生
  证据；不能只修改数组让 CI 看似扩容。
