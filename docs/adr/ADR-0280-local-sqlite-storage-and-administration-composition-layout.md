# ADR-0280：Local SQLite Storage 与 Administration Composition 布局

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-07、D-87、D-257、ADR-0087、ADR-0088、ADR-0276

## 上下文

`@qinglong/local-sqlite` 已按 Run、Security、Plugin Package、Tool Execution、Migration、Local Owner 等
领域组织 148 个源码文件，但 `src/` 根层仍有七个文件。其中 `bootstrap.ts` 与既有
`storage/config.ts`、`database.ts`、`schema.ts` 共同拥有数据库打开和最小 bootstrap authority；
`packageManagement.ts`、`pluginPackageWorkflowAdministration.ts`、`secretAdministration.ts` 则都是
受认证、短生命周期、显式 subpath 才可取得的管理 composition entry。

继续把这四个文件留在根层会让“公共 export 就必须物理平铺”成为惯例；为每个文件单独建立目录或拆成
workspace package，又会制造用户担心的微目录/微包。此次调整必须保持 public package specifier、export
集合、依赖、事务、Policy fence、SQLite authority 与低配制品边界不变。

## 决策

1. `bootstrap.ts` 进入既有 `src/storage/bootstrap.ts`，与 config/database/schema 形成数据库 opening、
   readiness 与最小 bootstrap repository 的 Storage composition；公开
   `@qinglong/local-sqlite/bootstrap` specifier 不变。
2. package management、Workflow administration 与 Secret administration 三个文件共同进入
   `src/administration/`。该目录表达“受认证、短生命周期、不能进入普通 runtime 的管理数据库组合”，
   不是按一个能力建立一个单文件目录。
3. `@qinglong/local-sqlite/package-management`、`authenticated-management`、
   `optional-feature-runtime`、`plugin-package-workflow-administration` 与 `secret-administration` 的公开
   specifier 和 API 保持不变，只让 package `exports` 直接指向新的 `dist/administration/*`。
4. 根层只保留 `index.ts`、`runtime.ts` 与 `adoption.ts`。前两者是 package root/runtime composition；
   后者是 738 行的独立 Legacy Adoption 公共领域入口。不得为了把根文件数做成零而给 adoption 建立缺乏
   同域成员的装饰性目录。
5. schema v2 边界账本将 Local SQLite root hard cap 从 7 收紧到 3，并逐名冻结三个合法根文件。clean
   build 必须证明旧根 source、JavaScript、declaration 和 source map 均不存在。
6. 本决策只移动路径和改写显式 import/export，不修改函数体、SQL、transaction、credential/Policy
   fence、Run/Workflow、Secret、exact replay、错误码或关闭顺序。

## 被拒绝的方案

- **为四个入口建立四个目录**：会把根文件问题变成单文件微目录问题，没有形成领域聚合。
- **把管理入口并回 `runtime.ts` 或 root export**：会让普通 Edge/Standalone runtime 获得短生命周期管理
  authority，并扩大低配设备加载面。
- **拆成 bootstrap/management/workflow/secret workspace package**：没有独立部署、依赖或生命周期价值，
  会突破 19-package 收敛边界。
- **保留旧根 facade 兼容层**：public package specifier 本来就稳定，旧源码路径不是公共契约；facade 只会
  让 stale dist 继续进入制品。
- **把 adoption 强行放入单文件目录**：它已经是明确且大型的公共领域入口，没有同域成员可形成聚合。

## 接受证据

- Local SQLite 保持 148 个源码文件/46,996 行，root 7→3、nested 141→145、hard cap 7→3；package-boundary
  schema v2 报告 workspace=19/hard cap=19、compatible=true。
- root/runtime/bootstrap/package-management/Workflow administration/Secret administration 的 export
  count/digest 分别保持 15/`f1884fabfa37efd5`、12/`daf0cfe03a52f442`、
  2/`868eb03aaaa678a4`、9/`11d78ae9a2c4066a`、1/`cbec651a9e47ee76`、
  1/`448b760a835d2b2b`。六个 public self-reference 均可解析；clean build 后四组旧根
  source/dist/声明/source-map 路径为零。
- 编辑前 55 个 function/class/method 为 4 HIGH/1 MEDIUM/50 LOW、94 direct/206 impacted/4 process
  hits；编辑后为 5 HIGH/2 MEDIUM/48 LOW、91 direct/150 impacted/4 process hits。风险标签变化来自目录聚类
  重分配；最高共享 fence error 仍为 29 direct/32 impacted/0 process，Workflow 流程命中仍只在测试链。
- Local SQLite 192/192；完整 19-package 门退出 0；后端 1,101 tests、1,099 pass/2 skip/0 fail。Edge
  import、cluster dependency、package boundary、cluster deployment、worker deployment 与 local image
  六项审计全部 compatible。
- 十档 artifact 的 package/file/module closure 均未增加，每档仅因嵌套路径增加 345 bytes：Edge/
  Standalone 3,549,039/3,549,087，Adopted 4,147,741/4,147,825，Application
  4,635,214/4,635,358，AI 4,883,961/4,884,021，Application AI
  5,970,208/5,970,364 bytes；最大档距 6 MiB 仍有 321,092 bytes，RSS 全部在对应预算内。
- PostgreSQL 18.4 arm64 physical-streaming HA `passed=true`：`remote_apply`、timeline 1→2、旧主 fencing、
  `pg_rewind` 只读同步重入、两个 fresh control replica 与全部 Workflow/Tool/AI gate 全绿，
  `ql3-ha-*` container/network/volume 零残留。
- 刷新后 GitNexus 为 42,538 nodes/96,512 edges/1,675 clusters/261 flows；`detect-changes`
  all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected production process。

## 后续边界

- `adoption.ts`、`runtime.ts` 与 `index.ts` 是明确公共入口，不以“根文件越少越好”为理由继续移动。
- `@qinglong/cluster-postgres` 的十个根文件同样是分角色 composition exports；只有出现多个同域成员或公共
  specifier 可以直接映射嵌套实现时，才应继续收敛。
- x64/arm64 CI matrix 已定义并有静态负向门，但远端 runner 的实际执行结果仍必须来自 GitHub CI，不能由
  本机 arm64 证据替代。
- 联网 production dependency vulnerability audit 因依赖元数据外发权限未获批准，本轮不重跑。
