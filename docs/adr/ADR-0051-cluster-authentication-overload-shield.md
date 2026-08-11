# ADR-0051: Cluster Authentication Overload Shield

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-05、D-35、D-40、D-43、D-44、D-47、D-50

## 上下文

ADR-0045 至 ADR-0049 已把 `/api/v3` 固定为有界 HTTP host，以及 route → Authentication → Policy → durable security audit → body → handler 的两阶段 admission。真实 bearer authentication 仍需要一次 PostgreSQL credential point lookup；攻击者不必持有合法 credential，就能用大量格式正确或错误的请求消耗连接池、审计写入和 CPU。仅靠 `maxInFlightRequests` 会在数据库工作已经开始后才体现压力，不能保护认证依赖。

QingLong 3.0 同时服务单副本、小规格集群和多副本控制面。把认证限流直接做成 PostgreSQL 或 Redis 权威配额会让滥用流量继续占用要保护的依赖，并为小集群增加新基础设施；只按 bearer/credential 限流则必须先查库，而且无法约束匿名攻击。反向代理部署还存在共享出口与伪造 forwarded header 的边界，不能默认把任意 `X-Forwarded-For` 当成身份。

## 决策

### 1. 在 transport admission 建立认证前资源护盾

cluster-control HTTP host 在以下检查之后启用护盾：

1. URL 有界且可解析；
2. liveness/readiness probe 已分流；
3. path 位于 `/api/v3` namespace；
4. application admission 已完成安装。

护盾在 method validation、route registry、Authentication、PostgreSQL、durable security audit 和 body 读取之前消费预算。未 ready 请求不消耗预算，probe 永不受该预算影响。通过护盾不代表认证或授权成功；它只表示本副本当前愿意为该请求支付安全 admission 成本。

### 2. 每个副本使用双固定窗口与有界 peer 表

每个 cluster-control 进程维护：

- 每 transport peer 的固定窗口预算，默认 `300 / 60s`；
- 本副本全局固定窗口预算，默认 `1200 / 60s`；
- 最多 `4096` 个 peer 指纹；
- 每次新 peer 最多检查 `64` 个旧条目做惰性过期回收。

实现不创建 timer、后台任务、外部连接或无界集合。窗口、peer/global budget 和 peer 表均有启动配置硬上限；表已满且无法在有界扫描内回收时 fail closed。关闭 HTTP surface 时立即清空状态和指纹 key。

该状态刻意是 disposable、process-local 的 overload protection，不是跨副本安全事实、计费配额或公平调度权威。多副本总预算由部署副本数放大；需要全局业务 quota 时必须在已认证主体和 Project 上另建 durable policy，而不能把本护盾升级为隐式共享事实源。

### 3. 只信任 socket transport peer

peer key 只来自 Node TCP socket 的 `remoteAddress`。`Forwarded`、`X-Forwarded-For`、`X-Real-IP` 和任意业务 header 都不得影响首版限流；缺失、超长或含控制字符的地址进入同一个 fail-closed unknown bucket。

部署在 L4/L7 proxy 后时，所有请求可能共享 proxy peer budget。运维方可以提高 per-peer budget、依赖本副本 global budget，或降低每个 pod 的入口流量。未来若支持客户端地址传播，必须新增显式 trusted-proxy allowlist、固定 hop 解析和 spoofing contract，不能静默改变本 ADR 的信任边界。

### 4. 内存中不保存原始 peer 地址

进程启动时生成 32-byte 随机 key，对 domain-separated transport peer 做 HMAC-SHA-256，只以指纹作为 Map key。原始地址只在单次调用栈中短暂存在，不进入 event、日志、durable audit 或 wire response；关闭时清零 key。

### 5. 稳定 wire 与低基数观测

