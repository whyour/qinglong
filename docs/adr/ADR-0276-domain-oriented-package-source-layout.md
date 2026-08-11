# ADR-0276：Package 内部领域目录与兼容 export 布局

- 状态：Accepted
- 日期：2026-08-05
- 关联：D-87、D-248、D-255、D-256、D-257、ADR-0087、ADR-0267、ADR-0274、ADR-0275

## 上下文

ADR-0267 已证明当前 19 个 workspace package 的部署、权限、可选依赖和消费者边界成立，但 package
边界正确不等于内部源码结构合理。当前 `src` 根目录仍有明显平铺：`runtime-core` 113 个文件、
`cluster-admin` 79、`cluster-postgres` 87、`local-sqlite` 63、`ai` 55、`cluster-control` 40、
`local-owner-cli` 38。`cluster-postgres` 和 `local-sqlite` 已把 migration 放入子目录，但 repository、
readiness、management、runtime composition 等仍大多混在根层。

继续平铺会让 ownership、依赖方向、测试定位和 review scope 只能依赖文件名前缀；把这些文件机械拆成
新 package 又会增加低配设备的 importer/SBOM/安装与构建成本，并可能把 Cluster、AI 或管理依赖带入
Edge closure。另一方面，为每个旧文件保留根 facade 虽能保持物理路径，却不能解决用户看到的平铺。
Node package 的受支持兼容面是 export specifier，不是 `dist` 内部物理路径，因此可以在不改变
`@qinglong/ai/plugin-package-prompt-execution` 等公开入口的前提下，把实现输出到嵌套目录。

## 决策

1. workspace package 继续只按独立部署制品、数据库/OS/网络 authority、可选重依赖隔离、可替换 adapter
   或多个 production consumer 裁决；内部目录整理不是新建 package 的理由。文件数与 LOC 只触发复核，
   不能直接决定拆包或合包。
2. `src` 平铺与 workspace 微包是两个独立问题。小而内聚的 package 可以保持浅目录；大 package 才按
   owning domain 下沉。全平铺 package 只允许作为机器账本中的显式例外：独立交付物的公开产品入口使用
   `public_entrypoints`，被至少两个生产闭包复用且零生产依赖的窄共享协议使用 `shared_protocol`；证据
   消失时合并回最接近的 owning package。禁止以“一文件一包”或“一目录一包”作为通用组织规则。
3. 每个 `src/` 根文件必须在 schema v2 账本中精确登记为 `public_export`、`binary_entry` 或
   `shared_infrastructure`。公开/二进制入口必须由 manifest 直接证明；共享基础设施必须有嵌套领域源码
   和具体保留理由，不能成为继续平铺实现的兜底分类。新 domain、repository、policy、codec、migration
   或 adapter 实现不得未经 ratchet 评审新增到根层。
4. 大 package 按真实 capability 建一级目录，例如 AI 的 `prompt/`、`model-invocation/`、
   `provider-credential/`、`pricing/`、`composition/`；目录内只在确有多种职责时再使用 `domain/`、
   `application/`、`ports/`、`adapters/`。禁止创建空层级、`common/`、`misc/` 或无 ownership 的
   `utils/` 汇集目录。
5. 跨 package 消费者只能使用 `package.json#exports` 中的公开 specifier。迁移时保持 specifier 与
   exported symbol 不变，把 target 从 `./dist/foo.js` 改为 `./dist/<domain>/foo.js`；测试同步镜像新的
   物理路径。未声明的 `dist/*` deep import 不作为兼容承诺，也不能为它保留几十个根 facade。
6. 同 package 内依赖必须指向领域相对路径，禁止绕回自身 package specifier；领域之间出现循环时，先
   抽取最小 contract/port 到 owning domain，不能用 barrel 或新 package 掩盖循环。
7. 机器审计冻结每个 package 的精确根文件名、职责和 hard cap，而不只统计数量；没有显式 ledger
   变更时，根文件不得增加、替换或伪装职责。每完成一个迁移批次即下调该 package 的 root-file ratchet，
   不能用删除测试、合并巨型文件或 facade 替换实现来“达标”。
8. 迁移顺序为：`ql3-ai` Prompt 样板；`runtime-core` 按 security/package/workflow/worker/local-runtime；
   `local-sqlite` 与 `cluster-postgres` 按相同 repository capability 对齐；最后处理 admin/control 的
   process、route、management adapter。每批只做路径、exports 和 import 变化，不混入领域行为重写。
9. 每批必须在编辑前运行 GitNexus upstream impact；保持公开 export key/symbol 集合；通过该 package
   check/test、完整 19-package、后端、dependency/package/Edge import 与受影响 Profile artifact 门。
   PostgreSQL/SQLite migration ID、checksum、SQL 顺序与 runtime authority 不得因目录迁移变化。

## 被拒绝的方案

- **按领域再拆 workspace package**：内部导航问题不构成部署或 authority 边界，反而增加制品复杂度。
- **所有旧文件保留根 facade**：外部 specifier 虽稳定，但根目录仍有同量文件，无法解决平铺问题。
- **一次性移动全部大包**：数百个 import 和测试路径同时变化，难以审查 blast radius 与回归来源。
- **按技术层建立全包 `controllers/services/repositories`**：同一 capability 被切散，ownership 与变更
  局部性更差；技术层只允许作为领域内第二层。
- **仅规定命名不加 ratchet**：文件名前缀已经证明不能阻止平铺继续增长。

## 接受门

- package boundary 仍为 19，消费者图、依赖方向和十档 artifact closure 不变；
- 新 root implementation non-growth 审计能拒绝超出账本的根文件；
- `ql3-ai` Prompt 与 `runtime-core` Worker/Security 样板的公开 export key 与 exported symbol 集合前后相同，
  内部源码进入领域目录；
- AI/Cluster Control/Owner CLI/Worker Runtime/Cluster Admin 消费者不使用未声明 deep import，相关完整测试
  与 PostgreSQL HA 回归通过；
- 后续每个大包都有明确 root baseline、目标目录和 ratchet 下调记录；
- 目录迁移不改变 migration checksum、SQL、runtime role、Profile closure 或稳态资源预算。

## 当前基线与迁移批次

目录收敛按“根层是否只剩公开入口/组合入口”判断，不按“是否存在子目录”或统一文件数阈值判断。
2026-08-06 的全 workspace 复核显示，19 个 package 中有 9 个 `src` 尚无子目录；其中多数是 1–9
个文件的窄协议、共享 leaf 或产品 composition package，可以保持浅目录。真正仍以文件名前缀代替
ownership 的四个大包已按 ratchet 逐批治理：`ai` 收口到 4/55，`local-owner-cli` 收口到 2/48，
`worker-runtime` 收口到 3/32，`local-admin` 已收口到 2/26（根文件/总文件）。复核还发现 9 文件的
可部署 `local-application` 同时承载 application runtime 与 production process 两个真实职责，现已在
同一 package 内收口到 2/9。Worker、Local Admin 与 Local Application 根层都只剩公开入口或
production/runtime composition；不得因此新增 workspace package。
`local-owner-console` 也已收口到 1/7；其 Bootstrap 与 credential recovery 虽分别只有一个实现文件，
但属于 dependency contract 隔离的高敏感 ceremony，不按目录文件数机械合并。
`local-process` 进一步收口到 1/8，把 process execution 与 completion receipt 两个真实 capability 留在
同一个 POSIX deployment package 内；目录收口不引入新的 importer、依赖或常驻进程。

第八十八批不再机械移动文件，而是把收口标准升级为 schema v2 强制门：19 个 package 的每个根源码
文件均有精确职责，根文件集合必须与账本逐名相等，`public_export`/`binary_entry` 必须由 manifest target
证明。全 workspace 仅剩三个显式全平铺例外：`local-command-file` 是由 Application、Owner CLI 与
Maintenance 三个生产闭包复用、零生产依赖的 `shared_protocol`；`local-profile` 与
`local-adopted-profile` 只包含 Edge/Standalone/Profile 公共产品入口，属于 `public_entrypoints`。审计会
拒绝缺失、证据不足或在出现嵌套实现后仍保留的浅层例外，也会拒绝用 `binary_entry` 冒充普通 export。
因此“小包保持简单”是可撤销、可核验的架构裁决，不是新的平铺豁免。
定向边界门 5/5、完整 19-package 门、后端 1,098 pass/2 skip、六项架构审计、十档 artifact 与
PostgreSQL HA 均通过；十档 artifact 相对第八十七批逐字节不变。刷新后四个被修改符号均为 LOW/0
affected process；最终图为 42,468 nodes/96,357 edges/1,679 clusters/265 flows，`detect-changes`
all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

第八十九批把 `@qinglong/local-sqlite` 根层的 `config.ts`、`database.ts` 与 4,831 行 typed
`schema.ts` 整体归入 `src/storage/`，形成 path/Profile/PRAGMA connection policy、开发工具兼容入口与
完整 Drizzle storage contract 的单一基础设施边界；没有按配置、连接和 77 张表拆成微目录或新 package。
package 保持 148 个 source file，root 10→7、nested 138→141、hard cap 10→7，三项
`shared_infrastructure` 根例外从 schema v2 账本删除，根层只剩七个 manifest 可证明的 public export。
root/runtime/migration/config/database/schema 六组 export count/digest 分别保持
15/`f1884fabfa37efd5`、12/`daf0cfe03a52f442`、4/`588ef1025be22417`、4/`63528837c5fe7e1b`、
15/`0a80103752c5b74e`、77/`29271096be568db2`；clean build 后旧根 dist 路径为零。

编辑前 82 个 function/class/method 为 5 CRITICAL/77 LOW、85 direct/296 impacted/0 process；五个
CRITICAL 均是 Local SQLite options/path 校验、journal 选择、defensive client 打开与配置错误边界，
编辑前已显式告警。刷新后风险仍为 5 CRITICAL/77 LOW，85 direct/0 process 精确不变，impacted
296→292 来自 Storage 聚类收敛，不解释为运行风险下降。Local SQLite 192/192、完整 packages、后端
1,098 pass/2 skip、六项审计均通过；dependency audit 首轮准确发现 Drizzle allowlist 仍指向旧
`src/schema.ts`，修正为唯一精确新路径 `src/storage/schema.ts` 后 47/47 负向门通过，未使用通配放宽。
十档 artifact 文件/package/module closure 不变且均增加 226 bytes：Edge/Standalone
3,530,353/3,530,401，Adopted 4,125,971/4,126,055，Application 4,613,341/4,613,485，AI
4,865,275/4,865,335，Application AI 5,948,335/5,948,491；最大档距 6 MiB 上限仍有 342,965 bytes。
PostgreSQL 18.4 arm64 HA `gates.passed=true`，timeline 1→2、旧主 fence、`pg_rewind` 只读同步 rejoin
与两个 fresh control replica 全绿，Docker 容器/network/volume 零残留。
最终 GitNexus 为 42,471 nodes/96,358 edges/1,681 clusters/265 flows；`detect-changes` all/compare
`develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 孵化树仍未完整进入 Git
基线，因此该结果只作补充证据，不能替代上述逐符号 impact 与完整运行门。

第九十批把 `@qinglong/cluster-postgres` 的五个共享根实现归入两个真实 owning domain：CA 文件校验、
离散连接环境与 lazy `pg.Pool` 共同进入 `src/connection/`，跨仓储 administration audit/transaction 与
definition transaction/row decoder 共同进入 `src/repository/`。没有建立 `common`/`utils`，也没有把这些
高复用能力拆成新 workspace package。package 保持 142 个 source file 与 56,089 行，root 18→13、
nested 124→129、hard cap 18→13；根层只剩十个 manifest 可证明的 public composition entry，以及
需要和 Drizzle/migration contract 一起独立治理的 `schema.ts`、`schemaContract.ts`、
`schemaReadiness.ts`。schema v2 账本删除五个 `shared_infrastructure` 根例外，并冻结新的精确根集合。

index/runtime/admin/package manager/package executor/AI maintenance/AI credential manager/AI credential tester/
automation manager/worker ingress 十组公开 export count/digest 分别保持 94/`431e3c95f3e2582c`、
55/`f766a6184888590b`、19/`df4d60a7337976e3`、24/`d0a270751e55e137`、
32/`dfb1bf5135f03fc3`、7/`a2ae76bd839e0ede`、7/`57ce1e5beb70e9df`、
6/`39229b66bec2c56b`、15/`d00c42a6ea46caa8`、10/`48d406ee559a2273`；clean build 后五个旧根
source/dist 路径为零。编辑前 54 个 function/class/method 为 18 CRITICAL/18 HIGH/18 LOW、571 direct/
1,790 impacted/87 process hits；强制刷新后风险数量分布、571 direct 与 87 process 精确不变，impacted
1,790→1,766 只来自领域聚类收敛。风险最高的通用行解码、事务回滚、连接 release 与 availability
classification 的函数体均未改变；风险标签的个别重分配不能解释为行为风险下降。

Cluster PostgreSQL 275 pass/1 条件 skip、完整 packages、后端 1,098 pass/2 skip、六项架构/部署审计均
通过。十档本机制品相对第八十九批 package/file/module closure 与字节数全部精确不变：Edge/Standalone
3,530,353/3,530,401，Adopted 4,125,971/4,126,055，Application 4,613,341/4,613,485，AI
4,865,275/4,865,335，Application AI 5,948,335/5,948,491；最大档距 6 MiB 仍有 342,965 bytes。
PostgreSQL 18.4 arm64 HA `gates.passed=true`，timeline 1→2、旧主 fence、`pg_rewind` 只读同步 rejoin、
两个 fresh control replica 及全部事务窗口门通过，`ql3-ha-*` container/network/volume 零残留。最终图为
42,467 nodes/96,360 edges/1,675 clusters/265 flows；`detect-changes` all/compare `develop` 分别为
12 files/31 symbols 与 14/34，均 low/0 affected process。

第九十一批把 `@qinglong/cluster-postgres` 最后三个非入口根文件整体归入 `src/schema/`。
`schema.ts`、`schemaContract.ts`、`schemaReadiness.ts` 共 10,178 行，分别承载 Drizzle typed schema、
reviewed migration/catalog contract 与只读 readiness；三者共同维护同一 Schema capability 与 migration
lockstep，因此保持一个 owning domain，不进一步拆成微目录或 workspace package。Drizzle 配置、migration、
worker 与 AI 消费者均改为精确新路径，公开 package specifier 和 exported symbol 集合不变。package 仍为
142 个 source file/56,089 行，root 13→10、nested 129→132、hard cap 13→10；账本删除最后三个
`shared_infrastructure` 根例外，根层只剩十个 manifest 可证明的公共 composition entry。

十个公共入口的 export count/digest 保持 94/`431e3c95f3e2582c`、55/`f766a6184888590b`、
19/`df4d60a7337976e3`、24/`d0a270751e55e137`、32/`dfb1bf5135f03fc3`、
7/`a2ae76bd839e0ede`、7/`57ce1e5beb70e9df`、6/`39229b66bec2c56b`、
15/`d00c42a6ea46caa8`、10/`48d406ee559a2273`；Schema、Schema Contract、Schema Readiness 自身也保持
84/`65e472451e4988e6`、1/`73a21f649514e359`、10/`15435b10cb0b01dc`，clean build 后旧根 source/dist
路径为零。编辑前对三个文件内 101 个 function/class/method 逐一 upstream impact：6 MEDIUM/95 LOW、
62 direct/117 impacted/0 process，零 HIGH/CRITICAL；六个 MEDIUM 只覆盖 readiness 的错误类型与
server/history/capability/contract/role 失败关闭断言。

Cluster PostgreSQL 275 pass/1 条件 skip、完整 packages、后端 1,098 pass/2 skip、六项架构/部署审计均
通过。十档本机制品的 package/file/module closure 与字节数相对第九十批全部精确不变：Edge/Standalone
3,530,353/3,530,401，Adopted 4,125,971/4,126,055，Application 4,613,341/4,613,485，AI
4,865,275/4,865,335，Application AI 5,948,335/5,948,491；最大档距 6 MiB 仍有 342,965 bytes。
PostgreSQL 18.4 arm64 HA `gates.passed=true`，timeline 1→2、旧主 fence、`pg_rewind` 只读同步 rejoin、
两个 fresh control replica 及全部事务窗口门通过，`ql3-ha-*` container/network/volume 零残留。刷新后的
GitNexus 为 42,468 nodes/96,361 edges/1,675 clusters/265 flows；101 个移动符号仍为
6 MEDIUM/95 LOW、62 direct/117 impacted/0 process，与编辑前精确一致。`detect-changes` all/compare
`develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

第九十二批不追求“所有根文件都下沉”，只消除两个已经存在明确 owning domain 的根例外：
`@qinglong/runtime-core` 的 `repositoryErrors.ts` 归入 `src/run/`，因为其八个 class 全部属于 Run
Repository error taxonomy；`@qinglong/local-execution` 的 `workflowTaskExecution.ts` 归入
`src/execution/`，由 execution subpath 继续导出，control/recovery 只获得这一个精确 contract 的跨域
import 许可。没有新增 `common`、`ports` 或单文件微目录。`pinnedSemver.ts` 与 `postgresql.ts` 仍保留为
Runtime Core 根共享基础设施：它们跨多个独立 capability，当前没有第二个同域实现可支撑真实目录。

Runtime Core 保持 113 files/54,015 lines，root 5→4、nested 108→109、hard cap 5→4；Local Execution
保持 19 files/5,043 lines，root 1→0、nested 18→19、hard cap 1→0。package boundary audit 允许
non-negative hard cap，使零根文件成为真实可表达状态；空 `rootSourceFileRoles` 仍必须与物理根集合精确
相等，未来任何根文件都会同时触发 hard-cap exceeded 与 role drift。Runtime root/run-repository 及 Local
execution/control/recovery/dispatch/scheduler 七组 export count/digest 保持
551/`1f9335f27d1212b2`、32/`1df31a110aa5e908`、7/`1e026da7eec6395c`、
7/`9e5639157f68501c`、6/`5d39277c1ca97957`、10/`4e4319b8a7d15392`、
4/`c7de5eb065a6d47c`；clean build 后旧根 source/dist 路径为零。

编辑前后两个文件的 33 个 interface/class/method/property 均精确为 3 MEDIUM/30 LOW、34 direct/
69 impacted/0 process；三个 MEDIUM 是两个 Workflow Task port 与 `RunRepositoryError` 基类。边界 hard-cap
与 import 审计函数分别为 LOW、2/1 direct、0 process。Runtime Core 435/435、Local Execution 30/30、
完整 packages、后端 1,098 pass/2 skip、六项架构/部署审计均通过。十档制品 closure 不变，非 Application
档净增 3 bytes，Application 档净增 2 bytes：Edge/Standalone 3,530,356/3,530,404，Adopted
4,125,974/4,126,058，Application 4,613,343/4,613,487，AI 4,865,278/4,865,338，Application AI
5,948,337/5,948,493；最大档距 6 MiB 仍有 342,963 bytes。PostgreSQL 18.4 arm64 HA
`gates.passed=true`，timeline 1→2、旧主 fence、`pg_rewind` 只读同步 rejoin、两个 fresh control replica
与全部事务窗口门通过，`ql3-ha-*` container/network/volume 零残留。最终 GitNexus 为 42,467 nodes/
96,361 edges/1,674 clusters/265 flows；`detect-changes` all/compare
`develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

| Package | 根文件 | 已嵌套 | 首批目标 |
| --- | ---: | ---: | --- |
| `@qinglong/runtime-core` | 4 | 109 | Worker、Security、Plugin Package、Local Runtime、Scheduler、Run、Tool、Remote 等领域已下沉，Run repository error 已归位；根只保留两个公共入口与 SemVer/PostgreSQL 两个真实跨域基础设施 |
| `@qinglong/cluster-postgres` | 10 | 132 | Connection、Repository 与 Schema 基础设施均已下沉；Worker Credential、Remote Execution、Run/StepRun、Run Recovery、Scheduling、Security/Identity、Automation、Management、Tool Execution、Approved Action、Migration orchestration 与 Plugin Package 全域已下沉；根层只保留十个公共 composition entry，完成当前 root topology 收口 |
| `@qinglong/cluster-admin` | 3 | 76 | Automation、Model Provider Credential、Worker Credential、Prompt Output、共享 Management Support 与 Plugin management/publisher/lifecycle/recovery/executor 已下沉；根仅保留 index、administration 与 AI migration composition |
| `@qinglong/local-sqlite` | 7 | 141 | Storage、repository/authority/maintenance 等领域已下沉；根层只保留 manifest 可证明的公开组合入口 |
| `@qinglong/ai` | 4 | 51 | Prompt、Model Invocation、Provider Credential、Prompt Output、Pricing、Usage 与 Model Gateway 边界已下沉；根仅保留 index、feature activation、migration 与 Profile composition，完成当前 root topology 收口 |
| `@qinglong/cluster-control` | 3 | 37 | Application Runtime 与 Production Process 已下沉；根仅保留 index 和两个 binary CLI composition entry，完成当前 root topology 收口 |
| `@qinglong/local-admin` | 2 | 24 | Legacy Adoption、Plugin Package、Local Security 与 Automation Administration 已下沉；根仅保留 index/runtime composition，完成当前 root topology 收口 |
| `@qinglong/local-application` | 2 | 7 | Application Runtime 与 Production Process 已分为两个浅层 capability；根仅保留 index 与 binary CLI，保持一个可部署 package |
| `@qinglong/local-execution` | 0 | 19 | Execution、Control、Recovery、Dispatch 与 Scheduler 五个领域全部下沉；Workflow Task repository port 由 Execution 精确拥有，零根目录由 hard cap=0 与空角色集合冻结 |
| `@qinglong/local-owner-console` | 1 | 6 | Authentication 与 Delivery 已下沉；根仅保留 index，Bootstrap/Credential Recovery 保持互相禁止导入的 ceremony 隔离 |
| `@qinglong/local-owner-keyring` | 1 | 3 | Pepper Custody 已下沉；根仅保留 index，继续作为 Owner CLI/Console/Maintenance 共享的高敏感 leaf |
| `@qinglong/local-owner-cli` | 2 | 46 | Lifecycle、Deployment、Plugin Package、AI Management、Security Management 与 Automation Management command family 均已下沉；根层只保留 `index.ts` 与总 `cli.ts`，不再为形式清零移动 |
| `@qinglong/local-process` | 1 | 7 | Process Execution 与 Completion Receipt 已下沉；根仅保留 index，共享 POSIX launcher asset 与本地/Worker 生产消费者仍处于同一部署边界 |
| `@qinglong/worker-runtime` | 3 | 29 | Credential、Session、Remote Execution、本地 Execution 与 Process lifecycle 已下沉；根仅保留 `index.ts` 和两个 production product composition，完成当前 root topology 收口；Worker 单一部署边界不拆微包 |

其余浅目录 package 只有在出现第二个真实 owning domain 时才建立子目录；`local-command-file` 的
单文件不是反例，它由 application、Owner CLI、maintenance 三个不同生命周期的生产闭包复用且零生产
依赖。若该复用或制品裁剪价值消失，按 ADR-0267 合并回最近 owner，不为“看起来整齐”保留微包。

当前首批样板已将 execution contract/executor、SQLite/PostgreSQL admission repository 与 Cluster
Prompt application 共 5 个文件移入 `src/prompt/`；五个公开 package export specifier 与 exported
symbol 保持不变，export target 直接指向嵌套 dist，根 hard cap 已从 55 下调为 50。第二批又将
`runtime-core` 的 credential、delivery、management plan、token、Session、Session transport 与 execution
attestation 共 7 个文件移入 `src/worker/`，根 hard cap 从 113 下调为 106。第三批再将 security
primitive、Project Policy、Security Audit 与 Audit Query 共 4 个文件移入 `src/security/`，根 hard
cap 从 106 下调为 102；`secretReference` 仍由 Secret domain 拥有。第四批将 Publisher provenance、
trust、revocation proposal 与 trust transition proposal 共 4 个文件移入
`src/plugin-package/publisher/`，根 hard cap 从 102 下调为 98。其余领域继续作为独立 ratchet 批次，
不要求在同一变更中完成。第五批再将 Workflow execution plan、administration、frontier、
cancellation convergence、task-attempt admission 与 task recovery 共 6 个文件移入
`src/plugin-package/workflow/`，根 hard cap 从 98 下调为 92。
第六批把 install state、admission、installation coordinator、activation 与 recovery 五个文件移入
`src/plugin-package/installation/`，把 lifecycle、lifecycle plan 与 quarantine 三个文件移入
`src/plugin-package/lifecycle/`；根 hard cap 从 92 下调为 84。两个目录仍属于同一个
`@qinglong/runtime-core` package，不新增部署 importer、依赖、facade 或常驻 authority。
第七批把 Local Dispatch、Local Execution Control、Local Completion Receipt Journal 与 Local Startup
Recovery 四个文件移入 `src/local-runtime/`，根 hard cap 从 84 下调为 80。目录按共享本地运行时职责
收敛，而不是按 `local*` 前缀机械聚类；Scheduler、Secret 与 TaskDefinition 文件继续留给各自领域批次。
第八批把 Trigger contract/administration 与 Local/Cluster Scheduler 四文件移入 `src/scheduler/`，把
TaskDefinition contract/administration、semantic registry、execution compiler 与 Cluster execution
revision 五文件移入 `src/task-definition/`；根 hard cap 从 80 下调为 71。Cluster execution revision
随编译链由 TaskDefinition owning domain 管理，而 Run、Remote Worker 与 Tool contract 仍留给后续批次。

## 验收证据（2026-08-05）

- package boundary ledger 仍为 19 个 workspace package；19 个 package 均登记
  `rootSourceFileHardCap`。审计报告中 `@qinglong/ai` 为 55 个 source file、45 个 root、10 个 nested，
  hard cap=50、`findings=[]`；负向契约证明增加第二个超限 root file 会被拒绝。
- Prompt 首批五个文件已进入 `src/prompt/`，五个既有公开 export key 不变并直接解析到
  `dist/prompt/*`；真实 `cluster-control` 消费者对五个 specifier 的解析与 exported symbol 集合均通过。
  未保留根 facade，也没有把内部整理转换为第 20 个 package。
- 迁移前 GitNexus upstream impact 将 `PluginPackagePromptExecutor` 与
  `PostgresPluginPackagePromptAdmissionRepository` 标为 HIGH：前者 4 个 direct caller、2 个执行流程，
  后者 4 个 direct caller；`LocalPluginPackagePromptAdmissionRepository`、
  `PostgresPluginPackagePromptExecutionService` 与 `preparePluginPackagePromptExecution` 为 LOW。实现变更
  因此按高风险范围执行完整验证。最终 `detect-changes` 对已跟踪基线报告 low、0 个 affected process；
  QL3 新树尚未进入 Git 基线，不能把该结果解释为覆盖未跟踪文件。
- AI 199 pass/3 条件 skip、Cluster Control 175 pass/2 条件 skip、Owner CLI 100 pass；完整 19-package
  门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster dependency、Edge import、package boundary、
  local image 四项审计均 compatible/零 finding。
- 十档 artifact 均 `compatible=true`：最小 Edge 3,519,580 bytes/324 files，最大 Standalone
  Application AI 5,930,873 bytes/475 files；非 AI 制品字节与文件数不变。嵌套路径使 AI 制品仅增加
  151 bytes，package 集合、文件数和 RSS 预算不变。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：Prompt admission/finalization 在 timeline 1 同步复制，
  timeline 2 promotion 后存活，Policy revoke fence 与 content-free 门仍为 true。`ql3-ha-*` 临时容器、
  网络、卷零残留；既有 `ql3-cnpg-evidence-control-plane` ID 不变、`running`、exit 0。

### Runtime Core Worker ratchet

- `@qinglong/runtime-core` 保持 113 个 source file，根层 113→106、`src/worker/` 0→7，hard cap 113→106；
  package 数仍为 19，未增加 facade。七个既有公开 specifier 从真实 Worker Runtime 与 Cluster Admin
  消费位置均直接解析到 `dist/worker/*`，运行时 export count 分别为 16、19、8、17、4、11、5。
- 迁移前对 134 个导出符号与 7 个文件节点逐一执行 upstream impact：111 LOW、13 MEDIUM、7 HIGH、
  10 CRITICAL。最大范围是两个 Worker credential delivery error，各 38 个 direct caller、4 条流程；
  `assertWorkerId`/`assertWorkerSessionId` 各 14 个 direct caller、跨 9 个模块。受影响流程包括文件与
  Kubernetes publish、credential issue 及 `runClusterWorkerCredentialExecution`，因此按 CRITICAL 批次验收。
- 强制刷新 GitNexus 后，七个旧路径均为 0 symbols，新路径共 254 symbols；关键 Session 校验仍保留
  14 个 incoming caller。`detect-changes` 对已跟踪 Git 基线报告 low/0 affected process，但 QL3 树尚未
  进入 Git 基线，不能用该结果替代上述新树 impact 与运行时门。
- Runtime Core 435/435、Worker Runtime 132/132、Cluster PostgreSQL 275 pass/1 条件 skip、Cluster Admin
  256 pass/2 条件 skip、Cluster Control 175 pass/2 条件 skip；完整 19-package 门退出 0，后端
  1,097 pass/2 条件 skip/0 fail。dependency、Edge import、package boundary、local image 全绿。
- 十档 artifact 均 `compatible=true`，package 集合、文件数及 RSS 上限不变；嵌套 Worker 路径让所有
  Profile 精确增加 267 bytes。最小 Edge 为 3,519,847 bytes/324 files，最大 Standalone Application AI
  为 5,931,140 bytes/475 files。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`；Worker credential delivery commit window exactly-once、
  management quota 与 identity ledger replica restart 门均为 true，timeline 1→2、旧主 fence/rewind 与
  fresh replicas 保持通过。`ql3-ha-*` 零残留，受保护控制面容器 ID 不变、`running`、exit 0。

### Runtime Core Security ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 106→102、nested 7→11，hard cap 106→102；
  `security.ts`、`projectPolicy.ts`、`securityAudit.ts`、`securityAuditQuery.ts` 共 1,040 行进入
  `src/security/`。四个公开 specifier 保持为 `security`、`project-policy`、`security-audit` 与
  `security-audit-query`，Local Admin 和 Cluster Control 均直接解析到 `dist/security/*`，export count
  为 6、18、4、4，双方 export digest 完全一致；未保留根 facade。
- 迁移前对 59 个导出符号与 4 个文件节点逐一执行 upstream impact：16 CRITICAL、19 HIGH、2 MEDIUM、
  26 LOW。`InvalidSecurityContractError` 有 38 个 direct caller/1 条流程/6 个模块，四个核心 Security
  value contract 各有 34 个 direct caller；`InvalidProjectPolicyValueError` 影响 28 个 direct caller、
  5 条流程、20 个模块，`normalizeSecurityAuditRecord` 有 19 个 direct caller。因此本批按 CRITICAL
  范围执行全量消费者、后端和真实 HA 验收，不把物理移动当成低风险改动。
- 强制刷新 GitNexus 后代码图为 42,265 nodes/96,149 edges/1,671 clusters/265 flows；
  `SecurityPrincipal` 已定位到 `src/security/security.ts` 并保留 30 个 incoming import，
  `ProjectPolicyEngine` 已定位到 `src/security/projectPolicy.ts`。旧根源码路径不存在。`detect-changes`
  对已跟踪 Git 基线仍报告 low/0 affected process，但 QL3 树尚未纳入 Git 基线，不能用该结果覆盖上述
  pre-impact 或运行时验证。
- 完整 19-package 门退出 0，Runtime Core 最终 435/435；后端 1,097 pass/2 条件 skip/0 fail，3.0/2.x
  Project Policy parity 两项均通过。cluster dependency、Edge import、package boundary、local image 四项
  审计 compatible/零 finding；package boundary 精确报告 root=102、nested=11、hard cap=102。
- 十档 artifact 均 `compatible=true`，package 集合、文件数和 loaded module 数不变；四个嵌套路径相对
  Worker 基线统一增加 504 bytes。最小 Edge 为 3,520,351 bytes/324 files、RSS delta 10,928,128 bytes，
  最大 Standalone Application AI 为 5,931,644 bytes/475 files，均低于各自 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：Automation inspection 的 Policy/Audit 同事务提交、
  promotion 前复制、无同步 standby 时 fail-closed、timeline 2 后存活均为 true；Worker delivery、quota、
  identity ledger、旧主 fence/rewind/read-only rejoin 和 fresh replicas 同时保持通过。`ql3-ha-*` 容器、
  网络、卷零残留，受保护 `ql3-cnpg-evidence-control-plane` 容器 `79b30d0c5348` 保持 running。

### Runtime Core Plugin Package Publisher Trust ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 102→98、nested 11→15，hard cap 102→98；
  `pluginPackagePublisherProvenance.ts`、`pluginPackagePublisherTrust.ts`、
  `pluginPackagePublisherRevocationProposal.ts` 与 `pluginPackagePublisherTrustTransitionProposal.ts`
  共 2,623 行进入 `src/plugin-package/publisher/`。四个公开 specifier 保持不变并分别导出
  16/16/12/14 个符号；Cluster PostgreSQL 与 Cluster Admin 两个真实消费者的解析目标、export count
  和 export digest 完全一致，未保留根 facade，也未增加 workspace package。
- 迁移前对 94 个顶层导出/文件节点逐一执行 upstream impact：6 CRITICAL、9 HIGH、72 LOW，另有
  7 个纯 type alias 在运行图中无边而为 UNKNOWN。`InvalidPluginPackagePublisherProvenanceError`
  为 CRITICAL，12 个直接影响、9 个模块、总 impacted 38；provenance conflict、trust transition
  conflict/unavailable 与 provenance unavailable 同属 CRITICAL。信任快照规范化和 keyset digest 为
  HIGH，因此本批只移动物理路径及 export target，不混入 digest、校验、错误或 proposal 语义修改。
- 强制刷新 GitNexus 后代码图为 42,269 nodes/96,152 edges/1,672 clusters/265 flows；
  `normalizePluginPackagePublisherTrustSnapshot` 已定位到新目录，仍保留 11 个 incoming caller 和
  2 条 trust transition proposal 流程；provenance error 的 Cluster PostgreSQL 调用链仍在。旧根源码
  路径不存在。`detect-changes` 对已跟踪 Git 基线仍为 low/0 affected process，但 QL3 树尚未纳入
  Git 基线，不能用该结果覆盖上述 pre-impact 或运行时验证。
- 完整 19-package 门退出 0，Runtime Core 435/435、Cluster PostgreSQL 275 pass/1 条件 skip、
  Cluster Admin 256 pass/2 条件 skip、Local Admin 83/83、Owner CLI 100/100；后端 1,097 pass/
  2 条件 skip/0 fail。cluster dependency、Edge import、package boundary、local image 四项审计
  compatible/零 finding；package boundary 精确报告 root=98、nested=15、hard cap=98。
- 十档 artifact 均 `compatible=true`，package 集合、文件数和 loaded module 数不变；四个嵌套路径
  相对 Security 基线统一增加 428 bytes。最小 Edge 为 3,520,779 bytes/324 files、RSS delta
  10,813,440 bytes，最大 Standalone Application AI 为 5,932,072 bytes/475 files、RSS delta
  20,447,232 bytes，均低于各自 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`，
  `pluginPackagePublisherTrustOverlapAndSafeRetirementSurvivePromotion=true`；publisher trust transition
  在 timeline 1 同步复制并于 timeline 2 promotion 后存活。旧主先 fence，再经 `pg_rewind` 以只读
  standby 回归，两套 fresh control replica 就绪。`ql3-ha-*` 网络、卷和临时容器零残留，受保护
  `ql3-cnpg-evidence-control-plane` 容器 `79b30d0c5348` 保持 running。

### Runtime Core Plugin Package Workflow ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 98→92、nested 15→21，hard cap 98→92；
  execution plan、administration、frontier、cancellation convergence、task-attempt admission 与 task
  recovery 六个文件共 3,172 行进入 `src/plugin-package/workflow/`。五个公开 specifier 保持不变，
  分别导出 17/4/6/3/9 个运行时符号；内部 task recovery 继续由根入口导出。Local SQLite、Cluster
  PostgreSQL、Local Admin 与 Cluster Control 四个真实消费者全部解析到嵌套 dist，export count/digest
  与迁移前逐项一致；旧根 source/dist 不存在，未增加 facade 或 workspace package。
- 迁移前对 85 个顶层导出/文件节点逐一执行 upstream impact：10 CRITICAL、9 HIGH、1 MEDIUM、
  62 LOW，另有 3 个纯 type alias 在运行图中无节点而为 UNKNOWN。
  `PluginPackageWorkflowAdmissionUnavailableError` 为 CRITICAL，12 个直接影响、2 条流程、7 个模块；
  `InvalidPluginPackageWorkflowExecutionPlanError` 总 impacted 50、8 个直接影响、3 条流程、13 个模块；
  Task Attempt admission 校验错误有 12 个直接影响、1 条流程、8 个模块。因此本批只迁移物理路径、
  相对 import 与 export target，不混入 plan digest、admission、frontier、cancellation 或 recovery 语义。
- 强制刷新 GitNexus 后代码图为 42,270 nodes/96,154 edges/1,671 clusters/265 flows；Admission
  Unavailable 仍有 9 个 incoming call、3 个 incoming import 和 2 条 Start 流，Execution Plan 校验仍有
  5 call、3 import 和 3 条流程，Task Attempt 校验仍有 9 call、3 import 和 1 条 Admit 流。旧根源码
  路径不存在。`detect-changes` 对已跟踪 Git 基线仍为 low/0 affected process，但 QL3 树尚未纳入
  Git 基线，不能用该结果覆盖上述 pre-impact 或运行时验证。
- 完整 19-package 门退出 0，Runtime Core 435/435、Cluster PostgreSQL 275 pass/1 条件 skip；后端
  1,097 pass/2 条件 skip/0 fail。Workflow 的本机/集群 admission、authorized admission、frontier、
  task attempt、cancellation、recovery 与 crash matrix 均通过。cluster dependency、Edge import、
  package boundary、local image 四项审计 compatible/零 finding；package boundary 精确报告
  root=92、nested=21、hard cap=92。
- 十档 artifact 均 `compatible=true`，package 集合、文件数和 loaded module 数不变；目录加深相对
  Publisher Trust 基线增加 560 bytes。最小 Edge 为 3,521,339 bytes/324 files、RSS delta
  10,846,208 bytes，最大 Standalone Application AI 为 5,932,632 bytes/475 files、RSS delta
  20,611,072 bytes，均低于各自 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：Workflow admission/authorized admission 原子提交、
  exact replay、revocation fence、runtime-only 与 promotion 存活均为 true；frontier terminalization、
  task-attempt admission 和 remote cancellation 的原子性、重放及 promotion 存活门也全部为 true。
  timeline 1→2、旧主 fence/rewind/read-only rejoin 与两套 fresh control replica 同时通过；`ql3-ha-*`
  网络、卷和临时容器零残留，受保护 `ql3-cnpg-evidence-control-plane` 容器 `79b30d0c5348` 保持 running。

### Runtime Core Plugin Package Installation 与 Lifecycle ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 92→84、nested 21→29，hard cap 92→84；
  installation 五文件与 lifecycle 三文件共 6,832 行分别进入 `src/plugin-package/installation/` 和
  `src/plugin-package/lifecycle/`。安装与生命周期仍是同一个 profile-neutral package 内的两个领域，
  没有新增 workspace package、dependency、根 facade、timer、listener、Pool 或部署进程。
- 八个公开 specifier 保持不变，四个真实消费者对 install/activation/installation/admission/recovery/
  lifecycle/lifecycle-plan/quarantine 的运行时 export count 仍为 38/6/2/12/3/28/9/16，导出名称摘要
  分别保持 `a52785b8794f11ac`、`4e40c7ff264afa5c`、`97cacfa3ccae6f26`、`9e459e315f4f0214`、
  `d5514fa7b55cc46e`、`e1d389744f6e4e0d`、`e4b66dea6787144c`、`f981bcb33dcda62c`。
  clean build 后旧根 source/dist 均不存在，`package.json#exports` 与 `typesVersions` 直接映射嵌套 dist。
- 迁移前对 202 个顶层导出/文件节点逐项执行 upstream impact：23 CRITICAL、17 HIGH、18 MEDIUM、
  115 LOW，另有 29 个类型别名或文件节点未被索引而为 UNKNOWN。最大风险
  `InvalidPluginPackageInstallError` 为 147 impacted/85 direct；`PluginPackageInstallUnavailableError`
  为 102 impacted/30 direct/1 条流程；`InvalidPluginPackageLockError` 为 94 impacted/19 direct/3 条流程。
  因此本批严格只迁移路径、相对 import 和 export target，不改状态机、错误、摘要、repository 或
  activation/lifecycle/quarantine 行为。
- 刷新后的 GitNexus 图为 42,273 nodes/96,157 edges/1,671 clusters/265 flows。新路径上的
  `InvalidPluginPackageInstallError` 仍为 147 impacted/85 direct，Install Unavailable 仍为
  102 impacted/30 direct/1 条 admit 流；Activation Publisher 仍影响本机 application 的 2 条流程，
  Quarantine Unavailable 仍为 34 impacted/15 direct，证明关键上游已重连到新领域路径。
- 完整 19-package 门退出 0，Runtime Core 435/435、Cluster PostgreSQL 275 pass/1 条件 skip、Cluster
  Admin 256 pass/2 条件 skip、Local Admin 83/83、Owner CLI 100/100；后端 1,097 pass/2 条件
  skip/0 fail。cluster dependency、Edge import、package boundary、local image 四项审计均
  compatible/零 finding；package boundary 精确报告 root=84、nested=29、hard cap=84。
- 十档 artifact 均 `compatible=true`，package 集合、文件数和 loaded module 数不变；相对 Workflow
  基线统一增加 1,146 bytes。最小 Edge 为 3,522,485 bytes/324 files、RSS delta 11,075,584 bytes，
  最大 Standalone Application AI 为 5,933,778 bytes/475 files、RSS delta 21,217,280 bytes，均低于
  各档 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：Plugin Package lifecycle/quarantine 在 timeline 1
  同步复制并在 timeline 2 promotion 后存活；lifecycle exact replay、四眼审批、managed plan/crash
  convergence 与 quarantine commit-response-loss、Run/Tool fence、inventory promotion 门全部为 true。
  旧主先 fence，再经 `pg_rewind` 以只读同步 standby 回归，两套 fresh control replica 就绪。
  `ql3-ha-*` 容器、网络和卷零残留；受保护的 `ql3-cnpg-evidence-control-plane` 容器
  `79b30d0c5348` 仍为 running。

### Runtime Core Local Runtime ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 84→80、nested 29→33，hard cap 84→80；
  `localDispatch.ts`、`localExecutionControl.ts`、`localCompletionReceiptJournal.ts` 与
  `localStartupRecovery.ts` 共 803 行进入 `src/local-runtime/`。`localScheduler.ts` 属于 Scheduler，
  `localSecret.ts` 属于 Secret，`taskDefinitionExecutionCompiler.ts` 属于 TaskDefinition，未因文件名
  相似而混入本批。未增加 workspace package、dependency、根 facade、timer、listener、Pool 或进程。
- `local-dispatch`、`local-execution-control`、`local-completion-receipt-journal` 与
  `local-startup-recovery` 四个公开 specifier 保持不变，运行时 export count/导出名称摘要分别为
  15/`01028683355fc1c1`、7/`cae12775351f3657`、6/`b7c211a9a0cfb749`、
  1/`df9fd2feadf4486f`。clean build 后旧根 source/dist 不存在，`exports` 与 `typesVersions` 直接指向
  `dist/local-runtime/*`。
- 迁移前对 62 个公开定义与 4 个文件节点执行 upstream impact：2 CRITICAL、5 HIGH、10 MEDIUM、
  40 LOW、9 UNKNOWN。`normalizeLocalDispatchCommand` 为 CRITICAL，11 impacted/2 direct；
  `createLocalExecutionContextRecipe` 为 CRITICAL，7 impacted/2 direct；`LocalDispatchStore` 为 HIGH，
  33 impacted/6 direct；另外三个 repository port 均为 HIGH，22 impacted/2 direct。因此本批只改
  路径、相对 import 与 export target，不改 command normalization、recipe 或 repository contract。
- 刷新后的 GitNexus 图为 42,275 nodes/96,159 edges/1,671 clusters/265 flows。四个接口均定位到新路径，
  仍由 `LocalSqliteRunRepository` 实现；Dispatch 的任务编译、Secret、Cluster execution revision 与
  Workflow task admission imports 保持连接。刷新后两个函数仍为 CRITICAL、四个接口仍为 HIGH。
  `detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告 14 files/34
  symbols/low，二者均为 0 affected process；QL3 孵化树大部分尚未纳入 Git 基线，不能把该结果解释为
  覆盖未跟踪文件。
- 完整 19-package 门退出 0，Runtime Core 435/435；后端 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；package
  boundary 精确报告 total=113、root=80、nested=33、hard cap=80。
- 十档 artifact 均 `compatible=true`，package 集合、文件数和 loaded module 数不变；相对 Installation/
  Lifecycle 基线仅增加目录路径元数据。最小 Edge 为 3,522,848 bytes/324 files、RSS delta
  10,862,592 bytes，最大 Standalone Application AI 为 5,934,141 bytes/475 files、RSS delta
  21,217,280 bytes，均低于各档 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：物理流复制保持 `remote_apply`，timeline 1→2，旧主
  fence 后经 `pg_rewind` 以只读同步 standby 回归；Workflow admission/task-attempt、scheduler 与
  Plugin Package lifecycle/quarantine promotion 门同时保持通过。`ql3-ha-*` 容器、网络和卷零残留，
  受保护 `ql3-cnpg-evidence-control-plane` 容器 `79b30d0c5348` 保持 running、exit 0。

### Runtime Core Scheduler 与 TaskDefinition ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 80→71、nested 33→42，hard cap 80→71；
  Trigger contract/administration 与 Local/Cluster Scheduler 四文件进入 `src/scheduler/`，TaskDefinition
  contract/administration、semantic registry、execution compiler 与 Cluster execution revision 五文件
  进入 `src/task-definition/`，合计 3,323 行。两个目录仍属于同一个 profile-neutral package，未新增
  workspace package、dependency、根 facade、timer、listener、Pool、migration 或进程。
- 九个公开 specifier 保持不变，运行时 export count/导出名称摘要分别为：`task-definition`
  17/`3b4bbc8dbf7249e9`、`task-definition-administration` 8/`008f15735d3a16af`、
  `task-definition-execution-compiler` 7/`f330bc9c879275f6`、`task-spec-semantic`
  10/`d24dbbbeb891c652`、`cluster-execution-revision` 7/`46e13659bfb39918`、`trigger`
  21/`3f083726c3ac4db0`、`trigger-administration` 8/`6bfee65b37e23657`、`local-scheduler`
  7/`75c772e48cb97c4d`、`cluster-scheduler` 7/`ed043187e811316a`。clean build 后旧根 source/dist
  不存在，`package.json#exports` 直接指向两个嵌套 dist 目录。
- 迁移前对 144 个公开定义与 9 个文件节点逐项执行 upstream impact：26 CRITICAL、18 HIGH、
  22 MEDIUM、80 LOW、7 UNKNOWN。`InvalidTriggerError` 为 101 impacted/26 direct/1 flow/20 modules，
  `TriggerUnavailableError` 为 87 impacted/24 direct，`TriggerSpecSemanticRegistry` 为 65 impacted/
  18 direct/1 flow；`InvalidTaskDefinitionError` 为 61 impacted/22 direct/1 flow，
  `TaskSpecSemanticRegistry` 为 38 impacted/19 direct。因此本批只改物理路径、相对 import、测试夹具
  与 export target，不改 Trigger/TaskDefinition digest、semantic registry、schedule decision 或
  repository contract。
- 首次 clean 单包门准确发现三个共享 contract fixture 与 HA runner 的五处旧 `dist` 直达路径；这些
  路径全部改为新物理位置，没有增加兼容 facade。随后 Runtime Core 恢复 435/435，证明旧根 dist
  不参与通过条件。
- 刷新后的 GitNexus 图为 42,280 nodes/96,162 edges/1,673 clusters/265 flows。
  `InvalidTriggerError` 仍为 CRITICAL/101 impacted/26 direct/1 flow，Trigger repository 仍同时由
  `LocalSqliteTriggerRepository` 与 `PostgresTriggerRepository` 实现；TaskDefinition error/semantic
  registry、Local schedule store 和 Cluster schedule store 均定位到新路径并保留原 adapter 实现。
  `detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告 14 files/34
  symbols/low，均为 0 affected process；QL3 孵化树多数尚未进入 Git 基线，不能用该结果替代上述
  pre-impact、context 或运行门。
- 完整 19-package 门退出 0，Runtime Core 435/435、Cluster PostgreSQL 275 pass/1 条件 skip、Cluster
  Admin 256 pass/2 条件 skip、Local Admin 83/83、Owner CLI 100/100；后端 1,097 pass/2 条件
  skip/0 fail。cluster dependency、Edge import、package boundary、local image 四项审计均 compatible/
  零 finding；package boundary 精确报告 total=113、root=71、nested=42、hard cap=71。
- 十档 artifact 均 `compatible=true`，package 集合、文件数和 loaded module 数不变；相对 Local Runtime
  基线统一增加 562 bytes。最小 Edge 为 3,523,410 bytes/324 files、RSS delta 10,797,056 bytes，
  最大 Standalone Application AI 为 5,934,703 bytes/475 files、RSS delta 21,118,976 bytes，均低于
  各档 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline 1→2，
  Scheduler claim 在 promotion 前复制、过期后接管且 occurrence exactly-once，COMMIT response loss
  exactly-once 收敛；Task/Trigger management inspection 在无同步 standby 时 fail-closed 并在 promotion
  后存活，Workflow 与 Plugin Package 门同时通过。旧主 fence 后经 `pg_rewind` 以只读同步 standby
  回归；`ql3-ha-*` 容器、网络和卷零残留，受保护容器 `79b30d0c5348` 保持 running、exit 0。

### Runtime Core Run ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 71→62、nested 42→51，hard cap 71→62；
  Run aggregate、StepRun、repository port/contract、retry policy、dispatch lease、lost retry 与 Cluster
  cancellation/convergence 九文件共 2,934 行进入 `src/run/`。Remote activation、Tool completion 和通用
  repository error 仍由各自领域拥有；未新增 workspace package、dependency、根 facade、timer、listener、
  Pool、migration 或进程。仅 5 行的 `runRepositoryContract.ts` 是稳定公开聚合入口，不因文件小被删除，
  但也不留在根目录。
- 根入口和五个公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、`run-repository` 32/`1df31a110aa5e908`、`step-run`
  23/`22040361a3951ac2`、`cluster-run-cancellation` 11/`45e95ccfef4ae028`、
  `cluster-run-cancellation-convergence` 6/`3cb60a22813a5d8b`、`run-dispatch-lease`
  12/`ab15b9809bbe3733`。clean build 后九个旧根 source/dist 路径均不存在，`exports` 与
  `typesVersions` 直接映射 `dist/run/*`。
- 迁移前对 142 个公开定义/文件节点逐项执行 upstream impact：10 CRITICAL、10 HIGH、23 MEDIUM、
  81 LOW、18 UNKNOWN。`InvalidStepRunError` 为 67 impacted/16 direct，
  `StepRunRepositoryUnavailableError` 为 47 impacted/27 direct/1 flow，`assertRunDispatchId` 为
  38 impacted/14 direct，三个 Run 持久化 record 各为 27 impacted/17 direct。因此本批只改物理路径、
  相对 import、测试夹具和 export target，不改 Run/StepRun 状态机、digest、repository、retry、lease、
  lost recovery 或 cancellation 语义。
- clean 单包门先后发现十个测试模块的旧 `dist` 直达路径和一个源码权限审计的旧 `src` 路径，HA 的两个
  fixture 也已直接改到嵌套 dist；没有用根 facade 掩盖遗漏。随后 Runtime Core 435/435，完整 19-package
  门退出 0，Worker 在可监听 loopback 的外部环境为 132/132；后端在同环境为 1,097 pass/2 条件 skip/
  0 fail。cluster dependency、Edge import、package boundary、local image 四项审计均 compatible/零
  finding；package boundary 精确报告 total=113、root=62、nested=51、hard cap=62。
- 十档 artifact 均 `compatible=true`，package 集合、文件数和 loaded module 数未增加；相对 Scheduler/
  TaskDefinition 基线仅统一增加 188 bytes 的嵌套路径元数据。最小 Edge 为 3,523,598 bytes/324 files、
  RSS delta 7,700,480 bytes，最大 Standalone Application AI 为 5,934,891 bytes/475 files、RSS delta
  21,200,896 bytes，均低于 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline 1→2，Run
  cancellation 的 commit windows、Scheduler claim takeover/occurrence exactly-once 与
  commit-response-loss exactly-once 均通过；旧主 fence 后由 `pg_rewind` 以只读同步 standby 回归。
  `ql3-ha-*` 临时资源零残留，受保护容器 `79b30d0c5348` 保持 running、exit 0。
- 刷新后的 GitNexus 图为 42,280 nodes/96,164 edges/1,671 clusters/265 flows。
  `InvalidStepRunError` 仍为 CRITICAL/67 impacted/16 direct，`assertRunDispatchId` 仍为
  CRITICAL/38 impacted/14 direct，RunRecord 仍为 HIGH/27 impacted/17 direct；PostgreSQL/SQLite
  StepRun repository、Workflow、Remote Worker 和 cancellation convergence 上游均已重连到新路径。
  `detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告 14 files/34
  symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用该结果替代迁移前
  impact/context 和上述运行门。

### Runtime Core Remote Execution ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 62→54、nested 51→59，hard cap 62→54；
  Remote Dispatch、Offer Delivery、Run Activation、Activation Delivery、Secret Delivery、Worker
  Completion、Lease Control 与 Placement 八文件共 3,130 行进入 `src/remote-execution/`。该目录拥有
  Cluster↔Worker 的协议值对象、验证、投递与 fencing contract；Tool Completion、Cluster recovery 和
  PostgreSQL adapter 不迁入，避免把应用编排、持久化实现与协议核心揉成一个目录。未新增 workspace
  package、dependency、根 facade、timer、listener、Pool、migration 或进程。
- 根入口和七个公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、`remote-dispatch` 19/`f299a0aec08e2b4d`、`remote-offer-delivery`
  6/`502bd91dcd9cc388`、`remote-activation` 6/`f828407f94dc2bd0`、
  `remote-activation-delivery` 5/`79de61c4072a47b1`、`remote-secret-delivery`
  14/`32dcfa9502f8041f`、`remote-worker-completion` 24/`70d2666f854f35f7`、
  `remote-worker-lease-control` 15/`d35eda700fcd6c9d`。clean build 后八个旧根 source/dist 路径均
  不存在，`exports` 与 `typesVersions` 直接映射 `dist/remote-execution/*`。
- 迁移前对 151 个公开定义/文件节点逐项执行 upstream impact：7 HIGH、1 MEDIUM、125 LOW、
  18 UNKNOWN。`InvalidRemoteWorkerCompletionError` 为 29 impacted/8 direct/1 flow，
  `InvalidRemoteWorkerSecretDeliveryError` 与 `InvalidRemoteWorkerLeaseControlError` 均为 15 impacted，
  `RemoteWorkerCompletionFenceRejectedError` 为 13 impacted/2 direct/1 flow，
  `effectiveRemoteWorkerPlacement` 为 7 impacted/3 direct。因此本批只改物理路径、相对 import、测试
  夹具和 export target，不改 dispatch/offer/activation/secret/completion/lease/placement 协议或 fence。
- Runtime Core 435/435，完整 19-package 门退出 0；后端为 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；package
  boundary 精确报告 total=113、root=54、nested=59、hard cap=54。
- 十档 artifact 均 `compatible=true`，package 集合、文件数和 loaded module 数未增加；相对 Run 基线
  仅增加嵌套路径元数据。最小 Edge 为 3,524,176 bytes/324 files/42 loaded modules、RSS delta
  7,716,864 bytes，最大 Standalone Application AI 为 5,935,469 bytes/475 files/97 loaded modules、
  RSS delta 21,217,280 bytes，均低于 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline 1→2，
  Remote Worker completion、credential delivery、run cancellation 的 commit windows，Scheduler claim
  takeover/occurrence 与 commit-response-loss exactly-once 均通过；旧主 fence 后由 `pg_rewind` 以只读
  同步 standby 回归。`ql3-ha-*` 临时资源零残留，受保护容器 `79b30d0c5348` 保持 running、exit 0。
- 刷新后的 GitNexus 图为 42,282 nodes/96,166 edges/1,671 clusters/265 flows。新路径上的
  `RemoteWorkerCompletionFenceRejectedError` 仍为 HIGH/13 impacted/2 direct/1 flow，
  `effectiveRemoteWorkerPlacement` 仍为 HIGH/7 impacted/3 direct；Completion 已重连 Cluster Control 与
  Cluster PostgreSQL，Placement 已重连 TaskDefinition、Worker 与 Workflow。`detect-changes` 对已跟踪
  基线报告 12 files/31 symbols/low，compare `develop` 报告 14 files/34 symbols/low，均为 0 affected
  process；QL3 孵化树大部分尚未进入 Git 基线，不能用该结果替代 pre-impact/context 和上述运行门。

### Runtime Core Tool Execution ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 54→40、nested 59→73，hard cap 54→40；
  Project Tool Definition Snapshot、Tool Registry、Invocation Artifact、Trusted Invocation/Execution/
  Completion、Start Barrier、Evidence、Success/Failure Completion、Result Key Catalog/Rekey 与内置
  Run Read Tool 十四文件共 11,235 行进入 `src/tool-execution/`。该目录拥有从 immutable Tool
  definition/snapshot 到 admission、start、execute、evidence、completion 与 encrypted result lifecycle
  的完整领域协议；SQLite/PostgreSQL repository、Prompt composition、Plugin Package materializer 与
  process adapter 仍保留在各自 package/领域。未新增 workspace package、dependency、根 facade、timer、
  listener、Pool、migration 或进程。
- 根入口与十四个公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、`project-tool-definition-snapshot` 21/`8a1241b67d6f77c2`、
  `tool-registry` 22/`2354a4c6d15a78d6`、`tool-invocation-artifact`
  21/`db454559a8e37dc6`、`trusted-tool-invocation` 29/`f5bafd441ddcc3f2`、
  `tool-execution-evidence` 17/`6c36643ff9f2eba4`、`tool-execution-start-barrier`
  11/`34a1371bde8f96fb`、`trusted-tool-execution` 11/`ffcbcca10b524718`、
  `tool-execution-completion` 20/`c40001a9e98ae802`、`trusted-tool-success-completion`
  1/`7f68509ed1448ac8`、`trusted-tool-completion` 1/`75bc4999f472629f`、
  `tool-execution-failure-completion` 15/`9b0eff249add24f9`、`tool-result-key-catalog`
  23/`bafc6f2da9c216dd`、`tool-result-rekey` 18/`f4c52aff99af838d`、
  `builtin-run-read-tool` 10/`5c8d9beb623180f9`。clean build 后十四个旧根 source/dist 路径均
  不存在，`exports` 与 `typesVersions` 直接映射 `dist/tool-execution/*`。
- 迁移前对 251 个顶层公开定义/文件节点逐项执行 upstream impact：31 CRITICAL、30 HIGH、
  31 MEDIUM、159 LOW、0 UNKNOWN。`InvalidProjectToolDefinitionSnapshotError` 为
  65 impacted/5 direct/11 modules，`InvalidToolInvocationArtifactError` 为
  54 impacted/10 direct/1 flow，`InvalidToolExecutionStartBarrierError` 为 43 impacted/11 direct，
  `ToolDefinitionRegistry` 为 37 impacted/15 direct/1 flow，
  `ToolExecutionCompletionUnavailableError` 为 36 impacted/8 direct/1 flow，
  `trustedToolContractIdentityDigest` 为 30 impacted/6 direct/1 flow。因此本批只改物理路径、相对
  import、测试夹具和 export target，不改 Tool schema、digest、Policy fence、start barrier、encryption、
  result-key lifecycle、completion/recovery 或 repository 语义。
- clean 单包门发现五个源码权限断言仍读取旧 `src` 路径，逐个 test-file impact 均为 LOW/0 upstream/
  0 flow 后直接改到嵌套路径；没有用根 facade 掩盖遗漏。随后 Runtime Core 435/435、完整 19-package
  门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster dependency、Edge import、package boundary、
  local image 四项审计均 compatible/零 finding；package boundary 精确报告
  total=113、root=40、nested=73、hard cap=40。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；相对 Remote
  Execution 基线仅统一增加 950 bytes 的嵌套路径元数据。最小 Edge 为
  3,525,126 bytes/324 files/42 loaded modules、RSS delta 7,716,864 bytes，最大 Standalone
  Application AI 为 5,936,419 bytes/475 files/97 loaded modules、RSS delta 21,250,048 bytes，
  均低于 byte/file/RSS 门。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline 1→2，
  Project Tool snapshot、Invocation Artifact、非空 Result rekey、catalog rotation、completion/rekey
  COMMIT response loss 与 promotion 后 unified reopen 全部通过；旧主 fence 后由 `pg_rewind` 以只读
  同步 standby 回归。`ql3-ha-*` 临时资源零残留，受保护容器 `79b30d0c5348` 保持 running、exit 0。
- 刷新后的 GitNexus 图为 42,285 nodes/96,168 edges/1,672 clusters/265 flows。新路径上的
  `InvalidProjectToolDefinitionSnapshotError` 仍为 CRITICAL/65 impacted/5 direct，
  `InvalidToolInvocationArtifactError` 仍为 CRITICAL/54 impacted/10 direct/1 flow，
  `ToolDefinitionRegistry` 仍为 HIGH/37 impacted/15 direct/1 flow；Snapshot 已重连 SQLite/
  PostgreSQL，Artifact/Registry/Completion/Rekey 已重连 Prompt、Plugin Package 与 trusted execution。
  `detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告
  14 files/34 symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用该
  结果替代迁移前 impact/context 和上述运行门。

### Runtime Core Plugin Package Core ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 40→30、nested 73→83，hard cap 40→30；
  Plugin Package 核心 manifest/planning、Approved Action handler、bundle inspection、management/
  proposal、resource generation/materialization、Task reconciliation/publication 与 Automation
  publication 十文件共 7,502 行进入既有 `src/plugin-package/`。它们与已经归位的 installation、
  lifecycle、publisher、workflow 同属一个 Plugin Package bounded context，但仍以子目录表达子域
  ownership；没有为了整理目录新增 workspace package、单文件目录、兼容 facade、dependency、进程、
  timer、listener、Pool 或 migration。
- 根入口与十个公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、Plugin Package core 18/`6616d739da7640cd`、resource generation
  10/`a48fef1cc192af06`、resource materialization 21/`4aa4a4090a26f971`、Task reconciliation
  9/`659c923de2677e9c`、Task publication 9/`038764bba73744bf`、Automation publication
  21/`a0f1fe963dd76e1e`、bundle 19/`8dab467c940dc694`、Approved Action
  1/`504da7ceda7d57ff`、proposal 10/`30cdd69842040618`、management
  8/`b1849edbbd3707da`。clean build 后十个旧根 source/dist 路径均不存在，`exports` 与
  `typesVersions` 直接映射 `dist/plugin-package/*`。
- 迁移前对 172 个顶层公开定义/文件节点逐项执行 upstream impact：23 CRITICAL、21 HIGH、
  32 MEDIUM、96 LOW、0 UNKNOWN。`InvalidPluginPackageResourceMaterializationError` 为
  70 impacted/8 direct/1 flow，`InvalidPluginPackageManifestError` 为 65/19/3 flows，
  `InvalidPluginPackageAutomationPublicationError` 为 62/7/1 flow，
  `normalizePluginPackageResourceReferences` 为 49/4/2 flows，
  `PluginPackagePublisherTrustRegistry` 为 37/9/3 flows。因此本批只改物理路径、相对 import、测试
  夹具和 export target，不改 manifest/digest、resource generation/materialization、proposal/approval、
  publication generation、publisher trust、Task/Automation reconciliation 或 repository 语义。
- clean 单包门发现一个源码权限断言仍读取旧 `src/pluginPackage.ts`，其 test-file impact 为 LOW、
  无执行流，直接改到嵌套路径；没有用根 facade 掩盖遗漏。随后 Runtime Core 435/435、完整
  19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster dependency、Edge import、
  package boundary、local image 四项审计均 compatible/零 finding；package boundary 精确报告
  total=113、root=30、nested=83、hard cap=30。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；最小 Edge 为
  3,525,714 bytes/324 files/42 loaded modules，Standalone 为 3,525,762，Edge/Standalone Adopted 为
  4,119,688/4,119,772，Edge/Standalone Application 为 4,606,595/4,606,739，Edge/Standalone AI 为
  4,855,898/4,855,958，Edge/Standalone Application AI 为 5,936,851/5,937,007 bytes；所有 byte/file/
  RSS 门均通过。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline 1→2，
  Plugin Package lifecycle/publication/workflow/quarantine、publisher security fence、commit-response-loss
  与 promotion 后恢复均通过；旧主 fence 后由 `pg_rewind` 以只读同步 standby 回归。`ql3-ha-*` 临时
  资源零残留，受保护容器 `79b30d0c5348` 保持 running、exit 0。
- 第一次 GitNexus 增量写入中断后，分析器按其恢复协议强制完整重建并成功产出
  42,285 nodes/96,169 edges/1,671 clusters/265 flows。新路径上的
  `InvalidPluginPackageAutomationPublicationError`、`PluginPackagePublisherTrustRegistry` 与
  `PluginPackageInstallProposalUnavailableError` 仍为 CRITICAL，分别连接 Workflow、本地管理与
  PostgreSQL admission 流；`detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare
  `develop` 报告 14 files/34 symbols/low，均为 0 affected process。QL3 孵化树大部分尚未进入 Git
  基线，不能用该结果替代迁移前 impact/context 和全部运行门。

### Runtime Core Approved Action ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 30→27、nested 83→86，hard cap 30→27；
  Approval Request/Decision/Consumption、durable Approved Action Execution 与 Dispatcher 三文件共
  2,631 行进入 `src/approved-action/`。三者共同拥有 request→decision→consumption→lease/start/
  execute→complete/recovery 协议；Plugin Package、Tool Execution、Cluster Worker management 与
  SQLite/PostgreSQL repository 仍是消费者/adapter，不被并入该目录。没有新增 workspace package、
  dependency、根 facade、timer、listener、Pool、migration 或进程。
- 根入口与三个公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、`approved-action` 28/`9596b24a77c13d4c`、
  `approved-action-execution` 24/`8ac51ecd2bf30a2d`、`approved-action-dispatcher`
  1/`9f5417dbaccfeb78`。clean build 后三个旧根 source/dist 路径均不存在，`exports` 与
  `typesVersions` 直接映射 `dist/approved-action/*`。
- 迁移前对 95 个公开定义/文件节点逐项执行 upstream impact：7 CRITICAL、4 HIGH、26 MEDIUM、
  49 LOW、9 个纯类型 UNKNOWN。`InvalidApprovedActionValueError` 为
  61 impacted/20 direct/4 flows/6 modules，`ApprovedActionExecutionUnavailableError` 为
  37/11/3 flows/12 modules，`normalizeApprovedActionFence` 为 33/10/4 flows，
  `ApprovedActionExecutionRepository` 为 13/6/1 flow。因此本批只改物理路径、相对 import、测试
  夹具和 export target，不改 Approval schema/digest、human confirmation/separation of duty、Policy
  fence、lease/retry/start barrier、completion/recovery 或 repository 语义。
- clean 单包门发现两份 Tool Execution 测试仍直接读取旧 `dist/approvedAction`；两个 test-file
  impact 均为 LOW/0 upstream/0 flow，直接改到嵌套路径，没有用根 facade 掩盖遗漏。随后 Runtime
  Core 435/435、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster dependency、
  Edge import、package boundary、local image 四项审计均 compatible/零 finding；package boundary
  精确报告 total=113、root=27、nested=86、hard cap=27。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,526,052/3,526,100 bytes，Edge/Standalone Adopted 为
  4,120,026/4,120,110，Edge/Standalone Application 为 4,606,933/4,607,077，Edge/Standalone AI 为
  4,856,236/4,856,296，Edge/Standalone Application AI 为 5,937,189/5,937,345 bytes；所有 byte/
  file/RSS 门均通过。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline 1→2，
  Plugin Package lifecycle/management 与 Worker credential management 的 Approved Action
  consumption/execution、commit-response-loss 与 promotion 后恢复均通过；旧主 fence 后由
  `pg_rewind` 以只读同步 standby 回归。`ql3-ha-*` 临时资源零残留，受保护容器
  `79b30d0c5348` 保持 running、exit 0。
- 刷新后的 GitNexus 图为 42,287 nodes/96,171 edges/1,671 clusters/265 flows。新路径上的
  `InvalidApprovedActionValueError` 与 `normalizeApprovedActionFence` 仍为 CRITICAL/61/33 impacted，
  `ApprovedActionExecutionUnavailableError` 为 CRITICAL/36 impacted/11 direct/3 flows，Execution
  repository 仍连接 Cluster Worker credential 执行流。`detect-changes` 对已跟踪基线报告
  12 files/31 symbols/low，compare `develop` 报告 14 files/34 symbols/low，均为 0 affected process；
  QL3 孵化树大部分尚未进入 Git 基线，不能用该结果替代 pre-impact/context 和全部运行门。

### Runtime Core Cluster Control recovery ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 27→21、nested 86→92，hard cap 27→21；
  Cluster Control activation、bounded recovery source/convergence、evidence registry、evidence-based
  processor、claim supervisor 与 startup coordinator 六文件共 1,549 行进入
  `src/cluster-control/`。六者共同拥有 readiness→bounded discovery→claim/evidence→disposition→
  convergence→admission 启动闭环；PostgreSQL source/repository、Cluster process composition 与 Tool
  Execution 仍是 adapter/消费者。没有为六个内部模块新增公开 subpath、workspace package、dependency、
  根 facade、timer、listener、Pool、migration 或进程。
- 稳定根入口与六个模块导出保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、Activation 1/`6c9d86055d5f1ed9`、Recovery
  2/`6834ed7f9d87b1a9`、Evidence Registry 4/`5dd47aa0fe151459`、Processor
  5/`d34862257fcca4ad`、Supervisor 5/`039984c663fa0639`、Startup Coordinator
  2/`4eea3a9e805d8efe`。clean build 后六个旧根 source/dist 路径均不存在，根 `index` 直接指向
  `cluster-control/*`，不增加兼容 facade。
- 迁移前对 59 个公开定义/文件节点逐项执行 upstream impact：1 HIGH、8 MEDIUM、38 LOW、12 个
  纯类型 UNKNOWN。`ClusterControlRecoveryStoreError` 为 8 impacted/5 direct/4 modules，Activation
  的 readiness/stack/options 六个定义各为 15/8，`InvalidClusterControlRecoveryTransitionError`
  为 7/7。因此本批只改物理路径、根 re-export 与四个 Tool Execution Profile type import，不改
  readiness、bounded page/pass、claim lease、evidence timeout/identity、retry/manual disposition、
  convergence、activation ordering 或 fail-closed 语义。
- Runtime Core 435/435、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；package
  boundary 精确报告 total=113、root=21、nested=92、hard cap=21。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,526,148/3,526,196 bytes，Edge/Standalone Adopted 为
  4,120,122/4,120,206，Edge/Standalone Application 为 4,607,029/4,607,173，Edge/Standalone AI 为
  4,856,332/4,856,392，Edge/Standalone Application AI 为 5,937,285/5,937,441 bytes；所有 byte/
  file/RSS 门均通过。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：两个旧 control activation 在故障后均
  unavailable，fresh generation 两副本 ready，物理流复制保持 `remote_apply`、timeline 1→2，旧主
  在 promotion 前 fence 并由 `pg_rewind` 以只读同步 standby 回归。`ql3-ha-*` 临时资源零残留，
  受保护容器 `79b30d0c5348` 保持 running、exit 0。
- 刷新后的 GitNexus 图为 42,289 nodes/96,173 edges/1,671 clusters/265 flows。新路径上的
  `ClusterControlRecoveryStoreError` 仍为 HIGH/8 impacted/5 direct/4 modules，Activation readiness
  仍为 MEDIUM/15/8，Recovery transition 仍为 MEDIUM/7/7，Evidence Registry/Supervisor 均重连
  Cluster Control process。`detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare
  `develop` 报告 14 files/34 symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git
  基线，不能用该结果替代 pre-impact/context 和全部运行门。

### Runtime Core Local Owner credential/pepper ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 21→16、nested 92→97，hard cap 21→16；
  Local Owner bootstrap、credential recovery、delivery acknowledgement GC、Pepper catalog 与 Pepper
  material GC 五文件共 2,236 行进入 `src/local-owner/`。这是首 Owner 凭据与 Pepper 生命周期的单一
  安全领域；更广的 Identity credential administration 继续留在其原 owner。没有新增 workspace
  package、dependency、根 facade、timer、listener、Pool、migration 或进程。
- 根入口和五个稳定公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、`local-owner-bootstrap` 27/`b08ff625cb7f467d`、
  `local-owner-pepper` 9/`80a1d5df06f2b309`、`local-owner-credential-recovery`
  9/`d1a22dcd2fa037fc`、`local-owner-delivery-acknowledgement-gc`
  10/`4e3e314725debf9d`、`local-owner-pepper-material-gc` 13/`a5210811380412d8`。clean build 后
  五个旧根 source/dist 路径均不存在，`package.json#exports` 直接映射 `dist/local-owner/*`；根入口只
  继续聚合原先已经聚合的三个模块，没有扩大 public surface。
- 迁移前对 116 个公开定义/文件节点逐项执行 upstream impact：2 CRITICAL、14 HIGH、8 MEDIUM、
  88 LOW、4 个纯类型 UNKNOWN。`InvalidLocalOwnerBootstrapValueError` 为
  39 impacted/20 direct/2 flows，`LocalOwnerCredentialRecoveryRepositoryUnavailableError` 为
  20/10/1 flow，`LocalOwnerBootstrapUnavailableError` 为 38/21/2 flows，
  `LocalOwnerPepperReferenceRepository` 为 18/1，Pepper material GC unavailable error 为
  15/9/1 flow。因此本批只改物理路径、相对 import、四份测试夹具和 export target，不改 pristine
  fence、challenge/token digest、delivery acknowledgement、credential rotation、Pepper retention/
  reference/destruction 或 fail-closed 状态机。
- Runtime Core 435/435、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；package
  boundary 精确报告 total=113、root=16、nested=97、hard cap=16、source lines=54,015。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,526,376/3,526,424 bytes，Edge/Standalone Adopted 为
  4,120,350/4,120,434，Edge/Standalone Application 为 4,607,257/4,607,401，Edge/Standalone AI 为
  4,856,560/4,856,620，Edge/Standalone Application AI 为 5,937,513/5,937,669 bytes。相对前一批每档
  只增加 228 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline 1→2，
  promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control replica
  ready；所有临时 HA 容器清理完成，受保护容器 `79b30d0c5348` 保持 running。
- 刷新后的 GitNexus 图为 42,291 nodes/96,175 edges/1,671 clusters/265 flows。新路径上的 bootstrap
  value/repository unavailable、credential recovery unavailable、Pepper reference 与 Pepper GC
  unavailable 代表符号仍为 HIGH，并分别连接 Owner Console bootstrap/recovery、SQLite reference 与
  maintenance collect 流。`detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare
  `develop` 报告 14 files/34 symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git
  基线，不能用该结果替代 pre-impact/context 和全部运行门。

### Runtime Core Security identity/credential/policy/audit ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 16→8、nested 97→105，hard cap 16→8；
  API credential、API credential administration/token、Identity administration、Local Identity
  credential administration、Local Project Policy administration 与 Local security audit query/
  retention 八文件共 1,448 行进入既有 `src/security/`，该目录由 4→12 文件。它们共同拥有认证
  主体、credential、Policy fence 与 security audit 生命周期；没有新增 workspace package、
  dependency、根 facade、子目录、timer、listener、Pool、migration 或进程。剩余八个根文件仅为
  `index`、Local Secret 或跨域基础设施 primitive，不按“清空根目录”目标强行混入 Security。
- 根入口和八个稳定公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、API credential 9/`94db89e551dad331`、API credential administration
  9/`f8006d742eccf577`、API credential token 7/`73e3205bca9cf714`、Identity administration
  10/`5b65b3ad7c0755ff`、Local Identity credential administration
  5/`db55a413aac47d27`、Local Project Policy administration 10/`cf2b11a30cf65fba`、Local security
  audit query 3/`183b56ba96aee095`、retention 10/`56b783a78adc13d0`。clean build 后八个旧根
  source/dist 路径均不存在，`package.json#exports` 直接映射 `dist/security/*`，没有兼容 facade。
- 迁移前对 131 个公开定义逐项执行 upstream impact：11 CRITICAL、5 HIGH、4 MEDIUM、100 LOW、
  11 个纯类型 UNKNOWN。`ApiCredentialUnavailableError` 与
  `LocalIdentityCredentialAdministrationUnavailableError` 均为 30 impacted/16 direct/1 flow，
  `ApiCredentialRepository` 为 28/10，`IdentityAdministrationUnavailableError` 为 19/7，
  `LocalProjectPolicyAuthorizationFenceConflictError` 为 15/2。因此本批只改物理路径、相对 import、
  根 re-export 与八个公开 export target，不改 credential digest/token、Identity state、Project/
  RoleBinding fence、audit retention、authorization transaction 或 fail-closed 语义。
- Runtime Core 435/435、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；package
  boundary 精确报告 total=113、root=8、nested=105、hard cap=8、source lines=54,015。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,526,637/3,526,685 bytes，Edge/Standalone Adopted 为
  4,120,611/4,120,695，Edge/Standalone Application 为 4,607,518/4,607,662，Edge/Standalone AI 为
  4,856,821/4,856,881，Edge/Standalone Application AI 为 5,937,774/5,937,930 bytes。相对前一批
  每档只增加 261 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；域级 quota、identity ledger、audit、Policy、Approved Action、workflow、Prompt 与
  commit-response-loss exactly-once 门均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 刷新后的 GitNexus 图为 42,294 nodes/96,176 edges/1,673 clusters/265 flows。新路径上的
  `ApiCredentialUnavailableError` 与 Local Identity credential unavailable 仍为 CRITICAL/
  30 impacted/16 direct/1 flow，API credential repository 为 CRITICAL/28/10，Project Policy
  authorization fence conflict 为 CRITICAL/15/2，Identity administration unavailable 为
  HIGH/19/7；所有代表符号均已重连到 `src/security/*`。`detect-changes` 对已跟踪基线报告
  12 files/31 symbols/low，compare `develop` 报告 14 files/34 symbols/low，均为 0 affected process；
  QL3 孵化树大部分尚未进入 Git 基线，不能用该结果替代 pre-impact/context 和全部运行门。

### Runtime Core Secret Reference/Local Secret ratchet

- `@qinglong/runtime-core` 仍为 113 个 source file，根层 8→5、nested 105→108，hard cap 8→5；
  profile-neutral Secret Reference、Local Secret envelope/key contract 与 Local Secret administration
  三文件共 500 行进入新建的 `src/secret/`。三者形成引用编码→加密信封/密钥材料→Policy-fenced
  administration 的完整领域，不是按单文件建目录；没有新增 workspace package、dependency、根
  facade、timer、listener、Pool、migration 或进程。剩余根文件仅为 `index`、migration stream、
  pinned SemVer、PostgreSQL port 与 repository error primitive，继续保留各自基础 owner。
- 根入口和三个稳定公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  551/`1f9335f27d1212b2`、`secret-reference` 7/`4aad592351d4b22a`、`local-secret`
  24/`fd4d36e021ac4d60`、`local-secret-administration` 1/`91498602c7b13930`。clean build 后三个
  旧根 source/dist 路径均不存在，`package.json#exports` 直接映射 `dist/secret/*`，没有兼容 facade。
- 迁移前以精确符号 UID 对 47 个公开定义逐项执行 upstream impact：1 CRITICAL、5 HIGH、1 MEDIUM、
  38 LOW、2 个纯类型 UNKNOWN。`parseSecretRef` 为 13 impacted/4 direct/5 modules，
  `InvalidSecretReferenceError` 为 38/9，`InvalidLocalSecretError` 为 23/13，
  `LocalSecretAdministrationRepository` 为 22/2，authorization fence conflict 为 4/2/1 flow。
  因此本批只改物理路径、相对 import、根 re-export、三个公开 export target 与八份直接测试/HA
  夹具，不改 `qlsecret:v1` canonical encoding、Project scope、AES-256-GCM envelope/AAD、key material
  wipe、Policy fence、原子 audit、semantic replay 或 fail-closed 语义。
- Runtime Core 435/435、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。首次受限
  沙箱运行的 Worker/Vault loopback tests 因 `listen EPERM 127.0.0.1` 失败，在授权环境重跑后全部
  通过。cluster dependency、Edge import、package boundary、local image 四项审计均 compatible/零
  finding；package boundary 精确报告 total=113、root=5、nested=108、hard cap=5、source
  lines=54,015。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,526,742/3,526,790 bytes，Edge/Standalone Adopted 为
  4,120,716/4,120,800，Edge/Standalone Application 为 4,607,623/4,607,767，Edge/Standalone AI 为
  4,856,926/4,856,986，Edge/Standalone Application AI 为 5,937,879/5,938,035 bytes。相对前一批
  每档只增加 105 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；Worker credential delivery、Provider credential、Prompt、Policy 与 commit-response-loss
  exactly-once 门均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 刷新后的 GitNexus 图为 42,297 nodes/96,169 edges/1,675 clusters/264 flows。新路径上的
  `parseSecretRef` 仍为 CRITICAL/13 impacted/4 direct/5 modules，reference error 为 HIGH/38/9，
  administration repository 为 HIGH/22/2，authorization fence conflict 为 HIGH/4/2/1 flow；新
  Secret module 仍连接 Task Definition、Remote Execution、Local Admin/SQLite、Worker 与 AI consumer。
  `detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告
  14 files/34 symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用该
  结果替代 pre-impact/context 和全部运行门。

### Local SQLite Tool Execution ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file，根层 63→55、nested 85→93，hard cap 63→55；
  Project Tool Definition snapshot、Tool invocation Artifact、execution evidence、start barrier、成功/
  失败 completion、result key catalog 与 result rekey 八个 repository 共 4,357 行进入
  `src/tool-execution/`。它们共同拥有 Tool 执行前快照和准入、结果封装/完成及密钥轮换的 SQLite
  持久化边界，不是按单文件建目录；Run/StepRun 等通用 owner 保持原位。没有新增 workspace
  package、dependency、根 facade、timer、listener、Pool、migration 或进程，runtime 继续惰性装配。
- 根入口和八个稳定公开子路径保持不变，运行时 export count/导出名称摘要分别为：root
  15/`f1884fabfa37efd5`、Project Tool snapshot 1/`c94c368a286d8092`、execution evidence
  1/`30e0581abff1648a`、start barrier 1/`3b741234a0cb4a82`、completion
  1/`aa63d02dfc1c569d`、failure completion 1/`c81c4a03118ec77f`、result key catalog
  1/`d56db864f7f3e776`、result rekey 1/`ee0ea2c16dfa777a`、invocation Artifact
  1/`6c7fd35fcf325e57`。clean build 后八个旧根 source/dist 路径均不存在，公开 exports 直接映射
  `dist/tool-execution/*`，没有兼容 facade。
- 迁移前对八个公开 repository class 使用精确 UID 执行 upstream impact，全部为 LOW、0 条执行流程：
  snapshot 为 26 impacted/3 direct，invocation Artifact 为 25/3，completion、failure completion、
  start barrier、result key catalog 与 rekey 均为 25/2，evidence 为 0/0。因此本批只改物理路径、
  相对 import、runtime lazy import、公开 export target 与直接测试/HA fixture，不改 SQL、事务、
  Artifact/AAD、StepRun/Run fence、completion winner、catalog/rekey 或 commit-response-loss 语义。
- Local SQLite 192/192、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；package
  boundary 精确报告 total=148、root=55、nested=93、hard cap=55、source lines=46,659。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,527,245/3,527,293 bytes，Edge/Standalone Adopted 为
  4,121,219/4,121,303，Edge/Standalone Application 为 4,608,126/4,608,270，Edge/Standalone AI 为
  4,857,429/4,857,489，Edge/Standalone Application AI 为 5,938,382/5,938,538 bytes。相对前一批
  每档只增加 503 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；Project Tool snapshot、Tool invocation Artifact、非空结果 rekey、result catalog
  rotation 与 completion/rekey commit-response-loss exactly-once 门均通过。临时 HA 容器完成清理，
  仅受保护的 `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 刷新后的 GitNexus 图为 42,301 nodes/96,180 edges/1,676 clusters/265 flows。新路径上的 snapshot、
  completion、start barrier、invocation Artifact 与 rekey 代表类仍为 LOW，分别保持 26/3、25/2、
  25/2、25/3、25/2，均为 0 affected flow，并归入 `Tool-execution` 模块；evidence 仍为 0/0。
  `detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告
  14 files/34 symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用该
  结果替代 pre-impact/context 和全部运行门。

### Local SQLite Local Owner repository ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file，根层 55→50、nested 93→98，hard cap 55→50；
  Owner bootstrap、credential recovery、delivery acknowledgement GC、Pepper catalog/reference 与
  Pepper material GC 五个 repository 共 3,650 行进入 `src/local-owner/`。它们共同实现本机首 Owner
  凭据与 Pepper 生命周期的 SQLite 持久化边界，不是按单文件建目录。`bootstrap.ts`、
  `acknowledgementGc.ts`、`pepperGc.ts` 继续作为根级短生命周期 composition entry；没有新增
  workspace package、dependency、根 facade、timer、listener、Pool、migration 或进程。
- 根入口及稳定组合入口保持不变，运行时 export count/导出名称摘要分别为：root
  15/`f1884fabfa37efd5`、bootstrap 2/`868eb03aaaa678a4`、acknowledgement GC
  2/`753181418a7a2922`、Pepper GC 2/`25f6f6bd2219f29c`、runtime
  12/`daf0cfe03a52f442`。clean build 后五个旧根 source/dist 路径均不存在，公开 specifier 仍解析到
  原 composition entry，没有新增 repository subpath 或兼容 facade。
- 迁移前对五个 repository class 使用精确 UID 执行 context/upstream impact。GitNexus 明确警告
  `LocalSqliteOwnerBootstrapRepository` 为 CRITICAL/19 impacted/4 direct/5 modules，credential
  recovery 为 CRITICAL/18/3/5，共享 Pepper repository 为 CRITICAL/66/23/7；delivery
  acknowledgement GC 与 Pepper material GC 均为 LOW/3/3/1，全部为 0 affected process。因此本批
  只改物理路径、相对 import 与根 re-export，不改 pristine provisioning/challenge、credential
  recovery/acknowledgement、Pepper activation/reference/rotation、retention/GC、security audit、
  transaction、exact replay 或 fail-closed 语义。
- Local SQLite 192/192、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；package
  boundary 精确报告 total=148、root=50、nested=98、hard cap=50、source lines=46,659。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,527,477/3,527,525 bytes，Edge/Standalone Adopted 为
  4,121,451/4,121,535，Edge/Standalone Application 为 4,608,358/4,608,502，Edge/Standalone AI 为
  4,857,661/4,857,721，Edge/Standalone Application AI 为 5,938,614/5,938,770 bytes。相对前一批
  每档只增加 232 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；credential delivery、identity keyset ledger、security audit、Policy、Prompt 与
  commit-response-loss exactly-once 门均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 刷新后的 GitNexus 图为 42,303 nodes/96,182 edges/1,676 clusters/265 flows。新路径上的五个 class
  impacted/direct 数与迁移前一致，bootstrap、credential recovery 与 Pepper 仍分别为 CRITICAL
  19/4、18/3、66/23，两个 GC repository 仍为 LOW/3/3；全部归入 `Local-owner` 模块且 0 affected
  process。`detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告
  14 files/34 symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用该
  结果替代这些精确 impact、context 和全部运行门。

### Local SQLite Plugin Package Workflow repository ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file，根层 50→45、nested 98→103，hard cap
  50→45；Plugin Package Workflow admission、frontier terminalization、cancellation convergence、
  task-attempt admission 与 Workflow task execution 五个 repository 共 4,382 行进入
  `src/plugin-package/workflow/`。五者共同拥有 Package Workflow 从授权准入、任务尝试到终态/取消
  收敛的 SQLite 持久化边界，不是按文件拆 package，也没有建立五个单文件目录。短生命周期
  `pluginPackageWorkflowAdministration.ts` 继续作为根级 composition entry；没有新增 workspace
  package、dependency、根 facade、timer、listener、Pool、migration 或进程，runtime 继续惰性装配。
- 根入口、五个稳定 repository 子路径、administration 与 runtime 公开 specifier 保持不变，运行时
  export count/导出名称摘要分别为：root 15/`f1884fabfa37efd5`、admission
  1/`37540df72fc7b09a`、frontier 1/`4fd277ee348c3f1f`、cancellation convergence
  1/`c95e8ef5d388129a`、task-attempt admission 1/`da9fc2222ed586dd`、Workflow task execution
  1/`b1dfeff268b7de97`、administration 1/`cbec651a9e47ee76`、runtime
  12/`daf0cfe03a52f442`。clean build 后五个旧根 source/dist 路径均不存在，公开 exports 直接映射
  `dist/plugin-package/workflow/*`，没有兼容 facade。
- 迁移前对五个 repository class 使用精确 UID 执行 query/context/upstream impact，全部为 LOW、0 条
  affected process：admission 为 2 impacted/2 direct，其余四个均为 25/2。因此本批只改物理路径、
  相对 import、runtime lazy import、公开 export target 与直接测试/HA fixture，不改 SQL、transaction、
  Policy/Package fence、Run/StepRun、exact replay、completion winner、frontier terminalization 或
  cancellation convergence 语义。
- Local SQLite 192/192、完整 19-package 门退出 0。首轮后端总门只因边界账本的泛化补丁误把
  `ql3-ai` root cap 从 50 改为 45 而准确失败；修正为 Local SQLite 精确条目后，最终后端为
  1,097 pass/2 条件 skip/0 fail。cluster dependency、Edge import、package boundary、local image
  四项审计均 compatible/零 finding；package boundary 精确报告 total=148、root=45、nested=103、
  hard cap=45、source lines=46,663。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,527,977/3,528,025 bytes，Edge/Standalone Adopted 为
  4,121,951/4,122,035，Edge/Standalone Application 为 4,608,858/4,609,002，Edge/Standalone AI
  为 4,858,161/4,858,221，Edge/Standalone Application AI 为 5,939,114/5,939,270 bytes。相对
  前一批每档只增加 500 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；Workflow admission/frontier/task-attempt/cancellation 的复制、晋升、exact replay 与
  commit-response-loss 门均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 刷新后的 GitNexus 图为 42,305 nodes/96,183 edges/1,676 clusters/265 flows。新路径上的 admission
  仍为 LOW/2 impacted/2 direct，其余四个均为 LOW/25/2，全部 0 affected process；frontier、
  cancellation、task-attempt 与 execution 归入 `Workflow` 模块，admission 因由根级 administration
  composition entry 装配而仍显示 `Local-owner`。`detect-changes` 对已跟踪基线报告 12 files/31
  symbols/low，compare `develop` 报告 14 files/34 symbols/low，均为 0 affected process；QL3 孵化树
  大部分尚未进入 Git 基线，不能用该结果替代这些精确 impact、context 和全部运行门。

### Local SQLite Plugin Package core repository ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file，根层 45→38、nested 103→110，hard cap
  45→38；Plugin Package install、materialized revision、Task reconciliation、automation
  publication、lifecycle、quarantine 与 proposal 七个 repository 共 5,198 行进入既有
  `src/plugin-package/`。七个实现并列形成 Package 安装、物化、发布与生命周期的 SQLite 持久化
  领域，现有 `workflow/` 继续作为子域；没有按文件拆 package 或建立单文件目录。
  `packageManagement.ts` 与 `pluginPackageWorkflowAdministration.ts` 继续作为根级短生命周期
  composition entry。没有新增 workspace package、dependency、根 facade、timer、listener、Pool、
  migration 或进程，runtime 继续惰性装配。
- 根入口、七个稳定 repository 子路径、runtime、package-management 与 Workflow administration
  公开 specifier 保持不变，运行时 export count/导出名称摘要分别为：root
  15/`f1884fabfa37efd5`、install 1/`6bd9de93b55af21a`、materialized revision
  1/`804c5e429c11fac5`、Task reconciliation 1/`9559c5d6788c3764`、automation publication
  1/`bb94b65882a31e22`、quarantine 3/`4bef4136a122c220`、lifecycle
  3/`cf723ca98c73a5ca`、proposal 2/`c23eb5fc1f388648`、runtime
  12/`daf0cfe03a52f442`、package-management 9/`11d78ae9a2c4066a`、Workflow
  administration 1/`cbec651a9e47ee76`。clean build 后七个旧根 source/dist 路径均不存在，公开
  exports 直接映射 `dist/plugin-package/*`，没有兼容 facade。
- 迁移前对七个 repository class 与 proposal helper 使用精确 UID 执行 query/context/upstream
  impact。GitNexus 明确警告 install 为 HIGH/30 impacted/5 direct/4 modules，automation
  publication 为 MEDIUM/39/8/2；materialized revision、Task reconciliation、lifecycle、
  quarantine、proposal 与 helper 均为 LOW，分别为 27/4、25/2、1/1、11/2、14/3、2/2，全部
  0 affected process。因此本批只改物理路径、相对 import、runtime lazy import、公开 export
  target 与直接测试/fixture，不改 SQL、transaction、Approved Action/Policy fence、PackageLock、
  publication generation、Task reconciliation、lifecycle/quarantine、exact replay 或 fail-closed
  语义。
- Local SQLite 192/192、完整 19-package 门退出 0，后端最终 1,097 pass/2 条件 skip/0 fail。后端
  首轮唯一失败是受限沙箱拒绝 Vault loopback `listen`（EPERM），授权重跑后全绿。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；
  package boundary 精确报告 total=148、root=38、nested=110、hard cap=38、source lines=46,663。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,528,421/3,528,469 bytes，Edge/Standalone Adopted 为
  4,122,395/4,122,479，Edge/Standalone Application 为 4,609,302/4,609,446，Edge/Standalone AI
  为 4,858,605/4,858,665，Edge/Standalone Application AI 为 5,939,558/5,939,714 bytes。相对
  前一批每档只增加 444 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；Package lifecycle/quarantine/automation publication 的原子 capability fence、
  commit-response-loss exactly-once、复制与晋升存活门均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 全量强制刷新后的 GitNexus 图为 42,306 nodes/96,186 edges/1,675 clusters/265 flows；此前增量
  索引一度遗漏 proposal helper，force full re-index 后 helper 恢复为 LOW/2/2。新路径 install
  为 MEDIUM/31 impacted/5 direct/2 modules，automation publication 保持 MEDIUM/39/8，其余 class
  保持 LOW，全部 0 affected process；目录归并减少模块扩散但未减少直接 caller。`detect-changes`
  对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告 14 files/34 symbols/low，均为
  0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用该结果替代这些精确 impact、
  context 和全部运行门。

### Local SQLite Security, Identity, Policy and Audit ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file，根层 38→31、nested 110→117，hard cap
  38→31；API credential、Identity credential administration、Project Policy repository/
  administration 与 Security Audit authority/query/retention 七个实现共 4,020 行进入新建的
  `src/security/`。Credential、Identity、Policy 与 Audit 在同一目录形成认证→授权→审计/保留的
  SQLite 持久化领域，没有按子能力拆 package 或建立单文件目录；公开 administration/query 入口
  也随 owner 下沉，不保留根 facade。没有新增 workspace package、dependency、timer、listener、
  Pool、migration 或进程。
- 根入口及所有受影响稳定入口保持不变，运行时 export count/导出名称摘要分别为：root
  15/`f1884fabfa37efd5`、runtime 12/`daf0cfe03a52f442`、bootstrap
  2/`868eb03aaaa678a4`、package-management 9/`11d78ae9a2c4066a`、Workflow administration
  1/`cbec651a9e47ee76`、Secret administration 1/`448b760a835d2b2b`、Task administration
  1/`cbb6f148ef46c22d`、Trigger administration 1/`c4f2fafb8326fad1`、Project Policy
  1/`ee21778fa8b0b7da`、Policy administration 2/`dd01a4c08970ddb4`、Audit query
  2/`72b7540ad1725265`、Audit retention 1/`2d5dc82be2441d85`、Identity credential
  administration 2/`9d87c6ca57de4c38`。clean build 后七个旧根 source/dist 路径均不存在，五个
  公开移动入口直接映射 `dist/security/*`，root 直接 re-export 新路径 API credential，没有兼容
  facade。
- 迁移前对六个 repository class、三个 Audit authority helper 与三个 open function 使用精确 UID
  执行 query/context/upstream impact。GitNexus 明确警告 API credential repository 为
  CRITICAL/64 impacted/22 direct/5 modules；Identity administration、Policy administration、
  Project Policy、Audit query/retention 与 helper 均为 LOW，分别为 1/1、1/1、4/3、1/1、2/2、
  5/2、4/2、1/1，三个 open function 为 0/0，全部 0 affected process。因此本批只改物理路径、
  相对 import、根 re-export 与公开 export target，不改 credential digest/pepper、Identity/
  RoleBinding、Policy fence、SecurityAudit、retention、transaction、exact replay 或 fail-closed
  语义。
- Local SQLite 192/192、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；
  package boundary 精确报告 total=148、root=31、nested=117、hard cap=31、source lines=46,663。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,528,654/3,528,702 bytes，Edge/Standalone Adopted 为
  4,122,628/4,122,712，Edge/Standalone Application 为 4,609,535/4,609,679，Edge/Standalone AI
  为 4,858,838/4,858,898，Edge/Standalone Application AI 为 5,939,791/5,939,947 bytes。相对
  前一批每档只增加 233 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；identity keyset ledger、Automation/Package management audit、同步审计 fail-closed、
  Policy fence 与晋升存活门均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 全量强制刷新后的 GitNexus 图为 42,306 nodes/96,188 edges/1,673 clusters/265 flows。新路径 API
  credential 仍为 CRITICAL/64 impacted/22 direct/5 modules，其 12 个直接本包 consumer 从
  `Local-owner` 正确归入 `Security`；其余 symbol impacted/direct 数保持不变，全部 0 affected
  process。`detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告
  14 files/34 symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用
  该结果替代这些精确 impact、context 和全部运行门。

### Local SQLite Task Definition and Scheduling ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file、46,663 行，根层 31→25、nested 117→123、hard cap
  31→25。六个实现没有按文件拆 workspace package，也没有为了凑目录宽度混合 owner：Dispatch
  Definition store、Task Definition repository/administration 三文件进入 `src/task-definition/`；Trigger
  repository、Schedule repository 与 Trigger administration 三文件进入 `src/scheduling/`。前者拥有
  Task revision→execution revision/recipe 的原子发布边界，后者拥有 Trigger revision→schedule claim 的
  排程边界。没有新增 package、dependency、timer、listener、Pool、migration 或进程。
- 根、runtime、Task administration 与 Trigger administration 的公开 specifier 保持不变，运行时 export
  count/导出名称摘要分别为 root 15/`f1884fabfa37efd5`、runtime 12/`daf0cfe03a52f442`、Task
  administration 1/`cbb6f148ef46c22d`、Trigger administration 1/`c4f2fafb8326fad1`；其余已记录的
  bootstrap/management/security specifier 指纹也全部不变。clean build 后六个旧根 source/dist 路径均
  不存在，两个公开 administration export 直接映射嵌套 `dist`，没有根 facade。
- 迁移前对八个 class/function 执行 query/context/upstream impact。Dispatch Definition conflict error/store
  为 CRITICAL，分别为 38 impacted/7 direct/6 modules 与 41/14/10，并触及 adoption `publish`；Schedule
  unavailable/repository 为 MEDIUM 32/7 与 LOW 28/3，Task Definition/Trigger repository 均为 MEDIUM
  30/4，两个 administration open function 为 0/0。因而本批只迁移路径与 export，不改 SQL、revision、
  dispatch publication、schedule claim、transaction hook、exact replay 或错误语义。
- Local SQLite 192/192、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。受限沙箱中的
  Worker TLS/mTLS 与 Vault loopback 首轮只因 `listen EPERM` 失败，允许本地监听后原样重跑全绿。
  cluster dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；
  package boundary 精确报告 total=148、root=25、nested=123、hard cap=25、source lines=46,663。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/Standalone
  为 3,528,903/3,528,951 bytes，Edge/Standalone Adopted 为 4,122,877/4,122,961，Edge/Standalone
  Application 为 4,609,784/4,609,928，Edge/Standalone AI 为 4,859,087/4,859,147，Edge/Standalone
  Application AI 为 5,940,040/5,940,196 bytes。相对前批每档只增加 249 bytes 的嵌套路径字符串/元数据，
  file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；Scheduler exactly-once、Task/Trigger automation inspection、Package/Workflow 安全栅栏
  均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 全量强制刷新后的 GitNexus 图为 42,310 nodes/96,191 edges/1,674 clusters/265 flows。新路径 Dispatch
  Store 保持 CRITICAL/41 impacted/14 direct，但 modules 10→6；其 conflict error 为 HIGH/38/7，modules
  6→4；Schedule unavailable 为 MEDIUM/31/7，其余 impacted/direct 保持不变。`Task-definition` 与
  `Scheduling` 聚类局部性提升，直接 caller 和 adoption `publish` 流程仍完整可见。`detect-changes` 对已
  跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告 14 files/34 symbols/low，均为
  0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用该结果替代精确 impact/context 与
  全部门禁。

### Local SQLite Run, StepRun and Approved Action ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file、46,663 行，根层 25→20、nested 123→128、hard cap
  25→20。Run repository、StepRun repository/schema contract 三文件进入 `src/run/`；Approval Request
  与 Approved Action Execution repository 两文件进入 `src/approved-action/`，共 5 个文件/4,554 行。
  这是两个已有领域的包内归位，不是再拆 workspace package，也没有新增 dependency、timer、listener、
  Pool、migration、进程或常驻资源。
- 根、runtime、StepRun、Approved Action 与 Approved Action Execution 的公开 specifier 保持不变，
  运行时 export count/导出名称摘要分别为 root 15/`f1884fabfa37efd5`、runtime
  12/`daf0cfe03a52f442`、StepRun 1/`1f92d2c47a980bcd`、Approved Action
  1/`4052d28beafe750f`、Approved Action Execution 3/`d54127780463d1c5`。clean build 后五个旧根
  source/dist 路径均不存在，三个公开 export 直接映射嵌套 `dist`，没有兼容 facade。
- 迁移前对五文件全部 top-level class/function 做精确 upstream impact。GitNexus 明确警告
  `LocalSqliteRunRepository` 为 CRITICAL/63 impacted/30 direct/3 modules；`requiredString`、
  `requiredInteger`、RoleBinding/SecurityAudit 映射与写入 helper 为 CRITICAL，最高 103 impacted/22
  direct，并触及 Workflow start 与 Secret put 共 3 条流程；`queryRows` 为 HIGH/58/23。StepRun、
  Approval Request 与 Approved Action Execution class 为 LOW。因而本批只迁移路径、import、公开
  export 与测试/fixture，不改 SQL、transaction、Run/StepRun、Approved Action、Policy/Secret/Audit、
  exact replay、completion 或 fail-closed 语义。
- Local SQLite 192/192、完整 19-package 门退出 0，后端 1,097 pass/2 条件 skip/0 fail。cluster
  dependency、Edge import、package boundary、local image 四项审计均 compatible/零 finding；package
  boundary 精确报告 total=148、root=20、nested=128、hard cap=20、source lines=46,663。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,529,104/3,529,152 bytes，Edge/Standalone Adopted 为
  4,123,078/4,123,162，Edge/Standalone Application 为 4,609,985/4,610,129，Edge/Standalone AI
  为 4,859,288/4,859,348，Edge/Standalone Application AI 为 5,940,241/5,940,397 bytes。相对前批
  每档只增加 201 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；Run cancellation/completion、Scheduler exactly-once、Workflow/Approved Action 安全围栏
  均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 全量强制刷新后的 GitNexus 图为 42,313 nodes/96,194 edges/1,674 clusters/265 flows。新路径
  `LocalSqliteRunRepository` 保持 CRITICAL/63 impacted/30 direct；`requiredString`、`requiredInteger`、
  `queryRows` 与四个 Security helper 的 impacted/direct 数保持不变。StepRun 与两个 Approved Action
  class 保持 LOW。`detect-changes` 对已跟踪基线报告 12 files/31 symbols/low，compare `develop` 报告
  14 files/34 symbols/low，均为 0 affected process；QL3 孵化树大部分尚未进入 Git 基线，不能用该
  结果替代精确 impact/context 与全部运行门。
- 本批没有把架构债务标成已解决：`LocalSqliteRunRepository` 仍同时实现
  `LocalCompletionReceiptJournal`、`LocalDispatchStore`、`LocalExecutionControlSource`、
  `LocalRunStartupRecoverySource` 与 `LocalSecretAdministrationRepository`，并持有 Project Policy、
  RoleBinding、SecurityAudit 的事务职责。下一阶段应提取 security/secret 专用 repository 或窄
  transaction collaborator，但必须继续共享一个注入的 SQLite transaction authority，使授权、审计与
  Run mutation 保持同一原子提交；禁止以多连接、多事务、新 daemon 或为每个文件再拆 package 的方式
  制造表面解耦。

### Local SQLite Migration orchestration and Readiness ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file、46,663 行，根层 20→14、nested 128→134、hard cap
  20→14。migration runner、reviewed manifest、history stream store 三文件进入 `src/migration/`；
  readiness contract、只读 inspection、rollout/restore safety 三文件进入 `src/readiness/`，共 6 个文件/
  4,090 行。`src/migrations/` 继续只拥有 84 条编号 DDL 与 SQL migration context；单数目录表达编排与
  reviewed history authority，复数目录表达可执行 schema changes。没有新增 workspace package、
  dependency、timer、listener、Pool、migration、进程或常驻资源。
- 首次实现曾把三个编排文件放进 `src/migrations/`。runtime、readiness inspection 与 rollout safety
  的三条惰性加载门随即发现只读入口加载了 `migrations/` 路径。没有通过排除 manifest/store 的正则
  白名单放宽门禁，而是将 orchestration 调整到 `src/migration/`，从物理边界继续保证 runtime/readiness
  不加载编号 DDL 或可变业务 repository。这是门禁推动出的架构修正，而非测试适配。
- 根、runtime、migration、readiness、inspection、rollout 的公开 specifier 保持不变，运行时 export
  count/导出名称摘要分别为 root 15/`f1884fabfa37efd5`、runtime 12/`daf0cfe03a52f442`、migration
  4/`588ef1025be22417`、readiness 4/`d66949f398e23a87`、inspection
  4/`ead02207498f91e7`、rollout 7/`769a1d0ff90b48fd`。clean build 后六个旧根 source/dist 路径均
  不存在，四个公开 subpath 直接映射嵌套 `dist`，没有根 facade。
- 迁移前对六文件全部顶层 class/function/const 执行 query/context/upstream impact。GitNexus 明确警告
  `LocalSqliteMigrationStreamStore` 为 CRITICAL/70 impacted/5 direct/6 modules，
  `LocalSqliteReadinessError` 为 CRITICAL/88/27/8，`auditLocalSqliteReadiness` 为
  CRITICAL/39/19/7；readiness schema/integrity helpers 均为 CRITICAL/30/1/6，
  `migrateLocalSqliteDatabase` 为 HIGH/4/1/3。rollout/restore helpers 主要为 LOW–MEDIUM，全部 0
  affected process。因此本批只迁移路径、import、公开 export 与测试/部署脚本，不改 migration ID/
  checksum/SQL、schema/readiness contract、backup/restore 算法、transaction 或 fail-closed 语义。
- Local SQLite 192/192。完整 19-package 首轮并发门只有 AI crash matrix 出现一次 pending-promise
  cancellation；该 20-scenario matrix 单独原样通过。单线程受限门随后只因 Worker TLS/mTLS loopback
  `listen EPERM` 失败；允许本地监听后 19 个 package 逐包全部退出 0，包括 AI 199 pass/3 skip、
  Runtime Core 435/435、Local SQLite 192/192、Worker Runtime 132/132。后端为 1,097 pass/2 条件
  skip/0 fail。cluster dependency、Edge import、package boundary、local image 四项审计均
  compatible/零 finding；package boundary 精确报告 total=148、root=14、nested=134、hard cap=14、
  source lines=46,663。
- 十档 artifact 均 `compatible=true`，package 集合、文件数与 loaded module 数未增加；Edge/
  Standalone 为 3,529,525/3,529,573 bytes，Edge/Standalone Adopted 为
  4,123,499/4,123,583，Edge/Standalone Application 为 4,610,406/4,610,550，Edge/Standalone AI
  为 4,859,709/4,859,769，Edge/Standalone Application AI 为 5,940,662/5,940,818 bytes。相对前批
  每档只增加 421 bytes 的嵌套路径字符串/元数据，file/module/package/RSS 预算均通过。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：物理流复制保持 `remote_apply`、timeline
  1→2，promotion 前旧主 fence，`pg_rewind --write-recovery-conf` 只读同步重入，两个 fresh control
  replica ready；Scheduler、Run cancellation/completion、Package/Workflow/AI 的 exact replay、复制与
  晋升存活门均通过。临时 HA 容器完成清理，仅受保护的
  `79b30d0c5348 kindest/node:v1.34.0 ql3-cnpg-evidence-control-plane` 保持运行。
- 全量强制刷新后的 GitNexus 图为 42,316 nodes/96,196 edges/1,674 clusters/265 flows。新路径
  MigrationStreamStore 保持 CRITICAL/5 direct/6 modules，impacted 70→64；ReadinessError 保持
  CRITICAL/88/27，modules 8→6；readiness audit 保持 CRITICAL/39/19/7，schema/integrity helpers 保持
  CRITICAL/30/1/6；rollout configuration helper 保持 MEDIUM/16/12。`detect-changes` 对已跟踪基线报告
  12 files/31 symbols/low，compare `develop` 报告 14 files/34 symbols/low，均为 0 affected process；
  QL3 孵化树大部分尚未进入 Git 基线，不能用该结果替代精确 impact/context 与全部运行门。

### Local SQLite Maintenance and Authority ratchet

- `@qinglong/local-sqlite` 仍为 148 个 source file、46,663 行，根层 14→10、nested 134→138、hard cap
  14→10。共享 operation authority 与 instance-level Project authority 两文件进入 `src/authority/`；
  acknowledgement/pepper 两个短生命周期 GC database composition 进入 `src/maintenance/`。没有新增
  workspace package、dependency、migration、timer、listener、Pool、进程或常驻资源。
- `@qinglong/local-sqlite/operation-authority`、`/acknowledgement-gc`、`/pepper-gc` 公开 specifier 保持
  不变，仅由 `package.json#exports` 直接改映射到嵌套 `dist/authority` 与 `dist/maintenance`。root 与
  三个 subpath 的运行时 export count/摘要保持 root 15/`f1884fabfa37efd5`、acknowledgement GC
  2/`753181418a7a2922`、pepper GC 2/`25f6f6bd2219f29c`、operation authority
  2/`689e957ab08d55e7`；clean build 后四个旧 root source/dist 路径均不存在，没有兼容 facade。
- 迁移前对全部顶层 class/function/const 与 operation authority 方法执行 query/context/upstream impact。
  GitNexus 明确警告 `LocalSqliteOperationAuthority` 为 CRITICAL/345 impacted/165 direct/5 processes/
  20 modules，`enqueue` 为 CRITICAL/202/74/6/20，`close` 为 CRITICAL/45/13/0/7，
  `resolveLocalInstanceAuthorityProjectId` 为 CRITICAL/25/4/0/5；两个 GC open function 为 LOW/0。
  因此本批只迁移文件、相对 import、公开 export target 与直接测试路径，不改 256 pending-operation 上限、
  admission queue、close fence、Project resolution SQL、readiness、transaction 或 GC fail-closed 语义。
- Local SQLite 192/192。完整 workspace 聚合门中 Worker 的 3 个 TLS/mTLS 测试因 sandbox
  `listen EPERM` 失败并中断并发 AI crash matrix；解除 loopback 限制后 Worker 132/132，AI 单独为
  199 pass/3 skip，其余 package 在聚合门内通过。后端全量 1,099 项没有 assertion failure，但既有
  durable launcher 并发用例触发一次 15 秒 timeout；原测试按同一实现隔离复跑 1/1 通过。Edge import、
  cluster dependency、package boundary 均 compatible/零 finding；联网 production dependency audit
  因外发依赖元数据策略拒绝，未绕过也不计为本轮重新验证。
- 十档 artifact 均 `compatible=true`：Edge/Standalone 为 3,530,127/3,530,175 bytes，Edge/Standalone
  Adopted 为 4,124,101/4,124,185，Edge/Standalone Application 为 4,611,008/4,611,152，
  Edge/Standalone AI 为 4,860,311/4,860,371，Edge/Standalone Application AI 为
  5,941,264/5,941,420 bytes；文件数、loaded module、package 集合和 RSS 全部在原预算内。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：physical streaming `remote_apply`、timeline
  1→2、promotion 前旧主 fence、`pg_rewind` 只读同步重入、两个 fresh control replica，以及 Scheduler、
  Workflow、Package、AI 的 exact replay/复制/晋升存活门均通过。门后检查隔离 HA 容器、volume 与 network
  为零残留。
- 强制刷新后的 GitNexus 图为 42,320 nodes/96,199 edges/1,675 clusters/265 flows；新路径下 class、
  `enqueue`、`close`、instance authority resolver 与两个 GC open function 的 impacted/direct/process/
  module 数和风险级别完全不变，说明调用图仅发生物理归位。目录归位不改变后续架构债务：operation
  authority 是共享同连接事务与 close fence 的基础设施，不应拆成新 package；下一 ratchet 转向剩余
  composition root，语义拆分仍须独立批次处理。

### Cluster Admin Automation Management ratchet

- `@qinglong/cluster-admin` 保持 79 个 source file、29,545 行，Automation Management 的 application
  service、transport、TLS 1.3 HTTP adapter、PostgreSQL process composition、client 与两个 CLI 共 7 个
  文件/2,152 行进入 `src/automation-management/`；root 79→72、nested 0→7、hard cap 79→72。没有新增
  workspace package、dependency、进程、listener、Pool 或常驻资源。`managementProcessSupport.ts` 没有
  随单一领域下沉：它同时被 Worker Credential、Plugin Package、Provider Credential 与 Automation
  Management process 使用，继续作为包内共享 process composition support。
- `@qinglong/cluster-admin/automation-management`、`/automation-management-transport`、`-http`、
  `-process`、`-client` 五个公开 specifier 与 `ql3-automation-manage`、`ql3-automation-client` 两个 bin
  名称保持不变，`package.json#exports/bin`、Kubernetes Deployment/Job、deployment audit 与 live contract
  直接指向嵌套 `dist/automation-management/`，不保留根 facade。root 及五个公开入口的 export
  count/digest 为 6/`88de4148335daa48`、5/`d8b586e9fb6b9b0a`、6/`3475080ea1b4ae46`、
  1/`255cf2772cc69637`、3/`79b2c80c0f78d812`、2/`12f5045f3c844560`；clean build 后七个旧根
  source/dist 路径均不存在。
- 迁移前对领域内 132 个 function/class/method 图节点执行 upstream impact，并对 service、transport、
  HTTP、process config/start、client validate/execute 与两个 CLI run 做独立可读复核。关键公开入口全部
  LOW，最大 3 impacted、1 direct、2 modules、0 affected process；因此本批只改物理路径、相对 import、
  export/bin 与部署/审计硬编码路径，不改 Task/Trigger revision、Policy/audit fence、OIDC/mTLS、
  PostgreSQL role/readiness、HTTP bounds、CLI file authority 或 fail-closed 语义。强制刷新后 impacted/
  direct/process 数完全不变，affected modules 从分散的两个 cluster 收敛为一个
  `Automation-management` cluster。
- clean 19-package build 退出 0。Cluster Admin 首轮测试仅因 sandbox `listen EPERM` 失败，允许 loopback
  后 256 pass/2 skip/0 fail。后端首轮 1,096 pass/2 skip，唯一失败是负向依赖审计 fixture 在写入新
  嵌套路径前未建目录；补齐显式 `mkdir` 后目标文件 47/47、完整后端 1,097 pass/2 skip/0 fail。
  cluster dependency、package boundary、cluster deployment 三项均 compatible/零 finding；package
  boundary 精确报告 total=79、root=72、nested=7、hard cap=72、source lines=29,545。
- 十档 artifact 全部 `compatible=true` 且数值与前批相同：Edge/Standalone 为
  3,530,127/3,530,175 bytes，Edge/Standalone Adopted 为 4,124,101/4,124,185，
  Edge/Standalone Application 为 4,611,008/4,611,152，Edge/Standalone AI 为
  4,860,311/4,860,371，Edge/Standalone Application AI 为 5,941,264/5,941,420 bytes；这证明
  cluster-admin 内部归位没有进入路由器或本机 Profile 的 package/file/module/RSS 闭包。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：physical streaming `remote_apply`、timeline
  1→2、promotion 前旧主 fence、`pg_rewind` 只读同步重入与两个 fresh control replica 均通过；
  Automation identity keyset ledger 跨 replica restart/晋升存活，Automation inspection 与 audit 原子提交、
  同步复制、无同步 standby 时 fail-closed、晋升后存活。门后 `ql3-ha` 容器、volume、network 均零残留。
- 强制刷新后的 GitNexus 图为 42,322 nodes/96,201 edges/1,675 clusters/265 flows；关键入口风险、
  impacted/direct/process 数保持不变。`detect-changes --scope all` 为 12 files/31 symbols/low，compare
  `develop` 为 14 files/34 symbols/low，均 0 affected process；3.0 孵化树大部分尚未进入 Git 基线，
  不能用该结果替代精确 impact/context 与完整运行门。联网 production dependency audit 本批未绕过
  前批的外发依赖元数据策略限制，也不计为重新验证。

### Cluster Admin Model Provider Credential ratchet

- `@qinglong/cluster-admin` 保持 79 个 source file；Model Provider Credential 的 management service、
  transport、TLS 1.3 HTTP adapter、process、client、双 CLI，以及 test executor、process、CLI 共 10 个
  既有文件进入 `src/model-provider-credential/`。迁移前共 3,244 行，仅增加两行领域边界注释后 package
  为 29,547 行；root 72→62、nested 7→17、hard cap 72→62。workspace 仍为 19 个 package，没有新增
  dependency、migration、进程、listener、Pool、timer 或常驻资源。共享 `managementProcessSupport.ts`
  继续留在根层，因为 Worker、Plugin Package、Provider Credential 与 Automation management process
  均依赖它；这类包内共享 composition support 不应为目录整齐被复制或拆成微型 package。
- 七个公开 specifier `model-provider-credential-management`、`-management-transport`、
  `-management-http`、`-management-process`、`-management-client`、`-test-executor`、
  `-test-executor-process` 与三个既有 bin 名称保持不变，`package.json#exports/bin`、Kubernetes
  Deployment/Job、部署审计、HA contract 与直接测试路径全部映射嵌套 `dist/model-provider-credential/`，
  不保留根 facade。root 及七个公开入口的 export count/digest 分别保持
  6/`88de4148335daa48`、7/`3073801c92bea704`、6/`3fe6f435f24cf604`、
  1/`553632c35b0875a6`、3/`4264936496982c43`、2/`2910416de9ef3063`、
  3/`3d0128d107433a85`、3/`5e7bf51f450eb6ae`；clean build 后十个旧根 source/dist 路径均不存在。
- 编辑前对新领域十个文件中的 121 个 function/class/method 节点逐项运行 depth=6、include-tests 的
  upstream impact：20 HIGH、1 MEDIUM、100 LOW，全部 0 affected process；最高的 management request
  error 为 23 impacted/10 direct/3 modules。另对 service factory、management process、client、test
  executor/process 做 context 复核，均未参与新增执行流。因此本批只改物理路径、相对 import、export/bin
  和部署/审计硬编码路径，不改 credential catalog、envelope、OIDC/mTLS、PostgreSQL role/readiness、
  quota/identity ledger、test plan/result、COMMIT 收敛或 content-free 语义。
- clean 19-package build 退出 0，Cluster Admin 256 pass/2 skip/0 fail；完整后端为 1,097 pass/2 skip/
  0 fail。cluster dependency、package boundary、Provider Credential management deployment 与 test
  deployment 四项审计均 compatible/零 finding；package boundary 精确报告 total=79、root=62、
  nested=17、hard cap=62、source lines=29,547。联网 production dependency audit 因外发依赖元数据
  策略限制未重跑，未绕过也不计作本轮验证。
- 十档 artifact 全部 `compatible=true`：Edge/Standalone 为 3,530,127/3,530,175 bytes，
  Edge/Standalone Adopted 为 4,124,101/4,124,185，Edge/Standalone Application 为
  4,611,008/4,611,152，Edge/Standalone AI 为 4,860,311/4,860,371，Edge/Standalone Application AI
  为 5,941,264/5,941,420 bytes；文件数、loaded module、package closure 与 RSS 均在原预算内，证明
  Cluster 管理能力的内部归位没有进入低配路由设备或 Standalone 的运行闭包。
- PostgreSQL 18.4 arm64 HA 退出 0、总 `gates.passed=true`：Model Provider Credential catalog、
  management identity ledger 与 test connection 均在同步复制、COMMIT 响应丢失和 timeline 1→2
  promotion 后存活/收敛；test executor 使用 `ql3_ai_credential_tester` 最小权限角色，durable record
  不含 private material。旧主先 fence，再由 `pg_rewind` 以只读 standby 重入；门后隔离容器、volume、
  network 零残留。
- 强制刷新后的 GitNexus 图为 42,322 nodes/96,203 edges/1,673 clusters/265 flows。121 个节点的迁移后
  impact 为 0 HIGH/6 MEDIUM/115 LOW，仍全部 0 affected process，最大 module 面从 4 收敛至 2；风险
  下降来自同一 capability 被识别为更清晰的模块，而非删除调用或改变行为。`detect-changes --scope all`
  为 12 files/31 symbols/low，compare `develop` 为 14 files/34 symbols/low，均 0 affected process；3.0
  孵化树大部分未进入 Git 基线，因此这些结果只作补充，不能替代逐符号 impact 和运行门。

### Cluster Admin Worker Credential ratchet

- `@qinglong/cluster-admin` 保持 79 个 source file；Worker Credential administration、recoverable
  delivery、POSIX/Kubernetes delivery adapter、Kubernetes TokenRequest session、management service/
  transport/TLS 1.3 HTTP/process/client、approved executor/process 与三个 CLI 共 16 个文件进入
  `src/worker-credential/`。迁移前共 7,323 行，仅增加 16 行 owning-domain 边界注释后 package 为
  29,563 行；root 62→46、nested 17→33、hard cap 62→46。workspace 仍为 19 个 package，没有新增
  dependency、migration、进程、listener、Pool、timer 或常驻资源。
- `managementProcessSupport.ts`、Plugin Package identity keyset/client/HTTP 继续由真正 owning/shared
  边界管理；Worker process 使用 `../` 引用共享 composition support，Plugin Package HTTP、Automation
  和 Provider Credential 则显式引用 `worker-credential/` 的 transport 或通用 mTLS validator。没有
  通过 barrel、复制实现或新微型 package 掩盖跨域依赖。
- 11 个公开 Worker Credential specifier 与 `ql3-worker-credential-manage`、
  `ql3-worker-credential-execute`、`ql3-worker-credential-client` 三个 bin 名称保持不变，exports/bin、
  Kubernetes Deployment/Job、offline/live audit、HA contract 与直接测试路径映射到嵌套
  `dist/worker-credential/`，不保留根 facade。root 与 11 个入口的 export count/digest 分别保持
  6/`c030b9e6e116817a`、3/`02a297ed0f194bb1`、3/`518f654198733d71`、
  4/`57021c9d8ef5c9ff`、4/`374119c119f2b91b`、6/`c41a194e2bee421c`、
  6/`3cb638ce445f2635`、1/`1938ac4a4b8a730d`、3/`3c6ba7460c5e1033`、
  2/`75d6fe635677cddc`、1/`5ae4f022c452f582`、3/`dcaa890d9bf86cc2`；clean build 后 16 个旧根
  source/dist 路径均不存在。
- 编辑前对 16 个文件的 254 个 function/class/method 节点逐项运行 depth=6、include-tests upstream
  impact：1 CRITICAL、5 HIGH、16 MEDIUM、232 LOW。`WorkerCredentialManagementRequestError` 为
  35 impacted/14 direct/1 process/5 modules；`PrivateDirectoryAuthority` 为 16/11/1/3，executor
  process config 与 management transport/close 也为 HIGH。context 进一步确认 approved executor 参加
  7 条 Worker execution 流，delivery issuer、PostgreSQL repository 和私有目录 authority 形成同一闭环。
  因此本批只改路径、imports、exports/bin 与部署/审计引用，不改 credential/token/digest、0700/0600
  POSIX authority、Kubernetes CAS/TokenRequest、approval/Policy/audit、quota/identity ledger、事务或错误语义。
- clean 19-package build 与 Cluster Admin 256 pass/2 skip/0 fail。完整后端首轮为 1,096 pass/2 skip，
  唯一失败是负向 dependency fixture 写入新嵌套路径前未创建目录；补齐显式 `mkdir` 后目标 1/1、完整
  后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、cluster deployment 均
  compatible/零 finding；边界精确报告 total=79、root=46、nested=33、hard cap=46、source lines=29,563。
- 十档 artifact 全部 `compatible=true` 且字节与前批一致：Edge/Standalone 3,530,127/3,530,175，
  Edge/Standalone Adopted 4,124,101/4,124,185，Edge/Standalone Application
  4,611,008/4,611,152，Edge/Standalone AI 4,860,311/4,860,371，Edge/Standalone Application AI
  5,941,264/5,941,420 bytes；package 集合、文件数、loaded module 与 RSS 均在原预算，证明 Cluster
  Credential 管理能力未进入路由器/Standalone runtime closure。
- 首次 HA 前置脚本因机械路径替换同时误指未迁移的 Cluster PostgreSQL manager/executor dist，在 Docker
  创建前以 `MODULE_NOT_FOUND` 失败且零资源残留；精确恢复两个非目标路径并扫描同类误改后重跑。
  PostgreSQL 18.4 arm64 最终 `gates.passed=true`：Worker management quota 跨实例收敛、identity keyset
  ledger 跨重启/晋升存活、credential delivery COMMIT windows exactly-once，以及 timeline 1→2、旧主
  fence/rewind/read-only rejoin 与 fresh replicas 全部通过；门后容器、volume、network 零残留。
- 强制刷新后的 GitNexus 图为 42,324 nodes/96,205 edges/1,673 clusters/265 flows。迁移后 254 个节点为
  0 CRITICAL/0 HIGH/20 MEDIUM/234 LOW；最高节点仍为 35 impacted/14 direct/1 process，module 面从 5
  收敛为 1，说明调用和执行流未删除而 capability 聚合生效。`detect-changes` all/compare `develop` 为
  12 files/31 symbols 与 14/34，均 low/0 affected process；新树未完整进入 Git 基线，因此仍只作补充。
  联网 production dependency audit 沿用外发依赖元数据策略限制，本批未绕过或计作重新验证。

### Cluster Admin Prompt Output ratchet

- `@qinglong/cluster-admin` 保持 79 个 source file；Prompt Output GC、key retirement、key rotation、
  Kubernetes Secret authority/keyring、external recovery verifier 与四个 CLI 共 13 个文件进入
  `src/prompt-output/`。迁移前共 2,101 行，仅增加 13 行 owning-domain 边界注释后 package 为
  29,576 行；root 46→33、nested 33→46、hard cap 46→33。workspace 仍为 19 个 package，没有新增
  dependency、migration、进程、listener、Pool、timer 或常驻资源。
- 跨 Model Invocation、Provider Credential 与 Prompt Output schema 的 `modelInvocationMigrationCli.ts`
  继续留在根层 composition boundary，没有错误归入任一单领域；新目录内部使用局部相对引用，未引入
  barrel、兼容 facade、复制实现或微型 workspace package。
- 五个公开 Prompt Output specifier 与 `ql3-prompt-output-gc`、`ql3-prompt-output-key-retire`、
  `ql3-prompt-output-key-rotate`、`ql3-prompt-output-key-recovery-verify` 四个 bin 名称保持不变；exports/bin、
  Kubernetes operation Job、deployment/live audit、HA contract 与直接测试路径均映射到嵌套
  `dist/prompt-output/`。root、GC process、retirement process、rotation process、external recovery verifier、
  Kubernetes Secret keyring 的 export count/digest 分别保持 6/`c030b9e6e116817a`、
  2/`55aa642e4ba55dd2`、2/`2814b06f55304e72`、2/`6e83a0dd83d7275b`、
  2/`e2e1cce8026c333f`、2/`059c4cf7b95de3e2`；clean build 后旧根 source/dist 路径均不存在。
- 编辑前对 13 个文件的 56 个 function/class/method 节点逐项运行 depth=6、include-tests upstream
  impact：4 HIGH/52 LOW，无 CRITICAL/MEDIUM。`ClusterPromptOutputKubernetesSecretKeyring` 为
  7 impacted/4 direct/0 process/3 modules；`accessMatrix`、
  `AuthorizationApi.createSelfSubjectAccessReview#1` 与 `assertExactKubernetesAuthority` 也为 HIGH。
  context 确认 GC、retirement、rotation、external recovery 与 Kubernetes Secret authority 的原装配链；
  因此本批只改路径、exports/bin、部署/审计与测试引用，不改 key state/resourceVersion、RBAC、事务、
  ciphertext custody、recovery authorization 或错误语义。
- clean 19-package build 与 Cluster Admin 256 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/0 fail。
  cluster dependency、package boundary、cluster deployment 与 external recovery deployment audit 均
  compatible/零 finding；边界精确报告 total=79、root=33、nested=46、hard cap=33、source lines=29,576。
  两个 Kubernetes live report auditor 需要显式 report 参数，未伪装为无需集群报告的离线门。
- 十档 artifact 全部 `compatible=true` 且字节与前批一致：Edge/Standalone 3,530,127/3,530,175，
  Edge/Standalone Adopted 4,124,101/4,124,185，Edge/Standalone Application
  4,611,008/4,611,152，Edge/Standalone AI 4,860,311/4,860,371，Edge/Standalone Application AI
  5,941,264/5,941,420 bytes；package 集合、文件数、loaded module 与 RSS 均在原预算，证明 Cluster
  Prompt Output 维护能力没有进入路由器/Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Prompt Output tombstone-before-ciphertext-delete、GC 后 exact
  replay、key retirement durable fence、key rotation recoverability 与 maintenance least privilege 五门全绿，
  并完成 `remote_apply`、timeline 1→2、旧主 fence/`pg_rewind`/read-only rejoin 与 fresh replicas；门后
  容器、volume、network 零残留。
- 强制刷新后的 GitNexus 图为 42,326 nodes/96,207 edges/1,673 clusters/265 flows。迁移后 56 个节点
  全部 LOW；最高节点仍为 7 impacted/4 direct/0 process，module 面从 3 收敛为 1，说明调用与执行流未
  删除而 capability 聚合生效。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，
  均 low/0 affected process；新树未完整进入 Git 基线，因此仍只作补充。联网 production dependency
  audit 沿用外发依赖元数据策略限制，本批未绕过或计作重新验证。

### Cluster Admin shared Management Support ratchet

- `@qinglong/cluster-admin` 保持 79 个 source file；四个 Cluster 管理平面共同使用的 bounded process
  environment/TLS file support、identity assertion/keyset、one-shot authenticated client 与 bounded TLS
  HTTP host 共 5 个文件进入 `src/management-support/`。迁移前共 3,484 行，仅增加 5 行 shared-boundary
  注释后 package 为 29,581 行；root 33→28、nested 46→51、hard cap 33→28。workspace 仍为 19 个
  package，没有新增 dependency、migration、进程、listener、Pool、timer 或常驻资源。
- 该目录是四管理面共享基础设施，不是 Plugin Package owning domain。Plugin Package、Worker Credential、
  Automation 与 Model Provider Credential 的 process/HTTP/client 显式引用同一 shared boundary；真正
  Plugin-specific management service/transport/process/CLI、Kubernetes tunnel client 继续留待独立 ratchet。
  这避免把已被四方复用的 JWT profile、keyset rotation、TLS host 和 client protocol 错归给 Plugin。
- `plugin-package-management-client`、`plugin-package-management-http`、`plugin-package-identity-assertion`、
  `plugin-package-identity-keyset` 四个既有公开 specifier 保持名称不变，package exports 直接映射到嵌套
  `dist/management-support/`；内部 `managementProcessSupport` 不新增公开入口。root/client/HTTP/assertion/
  keyset 的 export count/digest 分别保持 6/`c030b9e6e116817a`、6/`d52efe0f9a0d24b3`、
  6/`96e4b3837a9c8246`、7/`2e2acfc3f489deb6`、6/`6458f8c8f67064f0`，clean build 后五个旧根
  source/dist 实现路径均不存在；未迁移的 `pluginPackageManagementClientCli` 仍是合法根层 process entry。
- 编辑前对 5 个文件的 121 个 function/class/method 节点逐项运行 depth=6、include-tests upstream
  impact：10 CRITICAL/12 HIGH/8 MEDIUM/91 LOW。`ClusterPluginPackageManagementClientRequestError`
  为 44 impacted/19 direct/0 process/5 modules；environment parser、TLS reader 与 identity keyset 横跨
  5–8 modules。context 明确显示 HTTP/client 各由四管理面调用，keyset factory 绑定四种独立 assertion
  profile。因此本批只改路径、relative imports、exports 与审计/fixture 映射，不改 JWT type/purpose、
  signature/rotation/ledger、TLS 1.3、body/connection/rate bounds、one-shot protocol 或错误语义。
- clean 19-package build与 Cluster Admin 256 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/0 fail。
  cluster dependency、package boundary、cluster deployment 均 compatible/零 finding；边界精确报告
  total=79、root=28、nested=51、hard cap=28、source lines=29,581。
- 十档 artifact 全部 `compatible=true` 且字节与前批一致：Edge/Standalone 3,530,127/3,530,175，
  Edge/Standalone Adopted 4,124,101/4,124,185，Edge/Standalone Application
  4,611,008/4,611,152，Edge/Standalone AI 4,860,311/4,860,371，Edge/Standalone Application AI
  5,941,264/5,941,420 bytes；最小 Edge 仍为 324 files/42 loaded modules，证明 Cluster management
  support 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Plugin/Worker/Automation/Provider Credential 四个 identity
  ledger 均完成 generation 3、rollback/same-generation rewrite/implicit removal 拒绝、COMMIT response-loss
  收敛与 promotion 后存活；management quota、`remote_apply`、timeline 1→2、旧主 fence/`pg_rewind`/
  read-only rejoin 与 fresh replicas 全绿，门后容器、volume、network 零残留。
- 强制刷新后的 GitNexus 图为 42,325 nodes/96,209 edges/1,670 clusters/265 flows。迁移后 121 个节点
  为 9 CRITICAL/2 HIGH/9 MEDIUM/101 LOW；最高 client error 保持 44 impacted/19 direct/0 process，
  module 从 5 收敛为 4。共享 environment/keyset 继续为 CRITICAL 是真实跨域复用证据，不以目录归位
  冒充职责解耦。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/
  0 affected process；新树未完整进入 Git 基线，因此仍只作补充。联网 production dependency audit
  沿用外发依赖元数据策略限制，本批未绕过或计作重新验证。

### Cluster Admin Plugin Package Management ratchet

- `@qinglong/cluster-admin` 保持 79 个 source file；Plugin Package 专属 management service、transport、
  PostgreSQL process、管理 CLI、one-shot client CLI、Kubernetes PortForward client/CLI 共 7 个既有文件
  进入 `src/plugin-package/management/`。迁移前共 3,384 行，仅增加 7 行 owning-domain 边界注释后
  package 为 29,588 行；root 28→21、nested 51→58、hard cap 28→21。workspace 保持 19 个 package，
  没有新增 dependency、migration、进程、listener、Pool、timer 或常驻资源。
- 四管理面共享的 process/identity/client/HTTP 继续由 `src/management-support/` 拥有；Plugin lifecycle、
  publisher trust、recovery/evidence 与 approved executor 也保留各自 authority。management process 通过
  显式相对路径组合这些 port，不用 barrel、复制实现或新微型 package 掩盖跨域依赖。
- `plugin-package-management`、`-transport`、`-process`、`-kubernetes-client` 四个公开 specifier 与
  `ql3-plugin-package-manage`、`ql3-plugin-package-client`、
  `ql3-plugin-package-client-kubernetes` 三个 bin 名称保持不变；exports/bin、Kubernetes Deployment、
  dependency/deployment audit 与直接测试路径均映射嵌套 `dist/plugin-package/management/`，不保留根
  facade。root/management/transport/process/Kubernetes client 的 export count/digest 保持
  6/`c030b9e6e116817a`、2/`6b3c27db6c40ae7b`、6/`9d0d7c1c6eb5f4cc`、
  3/`a62ebb3990be1228`、4/`2902faafefdd6541`；clean build 后七个旧根 source/dist 路径均不存在。
- 编辑前对 7 个文件的 86 个 function/class/method 节点逐项运行 depth=6、include-tests upstream
  impact：8 HIGH/3 MEDIUM/75 LOW、0 CRITICAL。最高的 transport configuration error 为
  26 impacted/5 direct/0 process/3 modules；process configuration 与 Kubernetes tunnel validation 也
  在 elevated 范围。因此本批只改物理路径、relative imports、exports/bin、部署/审计与测试 fixture，
  不改十四个管理命令、OIDC/mTLS、SoD/Policy/audit、durable quota、PostgreSQL role/readiness、TLS/HTTP
  bounds、Kubernetes PortForward 选择/重试规则或错误语义。
- clean 19-package build 退出 0，Cluster Admin 256 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/
  0 fail。cluster dependency、package boundary、cluster deployment 均 compatible/零 finding；边界精确
  报告 total=79、root=21、nested=58、hard cap=21、source lines=29,588。联网 production dependency
  audit 因外发依赖元数据策略限制未重跑，未绕过也不计作本轮验证。
- 十档 artifact 全部 `compatible=true` 且 package/file/module 预算不变：Edge/Standalone 为
  3,530,127/3,530,175 bytes，Edge/Standalone Adopted 为 4,124,101/4,124,185，Edge/Standalone
  Application 为 4,611,008/4,611,152，Edge/Standalone AI 为 4,860,311/4,860,371，Edge/Standalone
  Application AI 为 5,941,264/5,941,420 bytes；最小 Edge 仍为 324 files/42 loaded modules，证明
  Cluster Plugin management 与 Kubernetes 依赖没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Plugin management quota 在两个实例 16 个并发请求下精确
  8 admitted/8 limited，replay 不额外计费；identity keyset generation 3 拒绝 rollback/rewrite/removal；
  lifecycle/SoD、publisher revocation、`remote_apply`、timeline 1→2、旧主 fence/`pg_rewind`/只读同步
  rejoin 与两个 fresh control replica 全绿，门后容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,195 nodes/95,568 edges/1,665 clusters/265 flows。迁移后 86 个
  节点为 4 MEDIUM/82 LOW；最高 transport errors 仍为 26/25 impacted，全部 0 affected process，module
  ownership 收敛而调用未删除。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，
  均 low/0 affected process；新树未完整进入 Git 基线，因此仍只作补充。

### Cluster Admin Plugin Package Publisher ratchet

- `@qinglong/cluster-admin` 保持 79 个 source file；Plugin Package publisher provenance recovery、
  revocation/quarantine composition、revocation/trust-transition approval consumers、两个 Approved Action
  handlers 与 trust management 共 7 个既有文件进入 `src/plugin-package/publisher/`。迁移前共
  2,185 行，仅增加 7 行 owning-domain 边界注释后 package 为 29,595 行；root 21→14、nested
  58→65、hard cap 21→14。workspace 保持 19 个 package，没有新增 dependency、migration、进程、
  listener、Pool、timer 或常驻资源。
- quarantine service、OCI stage authority、recovery/executor process 与 management process 继续作为显式
  相邻 authority/消费者；publisher 目录只拥有 trust/provenance/proposal→approval→Approved Action→
  revocation/transition 闭环。没有把所有 `pluginPackage*` 文件机械聚类，也没有通过 barrel、复制实现、
  facade 或新微型 package 掩盖领域依赖。
- `plugin-package-publisher-revocation`、`-revocation-approved-action`、
  `-revocation-approval-consumer`、`-trust-transition-approved-action`、
  `-trust-transition-approval-consumer`、`-trust-management` 六个公开 specifier 保持名称不变，package
  exports、HA contract 与直接测试路径均映射嵌套 `dist/plugin-package/publisher/`。root 与六个入口的
  export count/digest 保持 6/`c030b9e6e116817a`、2/`000fd1128ec85e31`、
  1/`0a6ce74f8bc6cd0c`、2/`59840d5aa11efe1a`、1/`0ec7bca92a216978`、
  2/`9efb25193607f262`、1/`45eb76c787b9d210`；内部 provenance recovery 不新增公开入口，clean
  build 后七个旧根 source/dist 路径均不存在。
- 编辑前对 7 个文件的 51 个 function/class/method 节点逐项运行 depth=6、include-tests upstream
  impact：4 HIGH/1 MEDIUM/46 LOW、0 CRITICAL。最高 management `identifier` 为
  10 impacted/5 direct/0 process/4 modules；provenance `stageEvidence` 与 `provenanceFor` 为
  7/1/0/4 和 6/2/0/4。因此本批只改路径、relative imports、exports 与测试/审计映射，不改 trust
  digest/generation、stage evidence、dual control/break-glass、Policy/audit、Approved Action fence、
  revocation/quarantine、PostgreSQL transaction/role/readiness 或错误语义。
- clean 19-package build 退出 0，Cluster Admin 256 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/
  0 fail。cluster dependency、package boundary、cluster deployment 均 compatible/零 finding；边界精确
  报告 total=79、root=14、nested=65、hard cap=14、source lines=29,595。联网 production dependency
  audit 因外发依赖元数据策略限制未重跑，未绕过也不计作本轮验证。
- 十档 artifact 全部 `compatible=true` 且 package/file/module 预算不变：Edge/Standalone 为
  3,530,127/3,530,175 bytes，Edge/Standalone Adopted 为 4,124,101/4,124,185，Edge/Standalone
  Application 为 4,611,008/4,611,152，Edge/Standalone AI 为 4,860,311/4,860,371，Edge/Standalone
  Application AI 为 5,941,264/5,941,420 bytes；最小 Edge 仍为 324 files/42 loaded modules，证明
  Publisher PostgreSQL/Kubernetes authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：publisher trust transition 在 timeline 1 同步复制并于
  timeline 2 promotion 后存活，overlap-add/safe-retire、revocation immediate automation fence、
  quarantine commit-response-loss、inventory promotion survival 全绿；旧主在 promotion 前 fence，随后
  `pg_rewind` 为只读同步 standby，两个 fresh control replica ready，门后容器/volume/network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,330 nodes/96,214 edges/1,670 clusters/265 flows。迁移后仍为
  4 HIGH/1 MEDIUM/46 LOW，所有 impacted/direct/process 数完全不变；最高节点 module 4→3，说明领域
  ownership 收敛但真实风险未被目录移动掩盖。`detect-changes` all/compare `develop` 为
  12 files/31 symbols 与 14/34，均 low/0 affected process；新树未完整进入 Git 基线，因此仍只作补充。

### Cluster Admin Plugin Package root closure ratchet

- `@qinglong/cluster-admin` 保持 79 个 source file；lifecycle management/executor/quarantine 三文件进入
  `src/plugin-package/lifecycle/`，Kubernetes activation、OCI stage、recovery/process/CLI 五文件进入
  `src/plugin-package/recovery/`，Approved Action dispatcher、executor process/CLI 三文件进入
  `src/plugin-package/executor/`。迁移前共 4,895 行，仅增加 11 行 owning-domain 边界注释后 package
  为 29,606 行；root 14→3、nested 65→76、hard cap 14→3。workspace 保持 19 个 package，没有新增
  dependency、migration、进程、listener、Pool、timer 或常驻资源。
- 三个目录按真实生命周期分工，而不是按 `pluginPackage*` 前缀机械聚类：lifecycle 拥有审批后的状态迁移
  与 quarantine，recovery 拥有 OCI/Kubernetes stage→activation→recovery 闭环，executor 拥有 durable
  Approved Action dispatch composition；publisher 与 management 通过显式相邻领域路径消费它们。
  `src/` 根只剩 `index.ts`、`administration.ts` 和 `modelInvocationMigrationCli.ts`，没有新增 barrel、
  facade 或单文件 workspace package。
- `plugin-package-kubernetes-activation`、`-recovery`、`-oci-stage`、`-recovery-process`、
  `-approved-action`、`-executor-process`、`-lifecycle-management`、`-lifecycle-executor` 与 `-quarantine`
  九个公开 specifier 名称保持不变；`ql3-plugin-package-recover` 与 `ql3-plugin-package-execute` 两个 bin
  名称也保持不变。exports/bin、Docker ENTRYPOINT、Kubernetes Job/CronJob、HA actor、deployment/OCI/
  dependency audit 与直接测试路径均映射嵌套 `dist/plugin-package/{lifecycle,recovery,executor}/`，不保留
  根 facade。root 与九个入口的 export count/digest 保持 6/`c030b9e6e116817a`、
  1/`c2e79b707a8c4f4d`、6/`f7b0cdff03785f48`、8/`93eac4b09e6c735a`、
  6/`2fbc9fd57383846e`、2/`de57e456041e081b`、3/`ff648808f56d841f`、
  1/`6383e43ea9f4e88b`、2/`0bc7e783494e2781`、3/`34a472920e845f85`；clean build 后 11 个旧根
  source/dist 路径均不存在。
- 编辑前对 11 个文件的 161 个 function/class/method 节点逐项运行 depth=6、include-tests upstream
  impact：2 CRITICAL/7 HIGH/3 MEDIUM/149 LOW，aggregate 186 direct edge/350 impacted symbol，命中
  `reconcile` 与 `runClusterPluginPackageLifecycleExecution`。CRITICAL 包括 Kubernetes domain error
  preservation 与 recovery process config error，故在编辑前显式告警，并把 package/back/HA 全门列为
  强制验收。本批只改物理路径、relative imports、exports/bin、部署/审计与测试 fixture，不改 stage
  verification、Policy/SoD/audit、quarantine、recovery retry、PostgreSQL transaction/role/readiness、
  Kubernetes resourceVersion CAS、OCI allowlist/credential 或错误语义。
- clean 19-package build 退出 0，Cluster Admin 256 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/
  0 fail。cluster dependency、package boundary、cluster deployment 与 OCI layout contract 均 compatible/
  零 finding；边界精确报告 total=79、root=3、nested=76、hard cap=3、source lines=29,606。联网
  production dependency audit 因外发依赖元数据策略限制未重跑，未绕过也不计作本轮验证。
- 十档 artifact 全部 `compatible=true` 且与上一批完全一致：Edge/Standalone 为
  3,530,127/3,530,175 bytes，Edge/Standalone Adopted 为 4,124,101/4,124,185，Edge/Standalone
  Application 为 4,611,008/4,611,152，Edge/Standalone AI 为 4,860,311/4,860,371，Edge/Standalone
  Application AI 为 5,941,264/5,941,420 bytes；最小 Edge 仍为 324 files/42 loaded modules，最大
  Application AI 仍为 475 files/97 modules，证明 Cluster recovery/Kubernetes/PostgreSQL authority 没有
  进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：lifecycle management 的 disable/enable ×
  plan/propose/decide/execute 八个崩溃窗口全部 exactly-once 收敛；quarantine、publisher trust、
  remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿，
  门后容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,332 nodes/96,218 edges/1,668 clusters/265 flows。迁移后 161 个
  节点为 7 HIGH/3 MEDIUM/151 LOW、0 CRITICAL，aggregate direct edge 保持 186、impacted 350→349；
  recovery config error 仍为 18 impacted/12 direct，但新图将其归入 Recovery，说明风险标签下降源于
  ownership 收敛而非调用丢失。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，
  均 low/0 affected process；新树未完整进入 Git 基线，因此仍只作补充。

### Cluster Control Worker Ingress ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；Worker Ingress application、configuration、admission
  pipeline、production bootstrap 与 credential authenticator 五个文件进入 `src/worker-ingress/`。迁移前
  共 1,808 行，仅新增 5 行 owning-domain 边界注释后 package 为 11,558 行；root 40→35、nested
  0→5、hard cap 40→35。workspace 保持 19 个 package，没有新增 dependency、migration、process、
  listener、Pool、timer、路由或部署制品。
- 五个文件构成同一 Worker 入站安全闭环：配置解析并冻结 mTLS/PostgreSQL/Secret/Artifact 边界，
  authenticator 绑定短期 Worker principal，pipeline 在读取不可信 body 前执行认证/授权/audit，application
  与 production bootstrap 只负责资源所有权和启停。共享主 HTTP 平面的 `authenticationShield`、Remote
  Worker offer/activation/secret/completion/lease、S3 Artifact store 与 process application 不因文件前缀
  被机械并入；它们分别留待 security、remote-execution、artifact 与 composition ratchet。
- `worker-ingress`、`worker-ingress-config`、`production-worker-ingress` 与
  `worker-ingress-pipeline` 四个公开 specifier 名称保持不变，`package.json#exports` 直接映射嵌套 dist；
  root 入口及五个目标的 export count/digest 保持 11/`7de35017139f435d`、8/`f750e9bb5c589fe3`、
  5/`164e4be42e7d9248`、1/`9ceb2085bb7e013a`、1/`47f41bd9641e913b`，内部 credential
  authenticator 保持 1/`169f61c58695da6f`。clean build 后五个旧根 source/dist 路径均不存在，未保留
  facade，也没有创建五个单文件 package。
- 编辑前对五文件 40 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  1 CRITICAL/10 HIGH/1 MEDIUM/28 LOW，aggregate 66 direct edge/151 impacted symbol、0 affected process。
  `ClusterWorkerIngressConfigError` 为 CRITICAL，30 impacted/21 direct；十个 config validator 为 HIGH，
  最高 `boundedValue` 为 13/7。因此在编辑前显式告警，并将 package/back/HA 列为强制验收。本批只修改
  路径、相对 import、exports、审计 allowlist 和直接测试 fixture，不改变配置默认值/上限、credential
  digest、mTLS、CRL、rate limit、body admission、PostgreSQL role/readiness、Secret 或 Artifact 行为。
- clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/
  0 fail。cluster dependency、package boundary、cluster deployment 与 worker deployment audit 均
  compatible/零 finding；边界精确报告 total=40、root=35、nested=5、hard cap=35、source lines=11,558。
  联网 production dependency audit 因外发依赖元数据策略限制未重跑，未绕过也不计作本轮验证。
- 十档 artifact 全部 `compatible=true` 且与 Cluster Admin root closure 批次完全一致：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，
  AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小 Edge 324 files/42 loaded
  modules，最大 Application AI 475 files/97 modules。Worker Ingress、PostgreSQL、S3 与 Cluster
  authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Worker credential delivery commit windows 与 remote Worker
  completion exactly-once、remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 和两个
  fresh control replica 全绿，门后临时容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,334 nodes/96,220 edges/1,668 clusters/265 flows。迁移后 40 个
  节点为 11 HIGH/1 MEDIUM/28 LOW、0 CRITICAL，aggregate direct edge 保持 66、impacted 151→152；
  config error 仍为 31 impacted/21 direct，模块归入 `Worker-ingress`。风险标签下降并非调用被删除，
  而是 ownership 收敛；高风险校验节点仍被完整保留。`detect-changes` all/compare `develop` 为
  12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树未完整进入 Git 基线，因此该结果
  仅作补充证据，不能替代上述逐节点 impact 与运行时门。

### Cluster Control Remote Execution ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；Remote Worker offer dispatch、Run activation、
  Secret delivery、Artifact upload/completion、lease control 与聚合 PostgreSQL repositories 的 runtime
  port 六个文件进入 `src/remote-execution/`。迁移前共 1,195 行，仅新增 6 行 owning-domain 注释后
  package 为 11,564 行；root 35→29、nested 5→11、hard cap 35→29。workspace 保持 19 个 package，
  没有新增 dependency、migration、process、listener、Pool、timer、route 或部署制品。
- 六文件不是按 `remote*` 前缀凑目录：dispatcher 产生 offer/lease authority，activation 推进 starting/
  running/failure，Secret delivery 绑定同一 offer fence，Artifact/completion 提交不可变证据，lease control
  续租/释放，runtime port 以最小能力把它们一次性注入 Worker Ingress。`s3ArtifactStore.ts` 与
  `workerArtifactBinding.ts` 继续留在 Artifact adapter 边界；Worker authentication/mTLS/body admission
  继续属于 `worker-ingress/`，process/application composition 也没有被错误并入。
- `worker-runtime-port`、`remote-dispatch`、`remote-activation`、`remote-secret-delivery`、
  `remote-completion` 与 `lease-control` 六个公开 specifier 名称保持不变，root 与 Worker Ingress 的
  re-export 面也保持稳定。export count/digest 分别为 11/`7de35017139f435d`、8/`f750e9bb5c589fe3`、
  1/`abae8f44df6ffc2b`、3/`ed636a3b1fd72c04`、1/`c71cb871bac69c77`、
  1/`64406d1b345054c8`、2/`d7203bb86aec5883`、1/`a469620e93fc6699`。clean build 后六个旧根
  source/dist 路径均不存在，未保留 facade，也没有创建六个微型 package。
- 编辑前对六文件 45 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  3 MEDIUM/42 LOW、0 HIGH/CRITICAL，aggregate 64 direct edge/139 impacted symbol，命中 `claimNext` 与
  `put` 两条执行流，涉及 6 个 module。本批只修改物理路径、relative imports、exports、直接测试和
  Worker PostgreSQL live gate 路径；不改变 placement/offer digest、lease token、event ID、activation、
  Secret disposal、Artifact immutability、completion fencing 或 PostgreSQL repository/transaction 语义。
- clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/
  0 fail。cluster dependency、package boundary、cluster deployment 与 worker deployment audit 均
  compatible/零 finding；边界精确报告 total=40、root=29、nested=11、hard cap=29、source lines=11,564。
  联网 production dependency audit 因外发依赖元数据策略限制未重跑，未绕过也不计作本轮验证。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前两批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。Cluster Remote Execution 与
  PostgreSQL authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：remote Worker completion commit-response-loss exactly-once、
  Worker credential delivery、scheduler claim takeover/exactly-once、remote_apply、timeline 1→2、旧主
  fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿，门后临时容器、volume、network
  零残留。
- 强制完整刷新后的 GitNexus 图为 42,336 nodes/96,222 edges/1,668 clusters/265 flows。迁移后仍为
  3 MEDIUM/42 LOW，aggregate 64 direct edge/139 impacted symbol，`claimNext` 与 `put` 两条流程均保留；
  module 从 6 收敛到 `Remote-execution` 等 3 个。风险、调用和执行流完全不变，变化仅是 ownership。
  `detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process。
  QL3 新树未完整进入 Git 基线，因此该结果仅作补充证据，不能替代逐节点 impact 与运行门。

### Cluster Control Scheduling ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；Croner schedule adapter、bounded scheduler
  coordinator/lifecycle、Workflow frontier/Task Attempt coordinator 与按 recovery→lost retry→scheduler
  排序的 runtime coordinator 四文件进入 `src/scheduling/`。迁移前共 656 行，仅新增 4 行 owning-domain
  注释后 package 为 11,570 行；root 27→23、nested 13→17、hard cap 27→23。workspace 保持 19 个
  package，没有新增 dependency、migration、process、listener、Pool、timer、route 或部署制品。
- 四文件共享同一 production cadence，而不是按 `*Scheduler` 后缀机械聚类：Croner adapter 只解析下次
  occurrence，coordinator 原子 claim due schedule，lifecycle 唯一拥有 non-overlapping timer，Workflow
  coordinator 在同一 cadence 后推进 frontier/Task Attempt，runtime coordinator 在此前完成 recovery 与
  lost retry。`runCancellationLifecycle.ts` 有自己独立 coordinator/timer/drain 和 Run cancellation authority，
  因此明确不进入 Scheduling，留待 Run 领域 ratchet。
- `workflow-scheduler` 公开 specifier 保持不变并直接映射嵌套 dist；root、scheduler、Workflow、runtime 与
  Croner adapter 的 export count/digest 分别保持 11/`7de35017139f435d`、3/`e61ce80a1ff4745d`、
  1/`63135cb7b8ec3212`、1/`13f76bb33715891e`、1/`b3090d5ca6f6d23d`。clean build 后四个旧根
  source/dist 路径均不存在，未保留 facade，也没有创建四个微型 package。
- 编辑前对四文件 32 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  2 MEDIUM/30 LOW、0 HIGH/CRITICAL，aggregate 28 direct edge/73 impacted symbol、0 affected process，涉及
  Cluster Control/Workflow 三个 module。本批只修改物理路径、relative imports、export target、直接测试、
  PostgreSQL HA fixture 与 Croner dependency allowlist；不改变 schedule decision、claim lease/token、
  misfire grace、数据库时钟、pagination、frontier/Task Attempt admission、recovery/lost retry 顺序、timer 或
  bounded drain 语义。
- clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail。完整后端首轮发现 Croner 负向
  fixture 仍在临时树创建旧根 `cronerSchedule.ts`，使新 allowlist 正确拒绝它；对测试文件与 helper 的
  upstream impact 均为 LOW/0 process 后，将临时 adapter/forbidden 路径同步到 `src/scheduling/`，目标
  1/1、完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、cluster deployment 与
  worker deployment audit 均 compatible/零 finding；边界精确报告 total=40、root=23、nested=17、
  hard cap=23、source lines=11,570。联网 production dependency audit 因外发元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。Cluster cadence/PostgreSQL
  authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：scheduler claim replicated before promotion、expiry takeover、
  occurrence exactly-once、commit-response-loss convergence、remote_apply、timeline 1→2、旧主
  fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿，门后临时容器、volume、network
  零残留。
- 强制完整刷新后的 GitNexus 图为 42,342 nodes/96,226 edges/1,670 clusters/265 flows。迁移后仍为
  2 MEDIUM/30 LOW，aggregate direct edge 保持 28、affected process 保持 0；impacted 73→71，module
  归入 `Scheduling` 等三域。直接调用边与风险完全不变，差异来自图谱重新聚类而非删除调用。
  `detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process。
  QL3 新树未完整进入 Git 基线，因此该结果仅作补充证据，不能替代逐节点 impact 与运行门。

### Cluster Control Run ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；bounded Run read route、Policy/Audit-fenced durable
  cancellation route 与 cancellation convergence lifecycle 三文件进入 `src/run/`。迁移前共 411 行，仅新增
  3 行 owning-domain 注释后 package 为 11,573 行；root 23→20、nested 17→20、hard cap 23→20。
  workspace 保持 19 个 package，没有新增 dependency、migration、process、listener、Pool、timer、route
  或部署制品。
- 三文件由同一个 Run authority 内聚，而不是按 `*Route`/`*Lifecycle` 技术形态机械聚类：read route 只暴露
  Project-bounded capability-free projection；cancellation route 在 Policy fence 与同步 Audit 下提交 durable
  intent；lifecycle 以独立有界 cadence 把非执行中取消请求收敛到终态。根目录 `httpSurface`、
  `routeRegistry` 与 production application 仍属于 transport/composition，Scheduling 也继续拥有自己的唯一
  scheduler cadence，没有反向塞入 `run/`。
- `run-routes` 公开 specifier 保持不变并直接映射嵌套 dist；root、Run read、Run cancellation route 与
  convergence lifecycle 的 export count/digest 分别保持 11/`7de35017139f435d`、
  4/`c63cfc1f54687ea8`、2/`5c88ff1502caa4c1`、1/`2f26ff43f627296d`。clean build 后三个旧根
  source/dist 路径均不存在，未保留 facade，也没有创建三个微型 package。
- 编辑前对三文件 18 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  18 LOW、0 MEDIUM/HIGH/CRITICAL，aggregate 17 direct edge/32 impacted symbol、0 affected process，涉及
  Cluster Control、Create、Scheduling 等 module。本批只修改物理路径、relative imports、export target 与
  直接测试入口；不改变 Project masking、Run view、Policy revision fence、同步 Audit、idempotency、取消状态机、
  convergence pagination、timer、coalescing 或 bounded drain 语义。
- clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/
  0 fail。cluster dependency、package boundary、cluster deployment 与 worker deployment audit 均
  compatible/零 finding；边界精确报告 total=40、root=20、nested=20、hard cap=20、source lines=11,573。
  联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。Cluster Run/PostgreSQL authority
  没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Run cancellation commit-window exactly-once、remote Workflow
  cancellation replay/commit-response-loss/promotion、scheduler claim takeover、remote_apply、timeline 1→2、
  旧主 fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha 容器、volume、
  network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,344 nodes/96,228 edges/1,670 clusters/265 flows。迁移后仍为
  18 LOW，aggregate direct edge 保持 17、impacted symbol 保持 32、affected process 保持 0；module 收敛到
  `Run`、`Scheduling`、`Create` 与 `Cluster-control`。直接调用边与风险完全不变，变化仅是 ownership。
  `detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process。
  QL3 新树未完整进入 Git 基线，因此该结果仅作补充证据，不能替代逐节点 impact 与运行门。

### Cluster Control Plugin Package Prompt and Workflow ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；Prompt execution、output-read 与稳定公开 barrel 三文件
  进入 `src/plugin-package/prompt/`，Workflow administration capability 与 inspect/start route 两文件进入
  `src/plugin-package/workflow/`。迁移前共 1,088 行，仅新增 5 行 owning-domain 注释后 package 为
  11,578 行；root 20→15、nested 20→25、hard cap 20→15。workspace 保持 19 个 package，没有新增
  dependency、migration、process、listener、Pool、timer、route 或部署制品。
- Prompt 与 Workflow 是两个相邻但独立的 authority，并未按 `*Route` 技术后缀混放：Prompt 目录拥有模型
  execution bounds、Policy fence、output retention intent 与 durable output projection；Workflow 目录拥有
  materialized revision inspection、semantic plan、authorized durable admission 与 HTTP adapter。根目录
  `httpSurface`、`routeRegistry`、`index` 与 production application 仍是 transport/composition owner，只通过
  capability 注入消费这两个领域。
- `prompt-routes`、`workflow-administration` 与 `workflow-routes` 三个公开 specifier 保持不变并直接映射
  嵌套 dist；root、Prompt barrel/execution/output-read、Workflow administration/route 的 export
  count/digest 分别保持 11/`7de35017139f435d`、8/`3880ee7a8720791a`、
  5/`d131c8db71034a5c`、3/`91f906982005bc29`、4/`a2af99d6e411b53e`、
  4/`8adfdff1ee744512`。clean build 后五个旧根 source/dist 路径均不存在，未保留 facade，也没有创建
  Prompt/Workflow 微型 package；两行公开 barrel 作为包内稳定 subpath 留在 owning domain。
- 编辑前对五文件 41 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  1 MEDIUM/40 LOW、0 HIGH/CRITICAL，aggregate 54 direct edge/97 impacted symbol，命中 `start` 流程，涉及
  7 个 module。本批只修改物理路径、relative imports、export target、dependency allowlist 与负向 fixture；
  不改变参数/输出上限、deadline、Project/Policy fence、Audit/Event identity、output digest/view、Workflow
  materialization revision、semantic plan、admission receipt、idempotency 或 HTTP 错误映射。
- clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/
  0 fail。首轮 dependency 目标门揭示 Local Admin 与 Cluster Control 的同名 Workflow administration 原共用
  根路径 allowlist；对 `auditSourceImports` 的 upstream impact 为 LOW、1 direct/0 process 后，将规则改为显式
  接受两个 owning path，目标 47/47 与完整 cluster dependency audit 通过。package boundary、cluster
  deployment 与 worker deployment audit 均 compatible/零 finding；边界精确报告 total=40、root=15、
  nested=25、hard cap=15、source lines=11,578。联网 production dependency audit 因外发依赖元数据策略
  限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。Cluster Prompt/Workflow 与
  PostgreSQL authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Prompt admission finalization、Policy fence、durable output
  artifact/GC/rotation/retirement，以及 Workflow authorized admission、frontier、Task Attempt 的 atomicity、
  exact replay 与 promotion survival 全绿；remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步
  rejoin 与两个 fresh control replica 也全绿，门后 ql3-ha 容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,348 nodes/96,232 edges/1,670 clusters/265 flows。迁移后仍为
  1 MEDIUM/40 LOW，aggregate direct edge 保持 54、impacted symbol 保持 97，`start` 流程保留；module
  收敛到 `Prompt`、`Workflow`、`Create` 与 `Cluster-control`。风险、调用与执行流完全不变，变化仅是
  ownership。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected
  process。QL3 新树未完整进入 Git 基线，因此该结果仅作补充证据，不能替代逐节点 impact 与运行门。

### Cluster Control Authentication ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；API credential authenticator 与 process-local pre-body
  authentication overload shield 两文件进入 `src/authentication/`。迁移前共 495 行，仅新增 2 行
  owning-domain 注释后 package 为 11,580 行；root 15→13、nested 25→27、hard cap 15→13。workspace
  保持 19 个 package，没有新增 dependency、migration、process、listener、Pool、timer、route 或部署制品。
- 两文件共同拥有认证边界，但职责不混淆：shield 在读取 body/查询 credential 前执行 monotonic-clock、
  per-peer/global bounded admission 与精确 refund；authenticator 随后解析 Bearer credential、使用 pepper/HMAC
  与 timing-safe compare 验证，并生成短 TTL Principal。部署 `config.ts`、Remote Secret adapter、数据库
  availability fence、HTTP surface 与 composition entrypoint 继续留在各自边界，没有为了降低根文件数并入
  `authentication/`。
- `api-credential` 公开 specifier 保持不变并直接映射嵌套 dist；root、API credential 与内部 shield 的
  export count/digest 分别保持 11/`7de35017139f435d`、6/`b06ae23464c2211f`、
  1/`4c56eeb3c8751301`。clean build 后两个旧根 source/dist 路径均不存在，未保留 facade，也没有创建
  authentication 微型 package。
- 编辑前对两文件 23 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  4 CRITICAL/1 HIGH/18 LOW，aggregate 28 direct edge/64 impacted symbol、0 affected process，涉及 Security、
  HTTP、Worker Ingress 与 Automation Management 等 10 个 module。`decodeSecret`、configuration error、
  shield create/consume 为 CRITICAL，pepper assertion 为 HIGH，因此编辑前已显式告警。本批只修改物理路径、
  relative imports、export target 与直接测试入口；不改变 credential grammar、HMAC domain/digest、
  timing-safe compare、pepper key/generation、buffer zeroization、Principal TTL、monotonic clock、fingerprint、
  per-peer/global bound、lazy pruning、refund token 或 close 语义。
- 定向认证测试 10/10；clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail，完整后端
  1,097 pass/2 skip/0 fail。cluster dependency、package boundary、cluster deployment 与 worker
  deployment audit 均 compatible/零 finding；边界精确报告 total=40、root=13、nested=27、hard cap=13、
  source lines=11,580。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。Cluster authentication/PostgreSQL
  authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：authority split readiness、credential/identity ledger、
  remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha 容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,350 nodes/96,234 edges/1,670 clusters/265 flows。迁移后仍为
  23 个符号、aggregate 28 direct edge/64 impacted symbol、0 affected process；risk 调整为
  2 CRITICAL/3 HIGH/18 LOW，两项 shield 核心仍为 CRITICAL，API credential 内部 7 个节点聚类到
  `Authentication` 后降低跨 module 权重。调用边、impacted 数和安全行为没有删除，不能把标签变化解释为
  风险消失。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected
  process。QL3 新树未完整进入 Git 基线，因此该结果仅作补充证据，不能替代逐节点 impact 与运行门。

### Cluster Control Mounted Secret Provider ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；mounted Secret provider 单文件进入既有
  `src/remote-execution/`，与 `remoteWorkerSecretDeliveryService` 同域。迁移前 259 行，仅新增 1 行
  owning-domain 注释后 package 为 11,581 行；root 13→12、nested 27→28、hard cap 13→12。workspace
  保持 19 个 package，没有为单文件新建 package，也没有新增 dependency、migration、process、listener、
  Pool、timer、route 或部署制品。
- 该 provider 是 Remote Execution 的部署 adapter：Cluster process 仅在 Worker Ingress 显式启用
  `mounted-files` 时 dynamic import，产出 `RemoteWorkerSecretValueProvider` 后交给既有 Secret delivery
  service；每次请求重新读取 projected volume 以观察原子轮换。它不拥有通用 Secret CRUD、配置解析或
  Kubernetes API，也不进入 Edge/Standalone/disabled Cluster，因此没有建立 `secret-provider` 微包或放进
  根 `config.ts`。
- `mounted-secret-provider` 公开 specifier 保持不变并直接映射嵌套 dist；root 与 provider 的 export
  count/digest 分别保持 11/`7de35017139f435d`、4/`07975362b442662c`。clean build 后旧根
  source/dist 路径均不存在，未保留 facade。
- 编辑前对单文件 14 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  1 MEDIUM/13 LOW、0 HIGH/CRITICAL，aggregate 18 direct edge/28 impacted symbol、0 affected process，仅
  涉及 provider module。本批只修改物理路径、process dynamic import 与 export target；不改变 canonical
  SecretRef digest、root path/realpath、lstat/open/no-follow、projected-volume symlink containment、path escape、
  regular-file/byte bound、authority normalization/fence、每请求重读或 buffer disposal 语义。
- mounted Secret 定向测试 4/4；clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail，
  完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、cluster deployment 与 worker
  deployment audit 均 compatible/零 finding；边界精确报告 total=40、root=12、nested=28、hard cap=12、
  source lines=11,581。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。mounted Secret provider 仍只属于
  Cluster Worker Ingress closure，没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Worker credential delivery commit-window exactly-once、
  remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha 容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,352 nodes/96,235 edges/1,671 clusters/265 flows。迁移后仍为
  1 MEDIUM/13 LOW，aggregate 18 direct edge/28 impacted symbol、0 affected process；module 从临时
  `Cluster_575` 收敛到 `Remote-execution`。风险、调用与执行流完全不变，变化仅是 ownership。
  `detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process。
  QL3 新树未完整进入 Git 基线，因此该结果仅作补充证据，不能替代逐节点 impact 与运行门。

### Cluster Control Database Availability ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；PostgreSQL Pool failure 到 application admission
  withdrawal 的 availability fence 单文件进入 `src/database/`。迁移前 92 行，仅新增 1 行 owning-domain
  注释后 package 为 11,582 行；root 12→11、nested 28→29、hard cap 12→11。workspace 保持 19 个
  package，没有为单文件新建 package，也没有新增 dependency、migration、process、listener、Pool、timer、
  route 或部署制品。
- availability fence 的 producer 是 `createClusterControlDatabaseBinding`，consumer 是 application lifecycle；
  它只允许 Pool failure 单向撤销 admission，原进程不允许恢复。`config.ts` 仍负责 profile/env/TLS/Pool
  composition，`application.ts` 仍负责 readiness/liveness 与 shutdown composition，因此两者保留根入口，
  没有与单文件一起机械迁移。
- `availability` 公开 specifier 保持不变并直接映射嵌套 dist；root 与 availability runtime export 的
  count/digest 分别保持 11/`7de35017139f435d`、1/`d0d379a896ee1104`。clean build 后旧根
  source/dist 路径均不存在，未保留 facade。
- 编辑前对单文件 7 个 class/method 节点逐项运行 depth=6、include-tests upstream impact：7 LOW、
  0 MEDIUM/HIGH/CRITICAL，aggregate 7 direct edge/14 impacted symbol、0 affected process，涉及 database
  binding 与 application lifecycle 两个 module。本批只修改物理路径、relative imports 与 export target；
  不改变 available→unavailable→disposed 单向状态机、single listener、early signal delivery、promise
  containment、unsubscribe、dispose 或禁止 in-place recovery 语义。
- availability/config 定向测试 8/8；clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/
  0 fail，完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、cluster deployment 与
  worker deployment audit 均 compatible/零 finding；边界精确报告 total=40、root=11、nested=29、
  hard cap=11、source lines=11,582。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。Cluster database availability 与
  PostgreSQL authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：package authority split readiness before/after promotion、旧
  replicas unavailable、新 replicas ready、remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步
  rejoin 全绿；门后 ql3-ha 容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,354 nodes/96,237 edges/1,671 clusters/265 flows。迁移后仍为
  7 LOW，aggregate 7 direct edge/14 impacted symbol、0 affected process；module 收敛到 `Database`。
  风险、调用与执行流完全不变，变化仅是 ownership。`detect-changes` all/compare `develop` 为
  12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树未完整进入 Git 基线，因此该结果仅作
  补充证据，不能替代逐节点 impact 与运行门。

### AI Model Invocation ratchet

- `modelInvocation.ts`、durable coordinator、manual ambiguity resolution 与 SQLite/PostgreSQL transaction
  repository 五文件进入 `src/model-invocation/`。迁移前 6,825 行，仅在 resolution 增加 2 行 ownership
  说明后为 6,827 行；`@qinglong/ai` 保持 55 个 source file，root 50→45、nested 5→10、hard cap
  50→45，source lines=39,775，workspace 仍为 19 个 package。
- `localModelInvocationFeatureActivation.ts` 同时围栏 Provider Credential、Price Catalog、Prompt Output 和
  Prompt admission，综合 `modelInvocationMigration.ts` 同时拥有这些 optional schema；二者属于跨 AI
  feature lifecycle/composition，不随本批按名称前缀移动。Model Invocation 目录只拥有调用 contract、
  recovery/resolution coordinator 与双方言原子 repository，没有新建 workspace package、facade、dependency、
  migration、Pool、process、listener、timer 或 watcher。
- root、model-invocation、model-invocation-resolution、durable-model-invocation、profile、local storage 与
  PostgreSQL storage 七个 entry 的 export count/digest 保持 172/`8dbaba681822a7ce`、
  18/`d5515d82b0cf4b60`、10/`bac0bd4736f96096`、2/`b05f5b33c4c5bfea`、
  9/`e33b8d78c4843501`、1/`5e4113ac11649ed6`、1/`8a7b6411688daeb1`。公开 specifier 不变并直接指向
  嵌套 dist；clean build 后五个旧根 source 和 20 个旧根 dist 派生路径均不存在。
- 编辑前对 215 个 function/class/method 逐项运行 upstream impact：61 CRITICAL/39 HIGH/4 MEDIUM/
  111 LOW，aggregate 746 direct/2,015 impacted/445 process hits。最高的 repository unavailable、conflict 与
  invalid error 分别为 16/121/10、44/89/10、13/81/10（direct/impacted/process）。编辑前已显式告警，
  本批只改变物理路径、relative import、export target、deep-test/HA require 与 root cap，不改变 JSON/digest
  normalization、StepRun mutation、SQLite `BEGIN IMMEDIATE`、PostgreSQL SERIALIZABLE/advisory lock、usage/
  quota/pricing/Prompt output 原子提交、recovery/resolution 或 fail-closed error mapping。
- 定向测试 63 pass/2 条件 skip、AI package 199 pass/3 条件 skip；clean 19-package build 与完整 package
  门退出 0，完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、Edge import、Cluster
  deployment 与 Worker deployment 五项审计均 compatible/零 finding。联网 production dependency audit 因
  外发依赖元数据策略限制未重跑。
- 十档 artifact 均 `compatible=true`。六个非 AI 制品与前批完全一致：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152。四个 AI 制品因 source map 记录更长嵌套源路径各增加 570 bytes，成为
  4,860,881/4,860,941 与 5,941,834/5,941,990 bytes；文件数仍为 381/475，package/module 闭包不变，
  均低于 5/6 MiB hard cap。非 AI 路由器与 Standalone runtime 零字节、零 importer 增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：optional AI schema、Model Invocation 与 Package Prompt 在
  timeline 1→2 晋升前复制并在晋升后存活；旧主先 fence，再由 `pg_rewind` 只读同步 rejoin，两个 fresh
  control replica ready，门前后 ql3-ha Docker 容器均为零。
- GitNexus 增量刷新为 42,394 nodes/96,274 edges/1,675 clusters/265 flows。迁移后 215 个节点为
  49 CRITICAL/38 HIGH/7 MEDIUM/121 LOW，aggregate 746 direct/2,012 impacted/445 process hits；前三个
  高风险错误类 direct 保持 16/44/13，process 均保持 10。风险/impacted 的小幅变化来自五个临时根簇收敛
  到 Model Invocation ownership，不解释为行为风险消失。`detect-changes` all/compare `develop` 分别为
  12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git 基线，因此仅作
  补充证据，不能替代逐节点 impact 与运行门。

### AI Model Provider Credential ratchet

- Provider Credential contract、administration/catalog、SQLite/PostgreSQL repository、management identity
  ledger/audit query、连接测试 contract/repository 与 projected Secret material 十文件进入
  `src/model-provider-credential/`。这条目录拥有 binding/authorization → 管理/CAS → 持久化/审计 →
  连接验证 → 短生命周期 Secret material 的闭环；`openAiCompatibleProvider.ts`、
  `projectedModelGatewayAuthority.ts`、`localModelInvocationFeatureActivation.ts` 与
  `modelInvocationMigration.ts` 仍属于 Provider/Gateway 或跨 AI feature composition，不按名称前缀混入。
  迁移前 5,659 行，新增 3 行 ownership 注释后 `@qinglong/ai` 为 39,778 行；root 45→35、nested
  10→20、hard cap 45→35、total=55，workspace 仍为 19 个 package。
- root、provider-credential、administration、catalog、PostgreSQL storage、management identity ledger、
  management audit query、test contract、test PostgreSQL storage、projected Secret material 与 local storage
  十一个 entry 的 export count/digest 保持 172/`8dbaba681822a7ce`、9/`059b72cf919dafa5`、
  7/`e69be54962278aa1`、10/`9d6a28c8f8649c22`、2/`ca768b472c3df630`、
  5/`c4fe4108c8f71ffc`、9/`364fdb40966f266a`、21/`c95dc584ad1b9b33`、
  12/`5bd9c54d02e26de6`、4/`73f537fe3011c9a2`、1/`e3a4c7cdfa0797aa`。public specifier 不变并
  直接映射嵌套 dist；clean build 后十个旧根 source 与 40 个旧根 dist 派生路径均不存在，没有 facade。
- 编辑前逐项检查 270 个 function/class/method upstream impact：32 CRITICAL/37 HIGH/6 MEDIUM/
  195 LOW，aggregate 500 direct/1,097 impacted/39 process hits；编辑前已显式告警。本批只改变物理路径、
  relative import、package export target、deep-test/HA require 与 root cap，不改变 credential digest/
  authorization lease、Secret 擦除、catalog hash chain/CAS、SQLite `BEGIN IMMEDIATE`、PostgreSQL
  SERIALIZABLE/least privilege、identity anti-rollback、content-free audit、test plan/quota/execution/result 或
  commit-response-loss replay 语义。
- 定向测试 41/41、AI package 199 pass/3 条件 skip；clean 19-package build 与完整 package 门退出 0，
  完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、Edge import、Cluster deployment
  与 Worker deployment 五项静态审计均 compatible/零 finding；边界精确报告 total=55、root=35、
  nested=20、hard cap=35、source lines=39,778。联网 production dependency audit 因外发依赖元数据策略
  限制未重跑；缺参数的运行态 schema/receipt CLI 不计入静态架构门。
- 十档 artifact 均 `compatible=true`。六个非 AI 制品与前批完全一致：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152。四个 AI 制品因十个 export target 与编译路径变长各增加 1,038 bytes，成为
  4,861,919/4,861,979 与 5,942,872/5,943,028 bytes；文件数仍为 381/475，package/module closure 不变，
  低于 5/6 MiB hard cap。非 AI 路由器与 Standalone runtime 零字节、零 importer 增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：Credential Catalog、Management Identity Ledger 与 Test
  Connection 在 timeline 1→2 晋升前复制并于晋升后存活；test execution exact replay、completion COMMIT
  response loss、least-privilege tester、content-free durable rows、旧主 fence/`pg_rewind`/只读同步 rejoin 与
  两个 fresh control replica 全绿，门前后 ql3-ha Docker 容器为零。
- GitNexus 增量刷新为 42,396 nodes/96,276 edges/1,675 clusters/265 flows。迁移后同一 270 个节点为
  0 CRITICAL/3 HIGH/25 MEDIUM/242 LOW，aggregate 500 direct/1,096 impacted/39 process hits。direct 与 process
  完全不变，risk/impacted 的变化来自根层临时簇收敛到 Model Provider Credential ownership，不解释为
  行为风险消失。`detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0
  affected process；QL3 新树尚未完整进入 Git 基线，因此该结果只作补充证据。

### AI Prompt Output ratchet

- Prompt Output 没有按十九个文件名机械收成一个平铺目录：Artifact、Completion、Read、Retention 四个核心
  contract 位于 `src/prompt-output/`；Key Retirement、Key Rotation、Keyring Manifest、File Keyring 与
  Projected Keyring 位于 `key-management/`；External Custody、Custody Bundle 与 Recovery Authorization
  位于 `custody/`；SQLite/PostgreSQL Artifact、Retention、Key Retirement/Rotation 七个 adapter 位于
  `storage/`。依赖方向保持 core → key management → custody/storage；Model Invocation、Prompt execution
  与跨 AI feature lifecycle 仍通过显式上层依赖组合，没有创建 `common`、facade、新 workspace package、
  dependency、migration、Pool、process、listener、timer 或 watcher。
- 十九文件迁移前共 8,481 行，仅新增 6 行 ownership 说明后 `@qinglong/ai` 为 39,784 行；package 保持
  55 个 source file，root 35→16、nested 20→39、hard cap 35→16，workspace 仍为 19 包。根入口、Profile、
  Prompt execution/executor 与十九个 Prompt Output 公开 specifier 的 export count/digest 全部保持不变；
  clean build 后十九个旧根 source 与 76 个旧根 dist 派生路径均不存在，没有兼容 facade。
- 编辑前逐项检查 350 个 function/class/method upstream impact：44 CRITICAL/64 HIGH/11 MEDIUM/
  231 LOW，aggregate 875 direct/2,646 impacted/73 process hits；编辑前已显式告警。本批只改变物理路径、
  relative/dynamic import、package export target、deep-test/HA require 与 root cap，不改变 AES-256-GCM、
  Artifact identity/digest、Completion atomicity、retention/GC、key retirement/rotation CAS、Keyring material
  proof、external custody signature/recovery approval、SQLite `BEGIN IMMEDIATE`、PostgreSQL SERIALIZABLE/
  advisory fence、least privilege 或 commit-response-loss convergence。
- Prompt Output 定向 47/47、AI package 199 pass/3 条件 skip；clean 19-package build 与完整 package 门退出
  0，完整后端 1,097 pass/2 skip/0 fail。Cluster dependency、package boundary、Edge import、Cluster
  deployment 与 Worker deployment 五项边界/部署审计均 compatible/零 finding；边界精确报告 total=55、
  root=16、nested=39、hard cap=16、source lines=39,784。无参数 schema readiness 与 receipt audit 属于需要
  外部数据库/本地配置的运行态门，本轮缺配置失败未伪装为静态门通过；联网 production dependency audit
  因外发依赖元数据策略限制未重跑。
- 十档 artifact 均 `compatible=true`。六个非 AI 制品与前批完全一致：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152。四个 AI 制品因十九个编译与 source-map 路径变长各增加 2,062 bytes，成为
  4,863,981/4,864,041 与 5,944,934/5,945,090 bytes；文件数仍为 381/475，package/module closure 不变，
  低于 5/6 MiB hard cap。非 AI 路由设备与 Standalone runtime 零字节、零 importer 增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：Prompt Output Artifact 原子提交、GC tombstone、Key
  Retirement durable fence、Key Rotation response-loss recovery 与历史 Artifact 解密均通过；optional AI
  schema 和 Prompt facts 在 timeline 1→2 晋升前复制并于晋升后存活，旧主先 fence，再以 `pg_rewind`
  只读同步 rejoin，两个 fresh control replica ready。门后 ql3-ha Docker 容器、网络、卷均为零。
- GitNexus 增量刷新为 42,401 nodes/96,281 edges/1,675 clusters/265 flows。迁移后同一 350 个节点为
  10 CRITICAL/18 HIGH/32 MEDIUM/290 LOW，aggregate 875 direct/2,646 impacted/73 process hits；direct、
  impacted 与 process 精确不变，risk 标签下降来自四层 ownership 聚类收敛，不解释为行为风险消失。
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；
  QL3 新树尚未完整进入 Git 基线，因此只作补充证据。下一批处理 Pricing，Provider/Gateway 与跨 feature
  lifecycle 继续留在上层 composition。

### AI Pricing ratchet

- `pricing.ts`、Model Price Catalog contract 与 management service 进入 `src/pricing/`，SQLite/PostgreSQL
  catalog repository 进入 `src/pricing/storage/`。Catalog 的定义、管理与方言 adapter 构成同一 Price
  Catalog ownership；`usageLedger.ts` 与 `usageQuota.ts` 是消费计量/配额兄弟域，
  `modelInvocationMigration.ts` 和 `profileComposition.ts` 是跨 feature/schema composition，均未按相邻
  文件名混入。没有新增 workspace package、facade、生产 dependency、migration、Pool、process、listener、
  timer、watcher 或常驻价格服务。
- 五文件迁移前共 4,485 行，仅新增 3 行 ownership 说明后 `@qinglong/ai` 为 39,787 行；package 保持
  55 个 source file，root 16→11、nested 39→44、hard cap 16→11，workspace 仍为 19 包。root、Profile、
  Pricing、Price Catalog、Catalog Management、Local storage 与 PostgreSQL storage 七个 entry 的 export
  count/digest 保持 172/`8dbaba681822a7ce`、9/`e33b8d78c4843501`、21/`76fb39ce337f6573`、
  17/`efc4b61fbbd41b01`、21/`adab0109a27e6b4c`、1/`8c6bca31fc442596`、
  2/`fad2ab4ec0d20123`；clean build 后五个旧根 source 与旧根 dist 派生路径均不存在，没有 facade。
- 编辑前逐项检查 167 个 function/class/method upstream impact：48 CRITICAL/36 HIGH/7 MEDIUM/
  76 LOW，aggregate 502 direct/1,701 impacted/80 process hits；编辑前已显式告警。本批只改变物理路径、
  relative/dynamic import、package export target、deep-test/HA require 与 root cap，不改变 decimal money/
  token normalization、catalog revision/digest/CAS、quote/settlement、SQLite `BEGIN IMMEDIATE`、PostgreSQL
  SERIALIZABLE/least privilege、usage/quota 原子提交或 commit-response-loss convergence。
- Pricing 定向测试 13 pass/1 PostgreSQL 条件 skip、AI package 199 pass/3 条件 skip；clean 19-package
  build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/0 fail。Cluster dependency、package
  boundary、Edge import、Cluster deployment 与 Worker deployment 五项审计均 compatible/零 finding；
  边界精确报告 total=55、root=11、nested=44、hard cap=11、source lines=39,787。联网 production
  dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 均 `compatible=true`。六个非 AI 制品与前批完全一致：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152。四个 AI 制品因五个编译与 source-map 路径变长各增加 519 bytes，成为
  4,864,500/4,864,560 与 5,945,453/5,945,609 bytes；文件数仍为 381/475，package/module closure 不变，
  低于 5/6 MiB hard cap。非 AI 路由设备与 Standalone runtime 零字节、零 importer 增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、晋升前
  复制、旧主先 fence、`pg_rewind` 后只读同步 rejoin，以及两个 fresh control replica 全绿；业务
  Pricing/Catalog/settlement 门随完整 AI/Prompt gate 保持通过。门后 ql3-ha Docker 容器、网络、卷均为零。
- GitNexus 增量刷新为 42,409 nodes/96,284 edges/1,680 clusters/265 flows。迁移后同一 167 个节点为
  10 CRITICAL/18 HIGH/24 MEDIUM/115 LOW，aggregate 502 direct/1,701 impacted/80 process hits；direct、
  impacted 与 process 精确不变，risk 标签下降来自 Pricing core/storage ownership 聚类收敛，不解释为
  行为风险消失。`detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/
  0 affected process；QL3 新树尚未完整进入 Git 基线，因此只作补充证据。下一批必须先证明剩余
  Usage/Metering 或 Gateway/Provider/Composition 的真实 ownership，再决定是否下沉，不能以根文件清零
  代替架构裁决。

### AI Usage ratchet

- `usageLedger.ts` 与 `usageQuota.ts` 进入 `src/usage/`。Ledger 拥有 completion 派生的不可变 content-free
  计量事实与有界查询/汇总，Quota 拥有 admission reservation、window usage 与 completion settlement；
  两者共同形成 Usage governance，并由 Model Invocation repository/coordinator、Pricing、Gateway、Prompt
  Output completion 与 Profile composition 显式消费。它们没有并入 Pricing，也没有拉入跨 feature
  migration/activation；没有新增 facade、workspace package、生产 dependency、migration、Pool、process、
  listener、timer、watcher 或后台计费服务。
- 两文件迁移前共 1,035 行，新增两条 ownership 说明与相邻可读性空行后 `@qinglong/ai` 为 39,791 行；
  package 保持 55 个 source file，root 11→9、nested 44→46、hard cap 11→9，workspace 仍为 19 包。
  root、Profile、Usage Ledger 与 Usage Quota 四个 entry 的 export count/digest 保持
  172/`8dbaba681822a7ce`、9/`e33b8d78c4843501`、10/`3fb920194d30b618`、
  18/`6e152ba70b48d149`；clean build 后两个旧根 source 与旧根 dist 派生路径均不存在，没有 facade。
- 编辑前逐项检查 48 个 function/class/method upstream impact：25 CRITICAL/4 HIGH/1 MEDIUM/18 LOW，
  aggregate 171 direct/780 impacted/218 process hits；`ModelInvocationAuditSink` 的 inline type path 另为
  HIGH、15 direct/44 impacted。编辑前已显式告警。本批只改变物理路径、relative/inline type import、
  package export target、deep-test/HA require 与 root cap，不改变 Ledger digest/query bounds、Quota window/
  reservation/settlement、Pricing link、SQLite `BEGIN IMMEDIATE`、PostgreSQL SERIALIZABLE/least privilege、
  StepRun/Completion 原子提交或 commit-response-loss convergence。
- Usage/Repository 定向测试 28 pass/1 PostgreSQL 条件 skip、AI package 199 pass/3 条件 skip；clean
  19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/0 fail。Cluster dependency、
  package boundary、Edge import、Cluster deployment 与 Worker deployment 五项审计均 compatible/零
  finding；边界精确报告 total=55、root=9、nested=46、hard cap=9、source lines=39,791。联网
  production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 均 `compatible=true`。六个非 AI 制品与前批完全一致：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152。四个 AI 制品因两个编译与 source-map 路径变长各增加 238 bytes，成为
  4,864,738/4,864,798 与 5,945,691/5,945,847 bytes；文件数仍为 381/475，package/module closure 不变，
  低于 5/6 MiB hard cap。非 AI 路由设备与 Standalone runtime 零字节、零 importer 增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：Usage Ledger、Quota reservation/settlement、Pricing 与
  completion 原子路径随完整 AI gate 保持通过；physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿。门后 ql3-ha Docker 容器、
  网络、卷均为零。
- GitNexus 增量刷新为 42,411 nodes/96,286 edges/1,680 clusters/265 flows。迁移后同一 48 个节点仍为
  25 CRITICAL/4 HIGH/1 MEDIUM/18 LOW，aggregate 171 direct/785 impacted/218 process hits；direct 与
  process 精确不变，新增的 5 个 impacted 仅来自 Usage module ownership 图邻接，不解释为调用面扩大。
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；
  QL3 新树尚未完整进入 Git 基线，因此只作补充证据。下一批裁决 Gateway contract、Provider adapter 与
  projected authority；migration/activation/profile composition 可以按 ADR 根目录例外保留。

### AI Model Gateway ratchet

- `model.ts`、`validation.ts`、`gateway.ts`、`openAiCompatibleProvider.ts` 与
  `projectedModelGatewayAuthority.ts` 共同进入 `src/model-gateway/`。Model contract 定义 provider、
  policy 与 audit port；validation 规范化输入/输出；bounded gateway 编排 Pricing/Usage/Quota；
  OpenAI-compatible adapter 实现 provider port；projected authority 从只读 manifest/Secret 构造运行时
  provider 与 policy。五者是一个请求纵切面，因此保持同一浅层领域目录，没有为单个 adapter 或
  authority 再建立只有一个文件的子目录。`localModelInvocationFeatureActivation.ts`、
  `modelInvocationMigration.ts` 与 `profileComposition.ts` 仍是跨 feature lifecycle/composition，连同
  `index.ts` 合理留根。
- 五文件共 2,228 行，本批未新增 ownership 注释或源码行；`@qinglong/ai` 保持 39,791 行与 55 个
  source file，root 9→4、nested 46→51、hard cap 9→4，workspace 仍为 19 包。root、Model、Gateway、
  Profile、Projected Authority 与 OpenAI-compatible 六个 entry 的 export count/digest 保持
  172/`8dbaba681822a7ce`、10/`b178e1d066b03183`、10/`6a870624656306b1`、
  9/`e33b8d78c4843501`、5/`0a5c4ba93c1f7034`、4/`bce1fed0c3839a10`；clean build 后五个旧根
  source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 96 个 function/class/method upstream impact：5 CRITICAL/22 HIGH/6 MEDIUM/63 LOW，
  aggregate 208 direct/591 impacted/24 process hits；编辑前已显式告警。本批只改变物理路径、相对/动态
  import、package export target、deep-test/HA require 与 root cap，不改变 provider request/response、
  policy enforcement、audit、deadline、pricing quote、quota reservation、usage settlement、credential
  material 或 Profile activation/deactivation 语义。刷新后为 5 CRITICAL/14 HIGH/9 MEDIUM/68 LOW，
  aggregate direct/impacted/process 精确不变；风险标签变化来自 ownership 聚类重算，不解释为行为风险
  消失。
- Gateway/Provider/Profile 定向测试 43/43、AI package 199 pass/3 条件 skip；clean 19-package build 与
  完整 package 门退出 0，完整后端 1,097 pass/2 skip/0 fail。Cluster dependency、package boundary、
  Edge import、Cluster deployment 与 Worker deployment 五项审计均 compatible/零 finding；边界精确报告
  total=55、root=4、nested=51、hard cap=4、source lines=39,791。联网 production dependency audit 因
  外发依赖元数据策略限制未重跑。
- 十档 artifact 均 `compatible=true`。六个非 AI 制品与前批完全一致：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152。四个 AI 制品因五个编译与 source-map 路径变长各增加 311 bytes，成为
  4,865,049/4,865,109 与 5,946,002/5,946,158 bytes；文件数与 package/module closure 不变，仍低于
  5/6 MiB hard cap。非 AI 路由设备与 Standalone runtime 零字节、零 importer 增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：完整 AI/Gateway gate、physical streaming/
  `remote_apply`、timeline 1→2、晋升前复制、旧主 fence、`pg_rewind` 后只读同步 rejoin，以及两个 fresh
  control replica 全绿；门后 ql3-ha Docker 容器、网络、卷均为零。
- GitNexus 刷新为 42,409 nodes/96,288 edges/1,676 clusters/265 flows。`detect-changes` all/compare
  `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git
  基线，因此只作补充证据。AI 根目录至此只剩四个公开/组合入口，不再为“根目录清零”继续移动；下一批
  转向 `@qinglong/local-owner-cli` 的真实 command-family ownership。

### Local Owner Lifecycle and Deployment ratchet

- Adoption、Setup、Readiness 的 command/inspection 与一对一 CLI 共六文件进入 `src/lifecycle/`；
  `localDeployment.ts` 与 `localDeploymentCli.ts` 进入已有 `src/deployment/`，与 contract、render、Compose
  revision/preflight/apply/restore/evidence 等十个具体 capability 相邻。Lifecycle 表示本机安装生命周期的
  短期 ceremony/inspection，不是横切技术层；Deployment 继续拥有部署 composition。总 Owner 入口
  `index.ts`/`cli.ts` 和其余独立 command family 留根，没有建立 `commands/` 杂物目录或新 package。
- 八文件迁移前共 1,977 行，新增八条 ownership 说明后 `@qinglong/local-owner-cli` 为 20,703 行；
  package 保持 48 个 source file，root 38→30、nested 10→18、hard cap 38→30，workspace 仍为 19 包。
  root、Adoption、Setup、Readiness、Deployment 五个 entry 的 export count/digest 保持
  3/`5586e9b828816c8c`、3/`9cb3545bdb27b4ab`、4/`42839ffbc9f457a3`、
  5/`86c4f8322d3e1954`、22/`862da8ccaca87076`；`ql3-adoption`、`ql3-local-setup`、
  `ql3-local-readiness`、`ql3-local-deploy` 四个 bin 名保持不变，clean build 后八个旧根 source/dist 路径
  均不存在，没有 facade。
- 编辑前逐项检查 57 个 function/class/method upstream impact：0 CRITICAL/6 HIGH/2 MEDIUM/49 LOW，
  aggregate 92 direct/205 impacted/0 process hits；`LocalSetupConfigurationError` 为 HIGH、14 direct/
  26 impacted，另外五个 setup normalization helper 为 HIGH，编辑前已显式告警。本批只改变物理路径、
  相对 import、package export/bin target、deep-test/live-contract path、authority-audit allowlist 与 root cap，
  不改变 private command、POSIX ownership/mode、SQLite migration/readiness、key provisioning、Compose
  revision/CAS/restore/evidence 或错误码语义。刷新后为 0 CRITICAL/0 HIGH/3 MEDIUM/54 LOW，aggregate
  direct/impacted/process 精确不变；risk 标签下降来自 lifecycle/deployment ownership 聚类重算。
- Owner CLI 100/100；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 均 compatible/零 finding；边界精确报告 total=48、root=30、nested=18、hard cap=30、
  source lines=20,703。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes。Owner CLI 是短生命周期部署/管理
  制品，不进入这些路由设备/application runtime closure，因此文件数、package/module closure 与字节均
  零增量。参数化 Compose release-image live contract 需要外部已发布 pinned digest；本地无该制品，
  无参数 usage failure 未计作通过或回归，真实 digest 门仍固定在 image release CI。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker 容器、
  网络、卷均为零。
- GitNexus 刷新为 42,413 nodes/96,290 edges/1,678 clusters/265 flows。`detect-changes` all/compare
  `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git
  基线，因此只作补充证据。下一批裁决 Plugin Package command family 的真实共同 ownership，不把所有
  剩余 CLI 机械归入一个目录。

### Local Owner Plugin Package command ratchet

- `pluginPackageCommand`、Catalog、Publisher Trust、Workflow 与 Prompt 五对 Command/CLI 共十文件进入
  单一浅层 `src/plugin-package/`。它们分别管理 lifecycle、recovery catalog、publisher trust、
  generation-bound Workflow 与 server-derived Prompt，但都以同一安装/发布 aggregate 为边界，并由
  Local Owner 的 private command-file transport 暴露。因此本批没有为五对文件再创建五个两文件微目录，
  也没有建立横切 `commands/` 技术层；AI feature/price/credential、Identity/Security/Policy 与
  Task/Trigger 继续留给独立 ownership 批次。
- 十文件迁移前共 4,666 行，五个 Command 各增加一条 ownership 说明后
  `@qinglong/local-owner-cli` 为 20,708 行；package 保持 48 个 source file，root 30→20、nested
  18→28、hard cap 30→20，workspace 仍为 19 包。root、Package、Catalog、Publisher Trust、Workflow、
  Prompt 六个 entry 的 export count/digest 保持 3/`5586e9b828816c8c`、3/`8c36509d24d4d501`、
  5/`54ee5796fe423fa8`、3/`a3bcee1cde437e08`、3/`b4d8fedf8fdc3c65`、
  7/`3129d749c9c382a9`；`ql3-package`、`ql3-package-catalog`、`ql3-package-trust`、`ql3-workflow` 与
  `ql3-prompt` 五个 bin 名保持不变，clean build 后十个旧根 source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 126 个 function/class/method upstream impact：1 CRITICAL/10 HIGH/0 MEDIUM/
  115 LOW，aggregate 180 direct/310 impacted/19 process hits；Catalog configuration error 为 CRITICAL、
  13 direct/21 impacted，Package/Publisher Trust/Workflow/Prompt configuration error 与 Prompt unavailable
  error 为 HIGH，编辑前已显式告警。本批只改变物理路径、package export/bin target、deep-test path、
  authority-audit allowlist 与 root cap，不改变认证、Project/RoleBinding/Policy fence、approved action、
  trust keyset、catalog publication、Workflow admission、Prompt Provider I/O、exact replay 或错误码语义。
  刷新后为 0 CRITICAL/0 HIGH/6 MEDIUM/120 LOW，aggregate direct/impacted/process 精确不变；risk 标签下降
  来自统一 Plugin Package ownership 聚类。
- Owner CLI 100/100；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 均 compatible/零 finding；边界精确报告 total=48、root=20、nested=28、hard cap=20、
  source lines=20,708。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes。短生命周期 Owner CLI 不进入这些
  路由设备/application runtime closure，因此文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：Plugin Package Prompt/Workflow/Publisher Trust 业务门、
  physical streaming/`remote_apply`、timeline 1→2、旧主 fence、`pg_rewind` 后只读同步 rejoin 与两个
  fresh control replica 全绿；门后 ql3-ha Docker 容器、网络、卷均为零。
- GitNexus 刷新为 42,422 nodes/96,292 edges/1,685 clusters/265 flows。`detect-changes` all/compare
  `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git
  基线，因此只作补充证据。下一批裁决 AI Feature、Model Price 与 Provider Credential 六文件的共同
  AI management ownership，不按文件相邻关系混入其它命令族。

### Local Owner AI Management command ratchet

- `aiFeatureCommand/Cli`、`modelPriceCatalogCommand/Cli` 与 `modelProviderCredentialCommand/Cli` 六文件
  共同进入单一浅层 `src/ai-management/`。三者分别管理可选 AI Feature schema/lifecycle、Model Price
  Catalog 与绑定 Local Secret 的 Provider Credential，但共享显式 AI feature fence 和短生命周期 Owner
  管理入口。Plugin Package Prompt 继续留在 `src/plugin-package/`，没有因 AI 名称相邻被重复归类；也没有
  为三对文件制造三个微目录或新 package。
- 六文件迁移前共 2,447 行，三个 Command 各增加一条 ownership 说明后
  `@qinglong/local-owner-cli` 为 20,711 行；package 保持 48 个 source file，root 20→14、nested
  28→34、hard cap 20→14，workspace 仍为 19 包。root、AI Feature、Model Price 与 Model Provider
  Credential 四个 entry 的 export count/digest 保持 3/`5586e9b828816c8c`、
  5/`6b957db62b60291b`、3/`0a658286b6ecd5ad`、6/`486ba6a511737e3f`；`ql3-ai-feature`、
  `ql3-model-price`、`ql3-model-credential` 三个 bin 名保持不变，clean build 后六个旧根 source/dist 路径
  均不存在，没有 facade。
- 编辑前逐项检查 85 个 function/class/method upstream impact：0 CRITICAL/3 HIGH/0 MEDIUM/82 LOW，
  aggregate 111 direct/198 impacted/0 process hits；AI Feature、Model Price、Provider Credential 三个
  configuration error 分别为 HIGH 9/12、11/15、10/13 direct/impacted，编辑前已显式告警。本批只改变
  物理路径、package export/bin target、direct-test path、dependency-audit fixture/allowlist 与 root cap，
  不改变 schema activation、价格目录、Secret 引用/凭据绑定、Project/Policy fence 或错误码语义。刷新后
  为 0 CRITICAL/0 HIGH/3 MEDIUM/82 LOW，aggregate direct/impacted/process 精确不变；risk 标签下降来自
  AI Management ownership 聚类。
- Owner CLI 100/100；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 均 compatible/零 finding；边界精确报告 total=48、root=14、nested=34、hard cap=14、
  source lines=20,711。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes。短生命周期 Owner CLI 不进入这些
  路由设备/application runtime closure，因此文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：AI Feature/Provider Credential 业务门、physical
  streaming/`remote_apply`、timeline 1→2、旧主 fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh
  control replica 全绿；门后 ql3-ha Docker 容器零残留。
- GitNexus 刷新为 42,418 nodes/96,294 edges/1,679 clusters/265 flows。`detect-changes` all/compare
  `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git
  基线，因此只作补充证据。下一批裁决 Identity Credential、Secret、Project Policy 与 Security Audit
  Query 八文件的共同安全管理 ownership，优先单一浅层目录，不建立四个两文件微目录。

### Local Owner Security Management command ratchet

- `identityCredentialCommand/Cli`、`secretCommand/Cli`、`projectPolicyCommand/Cli` 与
  `securityAuditQueryCommand/Cli` 八文件共同进入单一浅层 `src/security-management/`。四者分别管理
  Identity/API Credential、加密 Local Secret、Project lifecycle/RoleBinding/Policy 与 Security Audit
  inspection/retention，但都由私有 command-file、Owner credential、authenticated-management fence 和
  SecurityAudit 原子闭环约束。各自 authority 继续通过明确的 Local Admin/SQLite/Runtime Core subpath
  隔离；目录共同 ownership 不合并权限。TaskDefinition/Trigger 留给独立自动化批次，没有制造四个微目录。
- 八文件迁移前共 3,609 行，四个 Command 各增加一条 ownership 说明后
  `@qinglong/local-owner-cli` 为 20,715 行；package 保持 48 个 source file，root 14→6、nested
  34→42、hard cap 14→6，workspace 仍为 19 包。root、Identity Credential、Secret、Project Policy 与
  Security Audit 五个 entry 的 export count/digest 保持 3/`5586e9b828816c8c`、
  5/`a532bbca27b11a48`、3/`7db38cb2284b82db`、3/`875518069228bcbd`、
  3/`a1a48d787ef056df`；`ql3-identity`、`ql3-secret`、`ql3-policy`、`ql3-audit` 四个 bin 名保持不变，
  clean build 后八个旧根 source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 93 个 function/class/method upstream impact：0 CRITICAL/8 HIGH/1 MEDIUM/84 LOW，
  aggregate 134 direct/235 impacted/23 process hits。Identity/Policy/Audit configuration error 与五个 Policy
  path/operation helper 为 HIGH，编辑前已显式告警。本批只改变物理路径、package export/bin target、
  direct-test path、dependency-audit allowlist/fixture 与 root cap，不改变 credential/Secret material custody、
  Project/RoleBinding CAS、authentication/authorization fence、audit redaction/retention 或错误码语义。刷新后
  为 0 CRITICAL/1 HIGH/3 MEDIUM/89 LOW，aggregate direct/impacted/process 精确不变；
  `LocalIdentityCredentialCommandConfigurationError` 仍以 15 direct/17 impacted 保持 HIGH，没有因目录聚类
  隐藏真实风险。
- Owner CLI 100/100、cluster dependency 定向测试 47/47；clean 19-package build 与完整 package 门退出 0，
  完整后端 1,097 pass/2 skip/0 fail。首次 sandbox 内完整 package 并发门仅取消 AI Prompt crash matrix，
  该 matrix 单独 1/1 通过，随后沙箱外按相同并发完整重跑退出 0。Cluster dependency、package boundary、
  Edge import、Cluster deployment、Worker deployment 与 Local image audit 均 compatible/零 finding；边界
  精确报告 total=48、root=6、nested=42、hard cap=6、source lines=20,715。联网 production dependency
  audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes。短生命周期 Owner CLI 不进入这些
  路由设备/application runtime closure，因此文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：Security/Policy 所依赖的 durable fence 业务门、physical
  streaming/`remote_apply`、timeline 1→2、旧主 fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh
  control replica 全绿；门后 ql3-ha Docker 容器零残留。
- GitNexus 刷新为 42,419 nodes/96,296 edges/1,678 clusters/265 flows。`detect-changes` all/compare
  `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git
  基线，因此只作补充证据。下一批裁决 TaskDefinition 与 Trigger 四文件的共同 Automation Management
  ownership；若成立，Owner CLI 根层将只保留 `index.ts` 与总入口 `cli.ts`。

### Local Owner Automation Management command ratchet

- `taskDefinitionCommand/Cli` 与 `triggerCommand/Cli` 四文件共同进入单一浅层
  `src/automation-management/`。TaskDefinition 负责可执行定义的版本化 authoring/inspection，Trigger 负责
  绑定定义的调度 authoring/inspection；两者采用同构的私有 command-file、Owner authentication、SQLite
  administration、Policy fence 与 SecurityAudit 闭环，并与 Cluster Admin 的 Automation Management
  capability 命名一致。没有建立两个两文件微目录，也没有把 scheduler/runtime authority 引入 Owner CLI。
- 四文件迁移前共 1,442 行，两个 Command 各增加一条 ownership 说明后
  `@qinglong/local-owner-cli` 为 20,717 行；package 保持 48 个 source file，root 6→2、nested
  42→46、hard cap 6→2，workspace 仍为 19 包。根层只剩公开 `index.ts` 与 process composition
  `cli.ts`，达到本 ADR 的根目录验收条件，不继续为“零文件”移动。root、TaskDefinition 与 Trigger 三个
  entry 的 export count/digest 保持 3/`5586e9b828816c8c`、3/`fe912559a4ceb2a3`、
  3/`619c5cc0b7d7c17a`；`ql3-task`、`ql3-trigger` 两个 bin 名保持不变，clean build 后四个旧根
  source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 42 个 function/class/method upstream impact：0 CRITICAL/2 HIGH/2 MEDIUM/38 LOW，
  aggregate 72 direct/126 impacted/0 process hits；TaskDefinition/Trigger configuration error 均为 HIGH、
  各 12 direct/15 impacted，编辑前已显式告警。本批只改变物理路径、package export/bin target、direct-test
  path、dependency-audit allowlist/fixture 与 root cap，不改变定义/触发器 revision CAS、Policy/credential
  fence、审计耦合、语义校验或错误码。刷新后为 0 CRITICAL/0 HIGH/4 MEDIUM/38 LOW，aggregate
  direct/impacted/process 精确不变；risk 标签下降来自统一 Automation Management ownership 聚类。
- Owner CLI 100/100、cluster dependency 定向测试 47/47；clean 19-package build 与完整 package 门退出 0，
  完整后端 1,097 pass/2 skip/0 fail。Cluster dependency、package boundary、Edge import、Cluster
  deployment、Worker deployment 与 Local image audit 均 compatible/零 finding；边界精确报告 total=48、
  root=2、nested=46、hard cap=2、source lines=20,717。联网 production dependency audit 因外发依赖
  元数据策略限制未重跑。
- 十档 runtime artifact 的稳定结果均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes。并行审计时 Edge Application AI
  曾因临时裁剪竞争报告 5,912,398 bytes，单档重跑恢复 5,946,002；以隔离重跑作为稳定证据。短生命周期
  Owner CLI 不进入路由设备/application runtime closure，文件数与 package/module closure 零增量。
- PostgreSQL 18.4 arm64 HA 首轮在晋升后的 Remote Workflow cancellation 检查出现一次
  `worker_unavailable` fence，失败路径完整清理 Docker；随后相同全量门重跑 `gates.passed=true`：
  Automation Management inspection、physical streaming/`remote_apply`、timeline 1→2、旧主 fence、
  `pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿，门后 ql3-ha Docker 容器零残留。
- GitNexus 刷新为 42,421 nodes/96,298 edges/1,678 clusters/265 flows。`detect-changes` all/compare
  `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git
  基线，因此只作补充证据。Owner CLI 根层至此收口；P0 队列转向 32/32 平铺的
  `@qinglong/worker-runtime`，再处理 26/26 平铺的 `@qinglong/local-admin`。

### Local Process execution and completion receipt ratchet

- `@qinglong/local-process` 被 Local Application、Local Execution 与 Worker Runtime 三个生产消费者复用，
  但都需要同一份 POSIX launcher asset、durable identity 与 completion receipt lifecycle，因此保持一个
  workspace package。launcher、controller、Linux durable identity 和 persisted inspection evidence 进入
  `src/process-execution/`；completion receipt codec、原子 file store 和 cleanup scanner/lifecycle 进入
  `src/completion-receipt/`。两个目录分别有 4/3 个文件，没有单文件微目录。
- package 保持 8 个 source file 与 1,724 行，root 8→1、nested 0→7、hard cap 8→1，workspace
  仍为 19 包，根层只保留公开 `index.ts`。唯一 public root 的 export count/digest 保持
  26/`220887278fd1b638`；clean build 后七个旧根 source/dist 路径不存在，没有 facade 或 deep import。
  launcher 从嵌套输出目录以 `../../assets/ql3-launcher.sh` 定位 bundled asset，既有 SHA-256、打开后 fd
  执行、路径替换攻击和 journal-before-spawn 测试共同证明运行资产没有因目录变化失联。
- 编辑前逐项检查 90 个 function/class/method upstream impact：1 CRITICAL/12 HIGH/3 MEDIUM/74 LOW，
  aggregate 137 direct/240 impacted/7 process hits，编辑前已对 CRITICAL/HIGH 显式告警。CRITICAL 为
  completion receipt ID 校验；HIGH 覆盖 codec 错误、receipt shard path、launcher/controller 与 Linux
  identity validation。本批只改变物理路径、barrel、launcher asset 相对层级和 root cap，不改变 receipt
  schema/唯一键/原子 hard-link publish/quarantine、`/proc` boot/start/process-group identity、TERM→KILL
  重验证、journal barrier、digest verification 或 fd execution。强制完整索引后仍为 90 个符号、137
  direct/7 process，impacted 240→239，风险为 0C/3H/6M/81L；receipt ID、launcher、controller 仍为 HIGH。
- Local Process 18/18、Local Execution 30/30、Local Application 39 pass/3 skip、Worker Runtime
  132/132。Worker 首轮沙箱内 3 个 loopback TLS 测试因 `listen EPERM` 失败，沙箱外完整重跑 132/132，
  没有把环境失败计为产品回归。完整 19-package clean build/test 退出 0，完整后端 1,097 pass/2 skip/
  0 fail；Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 全部 compatible/零 finding。联网 production dependency audit 因外发依赖元数据策略
  限制未重跑。
- 十档 runtime artifact 均 `compatible=true`。Edge/Standalone 3,530,127/3,530,175、Adopted
  4,125,685/4,125,769、AI 4,865,049/4,865,109 bytes，六档精确不变；Application
  4,613,055/4,613,199、Application AI 5,948,049/5,948,205，四档各增加 152 bytes，仅来自嵌套
  module/asset 路径字符串，文件/package/module closure 不变。最大档距 6 MiB 上限仍余 343,251 bytes。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker 容器、
  network、volume 零残留。GitNexus 完整刷新为 42,450 nodes/96,328 edges/1,677 clusters/265 flows；
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

### Local Owner Maintenance security and Prompt output ratchet

- `@qinglong/local-owner-maintenance` 是一个短生命周期、可独立部署的 Owner maintenance authority，保持
  单一 workspace package，不把四个 GC/retirement 实现按文件拆成微包。delivery acknowledgement GC 与
  pepper material GC 共同进入 `src/security-maintenance/`；Prompt output GC 与 key retirement 共同进入
  `src/prompt-output-maintenance/`。两个目录各有两个文件；根层保留 `command.ts` 与 `cli.ts` 两个真实的
  command/binary composition entry，不为 root 清零制造无意义目录。
- package 保持 6 个 source file 与 1,247 行，root 6→2、nested 0→4、hard cap 6→2，workspace 仍为
  19 包。pepper GC、acknowledgement GC、Prompt output GC、Prompt output key retirement 与 command
  五个 public specifier 保持不变，export count/digest 分别为 4/`e2b8b749b31e4ce7`、
  3/`57b60e690e47b830`、1/`829ac4b03de8b70e`、1/`e0188b2d5f4b6265`、
  3/`246ecf83bb6c11fd`；clean build 后四个旧根 source/dist 路径不存在，没有 facade。
- 编辑前与强制完整索引后，同一 54 个 function/class/method upstream impact 均为 0 CRITICAL/0 HIGH/
  3 MEDIUM/51 LOW，aggregate 58 direct/81 impacted/11 process hits。本批只改变物理路径、command 相对/
  动态 import、public export target、deep-test path、dependency-audit allowlist 与 root cap，不改变私有命令
  文件、acknowledgement bridge evidence、pepper material 双副本销毁、Prompt output tombstone、key
  retirement durable fence、least privilege 或 exact replay 语义。
- Maintenance 13/13；完整 19-package clean build/test 退出 0，完整后端 1,097 pass/2 skip/0 fail。Cluster
  dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与 Local image
  audit 全部 compatible/零 finding。无参数 schema readiness、legacy schema 与 receipt CLI 需要显式外部
  database/Profile，按契约拒绝缺参数，不伪装成静态门通过；联网 production dependency audit 因外发依赖
  元数据策略限制未重跑。
- 十档 runtime artifact 全部 `compatible=true`，且相对前批逐字节不变：Edge/Standalone
  3,530,127/3,530,175、Adopted 4,125,685/4,125,769、Application 4,613,055/4,613,199、AI
  4,865,049/4,865,109、Application AI 5,948,049/5,948,205 bytes。maintenance package 不在十档闭包中，
  因此对低配路由设备与常驻 Application/AI runtime 都是零文件、零字节增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker 容器、
  network、volume 零残留。GitNexus 完整刷新为 42,454 nodes/96,331 edges/1,678 clusters/265 flows；
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

### Local Secret custody ratchet

- `@qinglong/local-secret` 是 Local Admin、Local Application 与 Owner CLI 共享的加密 Secret authority；
  crypto、owned key material、private file keyring 与 encrypted service 共同承担一条 custody 链，因此保持
  一个 shared-leaf workspace package，并统一进入 `src/secret-custody/`，没有拆成四个微包。根层只保留
  公共 `index.ts`，也没有增加 façade、兼容 deep import、dependency、migration、process、listener 或 timer。
- package 保持 5 个 source file 与 862 行，root 5→1、nested 0→4、hard cap 5→1，workspace 仍为
  19 包。唯一 public root 的 export count/digest 保持 10/`d633fcfebfcb1f34`；clean build 后
  `crypto`、`keyMaterial`、`keyring`、`service` 四个旧根 source/dist 路径不存在。
- 编辑前逐项检查 37 个 function/class/method upstream impact：0 CRITICAL/3 HIGH/0 MEDIUM/34 LOW，
  aggregate 46 direct/71 impacted/0 process hits。HIGH 为 `ownedSecretKey`、
  `decryptLocalSecretEnvelopeToBuffer` 与 `ownedLocalSecretKeyMaterial`，编辑前已显式告警。本批只改变
  物理路径和根 barrel，不改变 AES-256-GCM/AAD、Project binding、owned buffer/zeroization、append-only
  key rotation、private mode/symlink protection、repository CAS、semantic replay 或 plaintext disposal。
  强制完整索引后同一 37 个符号为 0C/0H/0M/37L，46/71/0 精确不变；risk 标签下降只来自统一 custody
  聚类，不解释为安全风险消失。
- Local Secret 6/6；完整 19-package clean build/test 退出 0，完整后端 1,097 pass/2 skip/0 fail。Cluster
  dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与 Local image
  audit 全部 compatible/零 finding。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true`。不含 Local Secret 的 Edge/Standalone 与 AI-only 四档精确
  不变：3,530,127/3,530,175 与 4,865,049/4,865,109 bytes；包含该 package 的 Adopted、Application、
  Application AI 六档因四个嵌套 module/source-map 路径各增加 60 bytes，成为
  4,125,745/4,125,829、4,613,115/4,613,259、5,948,109/5,948,265 bytes。文件数、package/module
  closure 不变，最大档距 6 MiB hard cap 仍余 343,191 bytes。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker 容器、
  network、volume 零残留。最终 GitNexus 为 42,456 nodes/96,333 edges/1,678 clusters/265 flows；
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

### Cluster Control Application Runtime and Production Process ratchet

- `@qinglong/cluster-control` 是 Cluster 控制面的单一可执行部署边界；HTTP、Scheduler、Run、Remote
  Execution 等领域虽已下沉，剩余 application/process/config 仍是同一进程的生产组合，不具备独立部署、
  authority 或 dependency closure，因此不拆 workspace package。`application.ts`、
  `productionApplication.ts`、`aiProductionApplication.ts` 共同进入 `src/application-runtime/`；
  `config.ts` 与 `processApplication.ts` 共同进入 `src/production-process/`。根层保留公共 `index.ts`、
  `cli.ts` 与 `aiCli.ts` 三个真实入口，不为了 root 清零继续制造目录。
- package 保持 40 个 source file 与 11,585 行，root 8→3、nested 32→37、hard cap 8→3，workspace
  仍为 19 包，没有新增 dependency、migration、schema、role、Pool、listener、timer、route 或部署制品。
  root、application、production、AI production、config、process 六个公开 specifier 的 export
  count/digest 分别保持 11/`efb756ba17d47613`、2/`d95627d747ad85d2`、
  4/`ca88d1396a9946dd`、3/`24860c5bb73300e2`、3/`1a07d55cd46e61d7`、
  2/`4af26f40d197e0d6`；export target 直接映射嵌套 dist，clean build 后五个旧根 source/dist 路径
  不存在，没有 facade。
- 编辑前逐项检查 63 个 function/class/method upstream impact：0 CRITICAL/2 HIGH/1 MEDIUM/60 LOW，
  aggregate 64 direct/128 impacted/0 process hits。`ClusterControlDatabaseUnavailableError` 为
  5 direct/10 impacted，`ClusterControlConfigError` 为 11/16，编辑前已对两个 HIGH 显式告警。本批只
  修改物理路径、相对/动态 import、public export target、test/HA/audit/Docker build path 与 root cap；
  不改变 readiness→recovery→lifecycle→admission 顺序、数据库 fail-closed、TLS/HTTP drain、AI feature
  activation、S3 lazy binding、配置 exact shape/private authority path、signal shutdown 或错误映射。
  强制完整索引后仍为 63 个符号、64/128/0，风险分布变为 0C/0H/3M/60L；三个 MEDIUM 是
  `ProductionClusterAiConfigError` 5/6、Database unavailable error 5/10、production config error 11/16。
  风险标签变化来自 Application Runtime/Production Process 聚类，不解释为行为风险消失。
- Cluster Control 沙箱内首轮 compile 成功，但 20 个 listener 测试因 `listen EPERM 127.0.0.1` 失败；获得
  loopback 允许后完整重跑为 175 pass/2 skip/0 fail。完整 19-package clean build/test 退出 0，完整后端
  1,097 pass/2 skip/0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、
  Worker deployment 与 Local image audit 全部 compatible/零 finding；边界精确报告 total=40、root=3、
  nested=37、hard cap=3、source lines=11,585。联网 production dependency audit 因外发依赖元数据策略
  限制未重跑。
- 十档 runtime artifact 全部 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,125,745/4,125,829，Application 4,613,115/4,613,259，AI
  4,865,049/4,865,109，Application AI 5,948,109/5,948,265 bytes。最大档距 6 MiB hard cap 仍余
  343,191 bytes；Cluster Control/PostgreSQL/S3 authority 没有进入低配路由器或 Local runtime closure。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、`pg_rewind` 后只读同步 rejoin、scheduler/commit-response-loss exactly-once 与两个 fresh control
  replica 全绿；门后 ql3-ha Docker 容器、network、volume 零残留。最终 GitNexus 为 42,458
  nodes/96,336 edges/1,677 clusters/265 flows；`detect-changes` all/compare `develop` 分别为
  12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树尚未完整进入 Git 基线，因此
  detect 结果只是补充证据，不能替代逐节点 impact 与运行门。

### Local Owner Keyring Pepper Custody ratchet

- `@qinglong/local-owner-keyring` 由 Owner CLI、Owner Console 与 Owner Maintenance 三个短生命周期生产
  闭包复用，持有独立 POSIX pepper material authority，因此保持 shared-leaf workspace package；但其
  `destructive.ts`、`pepperFile.ts` 与 `pepperKeyring.ts` 共同形成 provision/inspect/backup/restore/destroy
  custody 链，统一进入 `src/pepper-custody/`，不再平铺，也不按文件拆三个微包。根层只保留公共
  `index.ts`，没有增加 facade、dependency、migration、process、listener、timer 或常驻 authority。
- package 保持 4 个 source file 与 1,095 行，root 4→1、nested 0→3、hard cap 4→1，workspace 仍为
  19 包。root 与 `./destructive` 两个公开 specifier 的 export count/digest 分别保持
  12/`2c1015aec88bab31` 与 1/`8a90eb461f9cbaf4`；destructive export target 直接映射嵌套 dist，
  clean build 后三个旧根 source/dist 路径不存在，没有 deep-import facade。
- 编辑前逐项检查 49 个 function/class/method upstream impact：9 CRITICAL/6 HIGH/0 MEDIUM/34 LOW，
  aggregate 138 direct/342 impacted/17 process hits。CRITICAL/HIGH 覆盖 pepper configuration/unavailable、
  bounded directory、UID/directory identity、file name/decode、key read/audit/path、provider 与 resolve，编辑前
  已显式告警。本批只修改物理路径、根 barrel、公开 export target、定向 test path 与 root cap；不改变
  absolute/bounded path、UID/inode/mode/symlink/unknown-file 防护、no-replace publication、独立 backup、
  restore-to-absence、key buffer disposal、destroy absence proof 或 exact replay。
  强制完整索引后仍为 49 个符号、138/342/17，风险为 1C/9H/1M/38L；
  `LocalOwnerPepperKeyringFileProvider` 仍为 CRITICAL（7 direct/13 impacted/2 flows），configuration、
  unavailable、directory identity、file name、key read 与 resolve 仍为 HIGH。标签变化来自 Pepper Custody
  ownership 收敛，不解释为敏感 material 风险消失。
- Keyring 定向 10/10；完整 19-package clean build/test 退出 0，完整后端 1,097 pass/2 skip/0 fail。
  Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与 Local image
  audit 全部 compatible/零 finding。package boundary 首轮准确抓到 ledger patch 误命中 AI 的 cap；修正为
  AI=4、keyring=1 后复核通过，没有用放宽 hard cap 掩盖错误。联网 production dependency audit 因外发
  依赖元数据策略限制未重跑。
- 十档 runtime artifact 全部 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,125,745/4,125,829，Application 4,613,115/4,613,259，AI
  4,865,049/4,865,109，Application AI 5,948,109/5,948,265 bytes；最大档距 6 MiB hard cap 仍余
  343,191 bytes。Local Owner Keyring 不在任何常驻路由设备、Application 或 AI runtime closure 中。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、`pg_rewind` 后只读同步 rejoin、scheduler/commit-response-loss exactly-once 与两个 fresh control
  replica 全绿；门后 ql3-ha Docker 容器、network、volume 零残留。最终 GitNexus 为 42,460
  nodes/96,338 edges/1,677 clusters/265 flows；QL3 新树尚未完整进入 Git 基线，最终 detect 结果只作
  补充证据，不能替代逐节点 impact 与运行门。

### Local Owner Console Authentication and Delivery ratchet

- `@qinglong/local-owner-console` 保持一个本机所有者安全控制台 package；Authenticated command 与
  Identity authentication 共同进入 `src/authentication/`，credential administration delivery 与 Secret
  delivery 共同进入 `src/delivery/`。package 保持 7 个 source file 与 5,426 行，root 5→1、nested
  2→6、hard cap 5→1，workspace 仍为 19 包，根层只保留公开 `index.ts`。
- 已有 `src/bootstrap/index.ts` 与 `src/credential-recovery/index.ts` 没有为了消除“单文件目录”而合并。
  二者分别持有 fresh Owner 建立与 credential recovery ceremony；dependency audit 只允许 Bootstrap 导入
  Identity authentication，并禁止 Bootstrap、Credential Recovery、Secret Delivery 之间出现未经审查的
  横向 import。目录在这里是 authority allowlist 的可验证锚点，不是视觉分组；合并会扩大高敏感内部 API。
- root、Secret Delivery、Authenticated Command、Credential Administration Delivery、Identity
  Authentication 五个公开入口的 export count/digest 保持 16/`0464f87113e9c6de`、
  2/`9db0e9bb40906ae2`、3/`332a7ece9e872c49`、2/`cb9ed41e65c0f350`、
  4/`e7413eb6519ae57d`。`bootstrap` 与 `credential-recovery` 不是公开 export，但内部构建输出的
  count/digest 仍保持 9/`f461e80fcb442deb` 与 6/`672561d400a84b64`；clean build 后四个旧根
  source/dist 路径不存在，没有 facade。
- 编辑前逐项检查 89 个 function/class/method upstream impact：2 CRITICAL/16 HIGH/4 MEDIUM/67 LOW，
  aggregate 219 direct/433 impacted/3 process hits，编辑前已对 CRITICAL/HIGH 显式告警。本批只改变物理
  路径、相对 import、public export target、dependency-audit exact path/fixture 与 root cap，不改变强身份
  authentication、TTL、command confirmation、Owner bootstrap/recovery、私有目录/原子文件发布、Secret
  acknowledgement 或 content-free receipt。强制完整索引后仍为 89 个符号、219/433/3，风险分布为
  1C/5H/8M/75L；`AuthenticatedLocalCommand.confirm` 仍为 CRITICAL，标签变化只来自目录聚类。
- Owner Console 45/45、cluster dependency 47/47；完整 19-package 门退出 0，后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 全部 compatible/零 finding。dependency audit 首轮准确暴露 path normalization 分支中
  漏定义 `targetRelative` 的审计实现错误；补齐局部变量后 47/47，通过过程没有把产品错误伪装为回归。
  联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与第八十一批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,125,685/4,125,769，Application 4,612,903/4,613,047，AI
  4,865,049/4,865,109，Application AI 5,947,897/5,948,053 bytes。Owner Console 是短生命周期本机管理面，
  未进入路由设备、Application 或 AI runtime closure，文件/package/module closure 零增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker 容器、
  network、volume 零残留。GitNexus 完整刷新为 42,447 nodes/96,325 edges/1,677 clusters/265 flows；
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

### Local Application deployment composition ratchet

- `@qinglong/local-application` 是 Edge/Standalone Application 的最终可执行部署边界，不因内部同时存在
  runtime 与 process 两个职责而拆成多个 workspace package。`activation.ts`、`contract.ts` 与
  `aiFeatureApplication.ts` 进入 `src/application-runtime/`；`processApplication.ts`、`processConfig.ts`、
  `startupReceipt.ts` 与 `pluginPackageRecoveryCatalog.ts` 进入 `src/production-process/`。两个目录分别有
  3/4 文件，没有单文件微目录；根只保留公共 `index.ts` 与 binary `cli.ts`。
- package 保持 9 个 source file，boundary 审计口径 3,681 行；root 9→2、nested 0→7、hard cap
  9→2，workspace 仍为 19 包。root、AI feature、process config、Plugin Package recovery catalog 与
  process 五个既有 specifier 的 export count/digest 分别保持 3/`b75f18080546f96b`、
  3/`e890c1d39be7ab18`、5/`3dc1d946b15bf849`、6/`df1199c3d8fb8543`、
  2/`1b0b03771e9362d0`；clean build 后旧根 source/dist 路径不存在，没有 facade。
- 编辑前逐项检查 106 个 function/class/method upstream impact：0 CRITICAL/15 HIGH/6 MEDIUM/85 LOW，
  aggregate 154 direct/274 impacted/33 process hits。HIGH 集中于 Startup Receipt 的安全路径、原子发布与
  完整性解析，以及 activation 的 stop/audit 链；编辑前已显式告警。本批只改变物理路径、相对 import、
  public export target、dependency-audit fixture 与 root cap，不改变回执摘要/原子替换、配置校验、信号
  drain、AI lazy loading、Plugin Package trust 或 application lifecycle。强制完整索引后同为 106 个符号、
  154 direct/274 impacted/33 process hits，风险分布为 0C/0H/7M/99L，标签变化只来自目录聚类。
- Local Application 39 pass/3 skip，cluster dependency 47/47；完整 19-package 门退出 0，后端
  1,097 pass/2 skip/0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、
  Worker deployment 与 Local image audit 全部 compatible/零 finding；十档 artifact 全绿。纯 Edge/
  Standalone、Adopted 与 AI-only 六档不变；Application 4,612,903/4,613,047、Application AI
  5,947,897/5,948,053 bytes，四档各增加 311 bytes，仅来自路径字符串，最大档距 6 MiB 上限仍余
  343,403 bytes。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、
  旧主 fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker
  容器、network、volume 零残留。GitNexus 完整刷新为 42,444 nodes/96,322 edges/1,677 clusters/
  265 flows；`detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/
  0 affected process。QL3 新树尚未完整进入 Git 基线，因此 detect 只作补充证据。

### Local Admin Automation Administration ratchet

- `taskDefinitionAdministration` 与 `triggerAdministration` 两个服务共同进入浅层
  `src/automation-administration/`。二者结构与调用面保持对称：强 User authentication、Project Policy、
  content-free Security Audit、definition revision CAS 与 bounded inspect/list 共同形成 Local Automation
  Administration capability，并被 Local/Cluster adapter 复用；因此没有建立两个单文件微目录，也没有拆出
  新 package。
- 两文件迁移前共 1,120 行，迁移不增加 ownership 注释，`@qinglong/local-admin` 保持 17,399 行与
  26 个 source file；root 4→2、nested 22→24、hard cap 4→2，workspace 仍为 19 包。根层只剩公开
  `index.ts` 与 runtime composition `runtime.ts`，达到本 ADR 的根目录验收条件，不为“零实现文件”移动
  composition。root、Runtime、TaskDefinition 与 Trigger 四个 entry 的 export count/digest 保持
  13/`41b52cc8f5723fe4`、2/`10786a6708098c78`、5/`b46483b5dab31ef4`、
  5/`47908786a003a149`；public specifier 不变，clean build 后两个旧根 source/dist 路径不存在，
  没有 facade。
- 编辑前逐项检查 48 个 function/class/method upstream impact：0 CRITICAL/0 HIGH/2 MEDIUM/46 LOW，
  aggregate 68 direct/104 impacted/0 process hits；两个 MEDIUM 是 TaskDefinition/Trigger configuration
  error。本批只改变物理路径、public export target、dependency-audit fixture path 与 root cap，不改变
  definition revision、Policy/credential TOCTOU fence、Security Audit、SQLite/PostgreSQL adapter contract 或
  错误码。强制完整索引后的风险分布与 aggregate 精确不变。
- Local Admin 83/83、cluster dependency 定向 contract 47/47；clean 19-package build 与完整 package 门
  退出 0，完整后端 1,097 pass/2 skip/0 fail。首次独立 boundary audit 捕获账本补丁误将 `@qinglong/ai`
  cap 4 改为 2、Local Admin 仍留 4；修正为 AI=4、Local Admin=2 后，Cluster dependency、package
  boundary、Edge import、Cluster deployment、Worker deployment 与 Local image audit 全部 compatible/零
  finding。边界精确报告 total=26、root=2、nested=24、hard cap=2、source lines=17,399；这个失败证明
  hard-cap 账本不是只报绿的装饰门。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true`。不含 Local Admin 的 Edge/Standalone
  3,530,127/3,530,175 与 AI-only 4,865,049/4,865,109 bytes 精确不变；含 Local Admin 的 Adopted
  为 4,125,685/4,125,769、Application 为 4,612,592/4,612,736、Application AI 为
  5,947,586/5,947,742 bytes，六档各增加 156 bytes。增量只来自两个 package export target 的嵌套
  路径字符串；文件、package 与 module closure 不变，最大档距 6 MiB 上限仍有 343,714-byte 余量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、未确认分区写未进入新主、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha Docker 容器、network、volume 零残留。GitNexus 完整刷新为 42,441 nodes/96,319 edges/
  1,677 clusters/265 flows；`detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与
  14/34，均 low/0 affected process。Local Admin 根层 topology 至此收口，下一阶段重新扫描 workspace 的真实
  ownership 债务，不为形式清零继续移动合法的 index/runtime composition。

### Local Admin Security Administration ratchet

- Identity Credential、Project Policy、Secret、Security Audit Query 与 Retention 五个入口共同进入浅层
  `src/security-administration/`。它们没有源码级相互导入，各自保留独立 service/repository contract，但
  都以强 User authentication、Project Policy fence、content-free Security Audit 与 Local SQLite 原子事务
  形成同一个本机 Security Administration boundary；因此没有按五个文件建立五个微目录，也没有把
  TaskDefinition/Trigger Automation administration 机械混入。
- 五文件迁移前共 3,056 行，迁移不增加 ownership 注释，`@qinglong/local-admin` 保持 17,399 行与
  26 个 source file；root 9→4、nested 17→22、hard cap 9→4，workspace 仍为 19 包。根只剩公开
  `index.ts`、runtime composition `runtime.ts` 与下一批的 TaskDefinition/Trigger administration。root、
  Runtime、Identity Credential、Project Policy、Secret、Security Audit Query 与 Retention 七个 entry 的
  export count/digest 逐项保持 13/`41b52cc8f5723fe4`、2/`10786a6708098c78`、
  5/`b711b60eec755e84`、5/`338a932546505ee5`、5/`1b09e31ece90b8ae`、
  4/`e87d9e3337d58f73`、4/`cb89ba450ef422e9`；public specifier 不变，clean build 后五个旧根
  source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 105 个 function/class/method upstream impact：0 CRITICAL/6 HIGH/5 MEDIUM/94 LOW，
  aggregate 133 direct/181 impacted/11 process hits。6 个 HIGH 全部位于 Project Policy Administration 的
  Configuration/Authentication/Authorization/Unavailable error，以及 `exactKeys`/`strongUser`，编辑前已
  显式告警。本批只改变物理路径、public export target、dependency-audit fixture path 与 root cap，不改变
  Identity/credential lifecycle、Project/RoleBinding CAS、Secret encryption、Audit pagination/retention、
  Policy/credential TOCTOU fence、SQLite transaction 或错误码。增量索引首次漏标 41 个顶层 Function，
  因而不可比较；强制完整 `--index-only` 刷新后恢复同口径 105 个符号，结果为
  0 CRITICAL/0 HIGH/8 MEDIUM/97 LOW、134 direct/183 impacted/11 process hits。+1 direct/+2 impacted 与
  risk 标签差异来自新目录聚类关系，不解释为行为安全性提升。
- Local Admin 83/83、cluster dependency 定向 contract 47/47；clean 19-package build 与完整 package 门
  退出 0，完整后端 1,097 pass/2 skip/0 fail。Cluster dependency、package boundary、Edge import、
  Cluster deployment、Worker deployment 与 Local image audit 均 compatible/零 finding；边界精确报告
  total=26、root=4、nested=22、hard cap=4、source lines=17,399。联网 production dependency audit
  因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true`。不含 Local Admin 的 Edge/Standalone
  3,530,127/3,530,175 与 AI-only 4,865,049/4,865,109 bytes 精确不变；含 Local Admin 的 Adopted
  为 4,125,529/4,125,613、Application 为 4,612,436/4,612,580、Application AI 为
  5,947,430/5,947,586 bytes，六档各增加 360 bytes。增量只来自五个 package export target 的嵌套
  路径字符串；文件、package 与 module closure 不变，最大档距 6 MiB 上限仍有 343,870-byte 余量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、未确认分区写未进入新主、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha Docker 容器、network、volume 零残留。GitNexus 完整刷新为 42,439 nodes/96,317 edges/
  1,677 clusters/265 flows；`detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与
  14/34，均 low/0 affected process。下一批把 TaskDefinition/Trigger 归入单一 Automation Administration capability，
  Local Admin 根层最终只保留 index/runtime composition，不为目录整理新增 workspace package。

### Local Admin Plugin Package ratchet

- `pluginPackageActivation`、Approved Action、Installation、Lifecycle、Management、Publisher Trust、
  Recovery Catalog、Resource Materialization、Staging 与 Workflow Administration 十文件共同进入浅层
  `src/plugin-package/`。它们共享从 staging/materialization、安装与 lifecycle，到 publisher trust、
  recovery、approved management action 和 Automation publication 的同一 Local Admin authority；目录内
  只有 Installation→Staging、Management→Approved Action、Recovery Catalog→Publisher Trust 三条直接
  引用，因此没有按文件前缀继续拆成微目录，也没有把 Security/Policy 或通用 Automation Administration
  机械混入。
- 十文件迁移前共 7,417 行，迁移不增加 ownership 注释，`@qinglong/local-admin` 保持 17,399 行与
  26 个 source file；root 19→9、nested 7→17、hard cap 19→9，workspace 仍为 19 包。root、Runtime、
  Staging、Activation、Resource Materialization、Installation、Approved Action、Management、Lifecycle、
  Recovery Catalog、Publisher Trust 与 Workflow Administration 十二个 entry 的 export count/digest
  逐项保持 13/`41b52cc8f5723fe4`、2/`10786a6708098c78`、3/`ae8c80911c856f3c`、
  2/`4bb0e97aaf40691b`、3/`e944c06fabb9d6a1`、2/`171d7d0546a196f8`、
  2/`e519d1584a3c068c`、2/`876f7aac4d27a2f0`、1/`c13d747a1e8485f8`、
  12/`660102b56e107078`、20/`b101ee591e63ee24`、6/`7deb1e29434ab096`；public
  specifier 不变，clean build 后十个旧根 source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 204 个 function/class/method upstream impact：0 CRITICAL/39 HIGH/5 MEDIUM/160 LOW，
  aggregate 431 direct/711 impacted/130 process hits。HIGH 主要集中在 Publisher Trust 的规范化、私有
  目录、retirement/revocation，Recovery Catalog publication error，以及 Workflow identity/request
  fence，编辑前已显式告警。本批只改变物理路径、public export target、内部相对引用、direct-test 与
  dependency-audit fixture path、root cap，不改变安装/生命周期事务、信任 keyset、恢复目录、资源落盘、
  Policy/identity fence、Workflow publication 或错误码。刷新后为 0 CRITICAL/31 HIGH/7 MEDIUM/166 LOW、
  425 direct/708 impacted/130 process hits，无新增 CRITICAL、direct/impacted 未放大；风险标签差异仅作
  聚类刷新证据，不解释为行为安全性提升。
- Local Admin 83/83、cluster dependency 定向 contract 47/47；clean 19-package build 与完整 package 门
  退出 0，完整后端 1,097 pass/2 skip/0 fail。Cluster dependency、package boundary、Edge import、
  Cluster deployment、Worker deployment 与 Local image audit 均 compatible/零 finding；边界精确报告
  total=26、root=9、nested=17、hard cap=9、source lines=17,399。联网 production dependency audit
  因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true`。不含 Local Admin 的 Edge/Standalone
  3,530,127/3,530,175 与 AI-only 4,865,049/4,865,109 bytes 精确不变；含 Local Admin 的 Adopted
  为 4,125,169/4,125,253、Application 为 4,612,076/4,612,220、Application AI 为
  5,947,070/5,947,226 bytes，六档各增加 450 bytes。增量只来自十个 package export target 的嵌套
  路径字符串；文件、package 与 module closure 不变，最大档距 6 MiB 上限仍有 344,230-byte 余量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、未确认分区写未进入新主、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha Docker 容器、network、volume 零残留。GitNexus 刷新为 42,437 nodes/96,315 edges/
  1,677 clusters/265 flows；`detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与
  14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git 基线，因此只作补充证据。下一批分别裁决
  Identity/Secret/Security Audit/Project Policy 与 Task Definition/Trigger 的 ownership，P0 剩余 9/26，
  不为目录整理新增 workspace package。

### Local Admin Legacy Adoption ratchet

- `legacyCrontabAdoption`、Decision Receipt、私有 Authorization File、专用 Issuer Keyring、streaming
  Review File、Decision Issuer public surface 与 policy-fenced Publisher 七文件共同进入浅层
  `src/legacy-adoption/`。它们从有界扫描/分类，经人工 decision receipt、私有授权材料与 issuer lifecycle，
  最终原子发布到 Local SQLite，形成完整 adoption capability；没有按 receipt/file/keyring 建单文件微目录，
  也没有把 Plugin Package、Security/Policy 或 Automation Administration 机械混入。
- 七文件迁移前共 3,825 行，各增加一条 ownership 说明后 `@qinglong/local-admin` 为 17,399 行；package
  保持 26 个 source file，root 26→19、nested 0→7、hard cap 26→19，workspace 仍为 19 包。root、
  Runtime 与 Decision Issuer 三个 entry 的 export count/digest 保持 13/`41b52cc8f5723fe4`、
  2/`10786a6708098c78`、11/`e3a52f4dc6f846f4`；public specifier 不变，clean build 后七个
  旧根 source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 121 个 function/class/method upstream impact：0 CRITICAL/5 HIGH/6 MEDIUM/110 LOW，
  aggregate 209 direct/450 impacted/0 process hits。HIGH 集中在 authorization file、decision receipt 的
  exact normalization 与 diagnostics traversal，编辑前已显式告警。本批只改变物理路径、public export
  target、index dynamic import/require、direct-test 与 dependency-audit fixture path、root cap，不改变
  分类语义、decision canonicalization、HMAC/私有文件、issuer key rotation、review stream、Policy fence、
  SQLite transaction 或错误码。刷新后为 0 CRITICAL/1 HIGH/7 MEDIUM/113 LOW、213 direct/
  453 impacted/0 process hits；新增四条 direct、三条 impacted 与风险标签差异来自同目录内部关系重索引，
  不解释为行为风险下降。
- Local Admin 83/83；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/0 fail。
  Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与 Local image
  audit 均 compatible/零 finding；边界精确报告 total=26、root=19、nested=7、hard cap=19、source
  lines=17,399。首次沙箱内全包门因 TLS loopback `listen EPERM` 和一个并行 crash-matrix pending 抖动
  退出 1；AI crash matrix 隔离重跑通过，允许 loopback 的 clean 完整门随后退出 0。联网 production
  dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true`。不含 Local Admin 的 Edge/Standalone
  3,530,127/3,530,175 与 AI-only 4,865,049/4,865,109 bytes 精确不变；含 Local Admin 的 Adopted
  变为 4,124,719/4,124,803、Application 4,611,626/4,611,770、Application AI
  5,946,620/5,946,776 bytes，六档各增加 618 bytes。增量只来自七条 ownership 注释与嵌套 import
  路径长度，文件、package 与依赖集合不变；最大档仍低于 6 MiB，保留 344,680-byte 余量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、未确认分区写未进入新主、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha Docker 容器、network、volume 零残留。GitNexus 刷新为 42,435 nodes/96,313 edges/
  1,677 clusters/265 flows；QL3 新树尚未完整进入 Git 基线，detect 结果只作补充证据。下一批继续裁决
  Local Admin Plugin Package ownership，P0 剩余 19/26，不为目录整理新增 workspace package。

### Worker Runtime Process Lifecycle ratchet

- `workerProcessConfig`、`workerProcessIdentity`、`workerProcessApplication` 与 `workerProcessCli` 四文件
  共同进入浅层 `src/process/`。Config 把环境变量归一为有界生产配置，Identity 装载并清零凭证与信任
  材料，Application 组合 Remote Execution 与 production lifecycle，CLI 只拥有进程信号和退出码；四者
  形成配置→身份→应用→进程入口的单一 lifecycle，因此没有为 Config/Identity 建单文件微目录，也没有
  把 `productionHeadlessApplication` 或 `productionWorkerApplication` 两层产品组合机械移入。
- 四文件迁移前共 943 行，各增加一条 ownership 说明后 `@qinglong/worker-runtime` 为 10,167 行；package
  保持 32 个 source file，root 7→3、nested 25→29、hard cap 7→3，workspace 仍为 19 包。root、Process
  Config、Process Identity、Process、Production 与 Product 六个 entry 的 export count/digest 保持
  7/`366c22d0171874b5`、2/`a3c8041114c4c3f6`、3/`6d493706e8919443`、
  2/`6005255fb66af7f3`、4/`a5d7507395c16c04`、1/`3ec041cede8c91f9`；三个 public
  process specifier 与 `ql3-worker` bin 名不变，容器 ENTRYPOINT 直接指向 `dist/process/workerProcessCli.js`。
  clean build 后四个旧根 source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 30 个 function/class/method upstream impact：0 CRITICAL/0 HIGH/2 MEDIUM/28 LOW，
  aggregate 36 direct/64 impacted/0 process hits；两个 MEDIUM 是 `WorkerProcessConfigError` 与
  `WorkerProcessIdentityError`。本批只改变物理路径、package export/bin/Docker target、direct-test path 与
  root cap，不改变环境配置校验、credential/trust 装载与清零、Remote Execution 组合、信号 drain、退出码
  或 production lifecycle。刷新后风险分布与 aggregate 精确不变。
- Worker Runtime 132/132；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 均 compatible/零 finding；边界精确报告 total=32、root=3、nested=29、hard cap=3、
  source lines=10,167。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes；Worker Process 不进入 Local
  路由设备/application closure，文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、旧主
  fence、未确认分区写未进入新主、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha Docker 容器、network、volume 零残留。GitNexus 刷新为 42,433 nodes/96,311 edges/
  1,677 clusters/265 flows；迁移前后 30 个节点保持 36 direct/64 impacted/0 process hits。
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。
  QL3 新树尚未完整进入 Git 基线，detect 结果只作补充证据。Worker 根层 topology 至此收口，下一批转向
  26/26 平铺的 `@qinglong/local-admin`，继续以 capability ownership 下沉而不是拆 workspace 微包。

### Worker Runtime Execution Plane ratchet

- `workerFileLogArtifactAllocator`、`workerPosixExecutionExecutor`、`workerCompletionCoordinator` 与
  `workerExecutionControlCoordinator` 四文件共同进入浅层 `src/execution/`。Artifact allocator 拥有
  edge/node 配额、私有文件输出与 read lease；POSIX adapter 在 durable spawn barrier 后启动进程；
  Completion 先上传 Artifact 再提交终态；Control 先重放 completion，再续租或停止精确进程并写入恢复
  证据。四者形成一个完整本地 execution plane，因此没有建立 Artifact/Executor 与 Completion/Control
  两个两文件微目录，也没有把 HTTPS transport、durable offer core 或产品组合机械混入。
- 四文件迁移前共 1,687 行，各增加一条 ownership 说明后 `@qinglong/worker-runtime` 为 10,163 行；
  package 保持 32 个 source file，root 11→7、nested 21→25、hard cap 11→7，workspace 仍为 19 包。
  root、Remote Log Artifact、POSIX Executor、Completion、Execution Control、Remote Offer Delivery、
  Production 与 Product 八个 entry 的 export count/digest 保持 7/`366c22d0171874b5`、
  5/`d34d2a0138a35e10`、2/`a2f65f719f7f5645`、2/`772cda23bc64cc1e`、
  2/`02bc8a907b2f8170`、45/`381dec6ea2b360da`、4/`a5d7507395c16c04`、
  1/`3ec041cede8c91f9`；四个 public specifier 不变，clean build 后四个旧根 source/dist 路径均不存在，
  没有 facade。
- 编辑前逐项检查 79 个 function/class/method upstream impact：1 CRITICAL/2 HIGH/5 MEDIUM/71 LOW，
  aggregate 122 direct/242 impacted/1 process hit。`WorkerRemoteLogArtifactError` 为 CRITICAL（17 direct/
  29 impacted），Execution Control error 与 Artifact uploader `upload` 为 HIGH，编辑前已显式告警。本批
  只改变物理路径、package export target、direct-test path 与 root cap，不改变 Artifact 配额/文件所有权、
  spawn barrier、进程启动、completion receipt authentication、上传顺序、lease renewal/expiry、精确停止、
  recovery evidence 或错误码语义。刷新后为 0 CRITICAL/1 HIGH/6 MEDIUM/72 LOW，aggregate
  direct/impacted/process 精确不变；标签变化来自 Execution ownership 重聚类，不解释为行为风险降低。
- Worker Runtime 132/132；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 均 compatible/零 finding；边界精确报告 total=32、root=7、nested=25、hard cap=7、
  source lines=10,163。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes；Worker execution plane 不进入 Local
  路由设备/application closure，文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA 一次 `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、
  旧主 fence、未确认分区写未进入新主、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha Docker 容器、network、volume 零残留。GitNexus 刷新为 42,432 nodes/96,309 edges/
  1,678 clusters/265 flows；迁移后 79 个节点保持 122 direct/242 impacted/1 process hit。
  `detect-changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。
  QL3 新树尚未完整进入 Git 基线，detect 结果只作补充证据。下一批裁决 `workerProcessConfig`、
  `workerProcessIdentity`、`workerProcessApplication` 与 `workerProcessCli` 的共同进程 ownership，根层保留
  `index.ts` 与两层 production product composition。

### Worker Runtime Remote Execution Core ratchet

- durable `executionInbox`、`executionInboxProcessor`、Secret-before-Artifact `executionContextMaterializer`、
  caller-driven `headlessExecutionLifecycle`、stable claim/delivery 与私有原子 `remoteOfferFileJournal` 六文件
  共同进入既有 `src/remote-execution/`。它们从 durable offer authority 经 ACK/spawn/recovery 到 supervision
  构成单一 delivery core，并由同层 public entrypoint 重导出；`transport/` 继续只拥有 HTTPS/mTLS adapter。
  Session、Artifact allocator、POSIX Executor、Completion/Control 与 process/application composition 是明确
  consumer 或相邻能力，不因 import 关系机械混入。
- 六文件迁移前共 2,713 行，各增加一条 ownership 说明后 `@qinglong/worker-runtime` 为 10,159 行；package
  保持 32 个 source file，root 17→11、nested 15→21、hard cap 17→11，workspace 仍为 19 包。root、
  Remote Offer Delivery、Production、Product 与 Session Lifecycle 五个 entry 的 export count/digest 保持
  7/`366c22d0171874b5`、45/`381dec6ea2b360da`、4/`a5d7507395c16c04`、
  1/`3ec041cede8c91f9`、4/`f1cc6ea078e4cf88`；公开 specifier 不变，clean build 后六个旧根
  source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 122 个 function/class/method upstream impact：6 CRITICAL/20 HIGH/6 MEDIUM/90 LOW，
  aggregate 279 direct/647 impacted/30 process hits，编辑前已显式告警。本批只改变物理路径、direct-test
  path 与 root cap，不改变 Inbox 状态/规范化、claim/revision、ACK/spawn barrier、recovery、文件原子性、
  supervision/drain ordering 或 Secret-before-Artifact 顺序。刷新后为 6 CRITICAL/9 HIGH/7 MEDIUM/100 LOW、
  279 direct/649 impacted/30 process hits；六个 CRITICAL 仍是同一 Inbox 规范化/错误边界，新增两条
  impacted 可达关系与风险标签差异来自 Remote Execution ownership 重聚类，不解释为行为安全性变化。
- Worker Runtime 132/132；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与 Local
  image audit 均 compatible/零 finding；边界精确报告 total=32、root=11、nested=21、hard cap=11、source
  lines=10,159。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes；Worker delivery core 不进入 Local
  路由设备/application closure，文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA 一次 `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、
  旧主 fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker
  容器零残留。GitNexus 刷新为 42,428 nodes/96,306 edges/1,677 clusters/265 flows；`detect-changes`
  all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树尚未完整
  进入 Git 基线，detect 结果只作补充证据。下一批裁决 Artifact/Completion/Execution Control/Executor
  ownership，根层继续保留 product/process composition。

### Worker Runtime Remote Execution Transport ratchet

- `remoteOfferDeliveryEntrypoint` 进入浅层 `src/remote-execution/`，共享 `workerIngressHttpsClient` 与
  Activation、Offer、Secret、Completion、Lease 五个 HTTPS client/adapter 共同进入其 `transport/`。
  public entrypoint 明确拥有 Remote Offer Delivery 的组合/export surface；六个 transport 复用同一 mTLS
  Agent、credential authority、请求边界与 fence/error contract，因此不拆成六个单文件微目录。Session、
  Credential 作为显式 sibling consumer 保持各自 ownership，process/application composition 继续留在根层。
- 七文件迁移前共 1,400 行，各增加一条 ownership 说明后 `@qinglong/worker-runtime` 为 10,153 行；package
  保持 32 个 source file，root 24→17、nested 8→15、hard cap 24→17，workspace 仍为 19 包。root、
  Remote Offer Delivery、Completion Transport、Lease Control、Session Transport、Production Credentials、
  Production 与 Product 八个 entry 的 export count/digest 保持 7/`366c22d0171874b5`、
  45/`381dec6ea2b360da`、3/`afcc241152ec20c3`、2/`41616697732827df`、
  2/`510ae69c5f7d65fa`、2/`bf1e3d635d515f67`、4/`a5d7507395c16c04`、
  1/`3ec041cede8c91f9`；三个 public specifier 不变，clean build 后七个旧根 source/dist 路径均不存在，
  没有 facade。
- 编辑前逐项检查 58 个 function/class/method upstream impact：7 CRITICAL/8 HIGH/4 MEDIUM/39 LOW，
  aggregate 129 direct/278 impacted/0 process hits，编辑前已显式告警。本批只改变物理路径、package export
  target、direct-test path 与 root cap，不改变 TLS 1.3/mTLS Agent 复用、credential 装载/清零、request/body
  cap、Session/Run Lease fence、Artifact stream、completion 或 abort/close 语义。刷新后为 0 CRITICAL/
  2 HIGH/4 MEDIUM/52 LOW，direct/impacted/process 精确不变；两项 HIGH 是共享 Ingress error/client 类型，
  风险标签变化来自 Remote Execution ownership 重聚类，不解释为行为安全性提升。
- Worker Runtime 132/132；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与 Local
  image audit 均 compatible/零 finding；边界精确报告 total=32、root=17、nested=15、hard cap=17、source
  lines=10,153。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes；Worker Transport 不进入 Local
  路由设备/application closure，文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA 一次 `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、
  旧主 fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker
  容器零残留。GitNexus 刷新为 42,428 nodes/96,305 edges/1,678 clusters/265 flows；`detect-changes`
  all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树尚未完整
  进入 Git 基线，detect 结果只作补充证据。下一批裁决 Remote Execution delivery/execution core，不移动
  product/process composition，也不为剩余文件机械造目录。

### Worker Runtime Session ratchet

- `workerExecutionCapacityOracle`、`workerSessionHttpsClient` 与 `workerSessionCoordinator` 三文件共同进入
  浅层 `src/session/`。capacity oracle 从 durable execution journal 推导可发布槽位，HTTPS client 绑定
  register/heartbeat/transition wire contract，coordinator 管理 lease、心跳与 drain，构成完整 Session
  capability。共享 `workerIngressHttpsClient` 被 offer、activation、secret、completion、lease 等调用面
  复用，留待完整 Transport 纵切面，没有因相邻 import 被错误归入 Session。
- 三文件迁移前共 722 行，各增加一条 ownership 说明后 `@qinglong/worker-runtime` 为 10,146 行；package
  保持 32 个 source file，root 27→24、nested 5→8、hard cap 27→24，workspace 仍为 19 包。root、
  Session Lifecycle、Session Transport 与 Product 四个 entry 的 export count/digest 保持
  7/`366c22d0171874b5`、4/`f1cc6ea078e4cf88`、2/`510ae69c5f7d65fa`、
  1/`3ec041cede8c91f9`；两个 public specifier 不变，clean build 后三个旧根 source/dist 路径均不存在，
  没有 facade。
- 编辑前逐项检查 45 个 function/class/method upstream impact：5 CRITICAL/7 HIGH/0 MEDIUM/33 LOW，
  aggregate 92 direct/205 impacted/0 process hits，编辑前已显式告警。本批只改变物理路径、package export
  target、direct-test path 与 root cap，不改变容量推导、Session registration/heartbeat/transition、lease
  expiry、credential/fence classification 或 drain ordering。刷新后为 0 CRITICAL/0 HIGH/4 MEDIUM/41 LOW，
  direct/impacted/process 精确不变；风险标签变化来自 Session ownership 重聚类，不解释为行为安全性提升。
- Worker Runtime 132/132；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 均 compatible/零 finding；边界精确报告 total=32、root=24、nested=8、hard cap=24、
  source lines=10,146。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes；Worker Session 不进入 Local
  路由设备/application closure，文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA 一次 `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、
  旧主 fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker
  容器零残留。GitNexus 刷新为 42,427 nodes/96,302 edges/1,680 clusters/265 flows；`detect-changes`
  all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树尚未完整
  进入 Git 基线，detect 结果只作补充证据。下一批裁决共享 Transport/Remote Execution ownership，不为
  每个 HTTPS client 建微目录。

### Worker Runtime Credential ratchet

- certificate enrollment、identity validation、原子 certificate store、renewal lifecycle 与 production
  mTLS/token provider 五文件共同进入浅层 `src/credential/`。它们覆盖生成、校验、持久化、续签与装载的
  完整凭证纵切面；`workerProcessIdentity` 仍作为进程组合入口留在根层。没有建立五个单文件微目录，也
  没有把 Session、remote execution 或 process composition 机械混入。
- 五文件迁移前共 1,770 行，各增加一条 ownership 说明后 `@qinglong/worker-runtime` 为 10,143 行；
  package 保持 32 个 source file，root 32→27、nested 0→5、hard cap 32→27，workspace 仍为 19 包。
  root、Enrollment、Store、Renewal 与 Production Credentials 五个 entry 的 export count/digest 保持
  7/`366c22d0171874b5`、2/`17100dff42dcd349`、2/`58b2ab242b6f5812`、
  2/`3edbc83bb00d28a4`、2/`bf1e3d635d515f67`；四个既有 public specifier 不变，clean build 后五个
  旧根 source/dist 路径均不存在，没有 facade。
- 编辑前逐项检查 72 个 function/class/method upstream impact：20 CRITICAL/8 HIGH/2 MEDIUM/42 LOW，
  aggregate 131 direct/304 impacted/0 process hits，编辑前已显式告警。本批只改变物理路径、package export
  target、direct-test/HA contract path 与 root cap，不改变 certificate identity/trust validation、原子
  generation store、renewal state、mTLS/token disposal、错误码或签名。刷新后为 1 CRITICAL/10 HIGH/
  2 MEDIUM/59 LOW、129 direct/281 impacted/0 process hits；差异来自 Credential ownership 重聚类，不把
  图风险标签变化解释为行为安全性提升。
- Worker Runtime 132/132；clean 19-package build 与完整 package 门退出 0，完整后端 1,097 pass/2 skip/
  0 fail。Cluster dependency、package boundary、Edge import、Cluster deployment、Worker deployment 与
  Local image audit 均 compatible/零 finding；边界精确报告 total=32、root=27、nested=5、hard cap=27、
  source lines=10,143。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 runtime artifact 均 `compatible=true` 且与前批逐字节一致：Edge/Standalone
  3,530,127/3,530,175，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，AI
  4,865,049/4,865,109，Application AI 5,946,002/5,946,158 bytes。Worker Runtime 不进入这些 Local
  路由设备/application closure，因此文件数、package/module closure 与字节均零增量。
- PostgreSQL 18.4 arm64 HA 一次 `gates.passed=true`：physical streaming/`remote_apply`、timeline 1→2、
  旧主 fence、`pg_rewind` 后只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha Docker
  容器零残留。GitNexus 刷新为 42,422 nodes/96,300 edges/1,677 clusters/265 flows；`detect-changes`
  all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树尚未完整
  进入 Git 基线，因此 detect 结果只作补充证据。下一批裁决 Worker Session/Transport ownership，不为
  每个 HTTPS client 建微目录。

### Cluster PostgreSQL Migration orchestration ratchet

- `migrate.ts`、公开 migration barrel、one-shot CLI、reviewed manifest 与 migration process 五文件进入
  `src/migration/`，与 Local SQLite 的目录语义对齐。可执行的 52 个 `pg-*` DDL 与 stream store 继续独占
  `src/migrations/`，因此 orchestration、manifest 与编号 schema change 的 ownership 没有混淆。迁移前
  673 行，CLI 增加 1 行 ownership 注释后为 674 行；root 23→18、nested 119→124、hard cap
  23→18，total=142、source lines=56,089。
- `migration`、`migration-process` 两个公开 specifier 与 `ql3-cluster-migrate` bin 名称保持不变，只把
  target 更新为嵌套 dist。root/runtime/admin/package-manager/package-executor/worker-credential-manager/
  worker-credential-executor/worker-ingress/migration/migration-process 的 export count/digest 保持
  94/`431e3c95f3e2582c`、55/`f766a6184888590b`、19/`df4d60a7337976e3`、
  24/`d0a270751e55e137`、32/`dfb1bf5135f03fc3`、20/`ec650b3043ba5f09`、
  21/`b0e1d0ba50ce8212`、10/`48d406ee559a2273`、22/`6726dcd5af10453f`、
  3/`380ebe03fcc72310`。clean build 后五个旧根 source 与 20 个旧根 dist 派生文件均不存在，
  没有 facade。
- 编辑前候选文件的 13 个 function/class/method upstream impact 全部 LOW，aggregate 12 direct/
  26 impacted、0 affected process；最大节点 `PostgresMigrationProcessConfigError` 为 4 direct/6 impacted。
  GitNexus 刷新后逐项复核仍为 13 LOW、12 direct/26 impacted/0 process，证明路径归位没有删除调用。
- 定向测试 104/104、Cluster PostgreSQL 275 pass/1 skip、clean 19-package 门退出 0、完整后端
  1,097 pass/2 skip。cluster dependency、package boundary、Edge import、Cluster/Worker deployment
  五项审计 compatible/零 finding；十档 artifact 字节、文件和 package/module closure 与前批完全一致。
  联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`：52 个主 migration、optional AI stream、remote_apply、
  timeline 1→2、旧主 fence、`pg_rewind` 只读同步 rejoin 与两个 fresh replica 全绿；门前后
  `ql3-ha-*` 容器、volume、network 均为零。GitNexus 图为 42,390 nodes/96,272 edges/1,673
  clusters/265 flows；`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均
  low/0 affected process。QL3 新树尚未完整进入 Git 基线，因此 detect 结果只作补充证据。

### Cluster PostgreSQL Run / StepRun / Attempt Authority ratchet

- Run aggregate repository、StepRun repository 与共享 Attempt advisory lock 三文件进入 `src/run/`。
  Attempt lock 的消费者跨 Remote Execution、Run Recovery 与 Worker Credential，但锁 key、row-lock ordering
  和被保护状态都属于 Run Attempt aggregate，因此放入 owning domain 并由 sibling 显式依赖，而不是建立
  `common/` 或新 package。迁移前 1,549 行，新增 2 行 ownership 注释后为 1,551 行；root 26→23、
  nested 116→119、hard cap 26→23，total=142、source lines=56,088。
- index/runtime/run/step-run 的 export count/digest 保持 94/`431e3c95f3e2582c`、
  55/`f766a6184888590b`、2/`93fbb9aa2a3ddaaa`、1/`e3257ab157019d33`。`step-run` 公开 specifier
  直接指向嵌套 dist；Run 继续由稳定 root/runtime barrel 导出，三个旧根 source/dist 均不存在。
- 编辑前 67 个 function/class/method 为 0C/19H/3M/45L、162 direct/451 impacted，命中 `apply`、
  `complete`、`failStart`。迁移后为 0C/3H/7M/57L，但 direct、impacted 与三条流程完全不变；共享
  `lockAttemptAuthority` 仍为 HIGH、11 direct/19 impacted，说明目录 ownership 没有削弱锁风险。
- clean build、定向 63/63、package 275/1 skip、backend 1,097/2 skip、五项审计、十档 artifact 与
  PostgreSQL 18.4 HA 总门全绿，Docker 零残留。GitNexus 为 42,389 nodes/96,260 edges/1,675
  clusters/264 flows；全局 flow 重新聚类为 264，但目标 `apply/complete/failStart` 三条执行流与调用边不变。

### Cluster PostgreSQL Approved Action ratchet

- Approval Request 与 Approved Action Execution 两个 repository 共 1,166 行进入
  `src/approved-action/`，与 runtime-core/local-sqlite 对齐；root 28→26、nested 114→116、hard cap
  28→26，total=142、source lines=56,086。它们共同拥有 request decision/consumption、immutable dispatch
  与 approved execution baseline/claim/start/completion authority，不按单文件拆 package。
- `approved-action`、`approved-action-execution` 与 Worker Credential manager/executor 聚合入口的 export
  count/digest 保持 1/`22434903411221e9`、3/`21d462017ef3e20c`、20/`ec650b3043ba5f09`、
  21/`b0e1d0ba50ce8212`；公开 specifier 直接指向嵌套 dist，旧根 source/dist 均不存在。
- 迁移前后 Approval Repository 都是 CRITICAL（10 direct/16 impacted，命中
  `runClusterPluginPackageLifecycleExecution` 与 `runClusterWorkerCredentialExecution`）；Execution
  Repository 都是 MEDIUM（5 direct/7 impacted，命中 Worker Credential execution）。调用面与风险未被
  目录移动掩盖。clean build、定向 19/1 skip、package 275/1 skip、backend 1,097/2 skip、五项审计、
  十档 artifact 与 PostgreSQL 18.4 HA 总门全绿，Docker 零残留。
- GitNexus 刷新为 42,387 nodes/96,267 edges/1,674 clusters/265 flows；迁移后的 direct、impacted 与
  affected process 精确保持不变。

### Cluster PostgreSQL Tool Execution ratchet

- Project Tool snapshot、execution evidence/start/success/failure、invocation Artifact 与 result key catalog/rekey
  八文件进入 `src/tool-execution/`，与 runtime-core/local-sqlite 对齐；4,430 行不变，root 36→28、nested
  106→114、hard cap 36→28，total=142、source lines=56,086。
- index/runtime/admin/package-executor 与八模块 export count/digest 不变。编辑前 137 节点为
  0C/9H/6M/122L、245 direct/345 impacted/`commit`；迁移后为 0C/1H/8M/128L、245 direct/
  347 impacted/同流程。package、backend、审计、十档 artifact 与 PostgreSQL HA 全绿。
- GitNexus 为 42,384 nodes/96,259 edges/1,674 clusters/265 flows；风险下降来自 Tool Execution
  ownership 收敛，不代表删除调用或事务语义。

### Cluster PostgreSQL Plugin Package Lifecycle / Publication ratchet

- Lifecycle Plan、Lifecycle transition、Quarantine 三文件进入 `src/plugin-package/lifecycle/`；Automation
  Publication、Task Reconciliation 两文件进入 `src/plugin-package/publication/`。前者拥有状态转换/隔离，
  后者拥有 Workflow/Prompt/Task publication 与恢复，没有按文件名前缀混组。3,510 行仅新增 5 行注释；
  root 41→36、nested 101→106、hard cap 41→36，total=142、source lines=56,086。
- package-manager/package-executor 与五模块 export count/digest 保持 24/`d0a270751e55e137`、
  32/`dfb1bf5135f03fc3`、2/`29237208b6a8448f`、1/`902a98af783e7c16`、
  2/`18bbce18b21fe76e`、1/`b35bc709ec4c44d1`、1/`f71b0160e572f1d9`。
- 编辑前 94 节点为 1C/8H/4M/81L、149 direct/222 impacted 与两条 process；迁移后为
  0C/4H/6M/84L、149 direct/223 impacted，同两条 process。clean build、定向 22/2 skip、package
  275/1 skip、backend 1,097/2 skip、审计、十档 artifact 与 PostgreSQL HA 总门全绿。
- GitNexus 刷新为 42,382 nodes/96,257 edges/1,674 clusters/265 flows；风险标签变化只表示
  Lifecycle/Publication ownership 收敛，不表示行为风险消失。

### Cluster PostgreSQL Plugin Package Installation ratchet

- immutable install proposal、installation history/head/admission 与 materialized revision storage 三个
  repository 共同进入 `src/plugin-package/installation/`。迁移前共 1,952 行，仅新增 3 行
  owning-domain 注释后 package 为 56,081 行；root 44→41、nested 98→101、hard cap 44→41，
  总数仍为 142，workspace 仍为 19 个 package，没有新增 dependency、migration、schema、role、Pool、
  process、timer 或部署制品。
- 三者形成 proposal→批准后 admission/install→资源 revision materialize/recover 的同一 Installation
  capability，但不是一个长事务：proposal 由 Install repository 在短事务中锁定消费，materialized
  revision 在安装提交后的 executor/recovery 阶段独立 append/exact replay。Lifecycle、Quarantine 与
  Automation Publication 继续由各自 authority 持有，因此没有按 `pluginPackage*` 前缀机械混组。
- package-manager、package-executor、proposal、install 与 materialized-revision 模块的 export
  count/digest 分别保持 24/`d0a270751e55e137`、32/`dfb1bf5135f03fc3`、
  2/`3f412914ae9871ad`、2/`c5b47332f4eab333`、1/`a73b861ac5111f1b`。三个既有公开
  specifier/symbol 不变，clean build 后旧根 source/dist 均不存在；package-local、AI integration 与 HA
  deep require 全部直接指向嵌套 dist，没有保留兼容 facade。
- 编辑前对三文件 68 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  4 CRITICAL/11 HIGH/0 MEDIUM/53 LOW、128 direct edge/251 impacted symbol，命中 `admit/propose` 两条
  process 和 14 个临时 module。Install `unavailable` 为 24 direct/37 impacted，`mappedError` 为 9/21、
  `parseRecord` 为 3/14；Proposal `unavailable` 为 6/11，编辑前已显式告警。本批不改 SQL、transaction
  isolation、Project/Policy fence、database clock、PackageLock、head/version CAS、exact replay、resource
  revision identity 或 fail-closed error mapping。
- 定向 24 pass/2 条件 skip、clean 19-package build、Cluster PostgreSQL 275 pass/1 skip/0 fail、完整后端
  1,097 pass/2 skip/0 fail。cluster dependency、package boundary、Edge import、Cluster/Worker deployment
  audit 均 compatible/零 finding；边界精确报告 total=142、root=41、nested=101、hard cap=41、
  source lines=56,081。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且 package/file/module 数与字节不变：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，
  AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；Cluster Installation authority 没有
  进入路由设备或 Standalone closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Package authority split、Lifecycle/Quarantine、Workflow/
  Prompt materialized revision consumer、remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步
  rejoin 与 fresh replicas 全绿；门后 ql3-ha Docker 零残留。
- 强制刷新后的 GitNexus 图为 42,380 nodes/96,256 edges/1,675 clusters/265 flows。迁移后 68 节点、
  128 direct、251 impacted 与 `admit/propose` 精确不变，module 14→7；风险因 ownership 聚类重分类为
  2 CRITICAL/9 HIGH/0 MEDIUM/57 LOW，关键节点 direct/impacted 均不变，不能把标签下降解释为行为风险
  消失。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected
  process；QL3 新树尚未完整进入 Git 基线，因此该结果仅作为补充证据。

### Cluster PostgreSQL Management ratchet

- durable management quota 与跨 Plugin Package/Worker Credential/Automation 三种 authority 复用的
  identity-keyset anti-rollback ledger 共同进入 `src/management/`。迁移前共 623 行，仅新增 2 行
  owning-domain 注释后 package 为 56,078 行；root 46→44、nested 96→98、hard cap 46→44，
  总数仍为 142，workspace 仍为 19 个 package，没有新增 dependency、migration、schema、role、Pool、
  process、timer 或部署制品。
- 两者共同拥有管理平面的有界 mutation quota、数据库时钟窗口、idempotency receipt 与外部 identity
  keyset generation anti-rollback。Install proposal 虽由 management service 创建，但由 Install repository
  直接消费并参与 installation transaction，明确留待 Installation 批次；因此没有按文件名前缀混组。
- package-manager、automation-manager、worker-credential-manager 与两个内部模块的 export count/digest
  分别保持 24/`d0a270751e55e137`、15/`d00c42a6ea46caa8`、20/`ec650b3043ba5f09`、
  1/`f7bed6fd4e7e245b`、3/`a0a92038286c4b59`。公开 specifier/symbol 不变，clean build
  后旧根 source/dist 均不存在；没有测试 deep import 需要兼容 facade。
- 编辑前对两文件 23 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  23 LOW、0 MEDIUM/HIGH/CRITICAL、27 direct edge/33 impacted symbol、0 affected process，涉及
  Management、Management-support、Worker-credential 三个 module。本批不改 database clock、quota
  UPSERT/replay ledger、authority discriminator、generation anti-rollback、trust-domain pin、
  commit-response-loss convergence 或 fail-closed error mapping。
- 定向 26/26、clean 19-package build、Cluster PostgreSQL 275 pass/1 skip/0 fail、完整后端
  1,097 pass/2 skip/0 fail。cluster dependency、package boundary、Edge import、Cluster/Worker deployment
  audit 均 compatible/零 finding；边界精确报告 total=142、root=44、nested=98、hard cap=44、
  source lines=56,078。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且 package/file/module 数不变：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，
  AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；Cluster management durability
  authority 没有进入路由设备或 Standalone closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：durable quota 跨两个实例收敛，Package/Worker/Automation
  三种 keyset ledger 的 replica restart rollback/rewrite/removal 拒绝、commit-response-loss convergence
  与 trust-domain pin 全绿；remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 通过，
  门后 ql3-ha Docker 零残留。
- 强制刷新后的 GitNexus 图为 42,378 nodes/96,255 edges/1,675 clusters/265 flows。迁移后仍为
  23 LOW、27 direct、33 impacted 与零 affected process，module 3→2，仅反映 ownership 收敛。
  `detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process；
  QL3 新树尚未完整进入 Git 基线。

### Cluster PostgreSQL Plugin Package Publisher ratchet

- Publisher provenance、revocation proposal、trust observation authority、trust-transition proposal 与
  approved transition execution 五个 repository 共同进入 `src/plugin-package/publisher/`。迁移前共
  3,219 行，仅新增 5 行 owning-domain 注释后 package 为 56,076 行；root 51→46、nested
  91→96、hard cap 51→46，总数仍为 142，workspace 仍为 19 个 package，没有新增 dependency、
  migration、schema、role、Pool、process、timer 或部署制品。
- 五者共同拥有 signer provenance→trust snapshot/head→revocation/overlap/retirement proposal→approved
  transition→revocation impact/recovery 的 Publisher 持久化边界。通用 Package proposal、management
  identity keyset、install/lifecycle/quarantine 继续由各自 authority 持有，因此没有按文件名前缀建立
  杂物目录，也没有为 repository 新建 workspace 微包。
- index/runtime/admin/package-manager/package-executor 的 export count/digest 保持
  94/`431e3c95f3e2582c`、55/`f766a6184888590b`、19/`df4d60a7337976e3`、
  24/`d0a270751e55e137`、32/`dfb1bf5135f03fc3`；五个模块分别保持
  2/`d2d3e8ea450cc756`、2/`c7aa2d9cf9a0cbf6`、1/`2b2b467df83b6129`、
  2/`a02dbe187012c211`、1/`907cd91d09c42167`。三个公开 specifier 与 manager/executor symbol
  不变，clean build 后旧根 source/dist 均不存在；同步四个 package-local test 和两个 AI integration
  deep require。
- 编辑前对五文件 99 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  6 CRITICAL/19 HIGH/2 MEDIUM/72 LOW、181 direct edge/433 impacted symbol、0 affected process/
  12 modules。最高风险 provenance `unavailable` 为 15 direct/29 impacted，`recordJson` 为 4/19，
  `mapStorageError` 为 5/13，编辑前已显式告警。本批不改 signer advisory lock、provenance/trust
  normalization、approval/separation-of-duty、revocation impact、serialization、database clock、exact
  replay 或 fail-closed error mapping。
- 定向 28 pass/1 条件 skip、clean 19-package build、Cluster PostgreSQL 275 pass/1 skip/0 fail、
  完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、Edge import、Cluster/Worker
  deployment audit 均 compatible/零 finding；边界精确报告 total=142、root=46、nested=96、hard
  cap=46、source lines=56,076。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且 package/file/module 数不变：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，
  AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；Publisher PostgreSQL authority
  没有进入路由设备或 Standalone closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Publisher trust transition 在 promotion 前同步复制并于
  timeline 2 存活，trust overlap/safe retirement 与 revocation 即时围栏 Automation 全绿；
  remote_apply、旧主 fence/`pg_rewind`/只读同步 rejoin 通过，门后 ql3-ha Docker 零残留。
- 强制刷新后的 GitNexus 图为 42,376 nodes/96,253 edges/1,675 clusters/265 flows。迁移后仍为
  99 节点、181 direct、433 impacted 与零 affected process，module 12→7，风险重分类为
  2 CRITICAL/20 HIGH/4 MEDIUM/73 LOW；上述最高风险节点 direct/impacted 精确不变。`detect-changes`
  all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未
  完整进入 Git 基线。

### Cluster PostgreSQL Plugin Package Workflow ratchet

- Workflow authorized administration、admission、frontier 与 task-attempt admission 四个 repository
  共同进入 `src/plugin-package/workflow/`。迁移前共 2,556 行，仅新增 4 行 owning-domain 注释后
  package 为 56,071 行；root 55→51、nested 87→91、hard cap 55→51，总数仍为 142，workspace
  仍为 19 个 package，没有新增 dependency、migration、schema、role、Pool、process、timer 或部署制品。
- 四者共同拥有 plan authorization→Run/Step admission→frontier terminalization→remote task-attempt
  admission 的 Workflow 持久化边界。Prompt 与 Workflow 共用的 Automation Publication 继续留父层；
  install/lifecycle/quarantine/task reconciliation 继续由 lifecycle authority 持有，因此没有按
  `pluginPackage*` 前缀制造杂物目录，也没有新建 repository 微包。
- 四个模块的 export count/digest 分别保持 1/`07905bcaeaecedef`、1/`5ac41addd6547c63`、
  1/`35f690ce3da08166`、1/`597184ba08204e82`。四个公开 specifier/symbol 不变，clean build
  后旧根 source/dist 路径均不存在；同步三项 package-local deep-test require，并在首次 HA 预检发现
  旧根 dist deep import 后修正同一夹具的四个加载点。
- 编辑前对四文件 71 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  17 CRITICAL/16 HIGH/0 MEDIUM/38 LOW、138 direct edge/320 impacted symbol，涉及 `admit`、
  `advance`、`start` 三条流程，编辑前已显式告警。最高风险 `unavailable` 为 12 direct/24 impacted，
  admission repository class 为 4/9。本批不改 SQL、transaction isolation、Policy/identity fence、
  database clock、exact replay、frontier terminalization、task-attempt admission 或 fail-closed mapping。
- 定向 17/17、clean 19-package build、Cluster PostgreSQL 275 pass/1 skip/0 fail、完整后端
  1,097 pass/2 skip/0 fail。cluster dependency、package boundary、Edge import、Cluster/Worker deployment
  audit 均 compatible/零 finding；边界精确报告 total=142、root=51、nested=91、hard cap=51、
  source lines=56,071。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且 package/file/module 数不变：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，
  AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；Workflow PostgreSQL authority
  没有进入路由设备或 Standalone closure。
- 首次 PostgreSQL HA 在容器启动前因夹具旧 dist 路径失败，修正后 PostgreSQL 18.4 arm64
  `gates.passed=true`：Workflow authorized admission、atomic admission/exact replay、frontier
  terminalization/exact replay、task-attempt admission/replication 与全部 promotion survivability 门为 true；
  remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 全绿，门后 ql3-ha Docker 零残留。
- 强制刷新后的 GitNexus 图为 42,374 nodes/96,252 edges/1,675 clusters/265 flows。迁移后仍为
  71 节点与 `admit/advance/start` 三条流程，风险重分类为 0 CRITICAL/17 HIGH/5 MEDIUM/49 LOW，
  aggregate 136 direct/268 impacted；`unavailable` 保持 12 direct、repository class 保持 4 direct/
  9 impacted，变化来自 module ownership 收敛。`detect-changes` all/compare `develop` 为
  12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git 基线。

### Cluster PostgreSQL Automation ratchet

- Task Definition publication/source/execution revision 与 Task/Trigger authorized administration 两个
  repository 共同进入 `src/automation/`。迁移前共 1,148 行，仅新增 2 行 owning-domain 注释后 package
  为 56,067 行；root 57→55、nested 85→87、hard cap 57→55，总数仍为 142，workspace 仍为 19 个
  package，没有新增 dependency、migration、schema、role、Pool、process、timer 或部署制品。
- Task repository 拥有 immutable definition publication、runtime source 与 compiled execution revision；
  Administration repository 在同一授权事务中组合 Task 与 Scheduling 所属 Trigger。两者构成
  definition→execution revision→authorized management 的 Automation authority。共享
  `definitionRepositorySupport` 继续留父层供 Trigger publication 复用，`automationManager` 继续是根
  composition entry，因此没有制造单文件目录、重复 support 或 workspace 微包。
- index/runtime/admin/automation-manager 与两个内部模块的 export count/digest 分别保持
  94/`431e3c95f3e2582c`、55/`f766a6184888590b`、19/`df4d60a7337976e3`、
  15/`d00c42a6ea46caa8`、4/`b99a860cdd708479`、2/`9f8c72ce951955d7`。公开 symbol 集合不变，
  clean build 后两个旧根 source/dist 路径均不存在，只同步两个 package-local deep-test require。
- 编辑前对两文件 41 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  3 CRITICAL/7 HIGH/2 MEDIUM/29 LOW、83 direct edge/160 impacted symbol、0 affected process、9 modules。
  `unavailable`、Task row mapping 与 error mapping 分别为 8 direct/19 impacted、3/11、5/11，编辑前已
  显式告警。本批不改 SQL、Task/Trigger normalization、semantic compiler、execution revision、
  authorization fence、append-only audit、serialization retry、database clock 或 fail-closed error mapping。
- 定向 37/37、clean 19-package build、Cluster PostgreSQL 275 pass/1 skip/0 fail、完整后端 1,097 pass/
  2 skip/0 fail。cluster dependency、package boundary、Edge import、Cluster/Worker deployment audit 均
  compatible/零 finding；边界精确报告 total=142、root=55、nested=87、hard cap=55、source lines=56,067。
  联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且 package/file/module 数不变：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，
  AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；Automation PostgreSQL authority
  没有进入路由设备或 Standalone closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Automation inspection 在一个事务内提交授权读取与 audit，
  promotion 前同步复制、无同步备库时 fail-closed、timeline 2 后存活；Scheduler claim/commit-response-loss
  exactly-once、remote_apply、旧主 fence/`pg_rewind`/只读同步 rejoin 全绿，门后 Docker 零残留。
- 强制刷新后的 GitNexus 图为 42,372 nodes/96,251 edges/1,675 clusters/265 flows。迁移后仍为 41 节点/
  83 direct/0 affected process，impacted 160→159；三个原 CRITICAL 节点的 direct/impacted 精确不变，
  风险重分类为 10 HIGH/2 MEDIUM/29 LOW，仅反映 module 收敛到 Automation。`detect-changes` all/compare
  `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git 基线。

### Cluster PostgreSQL Security / Identity ratchet

- API Credential runtime/administration、Identity administration、Project Policy 与 Security Audit
  write/query 六个 repository 整体进入 `src/security/`。迁移前共 1,533 行，仅新增 6 行 owning-domain
  注释后 package 为 56,065 行；root 63→57、nested 79→85、hard cap 63→57，总数仍为 142，workspace
  仍为 19 个 package，没有新增 dependency、migration、schema、role、Pool、process 或部署制品。
- 六者拥有 Identity→Credential→Project Role Policy→Audit 的完整安全 authority。共享
  `administrationSupport` 继续由 PostgreSQL package 父层提供，因为 Task/Trigger 等管理域也复用其事务与
  append-only audit primitive；AI/Worker credential 则保留在各自独立管理、交付与执行生命周期域。
  这不是按文件名前缀建立的杂物目录，也不是拆出 repository 微型 workspace package。
- index/runtime/admin/worker-ingress、worker credential manager/executor、automation-manager、AI credential
  manager 与 project-policy subpath 的 export count/digest 分别保持 94/`431e3c95f3e2582c`、
  55/`f766a6184888590b`、19/`df4d60a7337976e3`、10/`48d406ee559a2273`、
  20/`ec650b3043ba5f09`、21/`b0e1d0ba50ce8212`、15/`d00c42a6ea46caa8`、
  7/`57ce1e5beb70e9df` 与 1/`afe3ce2d2d94e570`。公开 specifier/symbol 不变，clean build 后六个
  旧根 source/dist 路径均不存在，只同步一个 package-local deep-test require。
- 编辑前对六文件 49 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  2 CRITICAL/12 HIGH/1 MEDIUM/34 LOW、84 direct edge/206 impacted symbol、五条 affected process。
  `PostgresProjectPolicyRepository` 为 17 direct/31 impacted/2 processes/12 modules；Security Audit
  `record` 为 10/14/2/5，编辑前已显式告警。本批不改 credential mutation/replay、Identity version CAS、
  Policy transaction/serialization retry、Audit append/query、database clock 或 fail-closed error mapping。
- 定向 28/28、clean 19-package build、Cluster PostgreSQL 275 pass/1 skip/0 fail、完整后端 1,097 pass/
  2 skip/0 fail。cluster dependency、package boundary、Edge import、Cluster/Worker deployment audit 均
  compatible/零 finding；边界精确报告 total=142、root=57、nested=85、hard cap=57、source lines=56,065。
  联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true`：Edge/Standalone 3,530,127/3,530,175 bytes，Adopted
  4,124,101/4,124,185，Application 4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI
  5,941,264/5,941,420；最小 Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。
  Cluster Security/Identity authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Automation inspection 与 Model Provider credential audit query
  在 promotion 前同步复制并于 timeline 2 存活，Policy/Package/Workflow runtime fences、Scheduler
  exactly-once、physical streaming、remote_apply、旧主 fence/`pg_rewind`/只读同步 rejoin 全绿。
- 强制刷新后的 GitNexus 图为 42,364 nodes/96,249 edges/1,669 clusters/265 flows。迁移后仍为
  49 节点、2 CRITICAL/12 HIGH/1 MEDIUM/34 LOW、84 direct/206 impacted 与五条 process；Project Policy
  module 12→11 仅来自临时图聚类收敛。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与
  14/34，均 low/0 affected process；QL3 新树尚未完整进入 Git 基线，该结果只作补充证据。

### Cluster PostgreSQL Scheduling / Dispatch ratchet

- 本批没有按 `cluster*` 前缀混组：`clusterDispatchRepository.ts` 进入既有
  `src/remote-execution/`，`triggerRepository.ts` 与 `clusterScheduleRepository.ts` 共同进入
  `src/scheduling/`。三文件迁移前共 1,437 行，仅新增 3 行 owning-domain 注释后 package 为 56,059 行；
  root 66→63、nested 76→79、hard cap 66→63，总数仍为 142，workspace 仍为 19 个 package。
- Dispatch Source 负责 Remote Worker offer candidate 与 lease recovery，沿既有 Remote Execution DAG；
  Trigger repository 在发布事务内校验 pinned Task 并绑定 schedule，Schedule repository 承担数据库时钟下
  claim/commit、serialization retry 与 occurrence admission，二者形成完整 Trigger→Schedule authority。
  因此本批是两个明确领域落点，不是一个技术层杂物目录，也没有形成单文件 workspace package。
- index/runtime/admin/automation-manager 的 export count/digest 分别保持 94/`431e3c95f3e2582c`、
  55/`f766a6184888590b`、19/`df4d60a7337976e3`、15/`d00c42a6ea46caa8`。公开 specifier/symbol
  不变，clean build 后三个旧根 source/dist 路径为零；只同步三个 package-local deep-test require。
- 编辑前对三文件 42 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  3 CRITICAL/7 HIGH/1 MEDIUM/31 LOW、76 direct edge/135 impacted symbol、跨 14 个 module。
  `unavailable` 为 9 direct/18 impacted/7 modules，`triggerRecord` 为 3/11/5，`mappedError` 为 4/10/5；
  编辑前已显式告警。本批不改 SQL、Trigger normalization、schedule claim fence、transaction retry、
  database clock、dispatch pagination/cursor 或 recovery semantics。
- clean 19-package build 与 Scheduling/Dispatch/entrypoint 定向 39/39 通过；Cluster PostgreSQL
  275 pass/1 skip/0 fail，完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、
  cluster deployment 与 worker deployment audit 均 compatible/零 finding；边界报告 total=142、root=63、
  nested=79、hard cap=63、source lines=56,059。联网 production dependency audit 因外发依赖元数据策略
  限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数不变：Edge/Standalone
  3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application 4,611,008/4,611,152，
  AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；Cluster Scheduling/Dispatch 没有进入
  路由设备或 Standalone closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Scheduler claim 在 timeline 2 promotion 后按 lease expiry
  接管，occurrence 仅生成 1 Run/1 Attempt/2 events；Scheduler COMMIT-response-loss 同样 exactly-once。
  physical streaming、remote_apply、旧主 fence/`pg_rewind`/只读同步 rejoin 与 fresh replicas 全绿，门后
  ql3-ha 容器、network、volume 零残留。
- 强制刷新后的 GitNexus 图为 42,364 nodes/96,247 edges/1,671 clusters/265 flows。迁移后 42 节点/
  76 direct 保持，impacted 135→134，风险重新分类为 2 CRITICAL/7 HIGH/2 MEDIUM/31 LOW；
  `triggerRecord` 仍为 3 direct/11 impacted，`PostgresTriggerSource` 仍为 9/11，说明标签下降只是模块从
  临时簇收敛到 Scheduling。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，
  均 low/0 affected process；QL3 新树尚未完整进入 Git 基线，因此该结果只是补充证据。

### Cluster PostgreSQL Run Recovery ratchet

- `@qinglong/cluster-postgres` 保持 142 个 source file；Recovery Source、Runtime Recovery Source、Claim、
  Resolution、Lost Retry、Run Cancellation 与 Cancellation Convergence 七个 repository 整体进入
  `src/run-recovery/`。迁移前共 2,920 行，仅新增 7 行 owning-domain 注释后 package 为 56,056 行；
  root 73→66、nested 69→76、hard cap 73→66。workspace 保持 19 个 package，没有新增 dependency、
  migration、schema、role、Pool、process、listener、timer 或部署制品。
- 七者共同拥有 recovery discovery→claim→resolution/lost retry→cancellation→terminal convergence 的
  PostgreSQL authority 链，属于同一个控制面故障恢复域，而不是七个可独立部署的小包。`runtime.ts` 与
  `index.ts` 继续留在根目录作为公开 composition entry；共享 Attempt lock/Run transaction 由父层
  PostgreSQL infrastructure 提供，目录内没有反向 package import。
- root/runtime 的 export count/digest 分别保持 94/`431e3c95f3e2582c`、55/`f766a6184888590b`；公开
  specifier 和 symbol 集合不变，clean build 后七个旧根 source/dist 路径均不存在，未保留 facade。
- 编辑前对七文件 92 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  1 HIGH/2 MEDIUM/89 LOW。唯一 HIGH `safeIdentifier` 为 3 direct caller/4 impacted symbol，跨 3 个临时
  module，编辑前已显式告警。本批只修改路径、relative import、barrel 与 hard cap，不改变 discovery
  bounds、claim lease/fence、transaction rollback、lost/retry transition、cancellation winner 或 convergence。
- Run Recovery/entrypoint 定向测试 49/49；clean 19-package build 退出 0，Cluster PostgreSQL 275 pass/
  1 skip/0 fail，完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、cluster
  deployment 与 worker deployment audit 均 compatible/零 finding；边界精确报告 total=142、root=66、
  nested=76、hard cap=66、source lines=56,056。联网 production dependency audit 因外发依赖元数据策略
  限制未重跑。
- 十档 artifact 全部 `compatible=true`，串行复核后字节/文件/package/module 数与前批一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小 Edge
  324 files/42 modules，最大 Application AI 475 files/97 modules。Cluster Run Recovery authority 没有
  进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Run cancellation、Remote Worker completion 与 Worker
  Credential delivery commit-response-loss window 均 exactly-once，physical streaming、remote_apply、
  timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 与 fresh replicas 全绿；门后 ql3-ha 零残留。
- 强制刷新后的 GitNexus 图为 42,363 nodes/96,245 edges/1,672 clusters/265 flows。迁移后 92 个节点为
  2 MEDIUM/90 LOW；`safeIdentifier` 仍为 3 direct/4 impacted，仅由 3 个临时 module 收敛到单一
  `Run-recovery` 域，因此不把 HIGH→LOW 标签变化解释为行为风险消失。`detect-changes` all/compare
  `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树尚未完整进入 Git 基线，
  该结果仅为补充证据。

### Cluster PostgreSQL Remote Execution ratchet

- `@qinglong/cluster-postgres` 保持 142 个 source file；Worker Session、Run Dispatch Lease、Remote Run
  Activation、Worker Execution Attestation/Recovery Evidence、Remote Worker Lease Control 与 Completion
  共七个 repository 整体进入 `src/remote-execution/`。迁移前共 4,536 行，仅新增 7 行 owning-domain
  注释后 package 为 56,049 行；root 80→73、nested 62→69、hard cap 80→73。workspace 保持 19 个
  package，没有新增 dependency、migration、schema、role、Pool、process、listener、timer 或部署制品。
- 七者共同拥有 Session→Dispatch Lease→Run Activation→Execution Attestation/Recovery Evidence→Lease
  Control/Completion 的完整 PostgreSQL authority DAG。`workerIngress.ts`、`runtime.ts` 与 `index.ts` 继续
  留在根目录作为公开 composition entry；共享 `attemptAuthorityLock` 仍由上层 PostgreSQL infrastructure
  提供，没有形成反向依赖，也没有为每个 repository 创建微型 package。
- root、runtime、worker-ingress 的 export count/digest 分别保持 94/`431e3c95f3e2582c`、
  55/`f766a6184888590b`、10/`48d406ee559a2273`。公开 specifier 不变，clean build 后七个旧根
  source/dist 路径均不存在，未保留 facade；仅一个 package-local deep-test require 改为嵌套 dist。
- 编辑前对七文件 139 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  10 HIGH/13 MEDIUM/116 LOW、aggregate 266 direct edge/404 impacted symbol，affected process 为
  `failStart` 与 `complete`。10 个 HIGH 全部位于 Run Dispatch Lease 的 transaction、row parsing、Worker
  current-state 与 fence helper，编辑前已显式告警。本批只修改物理路径、relative imports、barrel 与测试
  deep path；不改变 Session replacement/heartbeat、Lease claim/renew/release CAS、activation start/failStart、
  Artifact upload/completion、timeout/cancellation winner、attestation freshness、transaction rollback 或错误映射。
- Remote Execution/entrypoint 定向测试 49/49；clean 19-package build 退出 0，Cluster PostgreSQL
  275 pass/1 skip/0 fail，完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、
  cluster deployment 与 worker deployment audit 均 compatible/零 finding；边界精确报告 total=142、
  root=73、nested=69、hard cap=73、source lines=56,049。联网 production dependency audit 因外发依赖
  元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。PostgreSQL Remote Execution
  authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：Remote Worker completion、Run cancellation 与 Worker
  Credential delivery 的 commit-response-loss window 均 exactly-once convergence，physical streaming、
  remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿；
  门后 ql3-ha 容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,356 nodes/96,243 edges/1,667 clusters/265 flows。迁移后 139 个
  节点、aggregate 266 direct edge 与同两条 affected process 保持，impacted 404→403；module 从 12 个
  临时簇收敛到 Remote Execution、Cluster Control 与 Worker Credential 三域，风险标签因聚类边界重新分类为
  15 MEDIUM/124 LOW。原 10 个 HIGH 节点的 UID、direct 与 impacted count 已逐项复核，全部与迁移前一致，
  因此不把标签下降解释为行为风险消失。`detect-changes` all/compare `develop` 为 12 files/31 symbols 与
  14/34，均 low/0 affected process。QL3 新树未完整进入 Git 基线，因此该结果仅作补充证据，不能替代逐
  节点 impact 与运行门。

### Cluster PostgreSQL Worker Credential ratchet

- `@qinglong/cluster-postgres` 保持 142 个 source file；Worker Credential administration repository、runtime
  resolver、management plan/quota、manager/executor composition 与 Remote Worker Secret delivery authority
  共七文件整体进入 `src/worker-credential/`。迁移前共 1,938 行，仅新增 7 行 owning-domain 注释后 package
  为 56,042 行；root 87→80、nested 55→62、hard cap 87→80。workspace 保持 19 个 package，没有新增
  dependency、migration、schema、role、Pool、process、listener、timer 或部署制品，也没有创建单文件 package。
- 该目录对应一个完整 authority lifecycle：manager 持有计划、配额与管理身份 ledger 的组合，executor 只取得
  已批准计划、credential administration 与 Secret delivery authority；runtime resolver 只读最新 credential，
  Remote Secret delivery 再以 Session、Lease 和 immutable execution revision fence 限定 Secret scope。
  PostgreSQL support、schema readiness 与 attempt authority lock 继续由上层共享基础设施提供，目录没有形成反向
  runtime dependency 或绕过受审 public subpath。
- `worker-credential-manager`、`worker-credential-executor`、`worker-credential-management-plan` 三个公开
  specifier 保持不变并直接映射嵌套 dist；root、runtime、admin、manager、executor 与 management-plan 的
  export count/digest 分别保持 94/`431e3c95f3e2582c`、55/`f766a6184888590b`、
  19/`df4d60a7337976e3`、20/`ec650b3043ba5f09`、21/`b0e1d0ba50ce8212`、
  2/`fea9d04e0f01e82f`。clean build 后七个旧根 source/dist 路径均不存在，未保留 facade。
- 编辑前对七文件 59 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  56 LOW/3 MEDIUM、aggregate 89 direct edge/235 impacted symbol，affected process 为
  `runClusterWorkerCredentialExecution` 与 credential `issue`，没有 HIGH/CRITICAL。本批只修改物理路径、
  relative imports、内部 deep-test/HA require 与三个 package export target；不改变 credential append/CAS、
  mutation replay、delivery publish/revoke/stage-discard、management plan、database-clock quota、Session/Lease/
  execution revision fence、Secret scope、transaction rollback 或 recovery 语义。
- Worker Credential/entrypoint 定向测试 37/37；clean 19-package build 退出 0，Cluster PostgreSQL
  275 pass/1 skip/0 fail，完整后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、
  cluster deployment 与 worker deployment audit 均 compatible/零 finding；边界精确报告 total=142、
  root=80、nested=62、hard cap=80、source lines=56,042。联网 production dependency audit 因外发依赖
  元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。PostgreSQL/Worker Credential
  authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：credential delivery v1→v4、management quota 双实例并发与
  commit-response-loss convergence、identity keyset ledger restart/rollback/rewrite fence、remote_apply、
  timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿。
- 强制完整刷新后的 GitNexus 图为 42,357 nodes/96,241 edges/1,670 clusters/265 flows。迁移后仍为
  56 LOW/3 MEDIUM、aggregate 89 direct edge、同两条 affected process；impacted 235→232，module 从
  8 个临时簇收敛到 Worker Credential、Worker Ingress、Remote Execution 与 Cluster Control 四域。
  风险和直接调用不变，impacted 差异来自目录聚类边界。`detect-changes` all/compare `develop` 为
  12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树未完整进入 Git 基线，因此该结果仅作
  补充证据，不能替代逐节点 impact 与运行门。

### Cluster Control Transport ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；HTTP/TLS surface、route registry 与 authenticated
  Policy/Audit admission pipeline 三文件整体进入 `src/transport/`。迁移前共 2,068 行，仅新增 3 行
  owning-domain 注释后 package 为 11,585 行；root 11→8、nested 29→32、hard cap 11→8。workspace
  保持 19 个 package，没有新增 dependency、migration、process、listener、Pool、timer、route 或部署制品。
- 三文件形成明确的 Transport DAG：`httpSurface` 定义 wire/admission contract 并拥有 TLS、HTTP parsing、
  bounded streaming 与 drain；`routeRegistry` 只依赖其类型并编译/解析 reviewed routes；`admissionPipeline`
  再组合 registry、Authenticator、Project Policy 与同步 Audit。领域 `*Route` adapter 依赖 Transport 的窄类型，
  Transport 不 runtime import 领域实现；Authentication 的反向引用也是 type-only，因此没有新增循环。
- `http`、`admission` 与 `routes` 三个公开 specifier 保持不变并直接映射嵌套 dist；root、admission、HTTP、
  routes 的 export count/digest 分别保持 11/`7de35017139f435d`、3/`934ad46df56e2cf0`、
  5/`59fee65bf87e4e1f`、5/`bf0821b0cd629792`。clean build 后三个旧根 source/dist 路径均不存在，
  未保留 facade，也没有创建 Transport 微型 package。
- 编辑前对三文件 75 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  23 CRITICAL/3 HIGH/3 MEDIUM/46 LOW，aggregate 122 direct edge/298 impacted symbol、0 affected process，
  涉及 Authentication、Worker Ingress、Automation、Database 与 9 个临时 Transport module。TLS material、
  option/header/query/body/stream validation、response/drain、HTTP configuration 等 23 个节点为 CRITICAL，
  编辑前已显式告警。本批只修改物理路径、relative imports 与 export targets；不改变 TLS 1.3/mTLS material
  validation/reload/erase、header/body/response/in-flight bounds、pre-body shield/refund、JSON/streaming parsing、
  timeout/cancellation/drain、route overlap/path/query bounds、Authenticator/Policy/Audit 顺序或错误响应语义。
- Transport 定向测试 22/22；clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail，完整
  后端 1,097 pass/2 skip/0 fail。cluster dependency、package boundary、cluster deployment 与 worker
  deployment audit 均 compatible/零 finding；边界精确报告 total=40、root=8、nested=32、hard cap=8、
  source lines=11,585。联网 production dependency audit 因外发依赖元数据策略限制未重跑。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。Cluster Transport/TLS/PostgreSQL
  authority 没有进入路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：readiness before/after promotion、Worker credential delivery、
  remote completion、Run cancellation、scheduler claim/takeover、remote_apply、timeline 1→2、旧主
  fence/`pg_rewind`/只读同步 rejoin 与两个 fresh control replica 全绿；门后 ql3-ha 容器、volume、network
  零残留。
- 强制完整刷新后的 GitNexus 图为 42,355 nodes/96,239 edges/1,670 clusters/265 flows。迁移后仍为
  23 CRITICAL/3 HIGH/3 MEDIUM/46 LOW、aggregate 122 direct edge、0 affected process；impacted 298→297，
  module 从 13 个临时簇收敛到 `Transport`、Authentication、Worker Ingress、Automation 与 Database。
  CRITICAL 节点和直接调用均保留，impacted 差异来自聚类边界。`detect-changes` all/compare `develop` 为
  12 files/31 symbols 与 14/34，均 low/0 affected process。QL3 新树未完整进入 Git 基线，因此该结果仅作
  补充证据，不能替代逐节点 impact 与运行门。

### Cluster Control Artifact ratchet

- `@qinglong/cluster-control` 保持 40 个 source file；immutable S3 Artifact store 与把 S3 client/store
  绑定到 Worker runtime 的 lazy production binding 两文件进入 `src/artifact/`。迁移前共 821 行，仅新增
  2 行 owning-domain 注释后 package 为 11,566 行；root 29→27、nested 11→13、hard cap 29→27。
  workspace 保持 19 个 package，没有新增 dependency、migration、process、listener、Pool、timer、route
  或部署制品。
- 两文件共享一个清晰 adapter lifecycle：binding 只在 Cluster process 明确启用 S3 时 lazy import AWS
  SDK、创建 client/store，并在 shutdown 时销毁 client；store 负责临时对象、流式 checksum、条件复制、
  immutable inspect 与错误归一化。Remote Artifact admission/completion 仍由 `remote-execution/` 持有，
  `artifact/` 只实现其 port；因此没有把运行域和对象存储 adapter 混成一个目录，也没有新建 AWS 微包。
- `s3-artifact-store` 公开 specifier 保持不变并直接映射嵌套 dist；root、process、S3 与内部 binding 的
  export count/digest 分别保持 11/`7de35017139f435d`、2/`676de045d8cf6897`、
  3/`dea1f56bc25b2923`、1/`8a86a56fafdc87fd`。默认 root/production entrypoint 的既有测试继续证明
  不加载 AWS SDK，只有显式 S3 subpath/lazy binding 才引入重依赖。clean build 后两个旧根 source/dist
  路径均不存在，未保留 facade，也没有创建单文件 package。
- 编辑前对两文件 36 个 function/class/method 节点逐项运行 depth=6、include-tests upstream impact：
  1 HIGH/1 MEDIUM/34 LOW，aggregate 54 direct edge/91 impacted symbol，命中 S3 `put` 流程，涉及 5 个
  module。`configurationError` 为 HIGH，9 impacted/3 direct，因此编辑前显式告警。本批只修改物理路径、
  relative/lazy imports、export target 与 dependency audit allowlist；不改变 bucket/prefix/encryption 配置、
  expected owner、KMS、stream bound、checksum、conditional promotion、collision recovery、cleanup 或错误语义。
- clean 19-package build 退出 0，Cluster Control 175 pass/2 skip/0 fail；完整后端 1,097 pass/2 skip/
  0 fail。cluster dependency、package boundary、cluster deployment 与 worker deployment audit 均
  compatible/零 finding；边界精确报告 total=40、root=27、nested=13、hard cap=27、source lines=11,566。
  真实 S3-compatible integration 仍按 endpoint/credential 条件跳过；联网 production dependency audit 因
  外发依赖元数据策略限制未重跑，二者均未被伪装为已执行的活门。
- 十档 artifact 全部 `compatible=true` 且字节、文件、package/module 数与前批完全一致：Edge/
  Standalone 3,530,127/3,530,175 bytes，Adopted 4,124,101/4,124,185，Application
  4,611,008/4,611,152，AI 4,860,311/4,860,371，Application AI 5,941,264/5,941,420；最小
  Edge 324 files/42 modules，最大 Application AI 475 files/97 modules。AWS SDK/S3 authority 没有进入
  路由设备或 Standalone runtime closure。
- PostgreSQL 18.4 arm64 `gates.passed=true`：remote Worker completion commit-response-loss exactly-once、
  scheduler claim takeover、remote_apply、timeline 1→2、旧主 fence/`pg_rewind`/只读同步 rejoin 与两个
  fresh control replica 全绿，门后临时容器、volume、network 零残留。
- 强制完整刷新后的 GitNexus 图为 42,338 nodes/96,224 edges/1,668 clusters/265 flows。迁移后为
  1 MEDIUM/35 LOW、0 HIGH，aggregate 54 direct edge/91 impacted symbol 和 `put` 流程完全不变；module
  从 5 收敛到 `Artifact` 等 3 个。风险标签下降来自 ownership 收敛，不是删除配置校验、调用或流程。
  `detect-changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process。
  QL3 新树未完整进入 Git 基线，因此该结果仅作补充证据，不能替代逐节点 impact 与运行门。

### Narrow shared protocol implementation ratchet（2026-08-07）

- 小 package 是否成立仍按部署、权限、依赖隔离和多消费者复用裁决，但“边界成立”不再自动允许实现代码
  全部留在 `src/` 根层。`@qinglong/local-command-file` 继续作为 Application、Owner CLI、Maintenance
  三种生命周期共同依赖的零生产依赖安全协议，不合并进任一消费者；其 POSIX UID、`0600`、no-follow、
  inode/device/size 复核和输入清零实现整体进入 `src/protocol/privateLocalCommandFile.ts`，根
  `src/index.ts` 只保留稳定公开 re-export。
- package 名、三个 production consumer、生产依赖、公开 specifier、exported symbol 与行为均不变；源码
  从 1 个根实现文件变为 1 个根入口加 1 个嵌套领域实现。workspace 仍为 19 个 package，没有增加依赖、
  制品、进程、timer、listener、watcher 或权限。
- schema v2 边界门删除 `shared_protocol` 全平铺例外；以后即使是成立的窄共享协议，也必须把实现放入 owning
  domain，根层只允许 manifest 可证明的公开入口。全 workspace 的 `singleSourcePackages=[]`，全平铺例外
  只剩 `local-profile` 与 `local-adopted-profile` 两组纯公开 Profile entrypoint。
- 编辑前 GitNexus 将两个读取函数、错误类、浅层布局解析与边界审计均判为 LOW，最大 4 个直接调用、5 个
  impacted symbol、0 affected process。定向 command-file 3/3、package boundary 正向/负向 5/5，最终
  package audit 为 19/19、`findings=[]`。

### Runtime Core final root implementation ratchet（2026-08-09）

- `@qinglong/runtime-core` 最后 4 个根 source 中，`index.ts` 是 15 个 production consumer 共用的真实公共聚合入口；
  Migration Stream、统一 SemVer provider 与 PostgreSQL persistence port 则分别进入 `src/migration/`、
  `src/versioning/`、`src/persistence/`。三个目录当前各只有一个文件，但它们是 package 内 ownership namespace，
  不具备独立 deployable、authority、version 或裁剪收益，因此没有拆成 workspace 微包。
- Runtime Core 保持 113 source，root 4→1、596→160 审计行，nested 109→112；workspace 仍为 19 package/
  768 source，root 37→34、nested 731→734。根角色只保留 `index.ts: public_export`，manifest 直接把稳定的
  `/migration-stream` 映射到嵌套产物，不保留旧根 facade。
- 这批同时证明两条规则并不冲突：workspace package 按部署/权限/重依赖/裁剪价值保持粗粒度；大 package 内部则允许用
  小而明确的领域目录表达 ownership。文件数只触发评审，既不自动拆包，也不成为继续平铺的理由。
- Runtime Core 445/445、完整 19-package clean build/test、backend 1,112、dependency/boundary、Edge/Local/Cluster
  部署镜像与十档 artifact/RSS 门全部通过。PostgreSQL 18.4 arm64 HA 物理门 `gates.passed=true`，timeline
  1→2、旧主先 fencing、`pg_rewind` 后只读同步 rejoin 和两个 fresh control ready 均成立，门后 `ql3-ha-*`
  container/volume/network 零残留。完整影响与图证据见 ADR-0303。

### Root public export proof and Owner command ratchet（2026-08-09）

- Cluster PostgreSQL 剩余 10 个根入口/520 行经 TypeScript AST 逐文件证明全部只含 `ExportDeclaration`；它们是
  manifest 直接映射的 runtime/admin/Package/Worker/Automation/AI least-authority subpath，因此保留根 facade，不为
  `root=0` 移入无 ownership 收益的 `public-api/`。
- ledger 升为 schema v5：除已有根文件名、角色、行数、manifest target 外，非浅层 package 的 `public_export` 还必须
  非空且 statement 全为 re-export。新的负向 fixture 精确拒绝用 function/class/variable 等实现冒充公开入口。
  `local-profile` 与 `local-adopted-profile` 仍只通过既有 artifact 映射和 production closure 防火墙取得浅层资格。
- 同一扫描发现 Owner CLI 根 `index.ts` 与 Maintenance 根 `command.ts` 是真实实现，已分别进入
  `src/application-command/localOwnerCommand.ts` 与 `localOwnerMaintenanceCommand.ts`；公开 specifier、binary、symbol、
  error identity 和行为保持，不保留旧根 wrapper。workspace 保持 19 package/768 source，root 34→32、nested
  734→736；Owner CLI root 2/463→1/50，Maintenance 2/367→1/50。
- schema v5 fixture 8/8、dependency 47/47、clean packages、backend 1,113、Edge/Local/Cluster 与十档 artifact/RSS
  全绿且制品指标逐字节不变。PostgreSQL 18.4 arm64 HA 再次 `gates.passed=true` 并零 Docker 残留。GitNexus 为
  43,358 nodes/98,573 edges/1,698 clusters/269 flows；两个 runner 均 1 direct/3 total/0 process，all/compare
  `develop` 为 12/31 与 14/34、low/0 process。完整裁决与证据见 ADR-0304。

### Workspace micro-package consolidation ratchet（2026-08-09）

- schema v5 的 shallow 例外不是永久许可。真实 artifact pack 证明基础 Profile 已完整携带 Local SQLite，
  Adopted Profile 已完整携带 Local Admin/SQLite/Secret；Owner Keyring 的全部生产消费者也已依赖 Owner Console。
  三者均没有独立 deployable、重依赖隔离或版本生命周期，因而分别收敛为 `local-sqlite/profile/`、
  `local-admin/adopted-profile/` 与 `local-owner-console/pepper-custody/`。
- workspace 19→16、源码仍为 781，root 32→25、nested 749→756；账本 hard cap=16，
  `singleSourcePackages=[]`、`shallowSourcePackages=[]`。旧 package 名成为全局 tombstone，不保留 facade。
- Package 合并没有删除 authority boundary：Pepper destruction、SQLite Profile→runtime、Adopted Profile→runtime
  与 Application composition consumer 均由精确 subpath/目录级 import gate 约束。基础 Edge 不安装
  Local Admin/Secret，Adopted 不安装 Execution/Process/Croner。
- 十档制品全部 compatible，最小 Edge 3,623,093 bytes/331 files/49 modules，最大 Standalone Application AI
  6,108,281 bytes/492 files/109 modules；Local SQLite 203、Local Admin 91、dependency 50、boundary 与相关
  image/service 契约全部通过。完整裁决见 ADR-0311/0312。
