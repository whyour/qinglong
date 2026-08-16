# ADR-0426：以单一源码身份治理 3.0 版本，并提供可恢复的版本迁移

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-01、D-03、D-14、D-42、D-61、D-186、D-333、D-334
- 关联 ADR：ADR-0196、ADR-0253、ADR-0254、ADR-0255、ADR-0425

## 背景

QingLong 3.0 的当前版本同时存在于 18 个 workspace manifest、四组容器 build/runtime manifest 与 lock、
四个 Dockerfile label，以及 Kubernetes/Console 部署材料。D-333 已能在候选发布时发现 version/tag 漂移，
但没有定义哪个文件是版本 authority，也没有提供从一个版本安全迁移到下一个版本的正式路径。人工批量替换
会漏改部署面、误改 legacy 2.x 根 package，或在进程中断后留下无法判断的新旧混合状态。

版本治理本身不应进入 Edge、Standalone 或 Cluster 常驻运行时，也不能为了统一版本引入新的 workspace package。

## 决策

### 1. `ql3-release.json` 是唯一 3.x release identity authority

根级 canonical JSON 固定 product、exact 3.x SemVer、Node 版本/engine、workspace package 数量以及 legacy 根排除事实。
读取者只接受 bounded、canonical、non-symlink regular file、精确字段顺序和值；SemVer 必须同时通过 3.x 约束和
标准 SemVer 校验。legacy 根 `package.json` 的 2.x version 明确不参与 QingLong 3 release identity。

发布候选、容器/部署审计和物理 Edge 证据不再各自保存一份 3.0 常量，而是读取同一 authority。D-333 candidate
contract 还会携带 identity schema 与 canonical SHA-256，使发布证明能发现 authority 被事后替换。

### 2. CI 对完整版本表面执行失败关闭审计

`audit:release-version:ql3` 必须验证：

- 18 个 workspace version 与 Node engine；
- 四组容器 build/runtime manifest、lock、Dockerfile Node base 和 OCI version label；
- Kubernetes Cluster/Worker 与 Console 部署材料中的 QingLong 3 image/source tag；
- legacy 根仍为不同的 2.x version，且没有被纳入迁移集合。

审计只读取源码文件，具有 4 MiB 单文件、512 个受管文件和 canonical path/symlink 上限，不启动 listener、timer、
数据库或容器。共享 CI 与 image-release 静态审计均必须证明该 gate 存在，不能只依赖实际发布时才发现漂移。

### 3. 版本升级使用 review-first 的 `plan → apply` 两阶段协议

`ql3-version-transition.cjs` 只接受三个封闭模式：

1. `--mode=audit`：审计当前 identity；
2. `--mode=plan --from=<current> --to=<newer> --output=<absolute>`：生成 no-replace `0600` plan；
3. `--mode=apply --plan=<absolute> --report=<absolute>`：应用已审阅 plan 并生成 no-replace `0600` report。

目标必须是严格单调递增的 exact QingLong 3 SemVer；降级、相等版本、build metadata 和非 canonical SemVer 均拒绝。
plan 精确列出每个 path、mode、替换次数、before/after bytes 与 SHA-256，并对 unsigned canonical 内容形成自身 digest。
当前 `3.0.0-alpha.0 → 3.0.0-alpha.1` 计划覆盖 65 个文件、83 处替换，根 2.x package 不在集合中。

### 4. apply 必须先全量预检，再允许逐文件收敛

apply 在第一次写入前验证 plan 自身、legacy 版本、完整文件集合，以及每个受管文件的 mode 和 before/after digest。
任何第三种状态都使整次操作在无源码 mutation 时失败。通过预检后，每个 source 状态文件先写同目录确定性临时文件、
`fsync`，再 atomic rename；已经处于 target 状态的文件被计入 recovery，而不是报错。因而进程在部分 rename 后中断时，
原 plan 可原样重放直至全部 target，成功后再运行完整 identity audit。report 区分 changed/already-current，并以 canonical
SHA-256 绑定 plan 和结果。

该协议提供进程中断后的幂等恢复，不宣称跨 65 个文件的单事务原子性，也不替代 Git review/commit。机器断电时的目录项
持久性由文件系统和 Git 工作区恢复承担；apply 不自动 commit、tag、push 或触发 release。

## 资源与权限边界

- 不新增 workspace package、生产 dependency、schema、migration、SQL、role、Pool、Pod 或容器；
- 所有版本命令是维护者显式启动的短生命周期 Node 进程，Edge/Standalone/Cluster 运行时零常驻开销；
- plan/report 必须写入 canonical absolute、尚不存在的路径，拒绝 symlink 与覆盖；
- 工具只修改 plan 中经 before digest 证明的仓库文件，不触碰 legacy 根 version；
- 版本迁移完成后仍须经过完整回归、GitNexus `detect-changes` 和人工阶段提交。

## 失败与恢复

- audit 漂移：先修复 authority 或受管表面，不在发布 workflow 内临时覆盖；
- plan 后源码漂移：废弃旧 plan，重新 audit/plan/review；
- apply 部分完成：保留同一 plan，使用新 report path 原样重放；
- report path 已存在：选择新 path，不覆盖旧证据；
- 非 3.x、降级或非法 SemVer：拒绝迁移，另行走兼容/回滚决策；
- Git review 发现非预期文件：不提交，修复受管集合或计划生成器后重新执行。

## 被拒绝的替代方案

### 让根 2.x `package.json` 成为 3.0 版本源

拒绝。该文件仍服务 legacy 产品与现有构建，强行改成 3.x 会把兼容线和新架构发布线混为一体。

### 在 release workflow 内直接 `sed` 全仓版本

拒绝。它没有可审阅的精确文件集合、before digest、全量预检或部分失败恢复，还会让 tag 构建修改 checkout。

### 为每个 package 使用独立版本

拒绝。3.0 当前发布的是同一产品候选和闭合镜像集合；独立版本会放大部署 compatibility matrix。若未来确需独立发布，
应以新的 package/release RFC 显式改变 authority，而不是允许静默漂移。

## 验证

- 版本 identity/audit/plan/apply/replay/partial recovery/no-mutation preflight/CLI 负向门已实现；
- release candidate、Cluster/Local image、OCI、部署、CloudNativePG、物理 Edge 与外部恢复定向回归 177/177；
- backend 1,254 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0；package boundary 保持 18 个 package、
  `singleSourcePackages=[]`、`shallowSourcePackages=[]`，dependency、Edge import、Cluster deployment、image release 与
  Local image 审计均 compatible；
- 14 档 Local artifact 全部 compatible：默认 Edge/Standalone 为 2,589,890/2,589,968 bytes、315 files、56 modules，
  application+AI 为 4,493,043/4,493,175 bytes，MCP 为 7,315,930/7,316,038 bytes；Cluster Admin pack 保持
  250 files、271,238-byte tarball、1,690,196-byte unpacked；
- 格式与 `git diff --check` 已通过；GitNexus 索引与 `detect-changes` 在阶段提交前最终刷新；
- 本 Gate 不修改数据库或 HA 拓扑，PostgreSQL physical HA 复用 D-331/D-333 的 18.6 arm64 142/142、timeline `1→2`
  基线；若完整回归发现数据库/部署契约漂移，则必须重新运行 PostgreSQL HA 门而不能复用。
