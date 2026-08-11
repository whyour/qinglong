# ADR-0339：PostgreSQL Plugin Package Prompt Application 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-75、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0177、ADR-0276、ADR-0332、ADR-0333、ADR-0337、ADR-0338

## 背景

`@qinglong/ai` 的 `prompt/postgresPluginPackagePromptApplication.ts` 有 931 行，同时承担公开 application contract、Cluster Prompt execution/catalog service、migration/ACL readiness 和完整 bootstrap/optional output composition。它们共享一个 Cluster AI deployment capability，不具备再拆 workspace package 的部署、依赖或权限边界；但继续平铺会混淆只读 readiness、请求期授权服务和启动期 provider/storage ownership。

编辑前对全部 25 个 function/class/method（含接口和闭包方法）执行 GitNexus upstream impact，25 个均为 LOW，最大为 `unavailable` 的 4 direct/4 total/0 process；没有受影响 execution process。本批限定为等价 ownership 移动。

## 决策

保留一个 `@qinglong/ai` package、原导入路径和 15 行显式 facade，在同一 Prompt 领域建立：

```text
postgresPluginPackagePromptApplication.ts        # stable facade
postgres-plugin-package-prompt-application/
├── contracts.ts                                 # public options/results/capabilities/error
├── services.ts                                  # execution authorization + bounded catalog service
├── readiness.ts                                 # migration/runtime-role/append-only ACL proof
└── bootstrap.ts                                 # disabled/active composition and owned shutdown
```

不把单一 catalog inspect 再拆成微文件，而与 execution service 保持在完整 application service owner。原 5 个 runtime export、type surface、disabled loader-free、readiness-before-provider、bounded recovery、transaction-bound authorization、publication snapshot、optional output dynamic loading、storage ownership transfer、失败关闭和 stop 语义均保持。

## 小设备与集群影响

非 AI 六档制品逐字节、逐文件不变，最小 Edge 仍为 3,658,234 bytes、358 files、49 modules。AI 四档统一增加 2,770 bytes/4 files、loaded modules 不变：Edge/Standalone AI 为 5,115,858/5,115,906 bytes、496 files、50 modules；Application AI 为 6,234,282/6,234,414 bytes、607 files、115 modules。没有新增 package、生产 dependency、Pool、Pod、Service、timer、listener 或线程。

PostgreSQL 18.4 arm64 HA 门通过 `remote_apply`、timeline 1→2、旧主 fencing 和 `pg_rewind` 只读同步 rejoin；Prompt readiness、admission/finalization、Policy fence、output recovery 与 promotion 存活保持 true，最终 `gates.passed=true`。

## 被否决方案

1. 新增 Cluster Prompt Application workspace package：没有新的部署或依赖边界，会制造第 17 个微包。
2. 继续保留 931 行平铺文件：启动 authority、请求服务和 readiness 无法独立审阅。
3. 每个 service/method 一文件：catalog 只有一个完整 inspect operation，不应形成浅层微文件目录。
4. 把 readiness 合入 bootstrap：会弱化“provider credentials 可达前独立证明”的审查边界。
5. 公开 owner subpath：会把内部布局固化为外部兼容承诺。

## 验收证据

- facade 931→15 行；owner 为 contracts 126、services 356、readiness 241、bootstrap 247，总计 985 行，最大 356。
- 原路径仍精确导出 5 个 runtime symbol；AI check、Cluster Prompt 定向 8 pass/1 条件 skip/0 fail。
- AI 212 项为 209 pass/3 skip/0 fail；完整 16-package clean build/test 退出 0。
- 四项边界/部署审计 compatible；workspace 仍为 16 package、938 source、25 root/913 nested，AI 为 136 source、1 root/135 nested，无单文件或浅层 package。
- 十档 artifact compatible；非 AI 六档精确不变，AI 四档 +2,770 bytes/+4 files/+0 loaded modules。
- PostgreSQL HA Docker 门退出 0，Prompt 与最终 gate 全部通过。
- `git diff --check` 通过；GitNexus 强制重建为 44,469 nodes/101,444 edges/1,737 clusters/296 flows。post-impact 中 execution/catalog service 均为 LOW（3 direct/4 total/0 process），readiness/bootstrap 为 LOW（0/0/0）；稳定 unavailable error 为 MEDIUM（5/10/0），没有新增 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此结果只作 Git 基线补充。工作区无 staged change。

## 后续约束

contracts 不取得 I/O；services 不拥有启动或 provider lifecycle；readiness 只证明、不修复 schema/ACL；bootstrap 不复制请求期授权和 catalog SQL。新增职责按 deployment phase 与 authority 归入现有 owner，不自动增加 package 或一方法一文件。
