# ADR-0185：Workspace Package 边界审计与最小 Profile 交付梯度

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-02、D-05、D-35、D-37、D-40、D-42、D-169、D-174、D-175；
  ADR-0088、ADR-0093、ADR-0179、ADR-0184

> 2026-08-01 更新：ADR-0257/D-240 supersede 本 ADR 中“所有 Profile 共用 16 MiB
> import RSS delta”的部分，并明确 npm 开发包与最终运行制品的裁剪边界。本文的
> package/authority 边界和分层 files/bytes 预算保持有效；后续 22→19 package 收敛见
> ADR-0217 与 ADR-0243。

## 背景

QingLong 3.0 当前有 22 个 workspace package。包边界在孵化阶段帮助隔离了
SQLite/PostgreSQL、常驻 runtime/短生命周期 authority、Edge/Cluster 和可选 AI，
也阻止了 legacy 根包反向进入 3.0。部分 package 只有一至三个源码文件，因此需要
确认它们是有效交付边界，还是仅把源码目录误建成 package。

workspace package 不是普通源码目录：

- 每个 package 都增加 manifest、exports、tsconfig、build/test closure 和 lockfile
  importer 维护成本；
- 错误拆分会产生没有独立消费者、产物或 authority 的线性依赖链；
- 低配设备的主要成本来自最终 Profile 产物和 native/第三方依赖闭包，不是仓库中
  package 数量本身；
- 反过来，按文件数合并可能把 Secret 写 authority、GC/destructive authority、
  POSIX Owner 代码或 application 依赖带入更小的 Edge 产物。

## 审计事实

### 1. 一文件 package 不等于无效 package

22 个 package 中只有 3 个 package 只有一个生产源码文件：

- `@qinglong/local-command-file`：161 LOC，无生产依赖，被 local-application、
  local-owner-cli 和 local-owner-maintenance 三个 package 使用；
- `@qinglong/local-identity`：327 LOC，生产只依赖 runtime-core；它让通用 credential
  authentication 不反向依赖 POSIX Owner console、keyring 或 SQLite composition；
- `@qinglong/local-secret-admin`：489 LOC，是短生命周期 Secret 明文写入/强认证/
  Policy/audit authority，刻意不被常驻 application 依赖。

三者分别满足共享依赖反转、运行时认证边界和高权限代码排除，不能按 LOC 自动合并。

### 2. Profile 线性源码链实际是独立交付梯度

从 manifest 看，`local-profile → local-adopted-profile → local-application` 各只有一个
直接生产消费者，表面像可合并的 composition chain。但 artifact audit 实际发布三个
不同层级：

```text
edge / standalone storage-only
  runtime-core + local-sqlite + local-profile

edge-adopted / standalone-adopted
  storage-only + local-admin + local-adopted-profile

edge-application / standalone-application
  adopted + command-file + secret + process + execution + local-application
```

npm dependency 是 package 级而不是 export subpath 级。若把 profile 源码改成
`local-application/profile/*`，只安装该 subpath 仍会解析 local-application 的全部
production dependencies，把 command-file、Secret、Process 和 Execution 闭包带入
storage-only 路由设备产物。把 adopted-profile 合入 application 也会消灭中间的
adoption/fence 独立产物。

因此这两个小 package 是制品裁剪边界，不是单纯代码分层。

## 决策

### 1. Package 是交付与 authority 边界，不是代码分层单位

新增或保留 workspace package 必须至少满足一项：

1. **Profile/依赖隔离**：只进入特定部署 Profile，或隔离 native/大型第三方依赖；
2. **进程/凭据隔离**：拥有独立 binary、数据库角色、Kubernetes RBAC、OS 权限、
   credential 或 destructive authority；
3. **发布边界**：需要独立制品、平台矩阵或供应链审计；
4. **依赖反转**：是被两个以上上层 package 共享的稳定叶子，合并会迫使低层依赖
   composition root；
5. **运行时安全边界**：即使源码很少，也必须证明常驻产物不能携带该 authority。

仅有“领域名称不同”“目录更整齐”“当前只有一个文件”都不能单独成为 package
理由。领域内聚继续通过目录、文件和显式 package subpath 表达。

### 2. 当前 22 个 package 保持不变

