# ADR-0338：PostgreSQL Model Provider Credential Test Connection 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0265、ADR-0276、ADR-0331、ADR-0335、ADR-0337

## 背景

`@qinglong/ai` 的 `model-provider-credential/postgresModelProviderCredentialTestConnection.ts` 有 1,107 行，同时拥有三条不同事务边界：

1. 带 Policy fence、database-clock quota、audit 与 exact replay 的测试计划 admission；
2. 带 immutable start barrier、allowlist 复验、completion result 与 response-loss replay 的测试执行；
3. migration history、writable primary、tester role 与 least-privilege ACL readiness。

三者共享同一个 PostgreSQL Credential Test capability 和稳定公开路径，不具备独立部署、依赖或 consumer 边界，不能拆成新 workspace package；但把 manager admission、tester execution 和 readiness 混在一个文件中，会混淆两个数据库角色及其不同 SQL authority。

编辑前对全部 54 个 function/class/method（含接口方法和构造器）执行 GitNexus upstream impact：52 LOW、2 MEDIUM、0 HIGH/CRITICAL。两个 MEDIUM 是 plan unavailable（8 direct/12 total/1 process）和 execution unavailable（6/10/0）稳定错误。唯一相关流程仍是既有 credential test plan creation；本批限定为原样 ownership 移动。

## 决策

保留一个 `@qinglong/ai` package、原公共导入路径和 24 行显式 facade，在同一领域建立 package-private owner：

```text
postgresModelProviderCredentialTestConnection.ts       # stable explicit facade
postgres-model-provider-credential-test-connection/
├── contracts.ts                                       # public ports/results/errors
├── common.ts                                          # shared exact row/options/SQL-state helpers
├── planRepository.ts                                  # fenced quota + plan + audit transaction
├── executionRepository.ts                             # start/completion exact-replay transaction
└── readiness.ts                                       # migration/primary/role/ACL readiness
```

门面显式保持原 12 个 runtime export 和全部 type export；内部 common helper 不成为 package public subpath。SERIALIZABLE、advisory lock key、database clock、quota window/limit、receipt idempotency、audit 原子性、plan semantic replay、allowlist exact match、immutable execution/result、SQLSTATE mapping、client release、migration checksum、writable-primary 与 least-privilege SQL 均不变。

owner 文件为 common 84、contracts 147、execution repository 362、plan repository 482、readiness 107 行；没有按 SQL query、错误类或方法建立单文件，最大文件仍拥有一条完整 plan transaction protocol。

## 小设备与集群影响

不启用 AI 的六档 Edge/Standalone 制品逐字节、逐文件不变，最小 Edge 仍为 3,658,234 bytes、358 files、49 loaded modules。启用 AI 的四档统一增加 5,681 bytes/5 files，loaded modules 不变：Edge/Standalone AI 为 5,113,088/5,113,136 bytes、492 files、50 modules；Edge/Standalone Application AI 为 6,231,512/6,231,644 bytes、603 files、115 modules。没有新增生产 dependency、连接池、连接、timer、线程或常驻对象。

Cluster 仍使用原 plan/tester roles、Pool、schema 和 deployment topology。PostgreSQL 18.4 arm64 HA 门再次通过 `remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind` 只读同步 rejoin；Credential Test exact replay、completion COMMIT-response-loss convergence、同步复制、promotion 存活和 tester least privilege 均保持 true，最终 `gates.passed=true`。

## 被否决方案

1. 新增 plan/execution/readiness workspace package：它们不是部署或依赖边界，只会制造微包。
2. 继续保留 1,107 行单文件：manager/tester/readiness authority 无法独立审阅。
3. 每条 SQL 或 helper 一文件：会形成一操作一文件并破坏完整事务可读性。
4. 合并 manager 与 tester 数据库角色：会扩大生产权限，违反 least privilege。
5. 公开 owner subpath：会把内部目录固化成外部兼容承诺。

## 验收证据

- facade 1,107→24 行；owner 为 84/147/362/482/107 行，总计 1,206，最大 482。
- 编译后的原路径仍精确导出 12 个 runtime symbol；AI check 与定向 9/9 通过。
- AI 212 项为 209 pass/3 条件 skip/0 fail；完整 16-package clean build/test 退出 0。
- package boundary、Edge import、Cluster dependency/deployment 全部 compatible；workspace 仍为 16 package、934 source、25 root/909 nested，AI 为 132 source、1 root/131 nested，无单文件或浅层 package。
- 十档 artifact 全部 compatible；非 AI 六档精确不变，AI 四档 +5,681 bytes/+5 files/+0 loaded modules。
- PostgreSQL HA Docker 门退出 0，Credential Test 与最终 gate 全部通过。
- `git diff --check` 通过；GitNexus 强制重建为 44,457 nodes/101,410 edges/1,738 clusters/296 flows。post-impact 中 plan/execution repository 均为 LOW（2 direct/4 total/0 process），readiness 为 LOW（0/0/0）；两个 unavailable error 仍为 MEDIUM（13/17/1 与 11/15/0），没有新增 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此结果只作 Git 基线补充。工作区无 staged change。

## 后续约束

`contracts.ts` 不取得数据库 authority；`common.ts` 只拥有双方事务共享的 fail-closed 基础语义；plan repository 不取得 tester write authority；execution repository 不写 quota/audit；readiness 只检查、不修复 schema/ACL。新增职责按共同事务与权限原因归入现有 owner，不能自动增加 package 或一方法一文件。
