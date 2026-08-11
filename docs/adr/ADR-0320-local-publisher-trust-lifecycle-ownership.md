# ADR-0320：Local Publisher Trust Lifecycle Ownership

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-257
- 关联 ADR：ADR-0267、ADR-0276、ADR-0295、ADR-0318、ADR-0319

## 背景

ADR-0319 已把 Local Publisher Trust 的 contract、codec 与 private filesystem store 从 facade 分离，但 1,112 行
facade 仍同时拥有只读 inspection、provision/rotation publication、retirement 和双阶段 compromise revocation。
这些流程共享同一 durable store，却有不同的授权语义、callback barrier 和演进原因，继续平铺会让修改一种生命周期
时无意触碰另外三种。

编辑前逐 symbol GitNexus impact 显示 8 个 coordinator/helper 全部为 LOW。`createSnapshot` 有 3 个直接上游并进入
2 条流程，`assertTransition` 有 1 个直接上游；6 个公开入口在当前图中为 0 个 production process 扩散。没有 HIGH
或 CRITICAL。

## 决策

保持一个 Local Admin package、一个公共 subpath 和 18 行稳定 facade，在现有 `publisher-trust/` ownership 下新增
四个 package-private lifecycle 模块：

```text
publisher-trust/
├── contracts.ts                    # schema、公开 contract、错误 identity
├── codec.ts                        # canonical codec、digest、纯 snapshot composition
├── privateFilesystemStore.ts       # POSIX durable store
└── lifecycle/
    ├── inspection.ts               # read-only bounded projection
    ├── publication.ts              # provision、overlap rotation、publication fence
    ├── retirement.ts               # intent → proof → receipt → snapshot
    └── revocation.ts               # proposal → independent confirmation → snapshot
```

`createSnapshot` 是纯 canonical composition，归入 codec；publication、retirement 和 revocation 只导入同一个函数，
不复制 digest 规则。`assertTransition` 只服务 provision/overlap rotation，留在 publication。Revocation proposal 与
confirmation 保持在同一个 484 行模块，因为二者共同拥有 compromise transaction identity、impact digest、
dual-control/break-glass 与 quarantine lock 语义，禁止为了“一函数一文件”拆断协议。

原 `pluginPackagePublisherTrust.ts` 只 re-export contract、三个公开 codec function 与六个 lifecycle function。
所有公开函数、错误 class、package export 和调用路径仍是同一个 runtime object；没有新增公共 subpath。

本轮逐字移动 coordinator body，不修改 callback 执行点、generation fence、snapshot/intent/receipt 发布顺序、
authorization mode、impact/quarantine 语义、crash replay status、返回投影或错误 identity。

## 小设备与集群影响

新增 lifecycle 文件只进入包含 Local Admin 的 Application 制品，不进入最小 Edge/Standalone 基础 Profile。
四个物理文件没有增加实际启动 loaded module 数，说明现有基础/Application 启动闭包没有因目录拆分扩大。没有新增
dependency、进程、timer、listener、数据库连接或 Cluster 部署单元。

## 被否决方案

1. **单一 `lifecycle.ts`**：只是把 1,112 行文件换名，仍混合四种 authority，拒绝。
2. **proposal/confirmation 各一个文件**：拆断同一 revocation durable protocol，拒绝。
3. **每个公开函数一个 workspace package**：没有独立产物或部署闭包，拒绝。
4. **lifecycle 直接实现 filesystem publish**：破坏 ADR-0319 store ownership，拒绝。
5. **改成动态 import 降 module count**：当前 loaded module 未增长，没有必要引入异步 API 与失败面，拒绝。

## 验收证据

- facade 1,112→18 行；inspection 67、publication 239、retirement 318、revocation 484 行；codec 为 829 行、
  private store 841 行、contract 174 行。
- facade 与 owning module 的 6 个 lifecycle function identity 逐项相同；contract error 与公开 codec identity 沿用
  ADR-0318/0319 的同对象证明。
- Local Admin build 与 91/91；完整 16-package clean build/test 最终退出 0，Owner CLI 134/134，Application
  40 pass/3 条件 skip。
- package boundary 为 16 package、812 source、25 root、787 nested、findings 为空；Local Admin 为 36 source。
  Edge import、Cluster dependency、Cluster deployment 全部 compatible。
- Edge/Standalone Application 为 4,731,034/4,731,154 bytes、435 files、110 loaded modules；Edge/Standalone
  Application AI 为 6,126,411/6,126,543 bytes、514 files、109 loaded modules。相对 ADR-0319 只增加 4 个物理
  文件，loaded module 数不变，pack/RSS 预算保持 compatible。
- 本轮不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不重复 PostgreSQL HA Docker 门。

## 未完成

Local Publisher Trust 的 package 内 ownership 已形成稳定 contract → codec/store → lifecycle → facade 层次。下一轮
回到 workspace 大文件职责审计，优先选择仍同时混合协议、持久化与 coordinator 的实现；纯 schema declaration
继续不因 LOC 被机械拆分。
