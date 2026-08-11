# ADR-0360：Production Worker Kubernetes Session 生命周期实证门

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-272、ADR-0234、ADR-0235、ADR-0239、ADR-0241

## 上下文

ADR-0239 的第一版 K3s 门使用有界 shell actor 证明了 Secret/Deployment `resourceVersion`
CAS、`Recreate` 顺序、PVC journal 延续与 identity generation，但它没有在 Kubernetes
中运行产品 Worker 进程，也不能证明 Cluster Worker ingress、mTLS、Session 心跳和
graceful drain 的组合行为。ADR-0235/0236 在 Docker/PostgreSQL 纵切面证明了产品 Session
与 Run，却没有覆盖 Kubernetes PID 1、Pod termination、init materialization、RWO PVC 和
Recreate 的真实边界。

首次把产品 Worker 镜像放入该门时，进程完成 register 并输出 `active` 后以 exit code 0
退出，Pod 进入 `CrashLoopBackOff`。根因不是 Session 或 Kubernetes：JavaScript pending
Promise 本身不会保持 Node event loop；进程虽然等待 OS signal，却没有一个 ref'ed
生命周期句柄。这说明单元测试中主动投递 SIGTERM 不能替代真实容器 PID 1 证据。

## 决策

1. `runProductionWorkerProcess` 在取得 signal authority 后必须持有一个低唤醒频率的
   ref'ed lifecycle handle，直到成功 stop 或失败清理才释放。它不新增 watcher、listener、
   网络连接或每任务 timer；最长 interval 只负责 process ownership，正常执行 cadence
   仍由既有 product application 独占。
2. `qinglong/worker-kubernetes-rollout-live-contract@v2` 保留第一阶段真实 CoreV1/AppsV1
   CAS、四个审批计划、caller-driven executor Job、exact replay、Recreate journal 与 PVC
   恢复证据；随后必须从当前源码构建 Cluster Admin、Cluster Control 和 Worker 三个镜像。
3. 产品阶段在同一 K3s 内部署真实 Cluster Worker ingress 与真实 Worker。Control 使用
   专用 `ql3_worker_ingress` PostgreSQL role、TLS 1.3 server identity；Worker 使用独立
   mTLS client identity、`ql3w` credential、无 ServiceAccount token、non-root/read-only
   root 和同一 RWO PVC。
4. 门禁必须依次证明初始 Session、第四代 credential rollout 后的新 Session、client
   identity rollout 后的新 Session。每个 Session 都必须先有 durable online 和至少一条
   heartbeat audit，替换或最终 scale-to-zero 后必须留下 draining、offline；三代 generation
   严格递增。
5. 证据只在显式 `QL3_WORKER_KUBERNETES_ROLLOUT_LIVE=1` 时运行。完整报告必须写入调用方
   提供的绝对新路径，拒绝覆盖和 symlink parent，以 mode `0600` 产生；stdout 只输出低敏
   pass envelope。独立 auditor 必须使用 exact keys、精确计数、唯一 identity、全部 true
   gate、固定 limitation 和 secret-material scan 复核报告。
6. K3s 固定为 `rancher/k3s:v1.34.3-k3s1` index digest；PostgreSQL 固定为
   `postgres:18.4-bookworm` index digest。GitHub Actions 只允许手工触发，不进入默认 CI，
   不改变 Edge/Standalone artifact 或路由设备部署成本。

## 不采用方案

- **在 CLI 末尾增加永久空循环**：会绕过 application stop ownership，难以测试和释放；
  生命周期句柄应由拥有 signal/drain 的 process application 管理。
- **把 `CrashLoopBackOff` 当成可接受重注册**：会快速增加 Session generation，旧 Session
  来不及 drain，并把成功退出伪装成健康容器。
- **降低 heartbeat 断言或依赖时间碰巧经过**：门禁必须逐 Session 等待 durable heartbeat，
  不能用 `>=0` 或最终总数推断每代存活。
- **继续使用 shell actor 代表产品 Worker**：它只能证明 Kubernetes 编排顺序，不能证明
  production image、mTLS ingress、startup reconciliation 和 Session protocol。
- **进入默认 CI 或 Edge 制品**：真实 K3s、三个源码镜像与 PostgreSQL 是 Cluster 发布证据，
  不是低配设备运行依赖。

## 结果

2026-08-11 arm64 真实门禁通过。报告使用 K3s `v1.34.3+k3s1`、锁定摘要的 PostgreSQL
18.4、当前源码构建的三类镜像和 53 版数据库 contract。四个 plan/approval/dispatch/
successful execution/credential/publication 与 16 条管理审计全部精确收敛；三个主机动作的
fresh execution + exact replay 共执行 9 次授权复验，独立 executor Job 使用一次 600 秒
projected token，重放不再请求 token。

生产 Worker 产生 3 个不同 Pod UID、3 个不同 Session ID 和严格递增 generation
`1 → 2 → 3`。每个 Session 都被观察到 online、draining、offline；最终有 3 条 register、
6 条 transition、3 条 heartbeat audit，credential 明文未进入 PostgreSQL。最终 drain
耗时 616 ms，360 秒 termination grace 保持；所有 21 项具体 gate 为 true。

私有报告为 8,087 bytes、mode `0600`，SHA-256
`cd59efd53abfaf18cb959b3381eb96651cea5327f7df9b68770e555c1b5d492c`；独立审计器返回
`findings=[]`、`compatible=true`，相关 K3s/PostgreSQL Docker container 零残留。

限制保持显式：单节点 local-path PVC 不是多节点 CSI detach/attach；强制删 Pod 不是物理
节点断电；产品阶段只证明 Session 生命周期，Remote Run 仍由独立 Worker PostgreSQL live
gate 所有；确定性本地 strong-User ceremony 不是生产外部 IdP。

## 验证

```bash
mkdir -m 0700 /absolute/private/ql3-worker-evidence
QL3_WORKER_KUBERNETES_ROLLOUT_LIVE=1 \
QL3_KUBECTL_BIN=/absolute/path/to/kubectl \
pnpm test:worker-kubernetes-rollout-live:ql3 \
  --report=/absolute/private/ql3-worker-evidence/report.json

pnpm audit:worker-kubernetes-rollout-live:ql3 \
  --report=/absolute/private/ql3-worker-evidence/report.json
```

手工 CI workflow 为
`.github/workflows/ql3-worker-kubernetes-rollout-live.yml`。
