# ADR-0040：Profile 激活顺序与 Edge 导入隔离

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0036、ADR-0038、ADR-0039

## 上下文

独立 migration stream、schema readiness 和独立 cluster package 仍不能单独证明部署安全。两个装配错误会直接破坏 Profile 边界：

1. cluster-control 在 readiness 前创建 Repository、启动恢复 timer 或注册 admission；
2. edge 虽然不执行 cluster 路径，但根 importer 或启动导入闭包仍安装、解析或加载 PostgreSQL/Drizzle bundle。

前者会让不兼容 schema 或过度授权 role 在 fail-closed 之前产生业务副作用；后者会让低性能路由设备承担无用的安装体积、native/供应链风险和启动内存。仅使用动态 `import()` 只能推迟模块求值，不能从 edge lockfile、镜像或安装树中移除依赖。

## 决策

### 1. Cluster-control 只有一个有序激活门

cluster-control 的启动顺序固定为：

1. 明确启用且 Profile 精确为 `cluster-control`；
2. 执行 ADR-0039 的只读 readiness；
3. readiness 成功后才创建业务 Repository 和 runtime stack；
4. 先执行有界 startup recovery，并证明 `safe=true`、`remaining=0`、`failed=0`；
5. 再启动 claim、recovery 等 lifecycle；
6. 最后安装 admission，使 API、scheduler 或其他 producer 可以提交新工作。

禁用时不得查询数据库、创建 stack、启动 timer 或安装 admission。错误 Profile 必须在数据库探测前拒绝。readiness 成功不是自动接管信号，只有完整顺序全部完成后状态才是 active。

### 2. 失败与停止采用反向撤销

stack 创建后的任一步失败都必须：

1. 撤销已安装 admission；
2. 有界停止已创建的 lifecycle/stack；
3. 写低敏失败审计；
4. 保留原始激活错误，不用 cleanup 或 audit 错误覆盖根因。

正常停止同样先关闭 admission，再停止 stack。停止必须幂等；重复调用共享同一个停止结果。`installAdmission()` 必须自身具备原子安装或失败回滚语义，不能抛错后留下不可撤销的半注册入口。

数据库资源由外层 lazy bootstrap 管理：只有已启用且 Profile 为 `cluster-control` 时才调用 `openDatabase()`。readiness、assembly 或 activation 任一步失败，都在保留原错误后关闭数据库；active shutdown 必须先完成 admission/stack stop，再关闭 Pool。Pool close 失败不得跳过 stack stop，重复 stop/close 共享同一 Promise。

### 3. Readiness evidence 只授权本次装配

Repository factory 接收本次 readiness evidence，用于绑定 contract name/version、PostgreSQL major 和 migration IDs。evidence 不是永久缓存，也不能跨数据库、凭据或进程复用。连接重建、role 变化或数据库 failover 后，实际 production adapter 必须按运维策略重新证明 readiness；不得用旧 evidence 绕过检查。

### 4. Edge 根 importer 不得声明 cluster 依赖

edge/standalone 共用的根 `package.json` 在以下区段都不得声明 `pg`、`pg-native`、`drizzle-orm`、`drizzle-kit`、`@types/pg` 或 cluster package：

- `dependencies`
- `devDependencies`
- `optionalDependencies`
- `peerDependencies`

PostgreSQL driver、Drizzle schema/tooling 和 cluster-control assembly 只属于 ADR-0038 定义的独立 workspace/package 与 profile-specific 产物。根包的 dynamic import、optional dependency 或 install-time feature detection 均不能替代该边界。

### 5. Edge CI 同时审计 manifest 与代表性导入闭包

CI 必须在 edge Profile 下导入代表性的：

- Profile/resource policy；
- standalone/manual Primary 的轻量 bootstrap；
- headless Worker application runtime。

新增模块闭包不得包含 PostgreSQL migration 实现、`pg`、`pg-native`、Drizzle 或 cluster package。该门禁用于尽早发现静态 value import、barrel re-export 和 bootstrap 回归；它不等同于最终产物证明。独立 importer 落地后，还必须对 edge package tarball/镜像的 lockfile、安装树、SBOM、压缩体积与冷启动 RSS 做闭环审计。

## 当前孵化状态

`next` 已实现默认不可达的 `activateClusterControlRuntime()`：

