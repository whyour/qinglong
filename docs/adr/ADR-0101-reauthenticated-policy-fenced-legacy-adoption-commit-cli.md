# ADR-0101：重新认证且受 Policy 围栏约束的 Legacy adoption commit CLI

- 状态：Accepted（产品 commit、双重 reviewer authority 复核与事务回滚门禁已实现；物理 Edge 写放大和断电证据待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-04、D-08、D-16、D-17、D-23、D-61、D-62、D-78、D-84、D-85、D-86、D-95、D-96、D-97、D-98、D-99、D-100
- 关联 ADR：ADR-0085、ADR-0086、ADR-0095、ADR-0096、ADR-0097、ADR-0098、ADR-0099、ADR-0100

## 背景

ADR-0100 已能把人工 review stream 签发成 authenticated carrier，但产品只能签发，不能把 carrier 交给 ADR-0098 的 Policy-fenced publisher。若 commit 只信任 carrier 内过去的 reviewer，则持有 command file 的另一个本机用户可在 reviewer credential 已撤销后继续执行；若产品层复制 publisher SQL，则会绕过既有 Project/RoleBinding fence、allowed audit、ledger 和整批事务。

本入口仍是短生命周期本机管理能力。它不能进入常驻 edge/standalone runtime，也不能代替 cluster-control 的远程强身份、审批与 KMS/HSM。

## 决策

### 1. 在现有 binary 增加 exact commit operation

`@qinglong/local-owner-cli/adoption` 与同一 `ql3-adoption run --command-file ...` 增加 `legacy-crontab.adoption.commit`。不新增 workspace package、binary、timer、watcher或第三方依赖。

`0600` command file 只接受 exact-shape 的 deployment/target/source/authorization/keyring/credential 路径、Profile、plan/decision identity、Project、mutation 和 request ID。credential token 仍只从独立 `0600` presentation file 读取，不进入 command JSON、argv、stdout 或 stderr。成功输出只包含 inserted/existing、稳定 identity、计数、低敏 digest 和 audit event ID。

### 2. 当前操作者必须重新认证并匹配签名 reviewer

CLI 在 commit 时重新通过正式 SQLite Identity repository、credential version、subject 状态、Owner pepper catalog 与 POSIX keyring认证 User，并与同一 deployment-root proof 合成最长 60 秒的 `local_console` Principal。当前 Principal 的 subject type/id、合成 authentication ID 和 assurance 必须与 carrier 中的 reviewer 一致；另一个有效 User 也不能代替原 reviewer。

proof 固定当前 real/effective UID、部署根以及 target/source/authorization/issuer/credential/keyring 的 owner、mode、device 和 inode。target SQLite 是事务内唯一允许内容变化的文件，因此最终复核允许其 size/mtime/ctime 改变，但仍拒绝 inode、owner、mode 或类型变化；其他 authority 文件保持内容身份不可变。

### 3. reviewer authority 在 Policy 前和 COMMIT 前复核

`local-admin` publisher 在读取并验证 carrier 后、请求 `project.manage` 前执行一次 reviewer authority callback；同一 callback 又被传给 `@qinglong/local-sqlite/adoption`，在目标 `BEGIN IMMEDIATE` 已写完 TaskDefinition、recipe、execution revision、Trigger、allowed audit 和 ledger 后、执行 `COMMIT` 前再次执行。

最终 callback 是可等待的异步 fence。它重验 POSIX proof、短期 Principal 未过期、credential version/state、Identity subject state和 identity、secret digest/timestamps、pepper binding、catalog active/retired state、catalog/material digest，再匹配 carrier reviewer。插入和 exact replay 两条 COMMIT 路径都必须等待该 callback；拒绝或异常会回滚目标事务。

### 4. 复用唯一 mutation authority

CLI 只调用 ADR-0098 `publishReviewedLegacyCrontabAdoption()`，不复制 SQL、Policy 或 candidate 转换。legacy source 的 `BEGIN IMMEDIATE` fence、同一 authenticated carrier descriptor、Project/RoleBinding exact-version fence、单目标事务、append-only ledger 和 replay identity 继续由原 authority 裁决。

产品错误只沿有限 cause 链提升已知 authentication failure code；消息仍使用外层安全化错误，不输出 token、secret、内部栈或原始任务内容。

## 被否决的替代方案

1. **新增 commit package 或 binary**：与 issuer 总是共同部署、consumer 单一且没有新平台/供应链责任，不满足 D-85。
2. **只信 carrier reviewer，不重新认证**：不能证明当前执行 commit 的人仍是 reviewer，也不能发现 credential/Identity/pepper 撤销。
3. **只在 Policy 前检查一次**：Policy 决策与 COMMIT 之间仍存在撤权和文件替换窗口。
4. **把 target SQLite 当作完全不可变 authority file**：合法事务自身会改变数据库元数据，造成确定性误拒绝；应只放宽内容元数据，不放宽 inode/owner/mode/type。
5. **复制 ADR-0098 SQL 到 CLI**：会形成第二 mutation authority，使 Policy、audit、ledger 和上限发生漂移。
6. **把 credential token 写入 commit command 或环境变量**：扩大持久 intent、shell 和进程检查暴露面。

## 验收证据

1. local-sqlite 53 项测试通过；新增门禁证明异步 final authority rejection 被等待且 Task/Trigger/audit/ledger 全部回滚。
2. local-admin 35 项测试通过；插入和 exact replay 都在 Policy 前及 COMMIT 前调用 reviewer authority confirmation。
3. local-owner-cli 7 项测试通过；真实 binary 完成 issue→commit→Task/Trigger/ledger，并拒绝“有效但不是签名 reviewer”的另一个 User，失败后 ledger 为零且 token 不进入输出。
4. dependency boundary 23 项、完整 dependency audit、27 package 全量测试与 backend 665 项通过；仍为 27 importer，local-admin 9、local-owner-cli 4 个 source file，零 finding。
5. 六种 Profile 制品门禁通过。base edge/standalone 为 1,489,789/1,489,915 bytes、216 files、34 modules；adopted 为 1,723,559/1,723,730 bytes、240 files、37 modules；application 为 2,011,486/2,011,594 bytes、301 files、64 modules。最大 RSS delta 抽样为 11,763,712 bytes，均低于既有预算。本 ADR 不把这些本机逻辑/制品测试冒充物理 Edge 写放大或断电证据。

## 后续约束

下一切片优先采集 32 MiB/100,000-row review、carrier 验证和原子 publication 在固定物理 Edge 设备上的峰值 RSS、读取量、fsync、SQLite/WAL 与文件系统写放大及故障恢复证据。之后才能推进 Scheduler/Run admission；PostgreSQL publisher 和 cluster adoption ceremony 必须使用独立远程强身份、审批及 KMS/HSM adapter，不复用本机 credential presentation、Owner pepper 或 issuer file keyring。
