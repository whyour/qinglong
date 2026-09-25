# CLI 耗时 / CLI timing

[简体中文说明](../README.md) | [English guide](../README.en.md)

## 面板管理与本机工具 / Management and local tools

`ql-cli` 请求面板 API；`ql-local-cli` 执行本机运维。前者包含网络及必要的认证耗时，后者取决于维护操作，不能统一比较快慢。`ql-cli task run` 返回请求已接受，`ql-task-cli` 等待脚本结束；比较任务完成时间应从提交开始观测到实际完成。

`ql-cli` calls the panel API; `ql-local-cli` performs local maintenance. API latency includes network and authentication when needed; local latency depends on the operation. `ql-cli task run` returns acceptance, whereas `ql-task-cli` waits for script completion. Compare submission-to-completion time, not just command return time.

## 配置传输优化后 / After configuration transport optimization

去掉读取配置后额外启动的 Node 序列化进程，使用 `/usr/bin/env -0` 和当前进程解析环境。未跳过配置、钩子、日志或退出状态处理。Bash 选项及导出函数继续保留。

Removed the extra Node process used to serialize configuration environments. `/usr/bin/env -0` now supplies NUL-separated records to the current process. Configuration, hooks, logging, exit handling, Bash options and exported functions remain supported.

在上述同一 macOS 环境，停止回归测试后独立运行相同基准，预热及采样方法不变：

Rerun independently after regression tests finished, on the same macOS environment with unchanged warmups and sampling:

| 场景 / Scenario | Shell median (ms) | Optimized TS median (ms) | TS P95 (ms) |
| --- | ---: | ---: | ---: |
| Completion marker | 143.64 | 106.62 | 109.15 |
| Sleep 1 s + marker | 1197.93 | 1150.68 | 1164.98 |

极短任务相较上次 TS 的 169.86 ms 降至 106.62 ms（约 37%）；相较本轮 Shell 的 143.64 ms 少约 26%。优化前后为不同批次测量，不是统计置信区间。空配置桥单项各预热 2 次、采样 10 次，耗时从约 76–79 ms 降为通常 14–16 ms（一次约 22 ms）。不能把这些结果外推为所有真实任务的提速比例。

The short task decreased from the previous TS median of 169.86 ms to 106.62 ms (~37%), and was ~26% below this run's Shell median. Before/after measurements are separate batches, not confidence intervals. A separate empty-configuration probe (two warmups, ten samples) fell from roughly 76–79 ms to typically 14–16 ms, with one ~22 ms sample. These percentages do not predict all real workloads.

验证：TypeScript 构建通过；macOS 全量测试 246 通过、5 项平台限定跳过；Alpine/Node 18 与 Debian/Node 18 各 19 项配置、参数、取消及 Shell 差分测试通过。独立离线安装七个入口通过，无新增 npm 运行依赖。此处是优化后的增量验收，之前的完整迁移验收归档和镜像保持原样。

Validation: TypeScript build; macOS full regression (246 passed, five platform-specific skips); Alpine/Node 18 and Debian/Node 18 focused configuration, argument, cancellation and Shell differential suites (19 passed each); offline standalone installation of all seven entries. No new runtime npm dependencies. This is incremental optimization validation; previous acceptance archives/images remain unchanged.

[优化后的原始样本 / Optimized raw samples](timing-macos-20260925-optimized.json)

## 优化前历史数据 / Historical pre-optimization measurements

2026-09-25，本机 macOS ARM64、Node.js v24.18.0，单位 ms。

Measured on 2026-09-25, macOS ARM64, Node.js v24.18.0. Durations are milliseconds.

| 同一任务 / Same task | Shell median | TS median | TS − Shell | Shell P95 | TS P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 仅写完成标记 / Completion marker only | 143.55 | 169.86 | +26.31 (+18.3%) | 148.21 | 175.13 |
| 等待 1 秒后写标记 / Sleep 1 s, then marker | 1195.74 | 1217.40 | +21.66 (+1.8%) | 1250.21 | 1234.85 |

本次 TS 略慢，不能据此宣称迁移提升执行速度。短任务的开销占比更明显；长任务主要取决于脚本。TS 的直接收益是维护、类型检查和扩展。单机隔离夹具结果不代表 Linux 容器、远程 API、真实下载、升级或并发调度性能。

TypeScript was slightly slower in this run. This does not demonstrate a speed improvement. Overhead matters more for short tasks; longer tasks are dominated by the workload. TypeScript's direct benefits are maintainability, type checking and extensibility. These isolated single-machine results do not establish Linux container, remote API, download, upgrade or concurrent scheduler performance.

### 方法 / Method

每个场景、每个实现预热 2 次，测量 15 次，交替先后次序。每次启动新进程，墙钟时间包含启动到退出；检查退出码和完成标记。原 Shell 文件不修改，两者使用相同脚本、空钩子、配置和 no_tee 设置。临时目录内用夹具替代 pnpm 探测与 token helper，不设置任务 ID、不发送状态 API 请求、不读取真实面板配置。P95 使用 nearest-rank（15 个样本中为最大值），样本较少，仅作参考。sleep 场景包含操作系统调度延迟。

Each scenario/implementation has two warmups and 15 measured fresh processes, with alternating order. Wall time covers startup through exit; exit codes and completion markers are checked. Original Shell files are unmodified. Both use the same script, empty hooks, configuration and no_tee setting. Temporary fixtures replace the pnpm probe and token helper. No task ID, status API requests or real panel configuration are used. P95 uses nearest rank (the maximum of 15 samples); this small sample is indicative only. The sleep scenario includes OS scheduling delay.

```sh
npm run build:cli
node cli/scripts/benchmark-legacy.cjs
```

[原始样本 / Raw samples](timing-macos-20260925.json)。现有 `benchmark.cjs` 只比较空 Node 与 CLI 帮助启动，不是旧 Shell 与 TS 对比。

The existing `benchmark.cjs` compares empty Node startup with CLI help, not legacy Shell with TypeScript.
