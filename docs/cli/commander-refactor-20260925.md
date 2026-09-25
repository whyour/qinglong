# Commander 重构验收 / Commander migration validation

2026-09-25。统一 `ql` 入口、面板命令树、本机任务参数和开发命令参数已接入 Commander 15.0.0。保留 TypeScript 源码、按需加载、双语帮助、JSON 输出与旧命令兼容；子命令在同一进程分发。

The unified ql entrypoint, panel command tree, local task options and developer options now use Commander 15.0.0. TypeScript sources, lazy loading, bilingual help, JSON output and legacy compatibility remain. Commands dispatch in-process.

## 构建与交付 / Build and delivery

- Node >=22.12.0；推荐 Node 24 / Node 24 recommended.
- `npm ci --prefix cli` → `npm run build:cli` → `npm run check:cli`.
- Commander 与 esbuild 为固定版本开发依赖，使用 CLI 自身的 lockfile。Commander 打包为共享 JS 模块，附带许可证；运行无需安装外部 npm 依赖。
- Commander and esbuild are pinned build dependencies with the CLI lockfile. A shared Commander bundle and its license ship with the package; no external npm runtime dependencies are needed.

## 验证 / Validation

| 环境 / Environment | Tests | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: | ---: |
| macOS ARM64, Node 24.18.0 | 259 | 254 | 5 | 0 |
| Debian, Node 22.12.0 | 261 | 260 | 1 | 0 |
| Alpine, Node 24 | 261 | 260 | 1 | 0 |

类型检查通过；独立离线安装通过，九个 bin 入口均可运行。Alpine 验收时压缩包 267,122 bytes，解包 987,986 bytes（后续文档更新会改变包体积）。平台不适用用例保留跳过，不计为通过。

Type checking and standalone offline installation passed, including all nine bin entries. At Alpine validation the archive was 267,122 bytes and unpacked files 987,986 bytes; subsequent documentation changes affect these sizes. Platform skips are reported separately from passes.

覆盖重复选项、字符串保真、必填选项值、`--no-startup`、帮助与错误流、`--` 参数透传、task 脚本/API 分流、旧命令及模块加载边界。未重新执行真实面板升级；面板 2.20.1 镜像的 Node 24.13.0 已确认满足要求。

Coverage includes duplicate options, exact strings, required option values, --no-startup, help/error output, argument pass-through, task/API routing, legacy commands and module loading boundaries. A real panel upgrade was not rerun; the panel 2.20.1 image's Node 24.13.0 meets the runtime requirement.

## 真实入口耗时 / Actual entrypoint timing

macOS ARM64 / Apple M1 / Node 24.18.0。每项两轮预热、21 个独立进程，旧版与新版交替运行，文件缓存预热；输出为 JSON 帮助。

Two warmups and 21 fresh processes per scenario, alternating old/new builds with warm filesystem caches. Measurements request JSON help.

| 命令 / Command | Before median ms | After median ms | Delta ms | Before P95 ms | After P95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| ql --help --json | 72.540 | 76.352 | +3.812 | 75.488 | 81.225 |
| ql task list --help --json | 74.847 | 80.854 | +6.007 | 80.026 | 87.789 |
| ql task exec --help --json | 85.455 | 88.779 | +3.324 | 90.366 | 94.555 |

本机三个入口中位数增加约 3–6 ms。该结果仅衡量启动及帮助路径，不含网络请求、维护操作或真实脚本运行，不能外推 Linux 或任务整体耗时。

Median overhead is approximately 3–6 ms on this machine. This covers startup/help paths only, without network requests, maintenance or user script execution; it does not predict Linux performance or overall task duration.

[原始样本及构建文件哈希 / Raw samples and build hashes](../../cli/docs/commander-entrypoints-20260925.json)

复现 / Reproduce:

```sh
QL_CLI_BEFORE=/absolute/path/to/pre-commander/dist node cli/scripts/benchmark-entrypoints.cjs
```

旧版 dist 必须在重构前留存；脚本不会把当前 Commander 实现作为旧版基线。

Save the pre-migration dist before rebuilding. The benchmark requires an explicit old build rather than treating the current Commander parser as the baseline.
