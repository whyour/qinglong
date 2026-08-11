# ADR-0236：Production Worker Run 纵切面与认证尝试预算

- 状态：Accepted
- 日期：2026-07-31
- 关联 RFC：QL-RFC-0001 D-58、D-121、D-175、D-207、D-215、D-218—D-220
- 关联 ADR：ADR-0059、ADR-0087、ADR-0122、ADR-0217、ADR-0231—ADR-0235

## 背景

ADR-0235 已证明 production Worker 的 Session、凭据在线轮换和关停链路，但真实 Run 的
Offer→starting→running→lease-control→artifact→completion 尚未贯通。分段测试也没有同时
施加 Worker 最小 100 ms cadence、PostgreSQL 18 prepared statement 和入口认证防护。

首次完整纵切面暴露两个生产缺陷：

1. `acknowledgeRunning` 的 `$2` 同时用于 `varchar` 状态赋值和 CASE 比较，PostgreSQL 18
   以 `42P08` 拒绝该 prepared statement；
2. HTTP surface 的 authentication shield 把每个已成功认证的 Offer pull、lease renew、
   heartbeat、artifact 和 completion 都永久计入同一个 peer/global 窗口。一个合法 Worker
   在高频 cadence 下先耗尽 120 次/分钟的 peer 配额，关键 heartbeat/completion 随后收到
   429，最终 Session 过期且已完成的本机进程无法提交终态。

第二个问题不是简单“把限额调大”即可解决。固定额度既不能同时适配低频路由设备与大量
Cluster Worker，也不能保证心跳和完成不被空 Offer 轮询饿死。

## 决策

### 1. 增加真实 Linux Worker Run 合约

`test:worker-postgres-live:ql3` 在非 Linux 主机上必须把完整 Worker/Ingress 链放入受审
Node 24 Linux 容器，而不是伪造 `/proc` process identity。合约使用临时 PostgreSQL 18、
production composition root、TLS 1.3 mTLS、真实 POSIX launcher 和内存中的不可变
artifact adapter，完成：

1. 真实 Task/Run/Attempt/dispatch lease 与 remote offer；
2. starting/running ACK、durable Linux executor handle 和 callback fence；
3. 运行中 credential A→B 原子轮换，同一 Session/generation 继续心跳和续租；
4. 本机 receipt/log 恢复、流式 artifact 上传、completion 与 Run/Attempt/Lease 终态；
5. SIGTERM draining/offline、凭据撤销和最小 PostgreSQL 角色权限复核。

测试允许 100 ms cadence 作为饥饿压力，不因此修改产品 edge/node 默认值。成功和失败路径
都必须清理 PostgreSQL/Linux 容器与私有临时目录，输出不得包含 token、口令或路径。

### 2. 所有复用 PostgreSQL bind 参数都固定协议类型

`acknowledgeRunning` 的状态参数在赋值和 CASE 比较处都固定为 `$2::varchar`。该规则延续
ADR-0235：同一参数跨列赋值、比较、CASE 或重载时，authority SQL 必须给出唯一类型，
不能依赖 driver 或 server 版本推断。

### 3. Authentication shield 只保留失败的 pre-body admission 尝试

HTTP surface 仍在读取不可信 body 前为 transport peer/global 窗口预占一个认证尝试额度。
只有 `pipeline.prepare()` 成功返回、即认证与 admission preflight 已通过后，surface 才
通过一次性、幂等 ticket 精确归还该 peer/global 窗口中的额度。prepare 抛出的未知路由、
凭据错误、认证/授权/审计不可用、Policy deny 等失败继续消耗预算；被 in-flight
admission 容量直接拒绝、尚未尝试认证的请求则归还预算。

归还操作绑定 consume 时的 peer fingerprint 和窗口起点；窗口已轮换、shield 已关闭或
重复归还时不得修改新窗口。它不是业务 quota、分布式限流或绕过认证的 capability。

### 4. 不为合约或细粒度能力新增 package

workspace 保持 20 个 package。Run 合约属于仓库级 release gate，限流修复属于既有
`cluster-control` transport，SQL 修复属于既有 `cluster-postgres` adapter，均没有独立
部署、发布、权限或依赖生命周期，不能拆成新 package。

文件数也不决定合并：当前唯一一文件 package `local-command-file` 是零生产依赖且被
application、Owner CLI、maintenance 三个闭包复用的稳定 leaf；合并会迫使至少一个消费
者携带无关 authority/依赖，因此继续保留。新增能力优先进入职责 owner 的目录或显式
subpath；只有独立制品、进程/凭据/故障域、可选重依赖、可替换 Profile adapter，或至少
两个消费者共享且确实缩小闭包时，才允许 package 边界。

## 被否决的替代方案

1. **提高 Worker ingress 固定 rate 数字**：只延后故障，无法同时覆盖 NAT、多 Worker、
   edge cadence 与 Cluster 扩容，也仍让成功请求消耗攻击预算。
2. **让 heartbeat/completion 绕过整个 shield**：按路径白名单会在认证前暴露可滥用的
   数据库入口，并持续增加特例。
3. **429 时把本机 receipt 当作远端完成**：会把未提交的 Run/Lease 伪造成终态。
4. **用 macOS PID 代替 Linux handle**：无法证明 `/proc` start-time 与 boot identity。
5. **按每个 transport/repository 新拆 package**：没有新部署或 authority，增加 importer、
   lockfile、镜像和低配供应链成本。

## 影响与验证

- GitNexus 对 `createClusterControlAuthenticationShield` 为 CRITICAL，对
  `startClusterControlHttpSurface` 为 HIGH；影响普通 Cluster API 与 Worker ingress 两条
  composition root。因此修复必须同时跑 shield、HTTP surface、Worker 纵切面和 HA 门。
- authentication shield 5/5、HTTP surface 12/12；成功 prepare 可连续通过，失败 prepare
  仍在 body read 前触发 peer 429。
- PostgreSQL activation SQL 回归要求两处 `$2::varchar`，并使用真实 token digest 和
  transaction shape 验证 applied response。
- PostgreSQL `18.4 (Debian 18.4-1.pgdg13+1)` + Linux Node `24.18.0` 真实纵切面已通过：
  Run/Attempt `succeeded`、exit 0、Lease `completed`、69 次续租、事件顺序完整；31-byte
  日志 artifact 的内容与 SHA-256 一致；credential B 在 Run 中 observed，A revoked，
  最终 Worker offline。
- runtime 不能读取 credential、worker-ingress 不能更新 Run、worker-ingress 可以更新
  Session；PostgreSQL 中没有 credential secret。
- 禁止 image pull 的 PostgreSQL 18.4 arm64 physical HA 门已重新通过：
  `remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind` 只读同步重入、两个 fresh
  control 以及全部具体 gate 均收敛，`gates.passed=true`；门禁临时容器、volume 与
  network 均已清理。
- 不新增 package、生产依赖、migration、表、角色、端口、timer、watcher、listener、
  sidecar、Pool 或长期容器。

## 剩余 Gate

真实 S3/兼容对象存储故障与重试、Kubernetes Secret/CA rollout 与 rotation 分区/回滚、Worker/PVC 节点故障、在途
completion 的进程级 crash matrix、Linux cgroup 双架构镜像和固定路由设备资源/断电证据
仍是发布 Gate。本 ADR 的内存 artifact adapter 证明 production upload/completion 端口和
数据库原子终态，不冒充对象存储基础设施证明。
