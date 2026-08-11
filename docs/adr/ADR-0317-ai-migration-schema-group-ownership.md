# ADR-0317：AI Migration Schema Group 归属

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-257
- 关联 ADR：ADR-0267、ADR-0276、ADR-0295、ADR-0297、ADR-0316

## 背景

ADR-0316 已把 4,644 行、跨 SQLite/PostgreSQL 的 migration 实现拆成稳定 facade、共享 identity/history
校验和两个方言 owner，但 `sqlite.ts`/`postgres.ts` 仍分别为 2,079/2,473 行。问题不在 workspace package 数量，
而在同一 package 内把 migration 排序、store、readiness、执行入口和所有 schema DDL 平铺在一个文件中。

编辑前 GitNexus 显示公开 definition/runner 为 LOW、0 个 production process；高风险仍集中在未改算法的
readiness/history 路径。该轮只移动 package-private migration declaration，并用固定 ID/checksum 序列约束顺序，
不得借目录重排改变已部署 history。

## 决策

继续保留一个 `@qinglong/ai` package 和 ADR-0316 的公开 facade，在每个方言 owner 下按共同变化原因建立有限
schema group：

```text
src/migration/model-invocation/
├── sqlite.ts                         # store、最终顺序、readiness、runner
├── sqlite/
│   ├── context.ts                    # SQLite migration context
│   ├── core.ts                       # invocation core
│   ├── usagePricing.ts               # usage、quota、pricing
│   ├── catalog.ts                    # catalog、authorization、activation
│   ├── prompt.ts                     # Prompt admission/output lifecycle
│   └── credential.ts                 # provider credential catalog
├── postgres.ts                       # store、最终顺序、runner
└── postgres/
    ├── core.ts
    ├── usagePricing.ts
    ├── catalog.ts
    ├── prompt.ts
    └── credential.ts
```

方言 owner 是 migration stream 的唯一 composition root。SQLite 顺序固定为 core → usage/pricing → catalog →
Prompt → credential；PostgreSQL 为 core → usage/pricing → catalog → Prompt base → credential → Prompt extension。
Prompt extension 的声明与 Prompt 领域同处一个文件，但通过两个私有数组显式插入原有 17 步序列，避免文件位置
暗中决定数据库历史。

本轮不新增 package、公共 subpath、依赖或部署单元，不修改 SQL 文本、migration ID、checksum、schema/table 名、
transaction、lock、grant、readiness 或 error identity。`sqlite.ts` 降至 321 行，`postgres.ts` 降至 259 行；11 个
新增私有模块为 5–855 行。PostgreSQL Prompt 的 855 行是同一 schema 生命周期的 SQL declaration，不再因 LOC
机械拆散；只有出现第二个变化原因或独立测试/依赖边界时才继续拆分。

## Package 与目录治理规则

1. package 是发布、authority、依赖闭包和生产 consumer 边界，不是目录分类器；不能为消灭小文件继续加 package。
2. `src` 根只允许精确登记的 public export 或 binary entry；实现进入 package 内领域目录。
3. 一个 package 文件少不等于边界错误。若它隔离安全 authority、可选重依赖、独立 deployable 或被多个生产闭包
   消费，可以保持小；否则应并回 owning package。
4. 包内拆分按共同变化原因，不按“一类型一文件”“一 migration 一文件”或固定 LOC 阈值机械切割。
5. migration 的最终顺序必须由一个方言 owner 显式组合；目录枚举、glob 或文件名排序不得成为数据库协议。

拆分后 workspace 仍为 16 个 package、805 个 source；25 个位于 `src` 根，780 个位于领域目录。
`@qinglong/ai` 为 77 source。package boundary ledger 对每个根文件的角色、文件数和行数设置精确 hard cap，
`singleSourcePackages=[]`、`shallowSourcePackages=[]`，因此根平铺回退会直接使审计失败。

## 被否决方案

1. **新增五个 schema-group package**：没有独立发布、依赖闭包或 authority，拒绝。
2. **每条 migration 一个文件**：把 30 个稳定协议步骤变成导航噪声，且顺序更难审计，拒绝。
3. **按固定行数继续切 PostgreSQL Prompt**：没有第二变化原因，只得到任意分片，拒绝。
4. **自动扫描目录生成 migration 顺序**：文件系统顺序不能拥有持久数据库协议，拒绝。
5. **顺便格式化 SQL 或重算 checksum**：会破坏已部署 migration history，拒绝。

## 验收证据

- SQLite 13 步与 PostgreSQL 17 步的 `[migrationId, checksum]` 序列逐项不变；migration/activation 专项 7/7，
  `@qinglong/ai` 209 pass/3 条件 skip，完整 16-package clean build/test 退出 0。
- package boundary schema v5 为 16/16、805 source、25 root、780 nested、findings 为空；Edge import、Cluster
  dependency 与 Cluster deployment 全部 compatible，AI source 审计数为 77。
- 四档 AI pack/install/import/RSS audit 全部 compatible：Edge/Standalone AI 为
  5,018,404/5,018,452 bytes、410 files、50 modules；Edge/Standalone Application AI 为
  6,115,925/6,116,057 bytes、507 files、109 modules。相对 ADR-0316 增加 11 个私有文件，loaded module 不变。
- PostgreSQL HA Docker 门完成且 `gates.passed=true`：physical streaming、`remote_apply`、fence-before-promote、
  endpoint switch、旧主 `pg_rewind`/只读同步 rejoin 与 AI 持久事实晋升存活保持通过；临时容器、卷和网络由
  `finally` 清理。

## 未完成

本 ADR 关闭 AI migration 的方言内平铺问题，不宣称 QingLong 3.0 的所有大文件已经治理完毕。下一轮按 source
规模、GitNexus blast radius、变化频率和职责混合度审计其余 package 内部实现；优先拆真正多职责 owner，不按
package 数量或 LOC 排名机械重构。
