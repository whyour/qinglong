# ADR-0177：Active Head 驱动的本机 AI Application Composition

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-73、D-84、D-87、D-89、D-156、D-158、D-166、D-167；ADR-0167、ADR-0176

## 背景

ADR-0176 已建立显式、耐久的本机 AI feature active head 和数据库写围栏，但产品启动
尚未消费该事实。仅有管理 CLI 和底层 Profile 会留下四个缺口：

1. 部署不含 AI、含 AI 但未启用、已经启用三种状态没有统一的产品 composition；
2. 若基础 application 静态导入 AI，未启用 AI 的路由设备也会安装或加载可选能力；
3. 进程启动后发生停用时，内存中的 provider 可能继续接受请求；
4. operator 不知道 activate/deactivate 后何时需要重启来完成加载或卸载。

本决策只解决 edge/standalone 本机产品 composition。它不开放 HTTP/MCP/UI route，也
不把本机 Owner ceremony 扩展为 Cluster authority。

## 决策

### 1. 复用现有 application 包，不新增小包

在既有 `@qinglong/local-application` 内增加显式
`@qinglong/local-application/ai-feature` 子路径。基础 root 保持不变；不新增
workspace package、第三方生产依赖、进程、listener、watcher、后台 timer 或缓存。

基础 application 制品不安装 `@qinglong/ai`。只有显式选择 `*-application-ai`
制品时才把 AI package 纳入 production archive；选择该制品仍不代表启动时加载 AI。
`@qinglong/local-sqlite/optional-feature-runtime` 复用现有
`packageManagement.ts`，只增加窄 subpath 和返回类型，不创建“一文件一包”。

### 2. 启动顺序由 durable active head 决定

产品入口固定执行：

```text
base application ready
  → deployment included?
  → open optional-feature read authority
  → read exact 9007 head
  → active 时才 dynamic import AI
  → validate full feature history/schema/checksum and exact generation/digest
  → assemble shared invocation/pricing storage
  → bounded recovery
  → load provider credentials
  → active
```

以下路径不得加载 AI 或 provider：

- base application disabled；
- deployment 明确 `excluded`；
- 9007 schema 不存在；
- head 为 `inactive`。

active head 存在但 AI package、完整 schema/history、storage、recovery 或 provider
不可用时，整个组合失败关闭，并停止已经启动的 base application，不能降级成一个
表面 ready、实际丢失已启用能力的进程。

### 3. 每次请求复验 generation/digest

启动时读取的 active generation 和 transition digest 不是永久内存开关。每次
`list_models`、`generate`、`stream` 和 usage read 在占用 operation slot 前，都通过
同一个 SQLite operation authority 复验 exact active head。

若 head 已停用或漂移：

- 当前请求以 `ModelGatewayProfileDrainingError` 失败；
- capability 立即停止接收新操作；
- 没有 active operation 时按 provider → storage 顺序释放；
- 有 active operation 时等待最后一个 operation 完成后自动释放，不需要 timer。

数据库事务内的 admission fence 仍是防止新 durable invocation 的最终权威；这里的
请求前 fence 用来及时撤销进程内 provider authority，二者不能互相替代。

### 4. 有界 drain 和重启语义

组合根只暴露一个统一 `stop()`。停止顺序为 AI admission/drain、provider、AI
storage，再停止 base application。轮询只发生在显式 `stop()` 调用栈内，默认超时
5 秒、默认间隔 25 毫秒；没有常驻 timer。超时返回 `timed_out`，不把仍在执行的调用
伪装成已停止；最后一个调用完成时 Profile 仍会释放 authority。

`ql3-ai-feature activate|deactivate` 的成功响应必须返回
`runtimeAction: "restart_required"`，`inspect` 返回 `"none"`：

- activate 后重启，产品入口才会加载 AI；
- deactivate 的数据库写围栏立即生效，当前进程的下一次 AI 操作触发 drain；
- 重启是 operator 可验证的最终卸载边界，不实现隐式 watcher 或热重启。

### 5. Readiness 与可选 schema

本机基础 readiness 继续精确验证全部 owned base 表、列、索引和 trigger。其 adoption
`tableCount` 只排除已经受审的 14 张 AI optional feature 表；未知表仍计数并造成
manifest evidence 漂移，不能用前缀通配符隐藏扩展。

AI active composition 另外验证独立 9001–9007 history、checksum、schema 与 head。
因此“基础 readiness 不把受审 optional 表当作 legacy drift”不等于“基础 readiness
替 AI 证明可用”。

## 拒绝方案

1. **新建 `local-ai-application` package**：没有独立部署或依赖收益，只增加 importer
   和单文件包，拒绝。
2. **基础 application 静态依赖 AI**：让禁用 AI 的低配设备承担安装和加载成本，拒绝。
3. **schema presence 即启用**：绕过 Owner active head，拒绝。
4. **只在启动时读一次 head**：停用后进程内 provider 仍可接受请求，拒绝。
5. **用 watcher/timer 热装卸**：增加空载资源、竞态和不可预测运维语义，拒绝。
6. **active AI 启动失败时继续 base ready**：部署声明与 durable operator intent 不一致，
   拒绝。
7. **为 optional 表使用名称前缀豁免**：会隐藏未知插件或漂移表，拒绝。

## 当前证据

- local-application 18/18，覆盖 disabled/excluded 零 AI module、schema absent 零
  provider、真实 active startup、请求前停用 drain、inactive restart 和 provider
  启动失败后的完整 authority 释放；
- AI 98 项：96 pass、2 条 PostgreSQL 条件 skip；新增 active-head fence 与最后 operation
  自动释放测试；
- local-sqlite 127/127、local-admin 57/57、local-adopted-profile 7/7、
  local-owner-cli 22/22；22-package 全量门在允许本机 listener 的环境退出 0；
- 22-importer dependency/source audit `findings=[]`，local-application 4 个源码文件；
  精确允许 AI composition subpath，AI root/internal 和其它 SQLite runtime subpath
  均有负向门禁；
- edge/standalone 基础制品为 3,913,976/3,914,036 bytes、478 files、40 modules；
  application 为 4,578,408/4,578,540 bytes、591 files、87 modules；
  application-ai 为 5,256,223/5,256,367 bytes、635 files、87 modules。后者安装
  `@qinglong/ai`，但入口初始 require 没有加载它；
- disabled AI benchmark 仅加载 1 个 AI module，RSS 增量 475,136 bytes，三种 Profile
  的 storage/provider/management loader 均为 0。
- PostgreSQL 18.4 arm64 physical HA Docker 门重新通过：timeline 1→2、旧主 fencing、
  `pg_rewind` 只读同步重入、双 control replica 恢复和全部具体 gate 均为 true；
  pg-9001–pg-9006、11 张 AI 表及 ACL 在 promotion 前后精确一致。本地 composition
  没有修改 Cluster schema，该门只证明既有 Cluster 边界未回归。

## 后续门禁

1. ADR-0178 已由真实 edge/standalone headless executable 选择该 composition root；
   通用 CLI 的 installed provider ceremony 仍保持失败关闭；
2. 在固定低配 Linux 路由设备上记录冷启动、峰值 RSS、断电、ENOSPC 与备份恢复；
3. activation/price mutation 的专属 COMMIT-response-loss/SIGKILL 矩阵；
4. provider 配置 ceremony 与认证产品 route；在这些 authority 完成前不开放 HTTP/MCP/UI；
5. Cluster 继续使用 TLS identity、平台 Policy/quota 和职责分离，不复用本机 9007。
