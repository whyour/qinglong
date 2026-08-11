# ADR-0234：单身份 Production Worker 进程与部署边界

- 状态：Accepted（生产进程、镜像依赖根、Kubernetes 单身份基线、macOS arm64 资源证据及真实 PostgreSQL 凭据在线轮换已实现；Linux cgroup、真实镜像 digest 与固定路由设备证据仍是发布 Gate）
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-85、D-121、D-175、D-207、D-218
- 关联 ADR：ADR-0012、ADR-0057–ADR-0061、ADR-0110–ADR-0124、ADR-0185、ADR-0217、ADR-0231–ADR-0233、ADR-0235、ADR-0236

## 背景

ADR-0121/0122 已经提供单 journal owner、单 HTTPS Agent、单 cadence、Worker
Session、capacity oracle 和 execution plane，但仍只有可调用的 application
composition。部署者没有一个受审进程入口，也无法判断路由设备和 Kubernetes 节点应如何
保存 journal、装配 mTLS identity 或完成 drain。

把 Worker 当作普通无状态 Deployment 会产生更严重的问题：多个副本共享 Worker ID、
credential 和 PVC 时会竞争同一 Session 与执行事实；使用 `emptyDir` 会在重启后删除
spawn/completion 的唯一判定依据；直接读取 Kubernetes projected Secret 又会违反凭据
provider 对 direct file、`0700` parent、`0600` private material 和 `O_NOFOLLOW` 的约束。

## 决策

### 1. 一个进程只拥有一个 Worker 身份

`@qinglong/worker-runtime` 增加 package 内的显式 process subpath 和
`ql3-worker` binary，不新增 workspace package。进程只接受
`QL_DEPLOYMENT_PROFILE=worker` 与显式 `QL3_WORKER_RUNTIME_ENABLED=true`。
禁用态必须在读取 capability、storage path、certificate、private key 或 token 前返回。

启用态固定绑定一个 Worker ID、一个 canonical capability 文件、一个 control HTTPS
origin、一个 certificate store、一个 `ql3w` token 文件和一组 journal/log/receipt
目录。edge/node 只是同一进程的有界容量策略，不是两套 runtime：

- edge 默认 1 个并发 Run、2 秒 cadence、每页 4 条、journal 上限 64；
- node 默认 8 个并发 Run、500 ms cadence、执行页 16、supervision 页 32、
  journal 上限 256；
- 两者 Session lease 默认 45 秒、heartbeat 10 秒，并强制至少容纳两个
  heartbeat interval。

### 2. 凭据引导与 steady-state 必须分离

首次启动可从 direct bootstrap key/certificate 和 trust anchor 验证完整 leaf identity，
再原子安装到持久 certificate store，最多保留两代。相同证书的重启不得重复创建
generation。steady-state 每个请求重新读取 active generation、trust anchor 与 token，
因此 token/certificate replacement 不需要 watcher、cache、第二个 Agent 或常驻续期
进程。

private key、certificate、anchor 和 token Buffer 在验证/请求结束后必须清零。token
parent 必须为 `0700` direct directory，private files 必须为 `0600` 或更窄；symlink、
group/world permission、超限材料、credential ID drift 或无 active identity 均失败关闭。

### 3. 信号和 drain authority 先于 activation

进程必须在配置加载和 application start 前取得 SIGINT/SIGTERM ownership，避免
activation 窗口漏掉终止请求。启动只装配 ADR-0122 的一个 product application；不得再建
Session timer、Agent 或 execution owner。

收到信号后，进程反复调用同一 proof-bearing stop。只有结果为 `stopped` 才返回成功；
`drain_timed_out`、`recovery_required` 或 stop exception 必须保持现有 owner/Agent，
使用 ref'ed wait 后重试。进程事件只允许输出 Worker ID、capacity profile、生命周期
状态和枚举 diagnostic，不输出 origin、path、certificate、token、Secret、command 或
错误正文。

