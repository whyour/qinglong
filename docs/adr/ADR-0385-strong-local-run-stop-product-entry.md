# ADR-0385：强认证的 Local Run Stop 产品入口

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-297
- 前置决策：ADR-0005、ADR-0072、ADR-0086、ADR-0365、ADR-0372、ADR-0381、ADR-0384

## 上下文

Local Edge/Standalone 已有 cancellation repository、执行期 convergence 和单进程 HTTP `run.stop`，但 HTTP bearer 只能建立 `single_factor` User。ADR-0381 为人工 `run.retry` 建立了 Owner credential、pepper provenance、POSIX 私有命令文件和五分钟 `local_console` 强认证入口；`run.stop` 尚未进入同一产品面，导致 Local 与 Cluster 的强管理命令不对称。

QingLong 的 Local 部署可能运行在内存和 CPU 很小的路由设备上。补齐 stop 不能新增 package、数据库 migration、表、索引、常驻进程、listener、timer、watcher、连接、cache 或 sidecar，也不能让未调用管理命令的 runtime 多加载 Owner 管理依赖。

## 决策

### 1. 统一既有 `ql3-run`，不新增 package 或 binary

`@qinglong/local-owner-cli` 的既有 `ql3-run` binary 改为严格判别的 `retry | stop` 命令面：

```text
ql3-run retry --command-file /absolute/private-command.json
ql3-run stop  --command-file /absolute/private-command.json
```

`run.stop` 只接受私有 regular command file 中的 Project/Run identity、UUID mutation identity、request/audit identity、请求时间和既有 Local deployment authority 路径；Event ID、Principal、Policy fence、取消原因与数据库时间均由进程或服务端生成。产品根命令 `ql3 run` 仍无 shell 拼接地委派同一个 binary。

### 2. 强认证与事务内 credential fence

stop 复用 Owner credential、versioned pepper keyring 与 POSIX proof，建立不超过五分钟的 `local_console` User，并执行 `run.stop` Policy。命令进入 SQLite 事务前再次确认 presentation；事务内再次验证 active credential/pepper/material fence、Project version 和最新 RoleBinding。Owner、Admin、Operator 允许，Viewer 与其他主体失败关闭。

现有 Local HTTP route 继续保持原兼容能力，但其 `single_factor` bearer 不得被描述为本 ADR 的强产品入口；MCP 与 AI Tool 不获得 stop authority。

### 3. cancellation intent、Event 与 allowed audit 原子提交

`LocalSqliteRunCancellationRepository` 保留常驻 runtime 使用的轻量 `requestUserCancellation`，并新增只供短生命周期 Run Management 数据库暴露的 audited 方法。audited 方法在一个 `BEGIN IMMEDIATE` 事务中使用 SQLite 数据库时钟，完成：

1. 五分钟强认证和 credential fence；
2. Project/RoleBinding Policy fence；
3. Run cancellation intent、version/event sequence CAS；
4. immutable `run.cancel_requested` Event；
5. `run.stop` allowed security audit。

任一写入失败整体回滚。相同 command file 重放返回 `already_requested`，复验同一 allowed audit 且不产生重复 Event/audit。不存在、撤权、credential drift 与存储失败由 CLI 写一个独立 failure audit。实际进程 signal、Attempt/Run 终态和崩溃恢复仍由 ADR-0072 的既有 cancellation lifecycle 收敛。

### 4. 低配设备按调用付费

Run Management 数据库仍是 caller-driven、短生命周期、单 SQLite authority；只有执行 `ql3-run` 时才加载 Owner console、pepper、Policy 和 audit adapter。Edge/Standalone application 启动路径、timer 数、连接数、默认 artifact 与运行制品 package 集合保持不变。领域代码继续位于既有 `run-management/` 与 SQLite `run/` 目录，不创建单文件或浅 package。

## 验收

- repository 测试证明 intent/Event/allowed audit 原子性、exact replay、credential fence 回滚和原 runtime API 兼容；
- 真实 SQLite + Owner credential + 私有命令文件测试证明 `ql3-run stop` accepted/replay、Viewer 拒绝、missing 遮蔽与低敏输出；
- `ql3-run retry` 兼容回归、产品 CLI 无 shell 委派、package boundary 与内部 layout ratchet 全部通过；
- 完整 Local SQLite/Owner CLI package、backend、18-package、dependency/Edge import、Local image 和 14 档 Profile artifact 门全部通过后才允许阶段性提交。

## 被否决的替代方案

1. **开放 Local HTTP 强 stop**：现有 bearer 只有单因子，增加独立 MFA HTTP adapter 又会扩大常驻攻击面与路由设备资源。
2. **新增 `ql3-run-stop` binary/package**：与 retry 共享认证、存储和生命周期，拆分只会增加制品与浅边界。
3. **CLI 直接更新 Runs**：会绕过 Policy、credential fence、Event 和 cancellation convergence。
4. **allowed audit 在事务外写入**：可能留下意图成功但审计缺失，或审计成功但意图回滚。
5. **调用方提供 Event ID、Principal 或 cancel reason**：扩大重放碰撞与权限注入表面。

## 影响

- `ql3-run retry` 的参数与结果保持兼容，help 扩展为 `retry | stop`；内部 binary 文件名改为领域中性的 `runManagementCli`；
- Local SQLite schema contract 不变，不需要 migration；
- `@qinglong/local-owner-cli` 增加一个公开 `run-stop-command` subpath，但 workspace package 数保持不变；
- Cluster Run Management Kubernetes 多节点组合证据、UI 与固定物理路由设备门继续由后续阶段完成。

## 验收记录（2026-08-12）

- Local SQLite package：227/227；Local Owner CLI：163 pass、5 个条件 skip、0 fail；
- backend：1,166 pass、2 个平台条件 skip、0 fail；其中依赖边界测试 53/53，包含 exact `runRetryCommand`/`runStopCommand` authority allowlist 及 widened sibling 反向拒绝；
- 18-package clean build/test 通过；workspace 仍为 18 package、1,072 source、1,054 nested source，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；
- dependency audit、Edge import audit 与 Local application image audit 均 `compatible=true`；Edge import 闭包仍为 121 module 且无 Cluster/PostgreSQL 越界；
- 14 档 Local Profile artifact 全部 `compatible=true`。最小 Edge 为 2,467,343 bytes/295 files/53 loaded modules，RSS delta 11,141,120 bytes，分别低于 4 MiB/512 files/16 MiB 门限；完整 application、application+AI、MCP 档位也均在各自固定预算内；
- 本增量没有修改 lockfile、依赖版本、SQLite schema 或 migration，也没有增加 package、常驻进程、listener、timer、watcher、连接、cache 或 sidecar。
