# ADR-0460：一次性 Cancellation 可用性状态卡与告警退出码

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-367、PR-5、PR-7
- 关联 ADR：ADR-0005、ADR-0458、ADR-0459
- Amends：ADR-0459 的产品入口与告警路由边界

## 上下文

ADR-0459 已让 Run management plane 返回数据库事实驱动的 Project 级 cancellation summary，但现有 `ql3 run` 仍要求 operator 手工准备完整 command JSON，再自行解释三态 assessment。该协议可以被脚本调用，却还不是可直接使用的产品入口，也没有稳定的告警退出语义。

QingLong 的部署跨度很大。Cluster operator 需要可读状态卡和可供 systemd、CronJob、CI 或外部告警器路由的机器结果；路由器级 Edge/Standalone 则不能为 Cluster 可观测性引入 daemon、轮询、PostgreSQL 客户端或新的制品闭包。Copilot Console 又只有普通 Project API Bearer authority，直接把 Run management mTLS/OIDC 凭据并入该常驻本机 BFF 会混合两种权限边界。

## 决策

1. 在现有 `ql3 run`/`ql3-run-client` 增加一次性 `status` 模式：`ql3 run status --config=... --assertion=... --project=... [--format=text|json]`。它继续由统一产品 CLI 无 shell 委派同一 binary，不新增 workspace package、binary、服务或端口。
2. `status` 只在一次调用内生成 request/audit UUID，并构造固定 `run.cancellation.summary` 命令。Project、配置文件和短生命周期 assertion 仍显式提供；operator context 只可补充稳定的 Run management config，不保存 assertion。调用方不能提供 Run/Attempt identity、状态过滤、时间窗口、计数或服务端时间。
3. 通用认证管理客户端允许包内调用方传入内存命令，但仍执行同一 exact-shape normalizer、TLS 1.3、Run 专用 mTLS、OIDC Bearer、固定 management path、128 KiB 响应上限、单连接和响应校验。既有 `--command` 私有文件模式保持字节读取、权限检查、错误语义和输出格式不变。
4. 默认 `text` 输出是无 ANSI 控制字符、确定性、适合终端与日志的状态卡；`json` 输出使用固定 `qinglong/run-cancellation-status@v1` schema。两者只包含 request/Project、数据库观察时间、assessment/action、固定 dispatch/signal/blocking 计数和可选最早 blocked 时间，不增加 Run/Attempt/Worker、lease、PID、命令、环境、Secret、日志或错误原文。
5. 产品告警映射固定为 `clear → ok/0`、`converging → warning/10`、`attention_required → critical/20`。配置/网络/协议失败仍为 `1`，CLI 用法错误仍为 `64`；因此外部 supervisor 可区分“等待 caller-driven 收敛”“需要 inspect”与“查询本身失败”，而无需解析自然语言。
6. 命令严格 one-shot：一次 summary、一次 allowed/denied audit，然后退出；不重试、不轮询、不缓存、不保持 socket，也不改变 `/readyz`。blocked 仍不撤回整个 Cluster readiness。
7. 该入口只进入 Cluster Admin 制品。Edge/Standalone 依赖图和制品不得包含 `cluster-admin`、`cluster-postgres`、`pg`、状态 CLI 或 TLS/OIDC 管理凭据。
8. D-367 不返回 blocked Run 列表。用户从已知 Run 继续使用既有 inspect/rearm；从聚合发现未知 blocked Run 的能力必须以后用独立、有界、稳定 cursor、低敏 identity 和索引证明的 drill-down 契约完成，不能让 status 偷偷退化为无界扫描。

## 被拒绝的替代方案

### 在 Copilot Console 直接复用普通 Project API 凭据

拒绝。summary 位于独立 Run management authority，普通 Bearer 不应绕过 mTLS、OIDC purpose 和专用 Policy/audit。把第二组高权限凭据强制塞进 Console 也会扩大常驻 BFF 的秘密与故障面；Console 接入应在未来以显式可选 authority 单独设计。

### 新建 exporter、告警 daemon 或后台轮询器

拒绝。它会增加常驻进程、连接和 cadence，并让小规模 Cluster 为无人查看的状态持续付费。一次性命令可由现有部署侧调度器按自身策略调用。

### 客户端从列表或本地缓存推导 assessment

拒绝。列表可能分页且跨页漂移，本地缓存也会在 failover 后失真。状态卡只投影经过服务器和客户端双重交叉不变量校验的单事务 summary。

### 所有非 clear 状态返回同一个退出码

拒绝。converging 需要等待，attention_required 需要 inspect；合并后外部告警器只能解析 JSON 或把正常收敛当成阻塞故障。

## 资源、安全与部署影响

- Cluster 每次调用只建立一个短生命周期 mTLS 连接，使用既有 Run manager pool 完成一个最长 5 秒的 SERIALIZABLE summary/audit 事务；客户端不创建 Agent keep-alive、缓存、timer 或临时 command 文件。
- 文本卡和 JSON 使用同一已校验 projection；Project/时间/计数均有既有协议上限，不存在动态指标 label 或任意服务端路径。
- 旧命令文件模式继续支持 retry、stop、summary、inspect 和 rearm，升级不要求重写现有自动化。
- 新源码保留在已有 `cluster-admin/run-management` 内；通用内存命令入口位于已有 `management-support`，没有单文件 package 或 `src` 根平铺。

## 验证

- `runCancellationStatus` 与 management-client 聚焦门 `12/12`，CLI/product 真实进程门 `15/15`；覆盖内存 summary 命令、三态 severity/退出码、低敏文本卡、错误 operation 拒绝和原 command-file/mTLS route 兼容。
- 真实本机 TLS 1.3/mTLS CLI 集成测试验证只向 `/api/v3/runs/management` POST 一次 `run.cancellation.summary`，不带 Run ID，并以 `attention_required` 返回 JSON 与退出码 20；help 与非法 Project 在 I/O 前失败关闭。
- Cluster Admin 全量 `407 total / 404 pass / 3 conditional skip / 0 fail`；backend 全量 `1,489 total / 1,487 pass / 2 conditional skip / 0 fail`；18-package clean build/test 退出 0。
- package boundary、Cluster dependency、Edge import、Cluster deployment 四项审计均 compatible；workspace 保持 18 packages、无 single/shallow package，Cluster Admin 为 123 个 source、122 个 nested source、仅 1 个受审 binary root entry。
- `14/14` Local artifact audit 均 compatible；基础 Edge/Standalone 为 `2,589,998 / 2,590,076` bytes，Application+AI 为 `4,493,151 / 4,493,283` bytes，MCP 为 `7,315,930 / 7,316,038` bytes，证明 Cluster-only 入口未进入低配设备闭包。
- PostgreSQL 18.6 arm64 HA `145/145`，timeline `1→2`，报告 SHA-256 `59a568d0511cde671946ebf6df09f88868a3d591c5021c90bc27d4715411091e`；独立 evidence audit 为 `compatible=true`、零 finding。

## 后续

D-368 可设计 Project-scoped blocked drill-down：固定小页、稳定数据库 cursor、只返回继续 inspect 所需的最低 identity，并证明索引、事务一致性、Policy/audit 和多副本 HA。Copilot Console 状态卡应复用本 ADR 的 projection 和显式 Run management authority，但不得默认持有该 authority 或建立轮询。
