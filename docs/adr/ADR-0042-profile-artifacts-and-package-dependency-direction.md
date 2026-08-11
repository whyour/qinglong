# ADR-0042：Profile 专属产物与 Package 依赖方向

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001 D-35/D-37/D-40、ADR-0038、ADR-0040、ADR-0041

## 上下文

引入 pnpm workspace 解决的是仓库内开发与 lockfile importer 管理，不自动解决用户部署。开发者在仓库根运行 `pnpm install` 时可以安装全部 workspace package；若把这个行为直接当作镜像交付，edge 用户仍会下载 cluster driver。反过来，仅依赖 dynamic import 或检查根 `package.json`，也无法证明最终 `node_modules`、SBOM 和启动 import graph 没有 PostgreSQL 依赖。

另一个结构风险是让新的 `@qinglong/cluster-control` 反向依赖 `@whyour/qinglong` legacy 根应用，再通过 `../../back/**` 深层路径取得 Runtime。这样会把 2.x Controller、UI、Sequelize 和本地文件约定重新拖入 cluster assembly，workspace 只是把旧耦合换了目录，没有形成 3.0 边界。

当前 legacy Docker builder 只复制根 `package.json`、`.npmrc` 和 `pnpm-lock.yaml`，未复制 workspace 定义与 cluster manifests。一次性 production install 已验证 pnpm 只解析 `.` importer，安装 413 个现有生产 package，未出现 `pg`、Drizzle、`pg-native` 或 cluster package。这是当前兼容事实，但不是 3.0 最终镜像设计。

## 决策

### 1. Workspace 不是发布物

仓库根 install 只用于开发/CI。正式发布必须选择一个 Profile assembly/importer：

```text
edge / standalone artifact
  -> @whyour/qinglong compatibility importer
  -> local runtime assembly
  -> SQLite/local adapters only

cluster-control artifact
  -> @qinglong/cluster-control importer
  -> @qinglong/runtime-core + @qinglong/cluster-postgres
  -> PostgreSQL/control-plane adapters only
```

镜像、压缩包和 SBOM 均从选中的 importer 生成，不复制仓库根的完整 workspace `node_modules`。开发环境安装了 cluster dependency 不能作为 edge 污染证据；必须审计实际 Profile 产物。

### 2. 固定单向依赖图

3.0 目标依赖方向为：

```text
domain/runtime-core <- ports <- adapters <- profile assembly
```

- domain/runtime-core 不依赖数据库 driver、Web framework、legacy Controller 或具体 Profile；
- adapter 只实现 port，不调用 assembly；
- assembly 选择 Profile、配置、Secret source、adapter 和 lifecycle；
- legacy compatibility app 可以依赖 runtime-core，但 runtime-core 和 cluster package 不得反向依赖 legacy app；
- `@qinglong/cluster-control` 不得通过深层相对路径或未声明 export 读取根 `back/**`。

`@qinglong/runtime-core` 已成为公开孵化边界；新增 cluster adapter 和 assembly 必须只消费其 package export。legacy 根中暂留的 migration/Repository/activation 副本只服务 2.x 兼容与迁移回归，不能再作为 cluster assembly 的实现来源。副本退出条件由 ADR-0044 固定。

### 3. Root package 是兼容壳，不是永久 Core

`@whyour/qinglong` 在孵化期同时承载 legacy app 和尚未提取的 3.0 模块，只是迁移状态。后续按以下顺序提取：

1. 纯 domain、port、migration stream contract；
2. runtime application service 与 Profile-neutral lifecycle；
3. SQLite/local adapter package；
4. edge/standalone 与 cluster-control assembly；
5. legacy Controller/Shell 只通过兼容 adapter 调用公开端口。

提取按 vertical slice 进行，不进行一次性目录大搬迁。每次提取必须先做影响分析、双方 importer 构建、contract suite 和产物资源对比。

### 4. 发布门禁

edge/standalone 必须验证：

- 根 manifest 与 lock importer 无 cluster dependency；
- production-only 安装目录无 `pg`、Drizzle、cluster package；
- representative startup import closure 无 cluster module；
- 禁用 cluster 时无 DNS/socket/Pool/Secret read/timer；
- 产物体积、冷启动、RSS 和后台写入不超预算。

