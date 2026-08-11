# ADR-0257：Profile 运行制品裁剪与分层 Import RSS 预算

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-85、D-89、D-175、D-207、D-240
- 关联 ADR：ADR-0042、ADR-0185、ADR-0217、ADR-0256
- Supersedes：ADR-0185 中“所有 Profile 共用 16 MiB import RSS delta”与未区分开发包/运行制品的部分；不改变其 package 边界和文件/字节预算

## 背景

D-239 完成后，按真实 `pnpm pack -> offline install` 重跑十种本机 Profile，暴露出三个
不同问题：

- storage-only 安装闭包超过 512 files；
- adopted assembly 没有显式携带 `local-admin` 运行时需要的 `local-secret`；
- application 为 741 files、约 6.40 MiB，入口 import RSS delta 约 20.2--20.35 MiB，
  超过原 640 files / 5 MiB / 16 MiB 门。

逐文件核算发现，内部 npm 包中的 `.d.ts` 和 `.map` 占用了大量部署 inode/bytes，但
Node 运行时不消费它们。另有两处不必要的 eager import：fresh/disabled adoption 在读取
启用开关前加载 admin runtime；通用 TaskDefinition repository 为抛出管理域错误而静态加载
administration 模块。它们是制品装配和入口依赖问题，不是新增 workspace package 的理由。

## 决策

### 1. 开发包与最终运行制品分离

内部 npm package 继续发布 `dist/**/*.js` 与 `dist/**/*.d.ts`，供 workspace、SDK 和类型消费；
source、test、声明 map 和 JS map 仍由 packlist 规则排除。Profile assembler 在完成 exact
offline install、核对精确 package closure 后，只从 `node_modules/@qinglong/**` 删除：

- `*.d.ts`；
- `*.map`。

不得裁剪第三方包、JavaScript、package manifest、受审 assets、Drizzle migration 或 native
文件；不得通过 ignore、symlink、未声明依赖或 workspace source 直接运行来制造通过。Docker
local application 镜像必须执行同一内部运行制品裁剪，静态镜像审计同时验证两类删除命令。

### 2. 精确装配 adopted 与 application 闭包

adopted Profile 的 production closure 显式包含 `@qinglong/local-secret`。fresh/disabled
adoption 入口先读取 enable gate，仅在启用后动态加载 `@qinglong/local-admin/runtime`；因此
storage-only 和 fresh adopted 不为迁移 authority 支付模块加载成本。

通用 SQLite TaskDefinition repository 不再静态导入管理域错误模块。事务 hook 抛出的精确
错误实例原样传播，其他 storage failure 仍由既有 `mapStorageError` 处理；没有改变 repository
对外语义或放宽错误分类。

### 3. Profile 预算表达实际能力层级

文件和字节预算保持 ADR-0185 的分层，不因本次失败放宽：

| 能力层 | 文件上限 | 字节上限 | import RSS delta 上限 |
| --- | ---: | ---: | ---: |
| storage-only | 512 | 4 MiB | 16 MiB |
| adopted compatibility | 576 | 5 MiB | 16 MiB |
| AI-only | 640 | 5 MiB | 16 MiB |
| application | 640 | 5 MiB | 24 MiB |
| application + AI | 768 | 6 MiB | 24 MiB |

24 MiB 只表示在独立 Node probe 中加载完整 application capability entrypoint 后的 RSS
增量，不是设备总内存预算。Edge production process 仍至少按 96 MiB 暂定总物理预算规划，
最终支持声明仍要求 Linux cgroup 和固定物理设备证据；不能用本门替代 cold start、峰值 RSS、
执行并发或闪存证据。

### 4. 不改变 package 拓扑

workspace 保持 19 个 package，不新建 artifact-pruner、task-admin 或 profile wrapper 包，不新增
production dependency、migration、daemon、timer、watcher、listener、Pool、连接或端口。
源码文件数量继续只触发 package 复审；合并仍必须证明不会破坏 Profile closure、共享 leaf、
进程权限或高权 authority 排除。

## 被拒绝的替代方案

1. **把 19 个包合成少数大包**：npm dependency 按 package 解析，会把 administration、Secret、
   Process 和 Execution 依赖带入 storage-only 设备，拒绝。
2. **所有 Profile 统一抬到更大门限**：掩盖 storage/adopted 回归，拒绝；只有真实加载完整
   application 的能力层采用 24 MiB。
3. **从 npm package 删除声明文件**：破坏类型消费者与开发体验，拒绝；裁剪只发生在最终运行
   assembly。
4. **删除任意第三方文档、locale 或 package metadata**：会产生不可审计、升级易漂移的供应链
   裁剪，拒绝。
5. **让 disabled adoption eager-load 后只在业务上不执行**：安装闭包和 import RSS 仍已支付，
   拒绝；enable gate 必须先于 authority import。

## 验证

十档 exact offline artifact audit 全部通过：

| Profile | files | bytes | loaded modules | RSS delta bytes |
| --- | ---: | ---: | ---: | ---: |
| edge | 320 | 3,476,131 | 42 | 10,633,216 |
| standalone | 320 | 3,476,179 | 42 | 10,780,672 |
| edge-adopted | 358 | 4,033,157 | 43 | 10,764,288 |
| standalone-adopted | 358 | 4,033,241 | 43 | 10,878,976 |
| edge-application | 412 | 4,516,812 | 98 | 20,168,704 |
| standalone-application | 412 | 4,516,956 | 98 | 20,578,304 |
| edge-ai | 343 | 4,067,239 | 43 | 10,878,976 |
| standalone-ai | 343 | 4,067,299 | 43 | 10,878,976 |
| edge-application-ai | 435 | 5,107,992 | 97 | 20,348,928 |
| standalone-application-ai | 435 | 5,108,148 | 97 | 20,414,464 |

每档报告都包含实际/最大 files、bytes、RSS、精确 package 集合及被裁剪的内部开发文件计数。
local image 静态审计返回 `findings=[]`，并确认 application closure 包含 `local-secret`。
adopted lazy-authority 契约 8/8、TaskDefinition transaction 定向回归 13/13、local image
审计 7/7、local-sqlite 189/189 均通过；19 个 QL3 package 清理后拓扑构建和完整测试
零失败，backend 956 pass/2 条件 skip/0 fail。Edge import compatible，19-importer dependency
audit `findings=[]`；GitNexus compare-to-develop 与工作树检测均为 LOW、0 affected process。

## 后续约束

- 每次新增 production export、application capability 或 Profile package 必须重跑全部十档，不能
  只测 edge；
- 报告数字是开发机可重复审计门，不自动构成任意路由器的支持声明；
- 若 application import delta 接近 24 MiB，必须先给出模块级 eager closure 解释和瘦身方案，
  不能再次直接抬门；
- physical Edge、native/init-managed startup、镜像 SBOM/漏洞和 Cluster HA 门保持独立。
