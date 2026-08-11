# ADR-0297：AI 根实现的领域归属与公开 Subpath 稳定性

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-213、D-257、ADR-0040、ADR-0042、ADR-0087、ADR-0276、ADR-0296

## 上下文

ADR-0296 建立根 source 行数棘轮后，`@qinglong/ai` 成为最大根实现债务：4 个根文件共 6,187 个审计行。其中 `index.ts`
只有 16 个审计行并只做公开聚合；`modelInvocationMigration.ts`、`profileComposition.ts` 与
`localModelInvocationFeatureActivation.ts` 分别承载 4,644、872、652 个可见代码行，实际职责已经稳定为 Migration、
Profile Composition 和 Feature Activation。三者继续放在 package root 会把领域实现伪装成入口，也会使 schema v4 的
`rootSourceLineHardCap=6187` 失去治理价值。

这三个领域没有新的部署、权限、依赖或版本生命周期，拆成 workspace package 会扩大路由设备的 importer/SBOM/构建拓扑。
现有公开消费者已经通过 `@qinglong/ai/profile`、`@qinglong/ai/model-invocation-migration` 和
`@qinglong/ai/local-feature-activation` 使用能力，物理输出路径不是公共契约。

强制 GitNexus 在移动前显示：`LocalModelInvocationFeatureActivationRepository` 为 CRITICAL（9 direct/27 total/4
process），`assertLocalModelInvocationFeatureActive` 为 HIGH（6/11/3 process），`assertLocalModelInvocationFeatureReady`
为 HIGH（2/6/1 process）；Migration 文件整体为 MEDIUM（9 direct/19 total/0 process），Profile 文件和两个 bootstrap
入口均为 LOW。高风险来自既有本机 AI admission/completion 与 application bootstrap，不是本批新增流程。

## 决策

1. 将三个根实现原样归入同 package 的 owning domain：
   - `src/migration/modelInvocationMigration.ts`
   - `src/profile/profileComposition.ts`
   - `src/feature-activation/localModelInvocationFeatureActivation.ts`
2. 根目录只保留聚合公开导出的 `index.ts`，不增加兼容 facade 或 wrapper。package ledger 将 AI 的
   `rootSourceFileHardCap` 从 4 降为 1、`rootSourceLineHardCap` 从 6,187 降为 16；两个值以后只能继续下降或经独立 ADR 复审。
3. `package.json#exports` 只更新内部 `dist` target，三个公开 package subpath、根 export symbol、错误 class identity、
   migration ID/checksum/顺序与运行行为保持不变。
4. AI package tests 和 fixtures 改为通过 package self-reference 的公开 subpath 加载，禁止继续依赖旧的根 `dist/*.js` 私有路径。
   仓库根 live-contract/benchmark 脚本不是 workspace importer，继续显式加载受审嵌套 `dist` 路径，避免虚构 root dependency。
5. 不新增 package、生产依赖、migration、数据库对象、connection、timer、watcher、listener、进程或部署单元。

## 被拒绝的方案

- **保留三个根 facade**：根文件数和行数看似下降，但会制造无独立语义的 wrapper，继续让内部代码依赖虚假入口。
- **拆成三个 workspace package**：没有独立制品或权限边界，只会增加低配设备安装、lock importer、SBOM 和发布成本。
- **同时拆分 4,644 行 Migration 语义**：目录归位可以证明零行为变化；在同批重排 SQL step 会扩大 HIGH/CRITICAL 风险面。
- **继续让测试 require 私有 dist 路径**：会把旧编译布局误当公共 API，使后续内部重构不可验证。
- **只提高 6,187 行 hard cap**：冻结坏结构不等于治理；已有稳定领域边界时应降低棘轮。

## 接受条件

1. AI 保持 62 个 source，root 只有 1 个 `index.ts`/16 审计行，nested 58→61；workspace package/source 总数不变。
2. 三个公开 subpath 与根导出保持，AI package 及全部生产 consumer 通过 clean build/test。
3. migration 定义、Feature Activation repository、Profile disabled/active/drain 行为均由原测试覆盖；旧私有根 dist 引用清零。
4. 完整 packages/backend、四项架构审计和十档 artifact/RSS compatible；基础 Edge 不安装 AI。
5. GitNexus 保持既有 269 条流程，detect_changes 不出现新增受影响产品流程。

## 接受证据

- package boundary schema v4 报告 AI 为 62 source、1 root/16 root lines/61 nested，workspace 仍为 19 package、768 source、
  45 root、723 nested，`singleSourcePackages=[]`；7 项 boundary fixture 全部通过。
- AI 212 项为 209 pass/3 条 PostgreSQL 条件 skip；完整 19-package clean build/test 通过；backend 1,112 项为
  1,110 pass/2 skip/0 fail。cluster dependency、package boundary、Edge import、local image 四项审计均 compatible。
- 十档 artifact/RSS 全部 compatible。基础 Edge 保持 3,635,004 bytes/332 files/48 loaded modules；AI-only Edge 为
  5,022,545/396/49；最大 Standalone Application AI 为 6,123,597/491/104，低于 6 MiB/768 files 门。
- 强制 GitNexus 为 43,284 nodes/98,496 edges/1,695 clusters/269 flows。移动后 CRITICAL/HIGH 符号的 direct/total/process
  计数与移动前一致；`bootstrapModelGatewayProfile` 仍为 LOW（1 direct/1 total/0 process）。`detect_changes` all/compare
  `develop` 仍为 12 files/31 symbols 与 14/34，均 low/0 affected process。
- 本批没有修改 SQL、migration checksum、生产 dependency 或 Cluster 状态，不重复制造无关 PostgreSQL HA 物理证据；
  相关根 live-contract 路径契约 8/8 通过。
