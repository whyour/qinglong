# ADR-0475：Legacy System、Script 与 Open API 兼容基线

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-378、D-381、D-382
- 关联 ADR：ADR-0046、ADR-0471、ADR-0474

## 背景

ADR-0471 已锁定 Cron/Subscription 的核心执行 API，ADR-0474 已证明 adopted rollback 后正确 2.x 版本的本机 HTTP core
能够完成初始化。但 QingLong 2.x 部署用户仍直接依赖 System 配置、Script 文件与运行接口、Open 应用管理/token，以及面板和
Open 调用的认证、scope 与错误 envelope。缺少这些契约时，`legacy_ready` 只能证明一个极小健康点，不能支撑 3.0 升级前的
兼容评估。

兼容也不能意味着冻结已知不安全行为。现行 Script 目录检查使用字符串前缀，`scripts-sibling` 这类同前缀兄弟目录可能被当成
脚本根目录内部；目录列表还可能经直接符号链接离开脚本根。低配路由设备和集群节点都需要相同的失败关闭边界，且修复不能引入
新的 package、依赖或常驻资源。

编辑前 GitNexus upstream impact 显示：`readDir`、`isPathAllowed` 与 `ScriptService.checkFilePath` 均为 LOW，分别只有有界直接
调用者且没有已识别 execution flow；`back/loaders/express.ts` 为 HIGH，累计影响 29 个 symbol、22 个直接调用者。实现因此不修改
HIGH 风险的 Express 装配，只通过测试注入选择性生产 Router 和确定性 store 来执行原生产中间件。

## 决策

### 1. 用真实 HTTP 边界锁定现行契约

兼容门启动真实 loopback HTTP server，执行生产 `back/loaders/express.ts` 中间件以及生产 System、Script、Open Router 和
Celebrate validator。测试只替换 Router 之外的 service/store 副作用边界，不启动 master、scheduler、gRPC、Keyv SQLite 或完整
数据库，因此既验证路由、认证、校验和 envelope，又保持一次性、确定性和低资源成本。

锁定的 2.x 契约包括：

- System config 读取，日志清理频率、Cron 并发、依赖代理与 Python 镜像更新，reload、notify 及非法 body 的 dispatch 顺序；
- Script 根目录列表、detail、create、rename、run、越界拒绝及非法 run body；
- Open app list/create/update/delete/reset-secret 与公开 token issuance；
- 面板缺失/未登记 token，Open scope 允许/拒绝、过期 token、路径大小写、Celebrate 400 和通用 500 envelope。

现行受保护的成功响应继续使用 HTTP 200 与 `{code:200}`；既有 Script 路径授权拒绝继续返回 HTTP 200、`{code:403}`，避免在
3.0 孵化阶段静默破坏客户端。认证与中间件错误的既有 HTTP 状态和 JSON envelope 由测试精确锁定。

### 2. 路径 containment 必须按路径段判断

新增共享 `isPathInside(rootPath, targetPath)`，使用 `path.resolve`、`path.relative`、平台分隔符和 absolute 检查判断 lexical
containment。Script API 写入根检查和 `ScriptService.checkFilePath` 复用该函数，不再用 `startsWith` 接受同前缀兄弟目录。

`readDir` 在读取前同时执行：

- lexical containment；
- base/target `realpath` containment；
- target `lstat` 必须是非符号链接目录。

不满足任一条件时保持兼容地返回空列表。这关闭本阶段已证明的同前缀和直接目录符号链接越界，但不把 legacy Script API 宣称为
完整 capability filesystem sandbox；任意层级写入、TOCTOU 与 OS 权限隔离仍必须由 3.0 capability authority 和执行器边界解决。

### 3. Legacy Open scope 不升级为 3.0 Policy

`/open/*` 继续验证 2.x app token、expiration 与首段 scope，作为回滚兼容合同。它不获得 Project、Policy version、Approval、
Action digest 或 durable authorization fact，也不能作为 3.0 管理/执行 API 的授权来源。3.0 的新 API 继续使用 RFC 已定义的
Identity、Policy、Approval 与 capability 边界。

