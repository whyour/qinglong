# ADR-0364：Package 内部源码布局 Ratchet

- 状态：Accepted
- 日期：2026-08-11
- 关联：D-175、D-207、D-257、D-269、D-276

## 背景

QingLong 3.0 的 workspace package 必须表达独立制品、权限、依赖隔离或稳定适配器边界，不能把领域目录直接升级为微包。另一方面，只限制 package 数量和 `src/` 根文件仍不够：实现可能继续堆积在某个 capability 目录，形成名义上已分层、实际上 ownership 混杂的第二层平铺。

当前 17 个 package 共 1,004 个 TypeScript source，987 个已位于 capability/domain 子目录，`src/` 根层 17 个均为 manifest 可证明的 public/binary entry。剩余结构债务集中在少数高密度目录，而不是 workspace 根边界。

## 决策

1. `docs/ql3-package-boundaries.json` 升级为 schema v6，新增唯一的 `internalSourceLayout` 策略。
2. 任一非根目录直接包含至少 12 个 `.ts`/`.tsx` source 时，必须进入排序、精确的 `reviewedDenseDirectories`；未登记即失败。
3. 每项登记必须声明路径、当前 direct-source hard cap、具体 rationale，以及下列一种状态：
   - `ordered_ledger`：按版本追加且保持单目录更安全的 migration ledger；
   - `ownership_review`：尚需按 capability 继续下沉，但不得在评审前增长。
4. 超过登记 hard cap 必须失败；目录重构后降到阈值以下时，旧登记必须删除，避免永久豁免。
5. `src/` 根层继续执行 D-269 的精确 entry role、file cap、line cap 和 public-export-only 校验。内部密度门不能替代根门，也不能作为新增 workspace package 的理由。
6. 初始冻结 8 个目录：两个 migration ledger，以及 `cluster-admin` 的 prompt-output/worker-credential、`local-owner-cli` 的 deployment/cutover、`runtime-core` 的 security/tool-execution。首个收口把 cutover 的 target-run lifecycle 与 manual-resolution ceremony 下沉到两个 capability 子目录，直接文件 16→10；第二个收口把 Tool Registry facade、Project Tool snapshot 与内建 Run Read 投影下沉到 `tool-registry/` 和 `builtin-run-read/`，tool-execution 直接文件 15→11；第三个收口把 Worker credential management service、transport、HTTP、mTLS、process 与 CLI 下沉到同一 `management-server/` 部署能力目录，worker-credential 直接文件 16→10，同时保留 client、executor 与 delivery 的独立 ownership；第四个收口把 Prompt Output 的 external recovery、retention GC 和 key management 分别下沉到 `external-recovery/`、`retention/` 与 `key-management/`，prompt-output 直接文件 13→0；第五个收口把 Local deployment 的六个 Compose lifecycle 文件与四个共享 contract/file/Docker/render 基础分别下沉到 `compose/` 与 `foundation/`，deployment 直接文件 13→3，顶层只保留 facade、CLI 与 status；第六个收口把 Runtime Security 的身份/API 凭据、Project Policy 与安全审计分别下沉到 `identity-credential/`、`project-policy/` 与 `audit/`，security 直接文件 12→1，根层只保留跨域 principal/fence primitive。六项都删除 stale review；当前只剩两个按原序保留的 migration ledger，没有 ownership review。
7. 审计只在开发、CI 和发布检查中短生命周期运行；不进入 Edge、Standalone、Worker 或 Cluster 常驻制品，不增加依赖、进程、监听、timer、内存或闪存写入。

## 机器门禁

`scripts/ql3-package-boundary-audit.cjs` 现在同时拒绝：

- 缺失或 widened 的内部布局策略；
- 达到阈值但未评审的目录；
- 超过评审 hard cap 的继续平铺；
- 已低于阈值但仍保留的 stale exception；
- 原有的未声明 package、单文件/浅层微包、根实现文件、consumer/dependency/authority 漂移。

当前报告为 schema v6、17/17 package、2 个 reviewed dense directory、`findings=[]`，两项均为 migration `ordered_ledger`。正反向 fixture 10/10 通过，覆盖未评审、增长、重构后 stale 和 policy 缺失；Runtime Tool Execution 移动前 GitNexus 将 Tool Registry facade 判为 HIGH（15 direct/36 impacted/0 process），其余三个文件为 LOW；17-package clean build、Runtime Core 459/459、SQLite 相关 16/16、PostgreSQL 相关 11/11、四个稳定 public subpath 和 HA fixture import 均通过，四个旧 dist 路径为零。Worker credential management 六个文件移动前均为 LOW，最大影响面为 service 的 4 direct/21 impacted 和 transport 的 4 direct/17 impacted；Prompt Output 十三个文件也全部为 LOW，最大影响面为 Kubernetes Secret keyring 的 3 direct/4 impacted。第四批完成后完整 Cluster Admin 269 pass/2 条外部集成条件 skip、dependency 51/51、deployment 47/47、GC deployment 3/3 和 external recovery deployment compatible。第五批移动前 deployment contract 为 CRITICAL（33 direct/36 impacted），files 为 HIGH（17/21），其余最高 MEDIUM；本批只移动物理路径，17-package clean build、完整 Local Owner CLI 151 pass/5 条 root 条件 skip、service bridge import compatible、local-deployment 52 个公开导出和十个旧 source/dist 路径清理均通过。第六批移动前 Project Policy 为 HIGH（27 direct/60 impacted）、Security Audit 为 CRITICAL（33/55），其余最高 MEDIUM；仍只移动物理路径，17-package clean build、Runtime Core 459/459、Local SQLite 209/209、Cluster PostgreSQL 292 pass/1 条外部 PostgreSQL 条件 skip、dependency 51/51、十二个稳定 public subpath 和十一组旧 source/dist 路径清理均通过。同批 PostgreSQL 18.4 arm64 HA Docker 门 112/112 gate、timeline 1→2、旧主 fencing、`pg_rewind` 只读同步 rejoin 与最终 `gates.passed=true`；67,583-byte `0600` 私有报告 SHA-256 为 `a89276760ded51d058fb5ba340e5b68593b2f98fd774e38f9fc6afdec350077c`，独立审计无 finding，Docker 资源零残留。

## 后果

- package 数量继续由部署和 authority 边界决定，不会因为目录整理膨胀。
- 高密度目录不能悄悄继续增长，维护者必须先选择真实 ownership。
- migration ledger 保留可发现性和追加顺序，不为追求目录深度机械拆散。
- 本决策已清空当前 ownership review；剩余两个高密度目录是有意保持顺序与可发现性的 migration ledger，而非待拆职责豁免。
