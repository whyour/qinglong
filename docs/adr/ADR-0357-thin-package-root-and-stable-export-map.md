# ADR-0357：薄 Package 根目录与稳定 Export Map

- 状态：Accepted
- 日期：2026-08-10
- 关联：QL-RFC-0001 D-269、ADR-0296、ADR-0304

## 上下文

QingLong 3.0 的 17 个 workspace package 已按部署边界与 authority 拆分，但物理目录仍可能退化为另一种“平铺”：多个角色化公开门面堆在 `src/` 根目录。`@qinglong/cluster-postgres` 曾有 10 个根文件，其中 9 个只是为 `/runtime`、`/admin`、`/package-manager` 等公开 subpath 聚合既有领域实现。它们不是新的领域或 authority，却让根目录看起来像实现目录，也提高了继续堆放横切逻辑的概率。

目录整洁不能以破坏调用方契约为代价。外部消费者依赖的是 package export specifier，而不是仓库内的 TypeScript 物理路径；测试和运维脚本若直接引用 `dist` 物理文件，则属于仓库内部耦合，必须随实现布局迁移。

## 决策

1. 有嵌套领域实现的 package，`src/` 根目录只允许受审的主导出入口或二进制入口；普通实现不得回到根目录。
2. `@qinglong/cluster-postgres` 的 9 个角色化门面迁入 `src/entrypoints/`，`src/` 根目录只保留 `index.ts`。
3. 对外的 `@qinglong/cluster-postgres/runtime`、`/admin`、`/package-manager` 等公开 specifier 保持不变；`package.json#exports` 映射到新的 `dist/entrypoints/*` 物理目标。
4. 不保留旧 `dist/runtime.js` 等物理兼容壳。仓库内测试和脚本改用新物理目标或公开 specifier，防止双入口长期漂移。
5. `docs/ql3-package-boundaries.json` 将该 package 的根文件硬上限从 10 收紧为 1、根行数上限收紧为 125；CI 必须验证精确根文件角色、导出目标存在、旧根门面不存在。
6. 本次调整不创建新 workspace package、不改变 authority、不增加运行依赖，也不扩大 Edge/Standalone 闭包。

## 放弃的方案

- 保持 10 个根门面：公开 API 可用，但根目录继续成为无领域归属代码的默认落点。
- 为每个门面创建 package：把目录问题放大成部署与依赖问题，尤其伤害低配设备闭包。
- 保留旧 `dist` 兼容壳：形成两套可加载物理入口，测试可能绕过 export map，长期更难收敛。
- 直接修改公开 subpath：没有产品收益，却给 Cluster Control、Cluster Admin 和外部扩展制造迁移成本。

## 影响

- package 根目录更接近“接口面”，领域目录继续承载实现。
- 公开 import specifier 和类型契约不变；只依赖未承诺物理 `dist` 路径的仓库内部代码需要同步更新。
- package 数仍为 17；994 个源码文件中根文件由 26 降为 17，嵌套文件由 968 增为 977（98.3%）。
- 后续若确需增加根入口，必须先修改边界账本并给出角色与行数证据，不能静默增长。

## 验证

- 17 个 QL3 package 干净顺序构建通过。
- Package boundary audit compatible，8/8 边界回归通过。
- Cluster dependency audit compatible。
- PostgreSQL package：292 pass、1 条件 skip、0 fail。
- Cluster Control：186 pass、2 条件 skip、0 fail。
- Cluster Admin：269 pass、2 条件 skip、0 fail。
- 9 个既有 PostgreSQL 公开 subpath 均通过 Node 加载验证。