peer/global/capacity 超限统一返回 `429 authentication_rate_limited` 和整数秒 `Retry-After`。单调时钟异常或护盾不可用返回 `503 authentication_shield_unavailable`。护盾拒绝以及 route/Authentication/Policy/audit 等所有 pre-body 拒绝都固定关闭 HTTP/1.1 connection，避免未读取 body 或 pipeline 数据继续占用可复用 socket。响应不暴露 peer、窗口计数、credential existence 或具体部署容量。

HTTP surface 提供同步、不可改变 admission 结果的低基数 event hook，只包含：

- `outcome`: `rate_limited | unavailable`；
- `reason`: `peer | global | capacity | clock`。

hook 抛错会被吞掉，不能形成新的可用性依赖。transport 护盾拒绝发生在 Authentication 之前，因此不是 ADR-0049 的认证决策，也不为每个攻击请求写 PostgreSQL security audit；否则攻击者可以通过审计 INSERT 反向耗尽要保护的数据库。生产观测应把 hook 接入有界 counter，并在聚合阈值上告警。

### 6. Profile 与配置边界

配置只进入 cluster-control Profile：

- `QL3_CLUSTER_AUTH_RATE_WINDOW_MS`；
- `QL3_CLUSTER_AUTH_RATE_PER_PEER`；
- `QL3_CLUSTER_AUTH_RATE_GLOBAL`；
- `QL3_CLUSTER_AUTH_RATE_MAX_PEERS`。

edge/standalone 不安装 cluster-control 包，也不承担该状态或 crypto/cluster 依赖。该护盾不替代 edge 本机登录、cluster-admin ceremony、人工 recovery、Worker enrollment 或业务 Project quota 各自的限流设计。

## 被否决的替代方案

### PostgreSQL/Redis 全局 token bucket

拒绝作为认证前护盾。匿名滥用仍会打到网络依赖和连接池，Redis 又成为小型部署的新强制依赖与可用性门禁。它可用于认证后的业务 quota，但职责不同。

### 只按 credential、subject 或 Project 限流

拒绝作为第一层。取得这些事实需要完成 token 解析和 PostgreSQL Authentication，无法保护认证路径本身；攻击者还可以持续发送不存在的 credential ID。

### 默认信任 `X-Forwarded-For`

拒绝。没有显式 trusted proxy 与 hop contract 时客户端可伪造无限 peer key，既绕过 per-peer budget，也耗尽 peer 表。

### 无界 sliding window、每 peer timer 或请求日志

拒绝。它们分别引入无界时间戳集合、大量 timer 或攻击者可控的日志写放大，不适合作为控制面资源保护边界。

## 影响

### 正向

- 匿名攻击在 body、credential lookup、Policy 和 audit INSERT 之前被限制；
- 不新增 PostgreSQL 表、Redis、timer 或跨副本一致性依赖；
- 内存和每请求回收工作有硬上限，peer 原始地址不保留；
- probe/readiness 和 admission drain 语义保持不变；
- edge/standalone 产物依赖方向不变。

### 代价与未完成项

- process-local 限制随副本数线性放大，不提供全局精确配额；
- proxy/NAT 后多个客户端共享 peer budget，需要显式调参；
- 固定窗口允许边界突发，首版以实现可审查和常数状态优先；
- 管理 API、人工 recovery、Worker enrollment、异常 credential 告警和认证后 Project quota 仍需各自策略；
- 需要在独立 cluster 镜像与真实入口代理下测量默认值，而不是把开发机默认值视为最终容量结论。

## 验证

1. 单元测试覆盖 peer/global/capacity、窗口回收、时钟回退和 dispose fail-closed。
2. HTTP 测试证明未 ready 请求与 probe 不消耗预算，超限在 admission/body 前返回。
3. HTTP 测试使用不同 `X-Forwarded-For` 仍命中同一 socket peer budget。
4. 配置测试覆盖四个环境变量的默认值和硬上限。
5. Node 22/24 contract、edge/cluster dependency audit 与 GitNexus detect-changes 继续作为合并门禁。
