# ADR-0337：Plugin Package Prompt Execution 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-75、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0177、ADR-0276、ADR-0326、ADR-0332、ADR-0333、ADR-0336

## 背景

`@qinglong/ai` 的 `prompt/pluginPackagePromptExecution.ts` 有 1,199 行，同时承担：

1. execution plan、output intent、admission/finalization receipt、repository port 与稳定错误契约；
2. exact-shape、identity、digest、timestamp、大小和 canonical value 的 fail-closed 校验；
3. Prompt definition、参数、渲染、模型请求、output intent 与完整 execution plan 的规划和 normalization；
4. admission/finalization identity、receipt codec，以及初始 Run、RunEvent、StepRun mutation durable bundle 的构造。

这些职责共同定义一个 Plugin Package Prompt execution protocol：先把 publication 和瞬态输入固化为不含明文的 execution
plan，再由 Local SQLite 或 Cluster PostgreSQL adapter 原子 admission，最后从精确 ModelInvocation 证据完成 finalization。它没有
独立部署、依赖、权限主体、生产 consumer 或供应链生命周期，因此不能因为文件较大再新增 workspace package；但继续把公开
contract、纯规划算法、durable receipt codec 和 Run/StepRun 初始事实构造混在一个文件中，也不利于审阅 digest 与持久化边界。

编辑前对 37 个 function/class 和 5 个 repository port method 逐一执行 GitNexus upstream impact：20 CRITICAL、14 HIGH、
8 LOW。`PluginPackagePromptAdmissionUnavailableError` 为 34 direct/92 total/1 process，`invalid` 为 17/43/1，
`normalizePluginPackagePromptExecutionPlan` 为 9/29/1；唯一受影响流程是 Local Owner CLI 的 Plugin Package Prompt command
runner。已在编辑前告警，并把本批限定为语义等价的 ownership 移动，不调整字段次序、digest domain、大小预算、渲染、identity
推导或 admission/finalization 时序。

## 决策

保留一个 `@qinglong/ai` package、原 `prompt/pluginPackagePromptExecution` 导入路径和显式 public facade。在同一 Prompt
领域建立 package-private owner 目录：

```text
pluginPackagePromptExecution.ts             # 44-line stable explicit facade
plugin-package-prompt-execution/
├── contracts.ts                            # schemas, public ports, requests/results and stable errors
├── validation.ts                           # exact values, identity, digest, time and size validation
├── plan.ts                                 # definition/parameter/render/output/plan canonical preparation
└── durableEvidence.ts                      # admission/finalization receipts and Run/StepRun durable bundle
```

依赖方向固定为 `contracts <- validation <- plan`，`durableEvidence` 只依赖 contract、validation、plan 和既有 Runtime Core
domain contract；它不得取得 SQLite、PostgreSQL、Pool 或 provider I/O authority。根 facade 显式逐项转发原 25 个 runtime
export 及既有 type surface，不以 wildcard 暴露内部校验器、canonical shape 或 digest input。

execution/definition/admission/finalization digest domain、JSON field/order、exact-key validation、64 KiB 参数值、32 KiB plan、
16 KiB receipt 上限、legacy 缺失 output 的 exact live-only 语义、字符串替换渲染、identity 推导、瞬态 `AbortSignal` 排除、
Run/StepRun 初始 version/event facts、admission/finalization receipt counter 和稳定 error code/message 均保持。本轮不借目录化
统一 SQLite/PostgreSQL 事务实现，也不改变 provider 调用边界。

四个 owner 文件分别是 contracts 244、validation 126、plan 515、durable evidence 375 行。没有按每个 digest、receipt、
normalizer 或 repository method 建立单文件；最大文件 515 行，仍是一组共同变化的完整 planning protocol。

## 小设备与集群影响

