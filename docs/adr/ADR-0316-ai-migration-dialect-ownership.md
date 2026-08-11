# ADR-0316：AI Migration 方言归属与包内拆分

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-257
- 关联 ADR：ADR-0037、ADR-0042、ADR-0276、ADR-0295、ADR-0297、ADR-0311、ADR-0312

## 背景

`@qinglong/ai/src/migration/modelInvocationMigration.ts` 达 4,644 行，同时拥有 SQLite/PostgreSQL migration
identity、history store、DDL、checksum、readiness 和执行入口。它不是 workspace package 过多的问题，而是一个
已有 package 内部缺少方言 ownership。继续把它保留为单文件会让 PostgreSQL 变更无意触碰路由器 SQLite 路径；把
两种方言再拆成新 package 则会制造没有独立部署、依赖闭包或生产 consumer 的微包。

GitNexus 编辑前显示 `assertLocalModelInvocationFeatureReady` 与共享 `historyRecord` 为 HIGH，分别影响
6/9 个上游符号并进入一个本机 AI 启动流程；SQLite/PostgreSQL store 为 MEDIUM，各有 10 个直接、20 个累计
上游符号；definition/runner 为 LOW。已在编辑前告警，重构不得改变 SQL、checksum、错误 identity 或公开契约。

## 决策

保留一个 `@qinglong/ai` workspace package 和现有 `./model-invocation-migration` 公共 subpath，将实现改为：

```text
src/migration/
├── modelInvocationMigration.ts       # 3 行兼容 facade
└── model-invocation/
    ├── identities.ts                 # 35 个稳定 migration/schema identity
    ├── shared.ts                     # checksum、definition、history 严格校验
    ├── sqlite.ts                     # SQLite store、DDL、readiness、runner
    └── postgres.ts                   # PostgreSQL store、DDL、runner
```

`identities.ts` 是两种方言共享的不可变名称目录；`shared.ts` 只保留必须一致的 migration step checksum 和严格
history record 验证。方言 store、SQL、definition 与 runner 不再互相导入。旧 facade re-export 保持 package export、
调用方路径、symbol 和 error identity 不变；没有新增公共 subpath。

本次只做结构移动，不重排 migration、不格式化 SQL、不改 migration ID、schema/table 名、checksum 算法、advisory
lock、timeout、transaction、readiness 或 least-privilege grant。SQLite 13 步与 PostgreSQL 17 步的既有顺序保持。

## Package 治理规则

1. workspace package 只对应独立 deployable、authority、重依赖隔离、可替换 adapter 或多个 production consumer。
2. 方言、领域或内部 collaborator 优先在 owning package 下建目录，不因为“一组文件”新增 package。
3. 根 facade 应保持纯 export；大实现按变化原因拆分，不能只为 LOC 制造无语义文件。
4. 单文件 SQL declaration 允许比普通服务大，但跨方言、跨 authority 或运行时与 schema 混合不允许。

拆分后 workspace 仍为 16 个 package，共 794 个 source，只有 25 个位于 `src` 根、769 个位于包内领域目录，
`singleSourcePackages=[]`、`shallowSourcePackages=[]`。`@qinglong/ai` 为 66 source、1 root/65 nested；这证明当前
问题应继续按包内 ownership 治理，而不是增加第 17 个 package。

## 被否决方案

1. **新增 sqlite-ai-migration/postgres-ai-migration package**：没有独立产物或依赖差异，拒绝。
2. **只把原文件移动到新目录并改名**：仍保留跨方言职责耦合，拒绝。
3. **每条 migration 一个文件**：会产生 30 个近似纯 SQL 微文件，导航和顺序审计更差，拒绝。
4. **重写或重新格式化 SQL**：会改变 checksum 和已部署 history，拒绝。
5. **让 SQLite 引入 pg 或反向引入 node:sqlite**：破坏可选依赖和 Edge 边界，拒绝。

## 验收证据

- `@qinglong/ai` 209 pass/3 条件 skip；migration/activation 专项 7/7；完整 16-package clean build/test 退出 0。
- 现有固定 checksum 测试证明 SQLite 13 步、PostgreSQL 17 步 definition、顺序和 SQL 内容不变；公开 facade
  编译和所有内部消费者通过。
- PostgreSQL 18.4 arm64 HA Docker 门 `gates.passed=true`：physical streaming、`remote_apply`、timeline 1→2、
  fence-before-promote、endpoint 切换、旧主 `pg_rewind`/只读 sync rejoin、AI schema 与相关持久事实晋升存活全绿。
- package boundary schema v5 为 16/16、794 source、25 root、769 nested、findings 为空；Edge import、Cluster
  dependency 与 Cluster deployment 全部 compatible；没有新增 dependency 或部署单元。
- 受影响的四档 AI pack/install/import/RSS audit 全部 compatible。拆分的审计成本为每档 +3,643 bytes/+4 files，
  loaded module 不变：Edge/Standalone AI 为 5,014,271/5,014,319 bytes、399 files、50 modules；
  Edge/Standalone Application AI 为 6,111,792/6,111,924 bytes、496 files、109 modules。

## 未完成

`sqlite.ts` 仍为 2,079 行，`postgres.ts` 仍为 2,473 行。下一轮应按共同变化原因把两者内部继续分成有限的
schema group（core invocation、usage/quota/pricing、catalog、Prompt、credential），同时保持一个 dialect definition
拥有最终顺序和 checksum。不得机械变成“一 migration 一文件”，也不得新增 workspace package。

本 ADR 关闭 AI migration 的跨方言单文件耦合，但不宣称 package 内部的全部大文件治理已经完成。
