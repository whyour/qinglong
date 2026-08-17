# ADR-0446：System Crond 稳定 Shadow 准入与回调重放

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-02、D-354、PR-4
- 关联 ADR：ADR-0001、ADR-0002、ADR-0445
- Amends：ADR-0002 的 Alpha Shadow origin allowlist 与 system crond callback 关联规则

## 上下文

system crond 不由 Node worker spawn。它执行 `crontab.list` 中的 Shell 命令，`task.sh/share.sh` 再分别向
`/open/crons/status` 发送 running 与 idle callback。旧 callback 只有 Cron ID、PID、log path 和秒级开始时间：running callback 丢失时，finish
无法证明 accepted identity；重复、乱序或 HTTP response loss 又可能把同一次执行创建为多个 Shadow Run。因此 D-353 明确拒绝从结束事实直接伪造
`scheduled_system` Run。

这条边界还必须区分 Node scheduler 和面板手动执行。三者最终都可能进入同一 Shell 脚本；仅凭 `ID`、PID 或 `real_log_path` 猜测来源会把同一次手动
执行同时记为 `manual` 与 `scheduled_system`。

## 决策

1. 只有 `CronService.setCrontab` 在实际 system scheduler 模式写出的命令增加
   `QL_EXECUTION_ORIGIN=scheduled_system`。Node scheduler 注册命令、manual/boot `runSingle` 和直接 Shell 调用不带该标记。
2. Shell 仅在标记存在时生成一次 `legacy-system:<start-seconds>:<uuid-v4>` execution ID，并在 start/finish callback 复用。UUID 优先读取 Linux
   kernel random UUID，其次使用 `uuidgen`，最后使用已存在的 Node runtime；三者都不可用或输出非法时不发送 ID，Legacy 执行仍继续且不创建
   `scheduled_system` Shadow Run。
3. `/open/crons/status` 只接受严格小写 UUIDv4 和正整数秒时间的可选 `execution_id`。旧客户端没有该字段时继续走原 Cron ID/PID/log correlation，
   不改变 2.x 请求兼容性。
4. 带稳定 ID 的 callback 使用专用 detached observation，不注册虚构 ChildProcess，也不进入易歧义的本机 registry。running 映射为
   accepted→spawned→running；finish 映射为 accepted→spawned→exited，因此 start request/response 丢失后，finish-only 仍能形成完整的终态聚合。
5. Shadow Run 固定 `executionOwner=legacy`、origin/trigger type `scheduled_system`、`triggeredBy=legacy:system-crond`、Project `default` 和
   `legacy-cron:<id>` task identity。accepted/scheduled 时间从 execution ID 内的开始秒派生，task revision 摘要与 manual/node Cron 使用相同字段集合。
6. 带 request ID 的 `LegacyShadowRunWriter` 使用 request ID 和 accepted time 派生稳定 UUIDv7 形态的 Run/Attempt ID，并写既有
   `(project_id,idempotency_key)` 唯一键。重放只有在 Run、Attempt、task revision、Cron ID、origin、request ID 与创建时间全部一致时才复用；任一
   漂移都失败开放，不创建第二个 Run，也不改 Legacy callback 结果。
7. `QL3_SHADOW_ORIGINS` 增加 `scheduled_system`，但默认仍为 off；本决定不开放 Primary，不调用 Executor，不增加网络重试、timer、watcher 或后台
   reconciler。

## Response-loss 与乱序语义

- start 成功且 response 丢失：finish 使用同一 execution ID，复用既有 Run 并终结。
- start request 未到达：finish-only 创建同一确定性 Run/Attempt 后直接终结。
- finish 成功且 response 丢失后重放：唯一键和确定性 ID 命中 exact replay，终态与 Event 数不增加。
- finish 先于迟到 start：迟到 start 命中已终态聚合，writer 的幂等状态推进保持终态不变。
- 相同 ID 携带不同任务定义：exact replay 校验失败，Shadow 记录有界 accept failure；Legacy 状态更新与任务结果不受影响。
- 无 ID、ID 非法或来源未显式标记：不创建 `scheduled_system` Run；无 ID 的既有 callback correlation 保持原行为。

## 部署与资源影响

- 不新增 workspace package、生产依赖、schema、migration、表、索引、端口、Kubernetes object 或常驻进程。
- 复用 Run 表既有 idempotency unique index；SQLite 与 PostgreSQL Repository contract 不变。
- 默认关闭时后端只多一次缓存 Set 查询；system crond 命令仍可执行，Shell 只在显式标记下读取一个 UUID。
- Edge/路由设备优先读取 `/proc/sys/kernel/random/uuid`，不额外启动 Node；只有缺少 kernel UUID 与 `uuidgen` 时才使用已有 Node runtime 作为
  兼容 fallback。
- 不增加 callback retry，避免低配设备网络阻塞扩大；本决定保证重放安全和 finish-only 收敛，不把“最终一定送达”伪装成已解决问题。

## 被拒绝的替代方案

### 继续使用 Cron ID、PID 与 log path

拒绝。它们在并发、PID 复用、`/dev/null` 日志和进程重启后都不能证明一次 execution identity。

### 每个 callback 在后端生成新 ID

拒绝。start/finish 以及 response-loss 重放会产生不同 Run，无法幂等收敛。

### 为 Shell callback 注册虚构 ChildProcess

拒绝。Node 不拥有 system crond 子进程；伪造 handle 会污染取消、恢复和 owner 语义。

### 默认启用 scheduled_system Shadow

拒绝。低写入寿命设备必须显式选择迁移观测成本，且 Primary 与对账门仍未完成。

## 验证

- Shell contract 覆盖显式 origin 才生成 ID、UUID 格式和 callback JSON 原样复用；
- SQLite 集成覆盖 running→finish、start response-loss replay、finish-only、重复终态和 task revision drift；
- Bridge/registry/correlation/ChildProcess/ScheduleService/rollout 聚焦回归 38/38 通过，包含真实隔离 crontab 文件写入与 system/node 模式差异；
- `build:back`、4 个 Shell 文件语法检查与完整 backend 回归通过（1,415 pass、2 条条件 skip、0 fail）；
- 18-package clean build/test 退出 0，14/14 静态审计与 14/14 artifact 档位均 compatible，artifact 字节与 D-353 相同；
- 物理 PostgreSQL HA/K3s 只在数据库或部署面变化时重跑，本决定不以相邻阶段证据冒充新运行。
