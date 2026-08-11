# ADR-0235：Production Worker PostgreSQL 真实合约与 Session Transition 类型边界

- 状态：Accepted
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-58、D-121、D-215、D-218、D-219
- 关联 ADR：ADR-0058、ADR-0122、ADR-0231、ADR-0234

## 背景

Worker 进程、Cluster Worker ingress、PostgreSQL repository 和可恢复凭据投递此前都已有
独立测试，但没有一条门禁使用真实 production composition root 把它们连接起来。因此，
“每请求重新读取 token 可以在线轮换”“同一 Session 可以在轮换后继续工作”“SIGTERM
最终能写入 draining/offline”仍只是分段证明。

首次真实纵切面验证确实发现了一个分段测试没有暴露的问题。Session transition SQL 的
同一个 `$5` 参数既赋给 `varchar` 状态列，又参与未显式定型的
`$5 = 'offline'` 比较。PostgreSQL 18 拒绝该 prepared statement，Worker ingress
按安全边界返回低敏 503，Worker 进程则保持 owner 并持续重试关停。这个行为没有伪造
成功，但会让正常部署无法收敛停止。

## 决策

### 1. 增加真实、短生命周期的 Worker PostgreSQL 门禁

`test:worker-postgres-live:ql3` 必须使用临时 PostgreSQL 18 容器和受审六角色中的
migration、runtime、admin、worker-ingress 权限边界，完成：

1. 真实 migration；
2. production Cluster Worker ingress、TLS 1.3 mTLS 和 runtime capability port；
3. 默认 `runProductionWorkerProcess`、direct-file identity bootstrap 与真实 Session；
4. 文件投递 adapter 原子发布 credential A，并由真实 heartbeat 写入 observed；
5. 原子替换为不同 credential ID 的 B，保持同一 Session ID/generation；
6. recovery service 在 B observed 后撤销 A，并写入
   `previous_revoked` v4；
7. SIGTERM 后完成 draining 与 offline；
8. 验证 runtime 不能读取 credential、worker-ingress 不能更新 Run、token 不进入
   PostgreSQL。

门禁不得使用模拟 Worker client、直接 repository mutation 来代替生产链路，也不得
输出 token、secret digest、文件路径或数据库口令。容器和私有目录在成功与失败路径都
必须精确清理。

### 2. PostgreSQL 重用参数必须显式固定协议类型

Session transition 的状态参数固定写为 `$5::varchar`，包括列赋值和 offline 分支判断。
这是 wire parameter 类型消歧，不改变状态机、CAS fence、事务、角色或响应 schema。

后续 SQL 如果同一 bind parameter 同时进入列赋值、比较、CASE 或函数重载，也必须在
SQL authority 内指定唯一类型，不能依赖 PostgreSQL 版本或上下文碰巧得到一致推断。
包级回归必须直接检查这个约束，真实 PostgreSQL 门禁负责证明 server 端行为。

### 3. 关停失败仍保持 fail-closed

HTTP 503、transport unavailable、drain timeout 或 recovery required 仍不得使 Worker
返回成功。此次修复只让合法 transition 可执行，不降低 `runProductionWorkerProcess`
对未知关停结果的无限重试约束。

## 被否决的替代方案

1. **在测试里直接更新 `worker_sessions`**：绕过 mTLS、认证、审计、HTTP schema 和
   production composition。
2. **把 503 当作 offline**：会在数据库仍为 online 时释放唯一 journal owner。
3. **让 driver 猜测参数类型**：已被 PostgreSQL 18 的真实 prepared statement 否证。
4. **把 Worker ingress 授予 runtime 表权限**：与故障无关，并会扩大外部 listener
   compromise 的写权限。
5. **新增 integration package 或常驻测试服务**：没有新的发布/权限边界，增加低配和
   workspace 成本。

## 验收证据

- `@qinglong/cluster-postgres`：247 项，246 pass、1 条条件 skip、0 fail；
- SQL 回归明确要求 `status = $5::varchar` 与
  `WHEN $5::varchar = 'offline'`；
- PostgreSQL `18.4 (Debian 18.4-1.pgdg13+1)` 真实纵切面：
  TLS 1.3 mTLS、同一 Session/generation、A/B 投递分别到 v3/v4、A revoked、B active、
  final offline、零 runtime diagnostic、零 PostgreSQL token；
- authority 检查：runtime credential SELECT denied、worker-ingress Run UPDATE denied、
  worker-ingress Session UPDATE allowed；
- 没有新增 workspace package、生产依赖、migration、表、角色、端口、timer、watcher、
  sidecar、Pool 或长期容器。

## 后续 Gate

本 ADR 证明 idle Worker 的 production Session、Offer pull、credential rotation 与
drain/offline。实际 Run 的 offer→starting→running→artifact/completion/lease-control
已由 ADR-0236 的 Linux/PostgreSQL 18.4 纵切面完成；production certificate rotation 已由 ADR-0238 完成，
ADR-0239 又完成真实 K3s credential/identity generation 与单节点 PVC recovery。CA overlap/回滚、对象存储
故障、多节点 CSI/node-loss/production drain 和固定路由设备断电/资源证据仍是独立发布 Gate。
