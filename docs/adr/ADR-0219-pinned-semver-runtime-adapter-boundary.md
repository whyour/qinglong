# ADR-0219：固定 SemVer 运行时适配器边界

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-14、D-35、D-89、D-175、D-209
- 关联 ADR：ADR-0106、ADR-0126、ADR-0128、ADR-0217、ADR-0218

## 背景

`@qinglong/runtime-core` 的 Remote Worker placement、Tool registry、Trusted Tool
invocation、Plugin Package manifest 与 Plugin Package install 五个领域文件分别维护了
一份私有 `semver()` loader。前三份使用 `typeof import('semver')`，因此 TypeScript
builder 还必须安装 `@types/semver`；后两份则各自手写了不完全相同的结构类型。

真实生产行为始终来自 exact `semver@7.7.4`，但重复边界产生了三个问题：

1. 同一第三方 provider 有五个加载与类型 authority，容易在升级时产生能力漂移；
2. base/adopted、local application、Worker、cluster-control 与 cluster-admin builder
   都被迫携带只服务于编译的 `@types/semver`；
3. `runtime-core` 的第一方接口实际上只消费 `valid`、`validRange`、`compare` 与
   `satisfies`，却把第三方完整声明面传播给了领域实现。

这不是删除生产 SemVer，也不能用手写 parser 或字符串比较替代真实库。

## 决策

### 1. 单一 package-internal provider adapter

`packages/ql3-runtime-core/src/pinnedSemver.ts` 是唯一允许直接
`require('semver')` 的 QL3 源文件。它声明最小结构接口 `PinnedSemverApi`，只包含：

- `valid`；
- `validRange`；
- `compare`；
- `satisfies`，包括既有 `includePrerelease` 选项。

adapter 保持惰性加载与单实例缓存。五个领域文件只通过相对 import 消费该 adapter；
不为它增加 package export/subpath，也不新增 workspace package。

依赖审计以 exact 文件白名单固定该 authority，任何其他 QL3 源文件直接导入 SemVer
都失败。

### 2. 保留真实生产依赖，删除冗余声明依赖

`@qinglong/runtime-core` 继续直接声明 exact `semver@7.7.4`。本决策只删除
`@types/semver@7.5.8`：

- runtime-core workspace importer；
- cluster-control builder；
- cluster-admin builder；
- local-application builder；
- 对应 builder lock 与审计期望。

production manifest、runtime lock、SBOM 和 OCI runtime closure 不改变。结构类型由
第一方代码维护，真实 SemVer 算法仍由锁定生产包执行。

### 3. 行为兼容约束

五个调用面的参数、返回判定、异常传播与 prerelease 行为保持不变。尤其：

- canonical version 仍要求 `valid(value) === value`；
- version range 仍由真实 `validRange` 判定；
- Plugin Package 与 Remote Worker prerelease 匹配仍显式使用
  `includePrerelease: true`；
- registry 排序仍使用真实 `compare`。

本次 alpha 内部重构不增加兼容 facade。

## 不采用方案

### 保留五个 loader

拒绝。它没有部署隔离价值，只复制第三方边界并扩大 builder dependency。

### 把 `@types/semver` 移到 root 或共享 builder

拒绝。会隐藏依赖 ownership，且继续让低配 Profile 的 builder 闭包承担无关声明包。

### 手写 SemVer parser 或只比较字符串

拒绝。range、prerelease 与 canonical version 语义复杂，重新实现会产生兼容和安全
风险。本决策只收口真实库的调用边界。

### 新建 `semver-provider` workspace package

拒绝。单文件、单消费者 package 不满足 D-175/D-207 的独立部署、权限、重依赖隔离或
跨闭包复用价值。

## 影响

- workspace 保持 20 个 package；
- production 仍安装并审计 `semver@7.7.4`，运行时能力没有减少；
- 四个 builder manifest 不再声明 `@types/semver`；
- 领域文件不再依赖 DefinitelyTyped 的完整第三方类型面；
- 本机 adopted 制品与 PostgreSQL HA 门可越过 runtime-core，暴露各自真实的下一层
  storage dependency 阻塞。

## 验证

1. GitNexus 将五个旧 loader 判为 2 个 HIGH、3 个 CRITICAL；最大影响 47 个上游
   符号，涉及 Trusted Tool、Plugin Package 与 Remote Worker。改动因此保持真实 provider
   与调用语义不变，并对这些流程执行专项回归；
2. runtime-core build 通过，全量 369/369；
3. adapter、五个领域调用面与依赖 import boundary 定向 90/90；
4. dependency/deployment/SBOM/OCI/local-image 契约 101/101，production
   component/node 数不变；
5. 三个容器 builder lock 已从本地缓存离线重生成，当前 build dependency 审计仅保留
   Node、PostgreSQL 与 TypeScript 必需声明；
6. 首次 PostgreSQL HA 门已成功越过 runtime-core，并准确暴露
   `cluster-postgres` 未物化的 `pg`、`drizzle-orm`；随后从本机受审
   control/admin image 临时提取 exact production closure，三个 Cluster package
   均完成 TypeScript build；
7. edge-adopted 制品门已成功越过 runtime-core，当前由 `local-sqlite` 未物化的
   `drizzle-orm` 阻断；
8. 临时物化后的完整 `cluster-admin check → cluster-control check → HA Docker`
   总门通过 PostgreSQL 18.4 arm64 的 35 个具体 gate 与总 `passed`；过程中还发现并
   修正 HA CJS caller 未传 Cron provider，以及 Node 24 对 Kubernetes Node-stream
   pair 类型建模不足的问题，PortForward/TLS 定向测试 9/9；
9. 所有临时 package-local link 和 HA Docker container/volume/network 已清理。

因此本 ADR 已证明 SemVer 边界、builder closure 与本机 HA runtime 一致；但本机镜像
临时物化不能替代常规 registry 安装、远端 CI、六 Profile 物理 bytes/files/RSS 或
未物化 local-sqlite dependency 的完成证据。
