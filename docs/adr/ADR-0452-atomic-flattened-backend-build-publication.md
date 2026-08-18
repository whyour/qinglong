# ADR-0452：原子且扁平兼容的 Backend 构建发布

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-359
- 关联 ADR：ADR-0042、ADR-0106、ADR-0451

## 上下文

Backend TypeScript 开始引用 QL3 workspace source 后，TypeScript 的 common source root 扩展到仓库根。一次真正清空输出目录的构建会生成
`static/build/back/app.js` 与 `static/build/packages/**`，但 2.x 生产入口和现有镜像仍要求 `static/build/app.js`、`token.js`、`runtime/**` 等稳定路径。
开发机长期残留的旧 `static/build/*` 会掩盖该错位，使增量构建和测试通过，而干净镜像不可启动。

直接把所有生产入口改到 `static/build/back/**` 会扩大 2.x 部署、CLI、Docker 与 Shell 兼容面；把 workspace package 编译副本发布进 backend 目录又会形成第二套
package authority。构建必须只发布 backend subtree，同时保持既有路径和可追踪 source map。

## 决策

1. `build:back` 唯一进入 `scripts/ql3-build-back.cjs`，不再直接把 `tsc` 输出到公开的 `static/build`。
2. 每次构建在 `static/.back-build-<pid>-<nonce>/output` 隔离目录执行 `tsc -p back/tsconfig.json --outDir ...`。失败时保留当前公开构建，不允许半成品覆盖。
3. 发布前必须验证 staged `back/app.js`、`back/token.js`、`back/runtime/adapters/local-process/localProcessExecutor.js` 等必要输出存在；
   `output/packages/**` 只作为编译闭包，不进入公开 backend。
4. 只把 staged `output/back` 发布为扁平的 `static/build`，因此生产路径继续是 `static/build/app.js`、`runtime/**`，不要求修改 2.x 入口。
5. 发布前重写 `.js.map` 的 relative sources，使其从最终扁平位置仍能解析到真实 `back/**` source；不得删除 map 或留下指向临时 staging 的路径。
6. 发布采用同一父目录内 rename：现有 build 先改名为唯一 backup，staged backend 再 rename 到目标；只有新目录成功可见后才删除 backup。发布失败时恢复旧目录并清理精确
   staging/backup，不使用 shell、glob 或仓库级删除。
7. 构建结束后 `static/build/back` 与 `static/build/packages` 必须不存在。测试和镜像门必须从干净输出执行，禁止依赖历史 artifact。

## 被拒绝的替代方案

### 修改所有生产入口指向 `static/build/back`

拒绝。它把 TypeScript 内部 common-root 变化泄露成部署契约变化，并扩大 2.x 回滚风险。

### 构建前清空 `static/build` 后直接运行 tsc

拒绝。它仍发布错误目录，并在编译失败时破坏最后一个可运行构建。

### 同时发布 `output/back` 与 `output/packages`

拒绝。QL3 package 已有独立 dist/artifact gate，backend 不应携带另一份 workspace package 实现。

## 验证

- 主机和干净 Linux arm64 镜像中的 `pnpm build:back` 均通过；最终目录只保留原有 root layout，不存在 `static/build/back` 或
  `static/build/packages`。
- source map 从最终 `static/build/runtime/**` 位置可解析回仓库 `back/runtime/**`，不引用临时 staging。
- Edge benchmark、D359 compiled-backend 资源/回滚门和完整 backend 回归均只读取新的干净发布结果。
- 完整 backend 回归与 18-package clean build/test 均退出 0；五个静态契约文件 `126/126`，四个可执行架构审计和 14 个 Local Profile artifact
  预算全部通过，证明扁平 backend 发布没有改变 package closure 或 Profile 制品基线。
- 本 ADR 不改变 package graph、生产依赖、schema、migration、数据库或部署 authority。
