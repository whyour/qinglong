# ADR-0342：PostgreSQL Model Provider Credential Repository 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-75、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0037、ADR-0038、ADR-0042、ADR-0087、ADR-0276、ADR-0338、ADR-0341

## 背景

`@qinglong/ai` 的 `model-provider-credential/postgresModelProviderCredentialRepository.ts` 有 817 行，同时承载 PostgreSQL row/JSONB/bigint/SQLSTATE codec、content-free runtime audit、administration audit 与 Project/RoleBinding transaction fence、只读 credential source，以及普通/授权的 append-only mutation repository。公开 reader 与 repository 必须共享同一 durable transition protocol，但 runtime read authority、management mutation authority 与底层存储完整性需要独立审阅。

它们属于同一 PostgreSQL adapter 和同一发布 subpath，不是新的部署或供应链边界。编辑前对原文件全部 27 个 function/class/method 执行 GitNexus upstream impact：24 LOW、2 MEDIUM、1 HIGH、0 CRITICAL，全部 0 affected process。统一 `unavailable()` 为 HIGH（15 direct/18 total），`identity` 与 `integer` 为 MEDIUM；已在编辑前告警并把本批限制为等价 ownership 移动。

## 决策

保留一个 `@qinglong/ai` package、原 package export/subpath 和 2 行显式 facade，在同一 adapter 建立：

```text
postgresModelProviderCredentialRepository.ts          # stable public facade
postgres-model-provider-credential-repository/
├── storageProtocol.ts                                # row codecs, stable errors, lookup/audit normalization
├── administrationProtocol.ts                         # authorization fence and atomic security audit
├── reader.ts                                         # runtime transition/binding read and use audit
└── repository.ts                                     # ordinary and authorized mutation transactions
```

不新增 workspace package或公开 owner subpath。原运行时导出精确保持 `PostgresModelProviderCredentialReader` 与 `PostgresModelProviderCredentialRepository` 两项；repository 仍继承 reader，公开 class name、constructor 与 protected pool/transitionRows 关系保持。

SQL、schema/table/column、JSONB/bigint normalization、digest domain、SQLSTATE 映射、`SERIALIZABLE`、per-project/provider advisory lock、database clock、binding-before-transition、append-only audit、Project/RoleBinding fence、exact replay、rollback/release 顺序和错误 type/message/cause 均不变。runtime reader 继续只有 read 与 content-free credential-use audit；authorized commit 继续把 fence、transition 与 security audit 放在同一事务。

owner 分别为 storage protocol 223、administration protocol 172、reader 211、repository 282 行。没有按 SQL query、validator 或 repository method 拆成单文件；855 行 Prompt migration 继续保留为同一有序 DDL stream，避免“一迁移一文件”。

## 小设备与集群影响

非 AI 六档制品逐字节、逐文件、逐加载模块不变，最小 Edge 仍为 3,658,234 bytes、358 files、49 modules。AI 四档增加 4,153 bytes/4 files：Edge/Standalone AI 为 5,130,787/5,130,835 bytes、509 files、54 modules；Application AI 为 6,249,211/6,249,343 bytes、620 files、115 modules。所有 AI 档 loaded modules 均不变，说明 Cluster-only PostgreSQL owner 没有进入 Edge 运行时加载闭包；没有新增 dependency、连接、Pool、timer、线程或常驻对象。

PostgreSQL 18.4 arm64 HA 门通过 `remote_apply`、timeline 1→2、旧主 fencing 与 `pg_rewind` 只读同步 rejoin。Credential Catalog 的 bind/revoke exact replay、COMMIT-response-loss recovery、concurrent single winner、stale CAS rejection、content-free audit、manager/runtime authority split 和 promotion survival 均保持 true；最终 `gates.passed=true`。

## 被否决方案

1. 新增 credential reader/repository workspace package：双方共享 schema、transition chain 和 adapter release，不是独立部署边界。
2. 保留 817 行文件：runtime 与 management authority、row integrity 和 transaction audit 无法独立审阅。
3. 每个 SQL query、normalizer 或 commit method 一文件：会制造微文件并拆散事务顺序。
4. 把 reader 与 repository 做成互不相关的 class：会复制 transition query/codec，增加 runtime-management 语义漂移。
5. 趁移动抽取或合并两条 commit SQL：会改变高风险错误/事务路径，应另立行为变更与数据库集成证据。

## 验收证据

- facade 817→2 行；owner 223/172/211/282，总计 890 行，最大 282。
- 原路径仍精确导出 2 个 runtime symbol；repository 仍 `instanceof` reader，两个 class name 保持。
- AI 212 项为 209 pass/3 skip/0 fail；完整 16-package clean build/test 退出 0。
- package-boundary、cluster-dependency、edge-import 三项本地结构审计 compatible；workspace 仍为 16 package、951 source、25 root/926 nested，AI 为 149 source、1 root/148 nested，无单文件或浅层 package。
- 外部 profile vulnerability audit 沿用上一批结论：需要向默认漏洞服务发送生产依赖元数据且未获权限，本批不重复尝试，也不记为通过。
- 十档 artifact compatible；非 AI 六档精确不变，AI 四档 +4,153 bytes/+4 files/+0 loaded modules。
- PostgreSQL HA Docker 门退出 0，credential 与最终 gate 全部通过。
- `git diff --check` 通过；GitNexus 强制重建为 44,519 nodes/101,533 edges/1,738 clusters/296 flows。post-impact 中统一 unavailable 精确保持 HIGH（15 direct/18 total/0 process），identity 与 integer 保持 MEDIUM（6/12、7/11，均 0 process）；reader 因 facade/继承引用为 MEDIUM（5/9/0），repository 为 LOW（2/4/0），两类 commit 为 LOW（0/0/0），authorization fence 为 LOW（1/1/0）。没有新增 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此结果只作 Git 基线补充。工作区无 staged change。

## 后续约束

storage protocol 不取得 Pool 或独立事务；administration protocol 只处理授权围栏与 security audit；reader 不取得 binding mutation authority；repository 必须复用 reader 的 canonical transition read，且 authorized mutation 保持 fence/audit 同事务。新增数据库行为必须同时评审 SQL/schema/ACL、双方言语义、HA replay 与产物预算，不能自动新增 package、公开 owner subpath或一查询一文件。
