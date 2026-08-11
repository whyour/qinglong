# ADR-0341：AI Profile Composition 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0040、ADR-0042、ADR-0087、ADR-0088、ADR-0276、ADR-0336、ADR-0340

## 背景

`@qinglong/ai` 的 `profile/profileComposition.ts` 有 869 行，同时承载 Model Gateway 与 Model Price Catalog Management 两类公开 Profile contract、option/authority validation、排空/停止生命周期和 bootstrap composition。两类 Profile 共享 deployment vocabulary 与生命周期约束，但具有不同资源和权限边界；继续平铺会让 disabled loader-free、恢复先于 provider、Cluster separation-of-duty/quota 等关键顺序难以单独审阅。

它们不是独立部署单元，也不应成为新的 workspace package。编辑前对全部 55 个 function/class/method 执行 GitNexus upstream impact：49 LOW、6 MEDIUM、0 HIGH、0 CRITICAL。MEDIUM 为四个 unavailable/draining error 与 `beginOperation`、`finishOperation`；其余 bootstrap、validation、audit、dispose 和 stop 均为 LOW。没有需要先行告警的高风险符号。

## 决策

保留一个 `@qinglong/ai` package、原导入路径和 26 行显式 facade，在同一领域建立：

```text
profileComposition.ts                    # stable public facade
profile-composition/
├── contracts.ts                         # public profile contracts, states and errors
├── lifecycle.ts                         # shared best-effort audit and authority disposal
├── modelGatewayProfile.ts               # gateway validation, recovery and composition
└── modelPriceCatalogManagementProfile.ts # catalog-management validation and composition
```

不新增 workspace package或公开 owner subpath。原 9 个 runtime export 与全部 type surface 保持；disabled path 不触达 storage/provider loader，Gateway 继续按 storage → audit → dynamic import → recovery → provider 的顺序激活，恢复不完整时 fail closed，排空拒绝新操作并等待 active operation，停止顺序保持 provider dispose 后 storage close。Price Catalog Management 继续在 Cluster 使用 separation-of-duty、要求 quota authority，在 Edge/Standalone 使用原 decision mode，并保持 lazy service import 与幂等 drain/stop。

owner 分别为 contracts 267、lifecycle 33、Model Gateway 401、Model Price Catalog Management 217 行。没有把每个 validator、状态转换或 dispose 操作拆成单文件；`lifecycle.ts` 只保留两类组合都使用且具有同一资源释放语义的 helper。

## 小设备与集群影响

非 AI 六档制品逐字节、逐文件、逐加载模块不变，最小 Edge 仍为 3,658,234 bytes、358 files、49 modules。AI 四档增加 3,434 bytes/4 files：Edge/Standalone AI 为 5,126,634/5,126,682 bytes、505 files，冷启动模块由 50 增至 54；Application AI 为 6,245,058/6,245,190 bytes、616 files，loaded modules 保持 115。Edge-AI RSS 增量为 12,451,840 bytes，仍低于 16 MiB 门。目录化不是零成本，但未启用 AI 的路由设备不承担该成本，也没有新增 dependency、连接、timer、线程或常驻对象。

PostgreSQL 18.4 arm64 HA 门通过 `remote_apply`、timeline 1→2、旧主 fencing 与 `pg_rewind` 只读同步 rejoin；两份新 control activation ready，AI schema、Package Prompt execution/catalog/inspection、credential 与 management authority 跨晋升保持，最终 `gates.passed=true`。

## 被否决方案

1. 为 Gateway 与 Catalog Management 新增 workspace package：它们不是独立部署、供应链或版本边界，会制造微包。
2. 继续保留 869 行平铺文件：公开 contract、共享 lifecycle 与两类资源组合无法独立审阅。
3. 每个 validator、error 或 lifecycle operation 一文件：会把连续的 Profile 状态机切成微文件。
4. 合并两类 bootstrap：会把 runtime provider 权限与 catalog management 权限混成一个过宽组合根。
5. 趁移动改变激活顺序或默认预算：会改变 Edge 资源语义和 Cluster fail-closed 边界，应另立行为 ADR。

## 验收证据

- facade 869→26 行；owner 267/33/401/217，总计 944 行，最大 401。
- 原路径仍精确导出 9 个 runtime symbol；Profile Composition 定向 10/10 通过。
- AI 212 项为 209 pass/3 skip/0 fail；完整 16-package clean build/test 退出 0。
- package-boundary、cluster-dependency、edge-import 三项本地结构审计 compatible；workspace 仍为 16 package、947 source、25 root/922 nested，AI 为 145 source、1 root/144 nested，无单文件或浅层 package。
- 外部 profile vulnerability 审计因需要向默认漏洞服务发送生产依赖元数据而未获权限执行；不把它记为通过，也不以本地替代品冒充。
- 十档 artifact compatible；非 AI 六档精确不变，AI 四档 +3,434 bytes/+4 files；仅 Edge/Standalone AI 冷启动模块 +4，Application AI 模块数不变。
- PostgreSQL HA Docker 门退出 0，最终 `gates.passed=true`。
- `git diff --check` 通过；GitNexus 强制重建为 44,505 nodes/101,507 edges/1,737 clusters/296 flows。post-impact 中 Gateway bootstrap 为 LOW（1 direct/1 total/0 process），Catalog Management bootstrap 为 LOW（0/0/0），四个 profile error 保持 MEDIUM（5/14、5/21、5/13、6/14，均 0 process），best-effort audit 为 LOW（3/12/0）；没有新增 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此结果只作 Git 基线补充。工作区无 staged change。

## 后续约束

contracts 不取得 I/O；lifecycle 不拥有 Profile-specific validation 或启动顺序；Gateway owner 不取得 catalog management mutation authority；Catalog Management owner 不加载 provider runtime。新增 Profile 必须先证明部署/权限/资源边界，并复用有界生命周期协议；不能自动新增 workspace package、公开 owner subpath或一操作一文件。
