# CLI 框架选型与性能 / CLI framework selection and performance

## 建议 / Recommendation

建议采用 **Commander 15 + TypeScript + 构建时打包**，运行以 Node 24 LTS 为主，若保留较低版本兼容则最低需满足 Commander 的 Node >=22.12.0。用户已明确取消 Node 18 作为新 CLI 的选型约束；Node 18 已 EOL，Node 22/24 当前仍为 LTS，见 [Node 官方版本状态](https://nodejs.org/en/about/previous-releases)。

Recommend **Commander 15 + TypeScript + build-time bundling**, targeting Node 24 LTS. Any lower supported baseline must meet Commander's Node >=22.12.0 requirement. Node 18 is no longer a selection constraint. See [Node release status](https://nodejs.org/en/about/previous-releases) and [Commander releases](https://github.com/tj/commander.js/releases).

现已完成 Commander 重构：面板命令树、本机执行参数和统一入口路由均使用 Commander；保留声明式注册表、双语帮助、业务校验及旧命令兼容层。CLI 最低 Node 22.12.0，推荐 Node 24。Commander 作为开发依赖锁定版本，构建时打包为共享模块，产物附带许可证，无外部运行时 npm 依赖。

The migration is complete: Commander handles the panel command tree, local execution options and unified entrypoint routing. The registry, bilingual help, business validation and legacy compatibility remain. Node 22.12.0 is the minimum; Node 24 is recommended. Commander is pinned as a build dependency, bundled once and shipped with its license, with no external runtime npm dependencies.

真实入口改造前后数据与验收见 [重构验收 / Migration validation](../../docs/cli/commander-refactor-20260925.md)。下方表格保留迁移前的选型原型数据，并非最终 CLI 的前后对比。

For actual before/after entrypoint measurements and validation, see the linked migration report. The tables below are historical framework-selection prototypes, not measurements of the final CLI migration.

## 选型原型历史实测 / Historical prototype measurements

2026-09-25，macOS ARM64、Apple M1、Node 24.18.0。各方案预热 2 次，轮换顺序测量 21 个独立进程；使用现有命令元数据，解析相同的 `task list --search example --page 2 --size 20 --json`，校验结果一致。

macOS ARM64, Apple M1, Node 24.18.0. Two warmups and 21 fresh processes per candidate, with rotating order. The same task-list request and normalized result are checked against the existing command metadata.

| 方案 / Candidate | 启动+解析 median ms | P95 ms | 帮助 median ms | 峰值 RSS median MiB | 构造+解析 warm ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous util.parseArgs | 73.26 | 75.24 | 71.99 | 45.78 | 0.016 |
| Commander 15.0.0 | 89.13 | 93.27 | 86.74 | 49.36 | 0.089 |
| Commander 15.0.0 bundled | 78.99 | 80.29 | 77.83 | 47.27 | 0.093 |
| CAC 7.0.0 | 77.47 | 84.42 | 74.30 | 46.92 | 0.302 |
| Yargs 18.2.0 | 128.55 | 130.88 | 126.00 | 59.59 | 1.153 |

Commander 普通安装比当前原型多约 15.9 ms；打包后多约 5.7 ms，峰值 RSS 中位数多约 1.5 MiB。对网络请求或较长脚本来说，不能把该差值直接换算成任务整体耗时百分比。纯解析和命令构造成本远小于进程启动成本。

Unbundled Commander adds ~15.9 ms over the current parser fixture; bundled Commander adds ~5.7 ms and ~1.5 MiB median peak RSS. These differences do not predict whole-task speedups/slowdowns for network requests or long-running scripts. Construction and parsing are much cheaper than process startup.

| 框架 / Framework | 安装文件体积（含传递依赖） | 包数（含自身） |
| --- | ---: | ---: |
| Commander 15.0.0 | 202.5 KiB | 1 |
| CAC 7.0.0 | 40.2 KiB | 1 |
| Yargs 18.2.0 | 539.0 KiB | 15 |

现有内置方案不增加第三方包。Commander/CAC 均无传递运行依赖；Yargs 本次安装包含 15 个包。Commander 全模块通过 esbuild 0.28.2 打包、压缩为 **40,575 bytes（39.6 KiB）JS**；这个数字不含 LICENSE、类型声明、文档、source map，不能与上表完整安装体积混为同一口径。正式发布仍需保留许可证。

The native solution adds no third-party package. Commander and CAC have no transitive runtime dependencies; this Yargs installation contains 15 packages. Bundling the entire Commander module with esbuild 0.28.2 produces **40,575 bytes (39.6 KiB) of minified JS**, excluding LICENSE, types, docs and maps. This differs from the full-installed-file metric above. Release artifacts must retain the license.

## 开发便利性 / Development trade-offs

| 方案 | 对当前 ql 的适配判断 |
| --- | --- |
| Commander | 首选。原生多级命令、选项声明、帮助及输出/退出控制，可替代部分自维护路由与参数处理；仍需适配业务错误、双语与兼容规则。 |
| CAC | 体积最小，简单命令容易写。本次需要为 `task list` 做手动分流；仍需处理多余参数和字符串类型等细节，不一定能减少最多维护代码。 |
| Yargs | 命令、选项和校验能力丰富；本次启动与依赖成本最高，当前功能未体现出值得支付额外成本的需求。 |
| util.parseArgs | 当前速度最快，无额外包；多级路由、帮助、约束、错误契约等仍由项目维护。 |

Commander best matches the current command tree. CAC is the smallest but the prototype requires manual group routing and extra semantic checks. Yargs is feature-rich with the largest measured startup/dependency cost. The current parser is fastest but leaves more CLI infrastructure to maintain.

官方资料：[Commander](https://github.com/tj/commander.js/)、[CAC](https://github.com/cacjs/cac)、[Yargs](https://github.com/yargs/yargs)。Commander 自带 TypeScript 类型；更强的选项类型推导可另行评估 extra-typings，不计入本次包体积。

## 已保留的迁移契约 / Preserved migration contracts

- stdout/stderr 分离、单行 JSON 错误、现有退出码与双语帮助。
- 重复选项拒绝规则；本次 Commander 原型默认允许重复 `--page`，正式实现已补齐。
- 多余位置参数和字符串原样保留；本次 CAC 原型接受多余位置参数，并将 `--search 00123` 变为 `123`，不能直接替代当前行为。
- `ql task` 的脚本/API 边界、`--` 后参数透传、`task` 简写，以及旧 `update false`/`reload system` 归一化。
- 特别检查 `--no-startup`：部分框架会自动解释为 `startup=false`，当前业务键是 `no-startup=true`，需显式映射。
- 按需加载业务模块；避免为每个子命令再启动一个 Node 进程；运行构建产物而非生产环境现编译 TS。

Preserve structured output, exit statuses, localization, duplicate-option rejection, positional validation, exact string values, task/API boundaries, pass-through arguments, legacy normalization and the meaning of `--no-startup`. Keep lazy business-module loading and in-process dispatch. The historical prototypes are **not** complete compatibility implementations; the production migration now tests these contracts.

## 方法边界与复现 / Method and reproduction

所有候选都加载共同的现有注册表与校验辅助代码。基线 70.65 ms 也加载这层代码，**不是空 Node 启动**。所以这是同一脚手架下的选型对比，不是完整 CLI 替换前后实测。计时包含启动、加载、构造、解析、JSON 序列化和退出；不含真实面板请求、维护操作、脚本执行。文件缓存已预热，不是冷磁盘测试。帮助布局和字数不同，帮助耗时只作参考。

All candidates load a shared existing registry/validation scaffold. The 70.65 ms baseline includes that scaffold; it is **not empty Node startup**. This compares framework prototypes, not before/after full CLI replacements. Timing includes process startup, loading, construction, parsing, serialization and exit, without panel requests or script execution. Filesystem caches are warm. Help layouts/lengths differ.

Warm 数据每批先预热 20 次，再构造+解析 200 次，共 5 批；每次重建命令树，不代表缓存解析器的极限吞吐。P95 使用 nearest-rank。安装体积是文件字节之和，含 types/docs 及传递依赖，不是 tgz 大小或物理磁盘占用。单机结果不能直接外推所有 Linux 部署。

Warm figures use five batches of 200 construction-plus-parse calls after 20 warmups per batch; they do not measure a reused parser's maximum throughput. P95 uses nearest rank. Installed sizes sum file bytes including types/docs and dependencies, not compressed archives or physical disk allocation. Single-machine results are not universal deployment measurements.

复现步骤与固定依赖见源码目录 `cli/benchmarks/frameworks/README.md`；脚本为 `cli/scripts/benchmark-frameworks.cjs`、`framework-prototype.cjs` 和 `bundle-framework.cjs`。运行时可把评测依赖放在临时目录，不改应用依赖。

[全部样本 / All samples](framework-benchmark-20260925.json) · [打包元数据 / Bundle metadata](framework-bundle-20260925.json) · [契约探测 / Contract probes](framework-contract-probes-20260925.json)
