# ADR-0319：Local Publisher Trust Codec 与 Private Filesystem Store

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-257
- 关联 ADR：ADR-0267、ADR-0276、ADR-0295、ADR-0318

## 背景

ADR-0318 已从 2,779 行 Local Publisher Trust 实现中抽出稳定 contract seam，但 facade 仍为 2,673 行，继续
同时拥有 document canonicalization、snapshot/intent/receipt codec、POSIX private filesystem store 和生命周期
coordinator。本轮目标是按变化原因分离前两项，不改变 publish/retire/propose/confirm 的流程算法。

编辑前逐 symbol GitNexus impact 显示：codec 基础 `digest` 为 HIGH（13 direct/20 total/3 processes），
`dataRecord`/`exactKeys` 为 HIGH（13/19/3），公开 document normalizer 为 HIGH（8/11/3）；store 的
`readPrivateJson` 为 HIGH（6/12/3），`loadState` 为 HIGH（6/6/3），directory、fsync、no-replace publish 等也
进入三条安全流程。没有 CRITICAL，已在移动前告警。

## 决策

保持一个 `@qinglong/local-admin` package、原公共 subpath 和原 facade，内部形成：

```text
src/plugin-package/
├── pluginPackagePublisherTrust.ts
│   # 唯一公共 facade；inspection 与 publish/retire/propose/confirm coordinator
└── publisher-trust/
    ├── contracts.ts
    │   # schema identity、公开结构、错误 identity
    ├── codec.ts
    │   # canonical document、digest、snapshot/intent/receipt codec 与纯模型 helper
    └── privateFilesystemStore.ts
        # owner-only path/file 验证、bounded load、atomic/no-replace publish、fsync
```

`codec.ts` 只依赖 contract 与现有 Runtime Core `plugin-package-bundle` 精确 subpath，拥有 canonical key ordering、
strict shape、digest material、active-key/key-map/snapshot equality 等纯模型规则。`privateFilesystemStore.ts` 不拥有
跨 workspace package 依赖，只依赖同目录 contract/codec；它拥有 path normalization、real/effective UID、mode、
symlink/inode/device revalidation、bounded strict UTF-8 read、directory cardinality、temporary file、no-replace rename、
file/directory fsync、state-chain load 与 crash-recovery durable facts。

facade 继续唯一拥有流程顺序、callback barrier、generation fence、dual-control/break-glass authorization 和返回投影。
三个既有公开 codec function 从 facade re-export 同一个函数对象；两个错误 class 仍由 contract 提供同一个 class
对象。没有新增 package export 或可导入的公共 subpath。

本次为逐字机械移动：不修改 JSON shape、key sort、digest material、filename、mode、byte/cardinality bound、
`O_NOFOLLOW`、inode/device fence、no-replace 行为、fsync 顺序、snapshot chain、replay status 或错误 identity。

## Dependency 与 Profile 边界

Cluster dependency allowlist 对 Runtime Core bundle 的许可精确限定为 facade、contract、codec 三个 owning file；
private store 没有该许可，禁止 storage 偷渡领域 dependency。新增两个模块只进入包含 Local Admin 的 Application
制品，不进入最小 Edge/Standalone 基础档，也不新增进程、timer、listener、数据库连接或部署单元。

## 被否决方案

1. **codec/store 新增 workspace package**：没有独立发布或部署闭包，拒绝。
2. **store 反向依赖 facade helper**：形成环依赖并让 persistence 拥有 coordinator，拒绝；纯 helper 归 codec。
3. **只按行数分成 part1/part2**：没有 ownership 语义，拒绝。
4. **顺便重写 async lifecycle**：扩大高风险回归面，拒绝。
5. **把 Runtime Core wildcard 授权整个目录**：扩大 dependency authority，拒绝。

## 验收证据

- facade 2,673→1,112 行；`contracts.ts` 174、`codec.ts` 803、`privateFilesystemStore.ts` 841 行。
- facade 与 contract 的两个 error constructor identity 相同；facade 与 codec 的三个公开 function identity 相同。
- Local Admin build 与 91/91 通过；完整 16-package clean build/test 最终退出 0，Owner CLI 134/134，Application
  40 pass/3 条件 skip。
- package boundary 为 16 package、808 source、25 root、783 nested、findings 为空；Local Admin 为 32 source。
  Edge import、Cluster dependency、Cluster deployment 全部 compatible。
- Edge/Standalone Application 为 4,730,649/4,730,769 bytes、431 files、110 loaded modules；Edge/Standalone
  Application AI 为 6,126,026/6,126,158 bytes、510 files、109 loaded modules。相对 ADR-0318 增加两个物理模块，
  loaded module 数不变，RSS 与 pack 预算保持 compatible。
- 本轮不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不重复 PostgreSQL HA Docker 门。

## 未完成

facade 的 1,112 行现在主要是 inspection、transition/snapshot composition 和四个 lifecycle coordinator。下一轮先
评估这些 coordinator 是否应按 publish/retirement/revocation 聚合成 package-private lifecycle 模块；只有能保持
callback barrier、generation fence 和 durable replay 原子语义时才继续拆，不以降 LOC 为目标。
