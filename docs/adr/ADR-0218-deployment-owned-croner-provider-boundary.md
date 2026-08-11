# ADR-0218：部署 Owner 持有的 Croner Provider 边界

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-14、D-35、D-89、D-105、D-175、D-208
- 关联 ADR：ADR-0103、ADR-0104、ADR-0105、ADR-0106、ADR-0126、ADR-0128、ADR-0217
- Supersedes：ADR-0106 中 `runtime-core` 继续传播 Croner 的临时状态，以及
  ADR-0103 中 SQLite storage publication 直接计算首个 cron occurrence 的实现细节

## 背景

`@qinglong/runtime-core` 同时被基础 Edge/Standalone、adopted-only、AI-only、
local application、Worker、cluster-control、cluster-admin 与 PostgreSQL adapter
使用。它此前直接声明 `croner@7.0.8`，并在 `localScheduler.ts` 内动态加载 Croner。
虽然 idle import 没有加载模块，包级依赖仍让所有 production closure 安装 Croner。

这产生三个不合理结果：

1. 不运行 Scheduler 的基础路由器、Worker 与短生命周期 cluster-admin 仍承担包字节、
   inventory、SBOM 与漏洞审计成本；
2. Cron provider 的部署责任被纯领域/协议 core 隐藏；
3. SQLite Trigger 与 adoption publisher 在 storage transaction 内加载 Croner并计算
   首个 occurrence，而 PostgreSQL 已写入 `NULL` sentinel、由 schedule owner 首次计算，
   两个 Profile 的 durable 语义不一致。

不能通过再建一个单文件 workspace package 解决这个问题，否则会违反 D-175/D-207，
把一个依赖移动问题变成新的 importer、发布和供应链成本。

## 决策

### 1. runtime-core 只保留纯 port 与决策 fence

`@qinglong/runtime-core/local-scheduler` 新增：

- `LocalCronSchedule`：只携带 `expression` 与 `timezone`；
- `LocalCronNextOccurrence(schedule, afterMs)`：由受信 deployment composition 提供。

`initialLocalCronNextFireAt`、`resolveLocalScheduleDecision` 与
`resolveClusterScheduleDecision` 必须显式消费该 port。core 统一拒绝：

- cron macro；
- 非函数 provider；
- 非安全整数、负数或不严格大于 `afterMs` 的结果；
- provider 抛错或无下一时刻。

失败只映射为稳定 `InvalidLocalScheduleError`，不能让 provider 绕过时间单调性，也不把
任意 provider 错误文本带入外部诊断。

### 2. 真实 Croner adapter 归部署 owner

不新增 package：

- 本机 adapter 固定为
  `@qinglong/local-execution` 的 `src/scheduler/croner.ts`；
- Cluster adapter 固定为
  `@qinglong/cluster-control` 的 `src/cronerSchedule.ts`。

两个 package 直接声明 exact `croner@7.0.8`。adapter 只在第一次实际计算时
`require('croner')`，并在 `finally` 中停止临时 Cron job；模块 import、空 schedule 页和
disabled composition 均不加载 Croner。依赖审计禁止任何其他 QL3 源文件导入 Croner。

### 3. storage publication 统一写 NULL sentinel

SQLite Trigger append、Legacy adoption 与 PostgreSQL Trigger append 都在原子发布事务内
写入：

```text
next_fire_at_ms = NULL
last_scheduled_at_ms = NULL
```

这不是“未知调度成功”，而是耐久的“尚未由 schedule owner 计算”状态。首次本机
application 或 cluster-control cycle 使用受审 provider，从 immutable Trigger
revision 的 expression/timezone 与 `triggerUpdatedAtMs` 计算；随后按现有 schedule
version/claim fence 原子执行 initialize、skip 或 admit。

因此 adoption-only 制品可以发布完整 Trigger 事实而不携带 Croner；稍后 application
启动时仍按原来的 misfire policy 处理，不能回放无界 backlog。

### 4. Profile 与镜像闭包

- base Edge/Standalone、adopted-only 与 AI-only：外部 schedule 相关闭包只有
  `semver`，不安装 Croner；