### 4. 保持低配与集群部署闭包不变

生产变更只位于现有 legacy backend 的三个文件；测试 harness 不进入发布制品。不新增 workspace package、production dependency、
binary、daemon、listener、timer、watcher、queue、cache、数据库连接、容器或 Kubernetes workload。Edge/Standalone 的基础运行闭包
和 Cluster 的独立控制面边界均保持不变。

## 被否决方案

1. **只 grep 路由或快照源码**：不能证明真实 middleware 顺序、Celebrate 400、认证与响应 envelope，拒绝。
2. **测试时启动完整 master 与数据库图**：引入无关 Keyv/SQLite、scheduler 和服务生命周期，导致兼容门不确定且资源过重，拒绝。
3. **为测试可见性重构 `back/loaders/express.ts`**：GitNexus 返回 HIGH，且本阶段无需承担 22 个直接调用者的行为风险，拒绝。
4. **保留字符串前缀和符号链接越界以追求兼容**：这是安全缺陷而非受支持合同，拒绝。
5. **把 2.x Open scope 映射为 3.0 Policy**：两者缺少相同 subject、version、resource 与 durable fact 语义，拒绝。
6. **拆出新的兼容 package**：测试和三个 legacy 修复没有独立交付、依赖或生命周期理由，拒绝。

## 升级与回退

本阶段没有 schema 或持久数据迁移。升级后，同前缀兄弟目录与直接目录符号链接不再能通过 Script 列表访问；这是失败关闭的安全
收紧。若旧部署依赖这种越界布局，应把脚本移动到真实 script root，而不是恢复不安全检查。

回退代码不会破坏已有数据，但会重新暴露越界读取风险，因此不建议把该安全修复单独回退。2.x Open token 与 envelope 仍保持现行
兼容；3.0 新 API 不接受它们作为 Policy authority。

## 验收证据

- D-382 聚焦门 `10/10`；与 D-378 Cron/Subscription `18/18`、D-381 `/api/system` readiness `2/2` 合并为 legacy HTTP 兼容门
  `30/30`。
- backend 全量 `1,535 total / 1,533 pass / 2 conditional skip / 0 fail`；`pnpm build:back` 通过。
- 18-package clean build 与逐包测试单次退出 0；package boundary、Cluster dependency、Edge import、Service Bridge import、
  Cluster/Worker deployment、Console 与 Console distribution 八项审计全部 compatible/passed。workspace 仍为 18 packages，
  `singleSourcePackages=[]`、`shallowSourcePackages=[]`，Local Owner 为 `113 source / 112 nested / 1 root binary entry`。
- 14 档 Local artifact audit 全部 compatible。基础 Edge/Standalone 为 `2,598,669 / 2,598,747` bytes、316 files、57 loaded
  modules；Adopted 为 `2,817,964 / 2,818,087` bytes、336 files、58 loaded modules；Application+AI 为
  `4,501,822 / 4,501,954` bytes、511 files、141 loaded modules；MCP 为 `7,324,601 / 7,324,709` bytes、802 files、
  227 loaded modules。
- 本阶段不修改 SQL、migration、PostgreSQL ACL/repository/role/Pool、连接或 failover 语义，因此不重跑且不重新占有
  PostgreSQL HA 证明。

## 未完成

- 真实 2.x SQLite 数据目录升级与回退演练；
- Primary 双态和真实目标实例 rollback rehearsal；
- 更广的 Config、Environment、Dependency 与日志 API 兼容矩阵；
- 任意层级 Script 写入的 capability filesystem 隔离与 TOCTOU 防护；
- 固定物理 Edge 与待镜像基础设施恢复后的 OpenRC live actor。

本 ADR 关闭 System、Script、Open 与认证/错误 envelope 的第二批 2.x HTTP 兼容基线，不代表 QingLong 3.0 升级/回退 Gate 已全部完成。
