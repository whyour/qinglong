# ADR-0267：机器可验证的 Workspace Package 边界账本

- 状态：Accepted
- 日期：2026-08-03
- 关联：RFC D-02、D-06、D-85、D-207、D-240、D-248；ADR-0087、ADR-0185、ADR-0217、ADR-0243

## 背景

QingLong 3.0 已从 32 个 workspace package 逐步收敛为 19 个。当前仍有一个只有单个
TypeScript 源文件的 `local-command-file`，以及三个文件的 `local-profile` 和
`local-adopted-profile`。文件数只能触发评审，不能回答 package 是否合理：机械合并
adopted profile 会让基础 Edge 路由器安装 `local-admin` 接管写栅栏；机械保留所有概念包
又会继续扩大 lockfile、构建、SBOM 和维护面。

此前保留理由主要散落在多份 ADR 和审计脚本的 hard-coded allowlist 中。它们可以发现
依赖变化，却不能直接回答“新增或保留这个 package 的独立价值是什么”，也不能阻止新增
一个没有部署、权限、依赖隔离、适配器或共享价值的薄包。

## 决策

1. `docs/ql3-package-boundaries.json` 是 QL3 workspace package 边界的唯一机器可读决策账本。
   它精确登记当前 19 个 package 的路径、名称、生产消费者、Profile、保留条件与理由。
2. 每个 package 至少证明以下一项：独立 deployable/binary/artifact、独立 authority、
   外部生产依赖隔离、可替换 adapter，或至少两个 production consumer 复用的 shared leaf。
3. 一文件 package 必须额外证明 deployable、authority 或 shared leaf；“代码以后可能增加”
   和“概念名称不同”都不构成理由。
4. 账本 schema v2 必须精确登记每个 `src/` 根文件及其职责，且只允许
   `public_export`、`binary_entry`、`shared_infrastructure`。前两类必须由 manifest 的
   `exports`/`main`/`bin` 直接证明；共享基础设施不得冒充公开入口，并且只允许存在于已经按领域
   下沉、有具体保留理由的 package。
5. 全部源码仍位于 `src/` 根层的 package 必须声明 `shallowSourceLayout`。`public_entrypoints`
   只适用于独立 deployable/artifact 的公开产品入口；`shared_protocol` 必须同时证明 shared leaf、
   至少两个 production consumer、零生产依赖。package 一旦出现嵌套实现，旧浅层例外立即视为 stale。
6. `scripts/ql3-package-boundary-audit.cjs` 从实际 manifest 反向计算生产消费者、源码体量、根文件集合
   和 manifest target，拒绝未登记或已消失的 package、消费者/根职责漂移、伪造入口、缺失或过期
   浅层证据、未知 workspace dependency、以及超过 19 的 hard cap。
7. 账本不替代 dependency/source/artifact/RSS 审计。package 数不是运行性能指标；低配设备
   仍以最终 artifact closure、loaded modules、RSS、I/O 和常驻资源为准。

## 当前裁决

- `local-command-file` 继续保留：它零生产依赖，被 application、Owner CLI 和 maintenance
  三个不同生命周期闭包直接复用；合入任一 owner 都会迫使其他消费者携带更大的闭包。
- `local-profile` 与 `local-adopted-profile` 继续分包：后者独占 legacy source write fence
  和 `local-admin` 依赖，并形成独立 adopted artifact；合并会扩大 storage-only 路由器制品。
- `runtime-core`、`local-sqlite`、`cluster-postgres` 等大包不因 LOC 再拆 workspace package；
  领域内聚继续使用目录和显式 subpath，避免重现“一概念一 package”。

## 后续实施计划：包内源码拓扑收敛

该工作排在 CloudNativePG/Barman continuous WAL、latest restore、PITR 与 cert-manager 证书
轮换实证之后，避免大规模文件移动干扰当前生产灾备 Gate。它只整理 package 内部物理布局，
不改变本 ADR 接受的 workspace 边界。

- 首批评审 `runtime-core`、`cluster-admin`、`ai`、`cluster-control`、`local-sqlite`、
  `cluster-postgres` 和 `worker-runtime`；小型且单一职责的 package 保持平铺。
- 以稳定业务能力建立目录，不以 class/interface/单文件建立目录，也不因目录形成新的
  workspace package。
- 外部 `package.json#exports` subpath、消费者 import、依赖树、部署 Profile、数据库 role、
  migration 顺序和最终 artifact closure 必须保持兼容。
- SQLite/PostgreSQL adapter 的领域目录尽量与 `runtime-core` port 对齐；管理包内部将同一能力的
  CLI、HTTP、transport、client、process 和 Kubernetes adapter 放在同一能力目录。
- 每次只处理一个 package，并先使用 GitNexus 评估 upstream blast radius；移动后必须通过该包
  contract、dependency/source boundary、packlist/artifact、Edge import/RSS 与全量回归。
- 若整理需要改变公共 API、authority、依赖、schema、运行资源或第 20 个 workspace package，
  必须停止并另立 ADR，不能伪装成目录重构。

## 验证

- 当前 workspace 精确 19 个 package，账本与实际目录一一对应；
- 实际 manifest 反向计算的所有 production consumer 与账本一致；
- 唯一一文件 package 是 `@qinglong/local-command-file`，并满足三个 production consumer
  的 shared-leaf 证明；
- 仅 `local-command-file`、`local-profile`、`local-adopted-profile` 是显式浅层源码例外；前者为
  `shared_protocol`，后两者为 `public_entrypoints`；
- 测试覆盖未登记 package、stale decision、consumer drift、根文件增长/角色漂移、伪造 binary、
  缺失/过期/证据不足的浅层例外和无理由薄包的失败关闭；
- 该变更不新增 workspace package、生产依赖、运行进程、listener、timer、数据库连接或
  任何 Edge/Standalone/Cluster/Worker 制品内容。

## 不采用方案

### 合并 `local-profile` 与 `local-adopted-profile`

拒绝。npm production dependency 是 package 级，不是 subpath 级；基础 storage-only Profile
会因此安装接管管理 authority，与低配设备最小闭包目标相反。

### 按 LOC 或文件数自动合并

拒绝。文件数看不到 deployment、credential、database role、destructive authority 或
第三方依赖边界。

### 只保留文档约定

拒绝。没有与实际 manifest/consumer graph 对账的 prose 会在后续依赖变更时静默失真。