- local application：通过 `local-execution` 保留 Croner；
- cluster-control：保留 Croner；
- Worker、cluster-postgres、cluster-admin：不声明 Croner。

cluster-admin production lock 因此从 85 个外部 component 降为 84；加三个内部
component 后，CycloneDX 从 88 components/89 dependency nodes 降为 87/88。
cluster-control 保持 43+3 components/47 nodes，本机 application 镜像仍保持
Croner+SemVer 两个外部 runtime root。

workspace importer 保持 20，不新增 migration、表、进程、timer、watcher、listener、
端口或 credential authority。

## 不采用方案

### 新建 `local-cron-provider` package

拒绝。只有一个第三方 adapter，且两个部署 owner 已有清晰 process/package 边界；新包
只会恢复 package-per-concept。

### 把 Croner 设为 runtime-core optional/peer dependency

拒绝。optional 仍会污染 lock、安装和漏洞图；peer 会把缺失/错误版本推迟到运行时，
也无法表达 cluster-admin 明确不需要 Croner。

### SQLite 继续在 storage transaction 内计算

拒绝。会迫使 base/adopted storage 闭包持有 provider，并继续与 PostgreSQL 的
`NULL` sentinel 语义分叉。

### 手写 cron parser

拒绝。cron/timezone/DST 语义复杂，重新实现会扩大正确性与安全风险；本决策只移动
既有 exact dependency 的 owner。

## 影响

- `runtime-core` 变为 Croner-free 领域/协议包；
- 基础路由设备、Worker 与 cluster-admin 删除无用 production dependency；
- 首次 schedule 计算从 storage publisher 移到唯一 schedule owner，但
  `triggerUpdatedAtMs`、misfire、schedule CAS/claim 与 Run admission 语义不变；
- provider 成为显式测试 seam，core 可独立证明异常和时间倒退失败关闭；
- alpha 公共函数签名增加 mandatory provider，所有仓内 caller 同切片迁移，不保留
  隐式 fallback facade。

## 验证

当前已完成：

1. GitNexus impact：五个核心/协调器符号均为 LOW；本机协调器影响 4 个符号、2 组
   application bootstrap 流，Cluster 协调器影响 9 个符号；SQLite 两个写 authority
   均为 LOW；
2. runtime core + local-execution Scheduler 13/13，Cluster coordinator 5/5；
3. SQLite Trigger/adoption/schedule 定向 5/5，完整 SQLite 可执行测试 142 pass，
   另 2 项只因未物化 `ts-node`/`drizzle-orm` 无法启动；
4. Cluster PostgreSQL schedule repository 6/6；
5. dependency/deployment/SBOM/OCI contract 73/73；Croner source import 只允许两个
   exact adapter；
6. local application build 通过，application/local-image 相关组合 45 pass、
   1 个实机条件 skip；Worker entrypoint 只因既有 `proper-lockfile` 未物化无法启动；
7. admin SBOM 实测报告为 84 external + 3 internal、87 components/88 nodes；
   control 保持 46/47；
8. adopted artifact 门已不再报告 Croner 缺失；ADR-0219 又移除
   `@types/semver` builder 阻塞，当前第一阻塞点为 local-sqlite 未物化的
   `drizzle-orm`；
9. 从本机已受审 control image 临时提取 exact production closure 后，两个真实
   Croner adapter 已以 `croner@7.0.8` 完成 UTC 与 Asia/Shanghai 4/4 计算；
10. PostgreSQL HA contract 的旧两参数 Scheduler 调用已修正为显式传入
    cluster-control adapter；完整 `cluster-admin check → cluster-control check →
    HA Docker` 总门以 PostgreSQL 18.4 arm64、physical streaming/`remote_apply`
    通过 35 个具体 gate 与总 `passed`。

六 Profile 新 bytes/files/RSS、完整 workspace 与 Worker 物理执行仍必须在锁定依赖
常规物化后重跑。上述 HA 总门使用本机镜像的 exact production dependency closure
临时物化，完成后已删除全部 package-local link，且临时 Docker 容器、卷、网络为零；
普通开发机直接重跑仍会在 cluster-postgres 未物化的 `pg`/`drizzle-orm` 处失败。
不能把本机镜像复用证据冒充 registry 安装或远端 CI 证据。
