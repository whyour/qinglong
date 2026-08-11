# ADR-0269：Profile-aware Local SQLite Readiness 诊断边界

- 状态：Accepted
- 日期：2026-08-04
- 关联 RFC：QL-RFC-0001 D-06、D-17、D-20、D-40、D-250
- 关联 ADR：ADR-0004、ADR-0063、ADR-0064、ADR-0086、ADR-0257

## 背景

仓库根命令 `audit:schema:ql3` 原先默认打开 `data/db/database.sqlite`，并用
`back/migrations` 的 legacy/Shadow ownership manifest 审计。该路径通常是用户的 2.x 数据库，
而 fresh/adopted QingLong 3.0 的正式 SQLite authority 已经迁移到
`@qinglong/local-sqlite` 的独立 84 条 migration stream 与 capability v42。

旧命令虽然只读，但默认选择现网路径会产生三个问题：

- 把 2.x 数据库误称为 3.0 fresh schema，并稳定输出缺失表误报；
- 无法验证 edge `DELETE` 与 standalone `WAL` 的 Profile 差异；
- 让诊断结果与 application、Compose preflight 使用的 readiness authority 分叉。

## 决策

### 1. `audit:schema:ql3` 只表示正式 Local 3.0 readiness

根命令现在调用既有 `@qinglong/local-owner-cli` 中的 `ql3-local-readiness`。调用者必须显式
提供 `--database` 与 `--profile=edge|standalone`；不存在默认数据库，也不从 cwd、环境变量或
2.x 配置猜测 authority。

诊断复用 `@qinglong/local-sqlite/readiness-inspection`，因此与启动/Compose preflight 共用同一
migration checksum、capability、required schema、foreign-key、quick-check 和 repository
integrity 权威。edge 必须是 `DELETE` journal，standalone 必须是 `WAL`；不能用一个 Profile 的
成功结果替另一个 Profile 背书。

### 2. 诊断入口保持短生命周期、只读和低敏

数据库必须是 canonical absolute path、当前 UID 所有、精确 `0600`、非 symlink regular file。
诊断使用 Node 24 defensive/query-only SQLite，不执行 migration、repair、journal 切换或任何业务
查询。成功只输出 contract name/version、migration/table 数、SQLite version 与 journal mode，
不输出数据库路径、row、credential、digest 或 Secret。

失败输出只有稳定 code/name；底层可能包含路径的异常不能进入 stdout/stderr 产品结果。

### 3. legacy/Shadow 审计显式隔离

旧 ownership drift 工具保留为 `audit:legacy-schema:ql3`，供 2.x Shadow migration 兼容诊断使用。
它必须显式传 `--database`；已删除隐式 `data/db/database.sqlite` 默认值，JSON 报告标记
`mode=legacy-shadow`。它不能作为 fresh/adopted 3.0 readiness 证据。

### 4. 不增加包或常驻成本

实现只在既有 `@qinglong/local-owner-cli` 增加一个 subpath/bin，复用已存在的
`@qinglong/local-sqlite` dependency。workspace 保持 19，不增加 dependency、migration、daemon、
listener、timer、watcher 或数据库连接池。诊断只在 operator 显式调用时加载。

## 替代方案

- **继续默认审计 `data/db/database.sqlite`**：拒绝。会把 2.x 路径冒充 3.0 authority。
- **复制一份 schema manifest 到根脚本**：拒绝。会与 application readiness 再次漂移。
- **诊断时自动 migration/切换 journal**：拒绝。readiness 不能同时是隐式修复 authority。
- **为诊断新建 workspace package**：拒绝。没有独立交付或 authority 价值，会突破包粒度约束。
- **从文件内容自动推断 Profile**：拒绝。部署 Profile 是 operator intent，不应由当前 journal
  状态反向猜测。

## 验证

- `pnpm --filter @qinglong/local-owner-cli test`
- `node --test test/back/ql3ClusterDependencyAudit.test.cjs test/back/nodeSqliteSchemaCompatibility.test.cjs`
- `pnpm audit:cluster-dependencies:ql3`
- `pnpm audit:package-boundaries:ql3`
- edge/standalone fresh database 的 `audit:schema:ql3` 正向门；跨 Profile、重复参数、隐式路径和
  `0644` database 负向门。

当前证据为 Owner CLI 91/91、dependency/legacy 定向门 46/46、Worker Runtime 132/132、
后端 1093 pass/2 条件 skip/0 fail；完整 package 门退出 0，workspace 仍为 19/19。正式 edge
实测输出为 capability v42、84 条 migration、76 张表和 `DELETE` journal，且不包含数据库路径。

## 影响

调用旧根命令但未传参数的开发脚本会失败关闭，需要明确选择 Local 3.0 或 legacy/Shadow 模式。
这是一项有意的诊断兼容性收紧，不影响应用启动、migration 或用户数据。
