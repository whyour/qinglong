# ADR-0006：Node.js 24 与多架构支持分层

- 状态：Accepted（由 ADR-0464 机器化；新增架构必须先满足对应原生门禁）
- 日期：2026-07-18
- 决策者：QingLong Maintainers
- 关联 RFC：[QL-RFC-0001](../QINGLONG_3_0_ARCHITECTURE_RFC.md)
- 关联决策：D-05、D-14、D-16、D-17
- Operationalized by：ADR-0464

官方参考：

- [Node.js v24.18.0 release binaries](https://nodejs.org/en/blog/release/v24.18.0)
- [Node.js official Docker image manifest](https://github.com/docker-library/official-images/blob/master/library/node)
- [Node.js supported platforms](https://github.com/nodejs/node/blob/main/BUILDING.md)
- [Node.js 24 node:sqlite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)

## 1. 上下文

QingLong 当前发布矩阵包含 `amd64`、`arm/v6`、`arm/v7`、`arm64`、`ppc64le`、`s390x` 和 `386`。这些架构不仅是 CI 标签，也代表真实的路由器、NAS、旧服务器和异构节点用户。

QingLong 3.0 同时提出：

1. ql-core 固定 Node.js 24 LTS，使用一致的 Web/SQLite 行为。
2. 优先保持现有多架构覆盖，不让小设备成为二等部署环境。

截至 2026-07-18，上游供给不能同时满足这两个承诺：

- Node.js 24 官方 release binary 提供 x64、arm64、ppc64le、s390x，不提供 ARMv6、ARMv7 或 386。
- 官方 Node 24 Docker image 的架构集合还会因 Debian/Alpine variant 不同而变化。
- Node.js BUILDING 将 ARMv7 列为实验级平台；ARMv6 和 32-bit x86 不属于 Node 24 官方发布基线。
- `node:sqlite` 属于 Node 运行时本身，不能在缺少受支持 Node 24 的架构上单独安装来解决问题。

因此，“所有现有架构继续发布 3.0”与“所有 3.0 都是官方 Node 24”当前是冲突目标。继续依赖 Alpine 仓库的浮动 `nodejs` 只会隐藏差异，不能解决冲突。

## 2. 决策

3.0 使用显式支持 Tier，不再用一个无条件 multi-arch manifest 暗示所有平台获得同等测试、恢复和安全承诺。

### 2.1 Tier 1：正式支持的 ql-core

候选架构：

- `amd64`
- `arm64`
- `ppc64le`，前提是选定镜像 variant 有固定 Node 24 产物并通过数据库门禁
- `s390x`，前提同上

要求：

- 固定同一 Node 24 exact patch，不从发行版仓库浮动安装 Node。
- 每个 libc/arch 组合通过安装、启动、migration、backup/restore、最小任务和 edge 资源门禁。
- 发布 manifest 只包含实际通过门禁的组合；不能为追求列表完整度加入未验证平台。
- 安全更新升级 Node patch 后重新运行完整矩阵。

### 2.2 Tier 2：实验支持

ARMv7 只有在项目拥有以下全部资产时才发布 3.0 experimental image：

- 可重复且受版本控制的 Node 24 toolchain/build recipe。
- 独立设备或可信模拟环境上的启动、SQLite、任务和恢复测试。
- 明确标注无上游官方 binary、支持周期和已知限制。
- 不阻塞 Tier 1 安全更新，不进入默认 `latest` manifest。

仅在某台 Maintainer 设备上构建成功，不足以进入 Tier 2。

### 2.3 Legacy-only

ARMv6、386，以及未通过 Node 24 门禁的 ARMv7 继续由有明确 EOL 的 2.x legacy support line 服务。它们不得被标记成满足 D-16 的完整 3.0 ql-core。

Legacy-only 不是静默停止维护：

- 继续接收约定窗口内的安全、任务执行和数据兼容修复。
- 升级页必须在修改数据库前说明设备无法进入完整 3.0 的原因与可选路径。
- 2.x 数据库保持可备份、可导出，未来迁移到受支持 3.0 控制面时不锁死。

### 2.4 老设备参与 3.0 集群

旧架构设备仍可作为执行节点参与 3.0，但不能假装运行完整 ql-core：

- 短期：由受维护的 2.x 节点通过明确兼容协议接收受限任务；协议范围、身份和 EOL 另行 ADR。
- 长期：评估不依赖 Node 控制面的轻量 Worker Agent；在安全模型、升级成本和资源基准成立前不承诺实现语言。
- 控制面必须展示 Worker 的 arch、runtime、capability、协议版本和支持 Tier，调度前阻止不兼容任务。
- Legacy Worker 不获得插件 Host、任意 Tool 或控制面数据库访问权。

该路径保留旧路由器的执行价值，但不把完整 Web/API/数据库控制面复制到无法获得受支持运行时的平台。

## 3. 发布命名与元数据

每个镜像/二进制至少声明：

    qinglongVersion
    nodeVersion
    architecture
    libc
    deploymentProfiles
    supportTier
    databaseDriver
    builtAt

建议 tag 语义：

    next / 3.0.x              只指向 Tier 1 manifest
    3.0.x-experimental-*     单独的 Tier 2 tag，不进入 latest
    2.x-legacy-*             明确 legacy line 与 EOL，不冒充 3.0

UI、诊断包和升级日志必须展示这些字段，不能只输出应用版本号。

## 4. 为什么不把 Node 22 作为隐式 3.0 回退

Node 22 能覆盖更多 32-bit ARM 镜像，但把同一个 3.0 tag 在不同架构上静默切换 Node major 会造成：

- `node:sqlite` API/stability/options 不一致。
- 数据库 adapter、备份和 defensive mode 行为分叉。
- 插件 engine、Web API 和安全修复周期不同。
- 用户无法从版本号判断真实能力。

若 Maintainers 决定让 Node 22 成为正式 3.0 compatibility runtime，必须先修改 D-16，并为两条 runtime 建立独立 capability 与测试矩阵；不能作为 Dockerfile 中的条件分支偷偷发生。

## 5. 被拒绝的方案

### 5.1 继续从 Alpine 仓库安装浮动 nodejs

同一 QingLong tag 会随构建时间获得不同 Node major/patch，无法重现数据库和插件行为。

### 5.2 QEMU 构建成功即视为支持

交叉构建不能覆盖真实内核、seccomp、VFS、内存压力、信号和断电恢复行为。QEMU 可以是 smoke 层，不能替代设备门禁。

### 5.3 为了 multi-arch 数量放弃 Node 24 固定基线

这会把运行时差异转嫁给数据库、插件和用户，且没有清晰支持边界。若要修改 Node 基线，应显式修订 RFC，而不是由镜像脚本决定架构政策。

### 5.4 立即新增另一种语言的 Worker

轻量 Worker 可能是长期方向，但现在决定语言会扩大构建、协议、安全和维护面，且不能替代 3.0 控制面核心切片。

## 6. 影响

正面：

- 发布承诺与上游运行时供给一致。
- ARMv7/ARMv6/386 用户能在升级前看到真实路径和支持周期。
- Node patch、数据库 driver 与恢复报告可重现。
- 集群调度可以基于真实 capability，而不是只看 arch 字符串。

负面：

- 完整 3.0 的首发架构可能少于 2.x。
- 若维护 ARMv7 experimental，需要额外 toolchain、设备和安全成本。
- Legacy line 与兼容 Worker 协议会增加一段时间的双线维护。

## 7. 进入 Beta 的门禁

1. Maintainers 明确接受、修改或拒绝本 Tier 方案。
2. 发布流水线固定 Node 24 exact patch，不使用浮动发行版 Node。
3. Tier 1 的每个 arch/libc 组合有可重复 CI 或设备报告。
4. ARMv7 是否进入 Tier 2 有明确 owner、toolchain 和支持周期；否则归入 legacy-only。
5. ARMv6、386 的 2.x EOL、迁移和备份说明可见。
6. 镜像、UI 和诊断信息能展示 supportTier、Node、arch、libc 和 databaseDriver。
7. 多架构 manifest 不包含未通过门禁的组合。

## 8. 接受标准

- 接受 3.0 架构支持按 Tier 声明，而不是无条件延续旧 manifest。
- 接受 Tier 1 固定官方 Node 24 exact patch。
- 接受 ARMv7 只有在自维护 toolchain 和设备门禁齐备后才能作为 experimental 发布。
- 接受 ARMv6、386 默认进入有 EOL 的 2.x legacy line，而不是伪装成 Node 24 3.0。
- 接受旧设备可通过受限 Worker 兼容路径参与 3.0，但不拥有完整 ql-core 权限。
- 接受任何 Node 22 的 3.0 compatibility runtime 都必须先显式修订 RFC。

## 9. 2026-08-20 实施状态

ADR-0464 已把本 ADR 从候选分层转为唯一发布身份中的机器契约。当前 3.0 Tier 1 精确为 `amd64`、`arm64`；
`ppc64le`、`s390x` 保持候选，必须在进入默认 manifest 前取得固定 Node 24 镜像与同等级原生门禁；`arm/v7`
因没有受维护 toolchain、owner 与设备证据而保持 experimental blocked；`arm/v6`、`386` 留在显式 `2.x`
legacy line。该状态不是删除小设备支持：2.x 兼容窗口和未来受限 Worker 路径仍需单独关闭，但不能冒充完整 3.0
ql-core 支持。

根 `ql3-release.json` 的 `qinglong/release-identity@v2` 是唯一事实源；release candidate、原生 OS matrix、OCI
platform 列表、release set 和 version audit 都从它派生。任何新增 Tier 1 架构若没有对应原生 runner mapping，
发布候选会失败关闭。实现未新增 workspace package、运行时依赖、服务、timer、数据库对象或 Edge 常驻成本。