- 保留 `local-profile` 作为 storage-only Edge/Standalone 制品边界；
- 保留 `local-adopted-profile` 作为 legacy activation fence 的增量制品边界；
- 保留 `local-command-file`、`local-identity` 和 `local-secret-admin` 的共享或
  authority 边界；
- `runtime-core`、`local-sqlite` 和 `cluster-postgres` 即使文件多，也不再按领域对象
  拆成 workspace package；它们通过显式 subpath 和源码目录管理内聚，分别承担
  Profile-neutral contract、单机 storage adapter 和 Cluster storage adapter 的单一
  发布职责。

只有在 storage-only/adopted 独立产物被明确取消，或引入可证明按 subpath 裁剪
production dependency 的新制品技术后，才能重新评估 Profile 合并。

### 3. 建立 package budget

- QL3 workspace importer hard cap 继续为 22；
- 新 package 必须在 RFC/ADR 中声明满足的边界条件、目标 Profile、生产消费者、
  third-party/native dependency 变化和制品预算；
- 若不能证明新的交付/authority 边界，应优先新增现有 package 的显式 subpath；
- 超过 22 必须同一变更合并或删除至少一个既有 package，或显式修改本 ADR；
- package 数不是性能 KPI，最终仍以 Edge/Standalone/Cluster/Worker 独立产物的
  bytes、files、loaded modules、RSS 和启动门为验收依据。

### 4. Profile 资源门按真实交付层级区分

统一 4 MiB/512-file 门已经无法同时表达 storage-only、adopted compatibility 和完整
application：当前 storage-only 仍低于该门，但 adopted 在没有加载完整 application
runtime 的情况下已达到约 4.51 MB/530 files。采用以下独立上限，RSS 均保持 16 MiB：

- storage-only：4 MiB / 512 files；
- adopted compatibility：5 MiB / 576 files；
- application：5 MiB / 640 files；
- application + AI：6 MiB / 768 files。

这不是把同一个失败门静默抬高：artifact report 必须输出 Profile 名、精确 package
集合和实际上限，storage-only 的路由设备门完全不变；adopted 仍比 application 少
64 个文件预算，且只用于需要 legacy write fence 的兼容部署。

## 不采用方案

### 将 Profile 两个小包合入 local-application

源码移动本身风险低，但会因 package-level production dependencies 扩大 storage-only
和 adopted 制品，直接违背路由设备最小依赖目标。

### 按 LOC 或文件数自动合并

会把 Secret admin、Owner maintenance 等高权限代码带入常驻产物，也无法识别共享
叶子造成的依赖反转。

### 每个领域对象一个 package

会把 runtime-core 和 storage adapter 拆成大量 importer，增加 lockfile、构建、
发布和供应链成本，但没有新增运行时隔离。

### 把全部本机包合成 `@qinglong/local`

会让 storage-only、adopted、application、Owner CLI、maintenance/destructive
authority 和 Secret 写 authority 共享同一发布单元，破坏当前可执行的 dependency/
source boundary。

## 验收证据

- GitNexus 对六个 Profile/adopted bootstrap 及四个内部 helper 的 upstream impact
  均为 LOW，0 条执行流程；这说明源码移动容易，但不能证明制品合并合理；
- manifest 审计确认 3 个一文件 package 的消费者和 production dependency 边界；
- artifact assembly 确认 storage-only、adopted、application 和 AI on/off 是不同
  package chain，而不是同一制品的重复 wrapper；
- storage-only 门通过：edge/standalone 为 4,062,246/4,062,306 bytes、486 files、
  40 loaded modules；adopted 独立门通过：4,510,432/4,510,516 bytes、530 files、
  43 loaded modules；
- D-174 后四种 application 产物门继续通过：非 AI 4,915,362–4,915,506 bytes、
  615 files、90 loaded modules；AI 5,593,183–5,593,339 bytes、659 files、
  89 loaded modules；
- 本轮没有保留任何 Profile 源码移动、manifest、lockfile 或 importer package
  hard-cap 变更，最终代码拓扑仍为 22 package；只新增 adopted 专属制品预算。

## 后续

每增加 5 个 D-series vertical slice，或 QL3 package 数拟超过 22 时重新生成相同
审计表：源码文件/LOC、生产消费者、依赖闭包、exports/binary、authority 和实际
Profile 制品归属。合并候选必须同时证明源码内聚和制品/authority 不回归。
