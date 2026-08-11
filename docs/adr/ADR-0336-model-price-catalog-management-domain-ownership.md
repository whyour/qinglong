# ADR-0336：Model Price Catalog Management 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0172、ADR-0173、ADR-0174、ADR-0177、ADR-0276、ADR-0334、ADR-0335

## 背景

`@qinglong/ai` 的 `pricing/modelPriceCatalogManagement.ts` 有 968 行，同时承担：

1. 公开管理 operation、Policy/authorization schema、service/repository port 与 request/result contract；
2. 六类稳定错误、强 User principal freshness 与 exact-shape 基础校验；
3. Policy decision、authorization command、committed authorization 的 canonical digest、normalization 与 catalog command binding；
4. publish/transition 的 Policy、quota、separation-of-duty 与 repository 编排。

这些职责属于同一个 Model Price Catalog management capability，共享强身份、Policy decision、authorization digest 与一次
catalog mutation 协议。它们没有独立部署、依赖、权限主体、生产 consumer 或供应链生命周期，不能仅因 968 行再拆一个
workspace package；但继续放在一个平铺文件中，会把公开 contract、纯 codec 与有副作用的 service orchestration 混为同一
审查单元，也让 Local/Cluster repository 对稳定授权门面的依赖看起来像对一个 god module 的依赖。

编辑前对 33 个 function/class 逐一执行 GitNexus upstream impact：21 HIGH、5 MEDIUM、7 LOW、0 CRITICAL。HIGH
主要来自被 Local/PostgreSQL repository 共同使用的 exact validation、digest 与 authorization normalizer；最大影响是
`InvalidModelPriceCatalogManagementValueError`（12 direct/48 total/0 process）和 `invalid`（19/36/0）。接口与对象方法的
method-level impact 均为 LOW。已在编辑前告警，并把本批限定为原样 ownership 移动。

## 决策

保留一个 `@qinglong/ai` package、原 `pricing/modelPriceCatalogManagement` 导入路径和显式 public facade。在同一 Pricing
领域建立 package-private owner 目录：

```text
modelPriceCatalogManagement.ts             # 42-line stable explicit facade
model-price-catalog-management/
├── contracts.ts                           # schemas, public ports, requests/results and stable errors
├── validation.ts                          # exact values, principal freshness and shared fail-closed helpers
├── authorization.ts                       # Policy/command/authorization canonical codec and bindings
└── service.ts                             # publish/transition Policy, quota and duty orchestration
```

依赖方向固定为 `contracts <- validation <- authorization`，`service` 只向这三层和既有 catalog contract 依赖；contract/codec
不得反向取得 repository、Pool、SQLite 或 PostgreSQL authority。根 facade 显式逐项转发原有 runtime/type export，不以
wildcard 意外公开 `BaseManagementRequest` 或内部 validation helper。

授权 digest domain、JSON field/order、exact-key validation、强认证 assurance、五分钟 freshness、operation/revision pairing、
Policy allow、quota idempotency key、separation-of-duty、repository 调用顺序、error class/code/message 与 public import path 均
保持。服务仍先在 request command 构造前验证 principal，并在 authorization 前再次按当前 clock 复验；本轮不借目录化改变
这一安全时序。

四个 owner 文件分别是 contracts 231、validation 243、authorization 349、service 229 行。没有按每个 operation、错误类或
normalizer 建立单文件；最大文件 349 行，同时包含一组共同变化的完整 authorization codec。

## 小设备与集群影响

不启用 AI 的 Edge、Standalone、Adopted 与 Application 六档制品逐字节、逐文件不变：最小 Edge 仍为
3,658,234 bytes、358 files、49 loaded modules。启用 AI 的四档因一个旧编译文件变成 facade 加四个 owner 编译文件，统一
增加 7,961 bytes/4 files，loaded modules 不变：Edge/Standalone AI 为 5,097,847/5,097,895 bytes、483 files、50 modules；
Edge/Standalone Application AI 为 6,216,271/6,216,403 bytes、594 files、115 modules。没有新增 workspace package、生产
dependency、连接、timer、watcher、listener、线程或常驻对象；未启用 AI 的低配路由设备不承担目录化成本。

Cluster 继续使用同一个 `@qinglong/ai` package、Pool/schema/roles 和 management service，没有新增 Pod、Service、sidecar、
连接池或 Kubernetes resource。PostgreSQL 18.4 arm64 physical-streaming HA 门通过 `remote_apply`、timeline 1→2、旧主
fencing、`pg_rewind` 后只读同步 rejoin 与 AI schema/ACL 跨晋升存活，最终 `gates.passed=true`。

## 被否决方案

1. **新增 Model Price Catalog Management workspace package**：没有独立部署、重依赖、authority 或多消费者边界，只会增加低配设备 importer、packlist 与 SBOM 粒度。
2. **继续保留 968 行文件**：公开 contract、canonical codec 与有副作用 service 无法独立审阅。
3. **按 publish/transition 或每个 normalizer 一文件**：会制造单 operation 文件，把共享 digest/principal/binding 不变量切碎。
4. **把 Local/PostgreSQL repository 一并合到 management 目录**：会混淆 domain service 与两个方言 adapter 的事务/连接 authority。
5. **直接导出 owner 文件为 package subpath**：会把内部层次固化成公共兼容承诺，并允许 consumer 绕过稳定 facade。
6. **趁移动统一 SQLite/PostgreSQL 或调整 principal 复验次数**：属于行为与安全时序变更，不能混入 ownership 重构。

## 验收证据

- public facade 968→42 行；owner 为 231/243/349/229 行，总计 1,094 行，最大 349；没有一方法一文件。
- 编译后的 facade 仍只有原 21 个 runtime export；所有 type export 由原路径生成，内部 `BaseManagementRequest` 与 validation helper 未公开。
- `@qinglong/ai` check 通过；AI package 212 项为 209 pass/3 条件 skip/0 fail；完整 16-package clean build/test 在允许 loopback TLS listener 的环境退出 0。
- package boundary、Edge import、Cluster dependency、Cluster deployment 四项审计全部 compatible；workspace 仍为 16 package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。AI 为 123 source、1 root/122 nested，Edge imported modules 仍为 121。
- 十档 artifact 均 compatible；非 AI 六档精确不变，AI 四档 +7,961 bytes/+4 files/+0 loaded modules。
- PostgreSQL HA Docker 门退出 0，旧主 fencing、promotion、rejoin、AI migration/ACL 和最终 gate 全部通过。
- `git diff --check` 通过；GitNexus 强制重建为 44,428 nodes/101,355 edges/1,738 clusters/296 flows。post-impact 保持 0 process：service、Policy creator 与两个 repository binding normalizer 为 LOW，底层 exact validation/digest/authorization codec 仍按预期显示跨三模块 HIGH，没有出现新 execution flow。
- `detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树尚未完整进入默认分支索引，因此 detect result 只作 Git 基线补充。

## 后续约束

`contracts.ts` 不取得 I/O authority；`validation.ts` 不拥有业务 operation；`authorization.ts` 不调用 repository；`service.ts`
不复制 canonical digest/normalization。新增字段或 schema version 必须同时评审 canonical digest、durable replay 与双方言 adapter；
新增 management operation 按共同变化原因归入现有层，不能自动增加文件或 package。只有出现独立部署、独立权限主体、显著可选
依赖、多个生产 consumer 或可测 artifact 裁剪价值时，才重新评估 workspace package 边界。
