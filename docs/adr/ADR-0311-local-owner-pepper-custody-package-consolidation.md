# ADR-0311：Local Owner Pepper Custody 的 Package 收敛

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-87、D-175、D-257
- 关联 ADR：ADR-0083、ADR-0185、ADR-0267、ADR-0276、ADR-0302、ADR-0304

## 背景

`@qinglong/local-owner-keyring` 只有一个公开入口和三个实现文件，没有独立 binary、部署制品、第三方依赖、
版本生命周期或独立 production consumer closure。它的所有生产消费者已经依赖
`@qinglong/local-owner-console`，因此这个 package 只表达源码分组，却增加 workspace importer、lockfile、
SBOM、拓扑构建和低配设备安装元数据。

迁移前 GitNexus 将 file provider 判为 CRITICAL（7 个直接调用、2 条执行流程），两个配置/不可用错误类判为
HIGH；其余节点为 LOW。该风险来自 Pepper provision、credential recovery 和 GC 的真实调用链，不能通过
删除校验或扩大导出来降低。

## 决策

1. 删除 `@qinglong/local-owner-keyring` workspace package；实现原样进入
   `@qinglong/local-owner-console` 的 `src/pepper-custody/` owning domain。
2. 普通 custody 只通过 `@qinglong/local-owner-console/pepper-custody` 暴露；销毁能力只通过
   `@qinglong/local-owner-console/pepper-custody/destructive` 暴露，并继续只允许 Maintenance 的精确 GC
   consumer 导入。
3. 旧 package 名成为全局 dependency/import tombstone，不能作为兼容 facade 回流。
4. 合并不得改变 POSIX no-follow、UID/mode/inode 复核、key generation、备份绑定、错误 identity、GC retention
   或失败关闭语义。

## 结果与证据

- workspace package 19→18；源码总数保持 781，根源码 32→31、nested 749→750；Owner Console 为
  11 source/0 root/11 nested。
- Owner Console 55/55、Owner CLI 116/116、Maintenance 13/13，完整 18-package clean build/test 通过；
  package boundary、dependency 与 Profile vulnerability 审计均无 finding。
- 十档制品全部 compatible；合并前后的生产代码闭包不扩大，Owner destructive authority 仍未进入常驻
  Application、Cluster 或 Worker。
- 本批不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不重复运行 PostgreSQL HA 门。

## 被否决方案

1. 保留空 facade package：继续支付 importer/SBOM 成本，也允许旧边界永久回流。
2. 把 destructive export 合入普通 custody root：扩大误导入面，破坏最小 authority。
3. 把 Pepper 实现移入 SQLite：文件 custody 是 POSIX authority，不是数据库 adapter ownership。