### 4. Worker 镜像是独立制品，不扩大 package 拓扑

Worker 镜像只构建和复制：

1. `@qinglong/runtime-core`；
2. `@qinglong/local-process`；
3. `@qinglong/worker-runtime`。

builder/runtime 使用从 workspace `pnpm-lock.yaml` 机械生成并校验的独立 npm v3 lock。
runtime 为 24 个外部 package，不包含 Cluster PostgreSQL/admin/control、Local
SQLite/application、AI、2.x server 或 UI。受审 POSIX launcher 必须显式复制并设为
`0555`，不能依赖源仓库文件 mode 或碰巧存在的 shell path。镜像固定 Node 24.18、
non-root UID/GID 65532 和绝对 entrypoint，不开放端口。

### 5. Kubernetes 使用单副本、单 PVC、私有 authority materialization

base Deployment 固定 `replicas=1`、`strategy=Recreate`、360 秒 termination grace、
read-only root、drop ALL、RuntimeDefault seccomp、无 ServiceAccount token和零入站
Service/port。journal/log/receipt/certificate store 必须进入同一 `ReadWriteOnce` PVC；
不得改为 `emptyDir`。

Secret/ConfigMap atomic-writer projection只作为 init 输入。init container 以相同 Worker
镜像在 fsGroup-writable 4 MiB tmpfs 中创建 UID 65532 自有的 `0700 private/` 子目录，
再把 CA、key、certificate、token 和 capability 复制为 direct files，同时创建 `0700`
state directories，最后把 authority tmpfs 只读挂给主进程。init 不尝试修改 root-owned
mount point。Secret rotation
必须更新 private overlay 的 digest 并执行 Recreate rollout；不得增加 watcher/sidecar。

一个 Deployment 不得 scale。横向扩容必须创建新的 Worker ID、certificate、token、
Session 和 PVC。Worker 没有面向流量的 Service，因此不伪造 readiness/liveness probe：
PID 存活不能证明 startup recovery 完成，自动 liveness kill 反而可能摧毁唯一 drain
owner。产品 readiness 是 Cluster 中的 durable Worker Session。

### 6. 路由设备直接运行 edge profile

非 Kubernetes 路由器/NAS 运行同一个 binary 和相同 direct-file/PVC 等价目录，不安装
Cluster 或 UI 闭包。当前 macOS arm64/Node 24.18 的真实进程+mTLS证据为：

- edge active RSS `67,616,768` bytes、peak `71,090,176` bytes；
- node active RSS `67,911,680` bytes、peak `71,286,784` bytes；
- 两档都只使用一个 TLS 1.3 mTLS socket并完成
  `register → draining → offline`。

因此 64 MiB 不能作为可信 Worker memory limit；在 Linux cgroup/固定设备证据取得前，
edge 部署至少按 96 MiB 运行预算规划。该数字是开发机上限 Gate，不是固定路由器发布
证明，也不代表执行用户脚本后的峰值。

## 被否决的替代方案

1. **多副本共享 Worker ID/PVC**：两个 owner 会竞争 Session、journal 和进程恢复。
2. **每个 Pod 动态生成 Worker ID**：Pod 重建会丢失稳定执行与凭据 authority。
3. **用 `emptyDir` 保存 journal**：重启会把未知 spawn outcome 错报为从未执行。
4. **主进程直接读取 projected Secret**：atomic-writer symlink/permission 与 direct
   private-file contract 冲突。
5. **sidecar 同步 Secret**：增加 watcher、进程、写竞态和 shutdown owner。
6. **使用 HTTP/PID 健康探针**：无法证明 Session/recovery readiness，并可能强杀 drain。
7. **为 process/config/deployment 新拆 package**：没有新的发布或 authority 边界，违反
   workspace package hard cap。
8. **把 Cluster Worker 与 control 放进同一镜像**：把 PostgreSQL/S3/control authority
   和供应链成本推给低配 Worker。

