# ADR-0343：Plugin Package Prompt Output Artifact 协议归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-75、D-85、D-87、D-156、D-157、D-213、D-244、D-257
- 关联 ADR：ADR-0260、ADR-0261、ADR-0268、ADR-0276、ADR-0337、ADR-0342

## 背景

`@qinglong/ai` 的 `prompt-output/pluginPackagePromptOutputArtifact.ts` 有 777 行，同时承载公开 schema/type/error、canonical validation 与 domain-separated digest、AES-256-GCM seal/open 生命周期，以及 content-free reference 协议。它既被本机 SQLite 与 PostgreSQL Artifact/retention repository 共同消费，也被 Prompt completion/read、外部 custody recovery 和 durable Model Invocation 协调器共享。

这些职责属于同一个加密 Artifact wire protocol，不是四个部署、依赖或供应链边界；继续平铺会让公开协议、密文完整性和引用投影难以独立审阅，拆为 workspace package 又会复制底层 schema 与 digest authority。编辑前对原文件全部 33 个 function/class/method 执行 GitNexus upstream impact：19 CRITICAL、1 MEDIUM、13 LOW。共享 validator/digest 与三类公开错误是主要高风险面，最大范围为 unavailable error 的 141 个上游符号并进入 1 条流程；已在编辑前告警并把本批限制为等价 ownership 移动。

## 决策

保留一个 `@qinglong/ai` package、原 `./plugin-package-prompt-output-artifact` export 和 34 行显式 facade，在同一领域建立：

```text
pluginPackagePromptOutputArtifact.ts                 # stable public facade
plugin-package-prompt-output-artifact/
├── contracts.ts                                    # schema, public types, ports and stable errors
├── canonicalProtocol.ts                            # exact-shape validation, digest, identity and artifact normalization
├── cryptography.ts                                 # AES-GCM seal/open and key/plaintext zeroization
└── referenceProtocol.ts                            # content-free reference projection and normalization
```

不新增 workspace package、依赖或公开 owner subpath。原路径仍精确发布 17 个 runtime export 与 8 个 public type/interface；facade 只显式转发，不使用 wildcard export。四个 owner 分别为 126、381、258、128 行，没有按 validator、digest 或单个操作拆成微文件。

`aes-256-gcm`、32-byte key、12-byte nonce、16-byte auth tag、JSON 字段顺序、AAD、五个 digest domain、Artifact identity、retention bounds、JSON/明文/输出预算、错误 type/code/message/cause、buffer/key/plaintext wipe、exact replay 和 content-free reference 均不变。SQLite 与 PostgreSQL 不各自实现 codec，仍通过同一个 public facade 复用 canonical protocol；双方言 storage/transaction/GC/tombstone 行为没有移动。

## 小设备与集群影响

非 AI 六档制品逐字节、逐文件、逐加载模块不变，最小 Edge 仍为 3,658,234 bytes、358 files、49 modules。AI 四档增加 8,451 bytes/4 files：Edge/Standalone AI 为 5,139,238/5,139,286 bytes、513 files、54 modules；Application AI 为 6,257,662/6,257,794 bytes、624 files、115 modules。所有 AI 档 loaded modules 不变，没有新增 dependency、连接、Pool、timer、线程或常驻对象；最大 Application AI 仍低于 6 MiB 门限。

PostgreSQL 18.4 arm64 HA 门通过 `remote_apply`、timeline 1→2、旧主 fencing 与 `pg_rewind` 只读同步 rejoin。Prompt output Artifact 原子提交、GC 先 tombstone 后删除密文、GC 后 exact replay、key rotation/retirement、最小权限 maintenance authority、执行输出灾后恢复与 promotion survival 均保持 true；最终 `gates.passed=true`。

## 被否决方案

1. 新增 Prompt Output Artifact workspace package：没有独立部署/权限/依赖/供应链边界，并会增加 Edge 安装拓扑。
2. 保留 777 行平铺文件：公开契约、canonical protocol、加密生命周期和 reference projection 无法独立审阅。
3. 每个 validator、digest 或 create/open 操作单独成文件：会制造一操作一文件并放大产物文件数。
4. 为 SQLite 与 PostgreSQL 分别实现 Artifact codec：会使密文/AAD/digest 语义发生方言漂移。
5. 同批升级 schema 或加密算法：这是 wire-format 行为变化，需要独立迁移、兼容读取和密钥 ceremony RFC。

## 验收证据

- facade 777→34 行；owner 126/381/258/128，最小 126、最大 381，没有微文件。
- 原路径仍精确导出 17 个 runtime symbol 与 8 个 public type/interface；没有 wildcard public facade。
- Artifact/读取/保留/SQLite/PostgreSQL 定向回归 29/29；AI 212 项为 209 pass/3 skip/0 fail；完整 16-package clean build/test 退出 0。
- package-boundary、cluster-dependency、edge-import 三项本地结构审计 compatible；workspace 仍为 16 package、955 source、25 root/930 nested，AI 为 153 source、1 root/152 nested，无单文件或浅层 package。
- 外部 profile vulnerability audit 需要向默认漏洞服务发送生产依赖元数据且未获权限，本批不重复尝试，也不记为通过。
- 十档 artifact compatible；非 AI 六档精确不变，AI 四档 +8,451 bytes/+4 files/+0 loaded modules。
- PostgreSQL HA Docker 门退出 0，Prompt Output Artifact 与最终 gate 全部通过。
- `git diff --check` 通过；GitNexus 强制重建为 44,535 nodes/101,575 edges/1,734 clusters/296 flows。post-impact 中 Artifact normalizer、retention normalizer/digest、identity 与 reference projection 保持 CRITICAL，retention 两项各影响 1 条流程；create/open 为 LOW，reference normalizer 为 MEDIUM，三类公共错误保持 CRITICAL，没有新增 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此结果只作 Git 基线补充。
- 工作区无 staged change。

## 后续约束

contracts 不取得 crypto、storage 或数据库 authority；canonical protocol 只负责稳定 wire validation/digest/identity；cryptography 必须继续拥有 key/plaintext 生命周期并在所有路径清零；reference protocol 必须保持 content-free。新增 Artifact 字段、算法、digest domain、retention 语义或错误契约必须独立评审迁移与双版本读取；新增 owner 文件必须同时满足内聚职责、非微文件和 Edge/Cluster artifact 门，不能自动新增 package。