不启用 AI 的 Edge、Standalone、Adopted 与 Application 六档制品逐字节、逐文件不变：最小 Edge 仍为
3,658,234 bytes、358 files、49 loaded modules。启用 AI 的四档因一个旧编译文件变成 facade 加四个 owner 编译文件，统一
增加 9,560 bytes/4 files，loaded modules 不变：Edge/Standalone AI 为 5,107,407/5,107,455 bytes、487 files、50
modules；Edge/Standalone Application AI 为 6,225,831/6,225,963 bytes、598 files、115 modules。没有新增 workspace
package、生产 dependency、连接、timer、watcher、listener、线程或常驻对象；未启用 AI 的低配路由设备不承担目录化成本。

Cluster 继续使用同一个 `@qinglong/ai` contract 和既有 PostgreSQL admission repository，没有新增 Pool、角色、Pod、Service、
sidecar 或 Kubernetes resource。PostgreSQL 18.4 arm64 physical-streaming HA 门通过 `remote_apply`、timeline 1→2、旧主
fencing、`pg_rewind` 后只读同步 rejoin；Prompt admission/finalization 的 exact replay、同步复制、promotion 存活、Policy fence、
content-free durable record 和 output Artifact 原子提交门全部为 true，最终 `gates.passed=true`。

## 被否决方案

1. **新增 Prompt Execution workspace package**：没有独立部署、重依赖、authority 或多消费者边界，只会扩大 importer、packlist 与 SBOM。
2. **继续保留 1,199 行文件**：公开协议、纯规划和 durable evidence 无法作为独立审查单元。
3. **按每个 digest/normalizer/receipt 一文件**：会制造一操作一文件，并割裂共享 canonical field/order 不变量。
4. **把 Local/PostgreSQL repository 一并移入 owner 目录**：会把纯协议与双方言的事务、连接和错误映射 authority 混合。
5. **直接公开四个 owner subpath**：会把内部层次固化成兼容承诺，并允许 consumer 绕过稳定 facade。
6. **趁移动修改渲染或统一 legacy output**：会改变 plan digest 和 durable replay，必须另立 ADR 与迁移协议。

## 验收证据

- public facade 1,199→44 行；owner 为 244/126/515/375 行，总计 1,304 行，最大 515；没有一方法一文件。
- 编译后的 facade 仍只有原 25 个 runtime export；所有 type export 由原路径生成，内部 validation/canonical shape 未公开。
- `@qinglong/ai` check 通过；AI package 212 项为 209 pass/3 条件 skip/0 fail；完整 16-package clean build/test 在允许 loopback TLS listener 的环境退出 0。
- package boundary、Edge import、Cluster dependency、Cluster deployment 四项审计全部 compatible；workspace 仍为 16 package、929 source、25 root/904 nested，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。AI 为 127 source、1 root/126 nested，Edge imported modules 仍为 121。
- 十档 artifact 均 compatible；非 AI 六档精确不变，AI 四档 +9,560 bytes/+4 files/+0 loaded modules。
- PostgreSQL HA Docker 门退出 0，旧主 fencing、promotion、rejoin、Prompt durable protocol 和最终 gate 全部通过。
- `git diff --check` 通过；GitNexus 强制重建为 44,443 nodes/101,380 edges/1,739 clusters/296 flows。post-impact 中 plan preparation 为 LOW（1 direct/2 total/1 process），plan normalization 为 CRITICAL（9/29/1），admission bundle 为 LOW（4/16/1），receipt digest 为 HIGH（2/10/0）；稳定错误仍因双方言 adapter 共同依赖显示 CRITICAL，但没有新增 execution flow，唯一流程仍是原 Local Owner Prompt command runner。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此 detect result 只作 Git 基线补充。工作区无 staged change。

## 后续约束

`contracts.ts` 不取得 I/O authority；`validation.ts` 不拥有业务流程；`plan.ts` 不写 durable state；`durableEvidence.ts` 不打开
数据库或调用 provider。新增字段/schema version 必须同时评审 canonical digest、双方言 durable replay、legacy plan 和制品预算；
新增 execution operation 按共同变化原因归入现有 owner，不能自动增加文件或 package。只有出现独立部署、独立权限主体、显著可选
依赖、多个生产 consumer 或可测 artifact 裁剪价值时，才重新评估 workspace package 边界。