## 验收证据与剩余 Gate

已完成：

1. Worker process config/application/identity 定向测试通过，Worker 完整 133/133；新增真实
   子进程回归证明 active 后在 SIGTERM 前持续驻留，收到信号后正常 stop 并退出。
2. 真实 TLS 1.3 mTLS 进程资源基准覆盖 edge/node、file identity bootstrap、单 socket、
   register/drain/offline 和低敏事件。
3. Worker deployment audit 证明 3 个 workspace package、24 个 runtime external、
   单副本、PVC、private materialization、零 token、零端口、零伪 probe；同一 pinned
   Node 基础镜像的 non-root Docker tmpfs smoke 证明 UID/GID 65532 能在
   `root:65532/0770` mount 内创建并收窄自身 `65532:65532/0700 private/`。
4. edge/node Kustomize 均可合成，capacity profile与资源 patch 精确分离。
5. PostgreSQL 18.4 arm64 physical HA 再次通过 `remote_apply`、timeline 1→2、旧主
   fencing、`pg_rewind` 只读 sync rejoin、two fresh controls 和总
   `gates.passed=true`。
6. workspace 仍为 20 个 QL3 package；本切片不新增 production dependency、database、
   migration、timer、watcher、listener、sidecar 或 Pool。
7. ADR-0235 的 PostgreSQL 18.4 真实 production 纵切面已完成默认 Worker process →
   TLS 1.3 mTLS ingress → Session/Offer pull → credential A observed → 原子替换 B →
   B observed → A revoke → draining/offline；Session ID/generation 保持不变，角色边界
   与 PostgreSQL 明文排除成立。门禁同时发现并修复 Session transition bind parameter
   在 PostgreSQL 18 下的 `varchar` 类型歧义。
8. ADR-0236 已完成真实 Linux Run 的 Offer→starting→running→69 次 lease-control→
   31-byte artifact→completion，Run/Attempt succeeded、Lease completed；运行中凭据
   A→B 保持同一 Session，最终 offline。压力门同时修复 running ACK 参数类型和成功
   Worker 流量耗尽 authentication shield、以 429 饿死 heartbeat/completion 的问题。
9. ADR-0360 已在真实 K3s 中从当前源码构建并运行 production Worker 与 Cluster Worker
   ingress。它发现并修复 pending Promise 不保持 Node event loop、active Worker exit 0
   导致 CrashLoopBackOff 的 PID 1 缺陷；3 个 Pod/Session generation 均完成 online、
   heartbeat、draining、offline，credential 与 mTLS identity Recreate 共用同一 RWO PVC。

发布前仍必须完成：

1. Linux x64/arm64 image build、inventory/SBOM、non-root/read-only/cgroup resource gate
   与 immutable image digest；当前 `--network=none` 构建因本机 Docker cache 缺少 npm
   tarball而失败，不能声称镜像已生成。
2. 固定 96–128 MiB 路由设备的 idle、任务峰值、闪存写放大、断网、休眠、时钟跳变、
   断电和恢复证据。
3. Worker production certificate rotation 已由 ADR-0238 的 PostgreSQL/Linux 纵切面完成；
   ADR-0239/0360 已完成真实 K3s credential/identity generation、production image、
   Recreate 顺序、Session heartbeat/drain/offline 与单节点 PVC 恢复，但仍缺 CA overlap
   分区/回滚和对象存储故障/重试；Run 的
   Offer→starting→running→Artifact/completion/lease-control 已由 ADR-0236 完成，
   idle Session/Offer pull、credential revoke/replace 和 drain/offline 已由
   ADR-0235 完成。
4. 多节点 CSI PVC detach/reattach、物理节点丢失和 production 360 秒长 drain 的 live
   证据；ADR-0239 的单节点 local-path/强制删 Pod 不能替代这些 Gate，基础设施不得在
   360 秒后把未收敛副作用解释为安全停止。
