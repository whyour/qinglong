# ADR-0090：Production Package Packlist 与开发 Map 排除

- 状态：Accepted（ADR-0106 后 23 个 QL3 importer 与六种 Profile 制品已执行）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-05、D-14、D-35、D-40、D-62、D-85、D-86、D-89
- 关联 ADR：ADR-0038、ADR-0040、ADR-0062、ADR-0063、ADR-0087、ADR-0088、ADR-0089

## 上下文

QL3 package 的 TypeScript 开发构建生成 `.js`、`.d.ts`、`.js.map` 与 `.d.ts.map`。此前每个 `package.json` 使用宽泛的 `files: ["dist"]`，所以 `pnpm pack` 会把四类文件全部装入 production artifact。ADR-0089 增加四个常驻 TypeScript 单元后，最大 application 虽仍低于 4 MiB/512 files/16 MiB 门禁，但已达到 2,450,553 bytes、505 files、60 loaded modules，只余 7 个文件预算。

这些 map 有开发调试价值，但 Node 运行和 package 间 TypeScript 类型解析分别只需要 `.js` 与 `.d.ts`。在开发构建中关闭 source map 会损害本地调试；在制品审计中直接忽略 map 又会让报告与用户实际安装内容不一致。

## 决策

1. 所有当前 23 个 QL3 package 继续在开发 `dist` 生成 source/declaration map，但 production `files` 精确白名单固定为 `dist/**/*.js` 与 `dist/**/*.d.ts`。
2. 只有两个受审例外：`@qinglong/local-process` 可额外发布 `assets`，`@qinglong/local-sqlite` 可额外发布 `drizzle`。不得使用 `dist`、`dist/**` 或新增任意目录通配符。
3. package dependency audit 对每个已登记 importer 比较完整、有序的 `files` 数组；缺少 JS/声明、重新加入宽泛 dist、增加未审资产或新增 importer 未登记全部 fail closed。
4. Profile artifact audit 继续按真实流程执行：逐包 build、`pnpm pack`、offline production install、精确 package 集合、文件/字节预算和 Node import closure/RSS。不得在安装后删除 map 或从计数器中排除文件。
5. 该规则只改变发布内容，不改变开发 `dist`、package exports、运行模块或依赖树。若未来要发布 ESM、WASM、native binary、schema 或 UI asset，必须显式增加对应 package 的窄白名单和制品测试。

## 被否决的替代方案

1. **把文件门禁从 512 调高**：掩盖无运行价值文件进入路由器制品，拒绝。
2. **全局关闭 TypeScript source/declaration map**：降低本地调试与声明定位能力，拒绝。
3. **制品审计安装后删除 map**：报告与用户收到的 package 不一致，拒绝。
4. **只发布 `.js`**：内部 package 的类型消费者和独立安装检查会失去声明契约，拒绝。
5. **使用负 glob 排除 map**：宽泛正向目录仍可能带入未来未知文件；精确正向白名单更易审计，拒绝。

## 影响与证据

- runtime-core 的实际 tarball 检查得到 39 个 JS、39 个 `.d.ts`、0 个 map，并保留根 export target。
- 当前 23 个 package manifest 全部通过 `QL3_PACKAGE_PRODUCTION_FILES_INVALID` fail-closed 审计，专用 contract test 覆盖默认及两个资产例外。
- 六种真实 production artifact 全部通过；更新后数据为：

| Profile | Bytes | Files | Loaded modules | RSS delta sample |
| --- | ---: | ---: | ---: | ---: |
| edge | 1,303,217 | 192 | 30 | 6,782,976 |
| standalone | 1,303,343 | 192 | 30 | 6,176,768 |
| edge-adopted | 1,378,389 | 202 | 33 | 7,962,624 |
| standalone-adopted | 1,378,560 | 202 | 33 | 8,699,904 |
| edge-application | 1,666,316 | 263 | 60 | 11,730,944 |
| standalone-application | 1,666,424 | 263 | 60 | 11,730,944 |

最大制品相对变更前减少 784,129 bytes 和 242 files，loaded modules 保持 60，证明优化来自发布元数据排除而不是删除运行能力。RSS 是本机单次抽样，只用于硬门禁，不作跨次性能提升结论。

ADR-0106 收敛四个 Profile wrapper 后，制品入口改为 `local-profile`/`local-adopted-profile` 精确 subpath。叠加后续 Scheduler 能力的当前快照为：edge/standalone 1,662,386/1,662,434 bytes、238 files、37 modules；edge-adopted/standalone-adopted 1,898,370/1,898,442 bytes、266 files、40 modules；edge-application/standalone-application 2,211,411/2,211,531 bytes、337 files、70 modules。六种制品继续低于原门禁；不同切片的 RSS/bytes 不用于推导单一优化收益。

## 后续约束

新 package 或新静态资产必须先进入 importer registry 和 packlist audit；不能把本 ADR 当作重新拆细 package 的理由。package 粒度仍由 ADR-0087 决定。最终 Docker/系统包还应验证解包后的 owner/mode、license/SBOM、签名和 release archive digest；本 ADR 只收敛 workspace package 的 production 文件集合。
