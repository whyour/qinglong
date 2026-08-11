# ADR-0366：薄 Package 边界 Ratchet

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-175、D-207、D-257、D-269、D-276、D-278，ADR-0364

## 背景

Package 边界和 package 内目录边界不能混为一谈。把多个领域实现平铺在 `src/` 根层会模糊 ownership；反过来，仅因文件少或目录整齐就建立 workspace package，也会增加 importer、manifest、lockfile、SBOM、构建和低配设备制品成本。

当前 17 个 QL3 package 共 1,006 个 TypeScript source，其中 989 个位于 capability/domain 子目录，`src/` 根层 17 个文件全部是 manifest 证明的 public export 或 binary entry。唯一只有两个 source 的 package 是 `@qinglong/local-command-file`：一个 8 行公开入口和一个 161 行私有 command-file 安全协议实现。

## 决策

1. `src/` 根层继续只允许受审 public export 或 binary entry；实现按 capability/domain 下沉，不以 workspace package 代替目录。
2. 薄 package 的自动复审范围从恰好 1 个 source 收紧为 1–2 个 source。它必须至少证明以下一项真实边界：
   - 独立部署制品；
   - 独立 authority；
   - 被多个生产生命周期复用的稳定共享叶子。
3. `dependency_isolation` 或 `replaceable_adapter` 本身不足以证明 1–2 文件 package；没有独立制品、authority 或共享消费者时，优先并入 owner package 并使用显式 subpath。
4. 文件数只触发复审，不自动决定合并。达到 3 个 source 也不能规避 package 的既有 deployment/authority/dependency/consumer 账本。
5. 保留 `@qinglong/local-command-file`。它被 Local Application、Local MCP、Local Owner CLI 和 Local Maintenance 四个不同生命周期制品使用，且集中维护 `lstat → O_NOFOLLOW open → fstat`、UID/mode/size/inode 复验和输入清零。合入任一 consumer 会复制安全协议，或迫使其他低权限/短生命周期制品依赖更高权限产品包。
6. 未来本机 HTTP、AI adapter、projection、codec 或单一命令不得仅因“看起来独立”新增 package；只有独立 listener/deployment、authority、重依赖隔离或稳定多消费者 contract 能通过同一账本评审。

## 机器门禁

`scripts/ql3-package-boundary-audit.cjs` 对 1–2 source package 执行相同的 thin-package criteria 校验。反向 fixture 使用两文件、仅声明 replaceable adapter 的 package，必须返回 `PACKAGE_BOUNDARY_THIN_PACKAGE_UNJUSTIFIED`；当前 workspace 仍为 17/17、`findings=[]`。

该门只在开发、CI 和发布检查运行，不进入 Edge、Standalone、Worker 或 Cluster 制品，不增加运行时依赖、进程、listener、timer、内存或闪存写入。

## 后果

- `src` 平铺通过领域目录治理，workspace 碎片通过薄包证据治理，两套规则互不替代。
- 小而安全、确有多消费者的叶子可以保留；单消费者 helper、adapter、projection 默认回到 owner package。
- 新增 Local HTTP 产品面时，必须先证明真实部署与 authority 边界，不能把路由文件直接升级成第 18 个 package。