cluster-control 必须验证：

- 只从 cluster-control importer 组装；
- exact Node/pg/Drizzle 版本和 SBOM 可复现；
- 无 `pg-native`、SQLite runtime adapter、legacy local executor 或 UI bundle；
- PostgreSQL 16/18 migration、Repository、readiness、最小权限和多副本竞争通过；
- migration 与 runtime 使用独立 entrypoint、Secret 和 role。

### 5. 当前 Dockerfile 的处理

2.x Dockerfile 继续作为兼容产物，不在本 ADR 中直接改成 cluster-aware workspace build。3.0 新增独立 Profile Dockerfile/stage；在新产物通过多架构、升级、体积和资源门禁前，不替换稳定镜像入口。

## 影响

正面影响：

- 小设备只支付本地能力成本，cluster 依赖不会因 monorepo 自动进入镜像；
- cluster-control 不继承 legacy UI/Controller/Sequelize 耦合；
- package 边界、镜像边界和运行时 Profile 边界一致；
- 可按 vertical slice 淘汰不合理架构，而不是把 2.x 根包永久包装成 core。

代价：

- 需要独立 runtime-core/local-adapter/assembly package 与 Profile build pipeline；
- 开发 install、测试 install 和发布 install 不再是同一个命令；
- 过渡期存在根源码与待提取 core 的双重目录认知成本。

## 未选择的方案

1. **仓库根 production install 后删除 pg/Drizzle**：不可审计且容易留下传递依赖，拒绝。
2. **cluster-control 依赖根 app 并 deep import**：反转依赖方向并固化 legacy 耦合，拒绝。
3. **把所有 adapter 放进 runtime-core 再依赖注入**：安装与供应链成本已经发生，拒绝。
4. **立即重排整个仓库**：回归面过大，无法保持 `next` 小步可构建，拒绝。
5. **继续共用一个万能镜像**：无法同时优化 256 MiB edge 与多副本 cluster，拒绝。

## 验证

- lock importer 与 manifest exact audit 通过；
- 一次性 root production install 不含 cluster dependency；
- edge import audit 通过；
- cluster package 严格类型构建与真实 pg contract 通过；
- 后续每个 Profile 镜像生成独立 SBOM、压缩/解压体积、RSS 与启动报告；
- GitNexus compare 只出现预期 package/assembly 方向，禁止新增 cluster→legacy 深层依赖。

## 当前孵化状态

`next` 已抽取 `@qinglong/runtime-core` 的 driver-neutral PostgreSQL resource contract、migration stream、cluster activation、Run/RetryPolicy domain、Repository port 与稳定错误。`@qinglong/cluster-postgres` 单向依赖 runtime-core并独立拥有 Pool、migration、readiness、typed schema 与 RunRepository；`@qinglong/cluster-control` 单向依赖两者并已形成可构建的 readiness-first composition root。三个 manifest 与 lock importer 的全部 dependency section 由 CI 做精确集合和 workspace-link 审计。审计还扫描各 package 的 `src/**/*.ts`：禁止相对 import 逃出 package，runtime-core 禁止 driver/adapter，cluster package 禁止 legacy 根、SQLite、Sequelize 和反向 assembly import；正反例 contract test 固化该规则。

`@qinglong/cluster-control` 已声明 `main`、`types` 和 package export，并通过契约测试证明 disabled/错误 Profile 零连接、readiness 前零 Repository、失败反向清理和 stop 幂等。它仍缺少实际 control-plane application stack、网络入口与独立发布产物，所以“可执行组合根”不等于“完整可部署 QingLong”。

ADR-0063 已补上独立 `@qinglong/edge`、`@qinglong/standalone` importer，以及 `runtime-core ← local-sqlite ← local-profile ← Profile importer` 的单向依赖。实际逐包 tarball production install 只有四个预期 package，未安装 PostgreSQL、Drizzle、Sequelize 或 sqlite3，并具备体积/文件数/导入 RSS 门禁。当前 pnpm 8 `deploy` 实测会错误复制 legacy 根生产树，因此明确禁止作为发布链；本机 importer 目前只组合 storage-ready RunRepository，完整 application stack、镜像/SBOM/签名和 2.x 数据 adoption 仍未完成。