- 错误 Profile 在 readiness 前拒绝；
- readiness 失败前不会调用业务 factory；
- 成功路径固定 readiness → assembly → recovery → lifecycle → admission；
- unsafe/incomplete recovery 会停止 stack，且不会开放 admission；
- admission-first shutdown 和重复 stop 已有契约测试。

独立 `@qinglong/cluster-control` 的 `bootstrapClusterControlRuntime()` 已把 lazy database、ADR-0039 readiness、ADR-0041 Run Repository 与激活门串联：disabled/错误 Profile 零打开，readiness 通过后才创建真实 `PostgresRunRepository` 和业务 stack，失败自动关闭，正常关闭顺序固定为 admission → stack → Pool。真实 `openDatabase()` 由 `@qinglong/cluster-postgres` 提供，组合根不读取 legacy `back/**`。

同时已加入 `audit:edge-imports:ql3`：

- 检查根 manifest 的四类依赖区段；
- 导入三个代表性 edge/standalone/worker 入口；
- 检查新增 `require.cache` 闭包是否触达 cluster bundle；
- 纳入 Node 20/24、x64/arm64 的 QL3 CI 矩阵。

ADR-0045 已在独立 package 增加有界 HTTP application host、`/livez`、activation-backed `/readyz` 和 fail-closed `/api/v3` admission，并把 disposer 升级为可异步 drain：停止先拒绝新请求、向在途 handler 传播 Abort，真实 handler 未结束时不能继续宣称排空。公开 config 入口先解析 Profile/enable，禁用时不读取 PostgreSQL Secret；application/config 导入闭包不含 migration DDL 或 legacy 根。

当前仍没有认证/Policy-fenced 业务 router、完整 production recovery/lifecycle stack、独立 cluster 镜像/SBOM 或 failover 演练。现有 host 是 executable application boundary，但尚不是完整可部署控制面，不能据此开启匿名或生产 cluster-control API。

## 影响

正面影响：

- schema/role 不兼容时不会提前构造可产生业务副作用的对象；
- startup recovery 与新流量之间存在可测试的硬顺序；
- edge 对 cluster 依赖的隔离从文档约束变为 CI 约束；
- 正常停止、部分启动失败和重复停止具有同一 ownership 语义。

代价与风险：

- 新 lifecycle 必须接入统一 stack，不能自行在模块加载时启动；
- readiness catalog 扫描会增加一次启动成本，需要 timeout、节流与重新证明策略；
- 代表性 CommonJS 导入审计无法发现所有 bundler、ESM tree 或容器打包错误；
- 独立 workspace 落地后，CI 还需同时证明 cluster 产物包含依赖、edge 产物排除依赖。

## 未选择的方案

1. **Repository 创建后再做 readiness**：constructor、pool hook 或 timer 已可能产生副作用，拒绝。
2. **recovery 与 admission 并行启动**：新工作会扩大未收敛状态，拒绝。
3. **readiness 失败后回退 SQLite**：形成双事实源并违反 Profile 边界，拒绝。
4. **只依靠 dynamic import**：不能降低安装体积或供应链暴露，拒绝。
5. **只检查根 package.json**：无法发现 barrel/value import 回归，拒绝。
6. **只检查运行时 require cache**：无法证明未加载包不存在于 edge 产物，拒绝。

## 验证要求

- disabled 路径无数据库、factory、timer 和 admission 行为；
- disabled/错误 Profile 不调用 `openDatabase()`，也不触发 driver dynamic import；
- 非 `cluster-control` Profile 在数据库探测前失败；
- readiness 失败保持原错误，且业务 factory 调用次数为零；
- recovery unsafe、remaining 或 failed 非零时不得启动 lifecycle/admission；
- lifecycle 启动失败或 admission 安装失败会反向清理；
- active stop 先同步切换 not-ready/拒绝新 admission，再异步等待在途 handler 结束，之后才停止 stack；drain timeout 显式失败且重复 stop 幂等；
- readiness/assembly/activation 失败关闭数据库；active stop 在 stack 后关闭 Pool，close 失败不覆盖更早的激活/停止错误；
- edge 根 manifest 出现任一禁止依赖时 CI 失败；
- 代表性导入闭包触达 PostgreSQL/Drizzle/cluster 路径时 CI 失败；
- 独立 package 落地后，edge tarball/镜像的 lockfile、SBOM 和安装树不包含 cluster bundle；
- PostgreSQL 16/18 role integration 通过后，才允许真实 cluster factory 接入激活门。
