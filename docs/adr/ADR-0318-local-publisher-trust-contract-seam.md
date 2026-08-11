# ADR-0318：Local Publisher Trust Contract Seam

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-257
- 关联 ADR：ADR-0267、ADR-0276、ADR-0295、ADR-0317

## 背景

完成 AI migration 的包内 ownership 后，剩余大文件审计发现
`@qinglong/local-admin/src/plugin-package/pluginPackagePublisherTrust.ts` 为 2,779 行。它不同于纯 schema
declaration：同一文件同时声明公开 contract/error identity、私有文件协议、POSIX 防替换存储和 publish/retire/
revoke 生命周期。直接一次拆完会同时触碰高风险错误 identity、原子发布和三条安全流程，不适合作为首步。

GitNexus 编辑前显示 `LocalPluginPackagePublisherTrustConfigurationError` 为 HIGH，27 个直接/35 个累计上游，
`LocalPluginPackagePublisherTrustConflictError` 为 HIGH，10 个直接/10 个累计上游；两者都进入 retire、propose、
confirm 三条流程。已在编辑前告警。

## 决策

先在原 package 内建立 `plugin-package/publisher-trust/contracts.ts`，只拥有：

- 六个稳定 schema identity 与三项有界数量上限；
- publish、retire、revocation、inspection 的公开结构 contract；
- 两个稳定错误 class、`code`、message prefix 与 constructor 行为。

原 `pluginPackagePublisherTrust.ts` 继续是唯一公共 facade，并 re-export contract 中的同一个 runtime class 对象；
所有现有 package export、调用路径、`instanceof`、error code 和类型名保持。原子文件发布、UID/mode/symlink/inode
校验、snapshot/intent/receipt 解析、状态加载以及 publish/retire/propose/confirm 算法本轮全部保持原位。

新的 contract 只通过既有 `@qinglong/runtime-core/plugin-package-bundle` 精确 subpath 引用 publisher key type。
Cluster dependency allowlist 从“只有旧 facade”扩展为“旧 facade + 新 contract”两个精确 owning file；没有开放目录
通配符，也没有新增 dependency。

本轮后的结构是：

```text
src/plugin-package/
├── pluginPackagePublisherTrust.ts       # 公共 facade、codec、storage、lifecycle（仍待拆）
└── publisher-trust/
    └── contracts.ts                     # 稳定 contract 与错误 identity
```

该 seam 是后续分离 document codec、private filesystem store 与 lifecycle coordinator 的前置边界，不把 2,673 行
facade 冒充为已经完成治理。

## 路由器与集群影响

contract 仅进入包含 `@qinglong/local-admin` 的 Application 制品，不进入最小 Edge/Standalone 基础 Profile，
不新增进程、listener、timer、数据库连接或 Cluster 部署单元。四档 Application 制品增加约 4.5 KiB/1 file，均在
现有 pack/install/import/RSS 预算内。

## 被否决方案

1. **一次拆完 codec/store/lifecycle**：同时触碰原子持久化与三条高风险安全流程，回归定位面过大，拒绝。
2. **新增 publisher-trust package**：没有独立部署、依赖闭包或多个外部生产 consumer，拒绝。
3. **复制错误 class 到新模块**：会产生两个 constructor identity 并破坏 `instanceof`，拒绝。
4. **为新目录开放 Runtime Core wildcard**：扩大 authority import 面，拒绝。
5. **优先拆 5,715 行 schema declaration**：行数大但职责单一，不如当前多职责文件优先，拒绝。

## 验收证据

- `@qinglong/local-admin` build 通过，91/91；完整 16-package clean build/test 退出 0。
- package boundary 为 16 package、806 source、25 root、781 nested、findings 为空；Local Admin 为 30 source。
- Edge import、Cluster dependency、Cluster deployment 全部 compatible；dependency audit 对新 contract 使用精确
  file/subpath allowlist。
- Edge/Standalone Application 为 4,725,012/4,725,132 bytes、429 files、110 loaded modules；Edge/Standalone
  Application AI 为 6,120,389/6,120,521 bytes、508 files、109 loaded modules，RSS 均在既有预算内。
- 本轮不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不重复 PostgreSQL HA Docker 门；
  ADR-0317 的最近一次 `gates.passed=true` 保持数据库基线证据。

## 未完成

下一轮在逐 symbol impact 分析后，把 document normalization/codec 与 private filesystem store 从 facade 分离，
最后才评估生命周期 coordinator。任何一步都必须保持 no-follow、owner-only mode、directory identity revalidation、
no-replace publication、fsync 和 crash replay 语义，并用现有 Publisher Trust 安全测试覆盖。
