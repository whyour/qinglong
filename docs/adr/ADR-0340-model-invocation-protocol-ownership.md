# ADR-0340：Model Invocation Protocol 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0172、ADR-0276、ADR-0330、ADR-0331、ADR-0337、ADR-0339

## 背景

`@qinglong/ai` 的 `model-invocation/modelInvocation.ts` 有 913 行，同时承载公开 repository/record/command/error contract、canonical validation 与 digest domain、audit outcome 映射、start protocol 和 completion protocol。它们共同定义 ModelInvocation 的 durable state machine，不是五个可独立部署的 package；但单文件让双方言 adapter、coordinator、pricing 与 usage ledger 依赖的协议层次难以独立审阅。

编辑前对全部 34 个 function/class/method 执行 GitNexus upstream impact：14 CRITICAL、11 HIGH、2 MEDIUM、7 LOW。最大调用面为 repository unavailable（30 direct/196 total）、conflict（58/182）、invalid contract（27/129）；start/completion codec 被 Local SQLite、PostgreSQL、coordinator 和 usage ledger 共同消费。已在编辑前告警，本批严格限定为等价 ownership 移动。

## 决策

保留一个 `@qinglong/ai` package、原导入路径和 35 行显式 facade，在同一领域建立：

```text
modelInvocation.ts              # stable public facade
model-invocation/
├── contracts.ts                # schemas, records, commands, repository port, errors
├── common.ts                   # exact validation, digest domains, mutation identity, JSON budget
├── audit.ts                    # canonical audit validation and outcome mapping
├── startProtocol.ts            # start record/command creation and normalization
└── completionProtocol.ts       # completion record/command creation and normalization
```

不新增 workspace package或公开 subpath。原 18 个 runtime export 和 type surface保持；digest domain、JSON field/order、24 KiB预算、128-row recovery上限、identity UUID/dedupe推导、audit phase/outcome映射、StepRun status/version/digest/event fence、success outputRef、deadline/lost语义和错误 code/message均不变。

owner 为 contracts 161、common 152、audit 151、start 245、completion 269 行。没有把每个 normalizer、digest 或 outcome 拆成单文件；start/completion 各自保留完整 command protocol。

## 小设备与集群影响

非 AI 六档制品逐字节、逐文件不变，最小 Edge 仍为 3,658,234 bytes、358 files、49 modules。AI 四档统一增加 7,342 bytes/5 files、loaded modules 不变：Edge/Standalone AI 为 5,123,200/5,123,248 bytes、501 files、50 modules；Application AI 为 6,241,624/6,241,756 bytes、612 files、115 modules。没有新增 package、生产 dependency、连接、timer、线程或常驻对象。

PostgreSQL 18.4 arm64 HA 门通过 `remote_apply`、timeline 1→2、旧主 fencing 与 `pg_rewind` 只读同步 rejoin；ModelInvocation start/completion、COMMIT-response-loss、recovery、usage/price settlement 和 promotion 存活门保持 true，最终 `gates.passed=true`。

## 被否决方案

1. 新增 Model Invocation contract/start/completion workspace package：它们是同一 durable protocol，不是部署边界。
2. 继续保留 913 行文件：公开 contract、共享 canonical codec 与两个 mutation phase 无法独立审阅。
3. 每个 normalizer/digest 一文件：会把共享 field order 和 mutation identity 切成微文件。
4. 分离 start/completion 公共 mutation identity：会产生重复或漂移的 durable identity domain。
5. 趁移动调整 outcome/StepRun 映射：会破坏历史重放，必须另立版本化迁移协议。

## 验收证据

- facade 913→35 行；owner 161/152/151/245/269，总计 1,013 行，最大 269。
- 原路径仍精确导出 18 个 runtime symbol；AI check、定向 30 pass/1 条件 skip/0 fail。
- AI 212 项为 209 pass/3 skip/0 fail；完整 16-package clean build/test 退出 0。
- 四项边界/部署审计 compatible；workspace 仍为 16 package、943 source、25 root/918 nested，AI 为 141 source、1 root/140 nested，无单文件或浅层 package。
- 十档 artifact compatible；非 AI 六档精确不变，AI 四档 +7,342 bytes/+5 files/+0 loaded modules。
- PostgreSQL HA Docker 门退出 0，ModelInvocation 与最终 gate 全部通过。
- `git diff --check` 通过；GitNexus 强制重建为 44,486 nodes/101,473 edges/1,737 clusters/296 flows。post-impact 中 mutation identity 保持 CRITICAL（9 direct/61 total/0 process），start record normalizer 为 HIGH（8/47/0），completion creator 为 HIGH（2/18/0），completion command normalizer 为 MEDIUM（8/16/0）；没有新增 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此结果只作 Git 基线补充。工作区无 staged change。

## 后续约束

contracts 不取得 crypto 或 I/O；common 不拥有 phase-specific业务；audit 不构造 durable command；start/completion 只通过共享 canonical helper 与 mutation identity连接。新增 schema/version 必须同步评审双方言 durable replay、StepRun状态机、usage/pricing ledger与制品预算，不能自动新增 package或一函数一文件。
