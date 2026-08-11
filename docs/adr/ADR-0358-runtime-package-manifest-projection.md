# ADR-0358：最终运行制品的 Package Manifest 投影

- 状态：Accepted
- 日期：2026-08-10
- 关联：QL-RFC-0001 D-270、ADR-0257、ADR-0346
- Supersedes：ADR-0346 中“最终 Local Runtime Artifact 不删除任何 manifest 字段”的限制；不改变源码/发布 package manifest、外部 npm package 或 Cluster/Worker 镜像策略

## 上下文

Cluster Approval 切片完成后，最紧的 Standalone Application AI 制品达到 6,284,121/6,291,456 bytes，只剩 7,335 bytes。预算没有安全增长空间，而 workspace package 数、authority 和 public export 又都有明确理由，不能靠合包、删功能或提高 6 MiB 上限解决。

既有裁剪器已经删除内部 package 的 `.d.ts`/`.map`、失效 sourcemap 指令并压缩 JSON，但最终运行制品的 `package.json` 仍保留指向已删除声明文件的 `types`、`typesVersions` 与 export `types` condition，以及只服务开发/发布阶段的 `files`、`scripts`、`devDependencies`。Node 运行时不消费这些字段；继续保留会让低配设备为已被移除的开发资产支付闪存字节。

按当前 Application AI 的 9 个内部 package 估算，这部分为 25,328 bytes。生产依赖、peer/optional 依赖、license、版本、engine、runtime export、main 和 binary 信息不在该范围内。

## 决策

1. 源码和 `pnpm pack` 产物继续保留完整开发 manifest；类型消费者和发布流程不受影响。
2. 本机 Profile 完成精确离线安装并核对 package closure 后，只对 `node_modules/@qinglong/*/package.json` 生成运行时投影。
3. 投影只删除根字段 `types`、`typesVersions`、`files`、`scripts`、`devDependencies`，以及 `exports` 条件树中的精确 `types` key。
4. 必须保留所有其他字段，包括 name/version/license/engines、main、bin、runtime `require/default/import` 条件、dependencies、optionalDependencies、peerDependencies 和 peerDependenciesMeta；不得改写版本或依赖。
5. 裁剪器继续先完整 inventory、拒绝 symlink/特殊文件并解析验证所有直接 manifest，再执行任何删除或原子替换；外部 npm package 不做投影。
6. 报告分别暴露 JSON compaction 与 runtime projection 的文件数/字节数；总回收量仍包含声明、map、指令、compaction 和 projection。
7. Local Application Dockerfile 继续复用同一裁剪器；不新增 workspace package、生产依赖、runtime module、listener、Pool、timer 或 authority。

## 放弃的方案

- 提高 Application AI 到 7 MiB：掩盖默认闭包增长，且没有设备证据支持。
- 从源码 package 删除类型和开发字段：破坏 SDK、编辑器和发布使用。
- 删除 license、版本或生产依赖：损害 SBOM、许可与模块解析事实。
- 对第三方依赖做通用 manifest 清洗：升级形态不可控，超出本地内部包证明范围。
- JavaScript minify/tree-shake：调试、动态 require 与审计风险更高，需要独立设计。
- 合并现有 package：会破坏部署、authority、可选依赖或多消费者边界，且不是字节问题的最小修复。

## 结果

十二档 artifact 全部保持原 package/file/module closure 和预算，投影分别回收 16,058–25,328 bytes。最紧两档为：

- Edge Application AI：6,258,661/6,291,456 bytes，余量 32,795 bytes；640 files、120 loaded modules。
- Standalone Application AI：6,258,793/6,291,456 bytes，余量 32,663 bytes；640 files、120 loaded modules。

Standalone Application 为 4,783,705 bytes，Standalone AI 为 5,150,523 bytes，Standalone MCP 为 9,862,496 bytes。所有预算不变。投影没有改变 package 数、源码布局、运行依赖、公开 specifier 或常驻资源。

## 验证

- Runtime Artifact Pruner 3/3：开发字段和 export `types` 被删除，runtime export 与 production dependency 保留，mode/原子写、symlink 和坏 manifest fail-before-mutation 继续成立。
- Local Image audit 7/7，静态镜像契约 compatible。
- 十二档 Local Profile artifact 全部 compatible；最紧档净回收 25,328 bytes。
- 每档真实 Node import probe 在投影后执行；Application AI 的 loaded module count 仍为 120。
