# ADR-0433：Catalog-bound Kubernetes 目标部署 Ceremony

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-337、D-339、D-341
- 关联 ADR：ADR-0429、ADR-0431、ADR-0432

## 上下文

ADR-0431 已把 verified release catalog 物化为 Kubernetes v2 locked manifest/report，但最后一步仍由运维者直接执行
`kubectl apply -f locked.yaml`。该命令没有再次绑定 report self-digest、目标 cluster、kubeconfig、kubectl executable 或
field manager；检查过的文件、实际输入和实际 API target 之间仍存在复制、context 漂移与 TOCTOU 窗口。成功输出也没有 durable
receipt，响应丢失后只能凭人工判断是否重放。

Cluster 需要解决这个缺口，但不能把 Kubernetes、YAML 或 registry 工具带到 Local/Edge，也不能为一次发布新增常驻 controller、
webhook 或长期 ServiceAccount authority。

## 决策

1. 在现有维护工作站脚本边界增加 `cluster.deployment.preflight`、`cluster.deployment.apply` 与
   `cluster.deployment.receipt.audit` 三种 canonical command；只提供一个
   `pnpm cluster-deployment:ql3 -- --command-file=/absolute/private/command.json` 入口，不新增 workspace package 或生产依赖。
2. command、locked manifest、lock report、kubeconfig、preflight 与 receipt 必须位于 current-UID 的 canonical `0700` 目录，文件为
   canonical、current-UID、单链接 `0600` regular file。所有输入使用 `O_NOFOLLOW|O_CLOEXEC` stable descriptor 有界读取，调用前后
   复验 dev/inode/size/mtime/ctime 与 SHA-256。kubectl 必须是 absolute canonical、current-UID 或 root owner、不可 group/other write
   的单链接 executable，并由 command 固定其 SHA-256。
3. 目标 consumer 独立验证 `qinglong/kubernetes-deployment-lock@v2` exact shape/self-digest、3.x release identity、catalog workflow/
   immutable reference/release-set 闭包、required role 顺序、全部 GHCR digest reference、manifest byte digest、资源/authority 数量、
   五项 release annotation，以及未知或畸形 QingLong image authority 为零。不能只相信 materializer 的 success stdout。
4. kubeconfig 必须由 command 固定 SHA-256 和 explicit context；禁止 `exec` 与 legacy `auth-provider`，避免稳定文件读取后再隐式执行
   ambient credential plugin。每次网络动作前显式读取 `kube-system` Namespace UID，并与人工审核的 `expectedClusterUid` 精确匹配。
5. preflight 只执行固定 manager `qinglong3-catalog-lock` 的 `kubectl apply --server-side --dry-run=server --validate=strict -f=-`，通过
   stdin 发送已验证的内存字节，不让 kubectl 按路径二次读取 manifest。所有承载 QingLong image authority 的资源必须显式携带
   namespace，禁止依赖 context 的 ambient default namespace。成功后才 no-replace 发布 self-digest preflight report；它明确
   `networkAccess=true`、`kubernetesMutation=false`。目标 namespace 必须预先存在，否则包含 namespaced resources 的 dry-run 自然失败关闭。
6. apply 必须消费 exact preflight digest，并重新执行全部离线检查、cluster UID 与 server-side dry-run；不使用
   `--force-conflicts`。实际 apply 后以 `kubectl get -f=- -o=json --show-managed-fields=true` 读取同一资源集合：每个对象必须有
   UID/resourceVersion，全部期望字段递归匹配；承载 QingLong image authority 的资源必须由固定 field manager 以 `Apply` 持有，所有
   image/catalog annotation 再次精确验证。结束时再次检查 cluster UID 和全部稳定文件。
7. 只有所有步骤成功后才以 `0600` no-replace 发布 self-digest receipt。receipt 绑定 mutation、command、preflight、lock/manifest/
   catalog digest、cluster UID、kubeconfig/kubectl digest、各 argv/stdout/stderr digest 与 byte count。已有 exact receipt 的相同 command
   离线返回；apply 成功但 receipt 丢失时，使用同一 command/field manager 重放 server-side apply，再以 live convergence 收敛。
8. Kubernetes 多资源 apply 不是事务，receipt 必须固定 `crossResourceAtomicity=false`。失败时不自动删除或回滚资源；先审计 live state，
   再用上一份 catalog-bound lock 执行新的显式 roll-forward。offline receipt audit 只重建 canonical/self/command binding，明确
   `externalResultsReplayed=false`，不伪称离线重放 API Server 结果。

## 部署与资源影响

- Local/Edge/Standalone 零导入、零制品增量、零常驻 CPU/RSS/网络/写放大；低配路由器继续只消费 Local v2 selection。
- Cluster 不新增 controller、webhook、CRD、RBAC、ServiceAccount、Pod、listener、timer、watcher、数据库、migration、SQL 或 Pool。
  ceremony 使用部署者原有 kubeconfig 权限并在命令结束后退出。每个 kubectl 子进程使用独立 `0700` 临时 HOME/XDG cache/TMPDIR，
  结束即清理，不读取 ambient HOME，也不在仓库或 operator home 留下 discovery cache。
- 实现内聚在 `scripts/lib/ql3-kubernetes-deployment-ceremony.cjs` 与薄 CLI；没有为单一工作站流程拆出浅 workspace package。
- 每次 preflight 为一次 cluster identity read 和一次 server-side dry-run；apply 为 identity read、dry-run、apply、convergence read、末次
  identity read。manifest/report/kubeconfig 各有明确 byte ceiling，process stdout/stderr 各最多 4 MiB。

## 被拒绝的替代方案

### 继续文档化裸 `kubectl apply`

拒绝。它无法证明 apply 的文件、report、context、cluster 和 executable 与人工审核对象相同，也没有 response-loss recovery receipt。

### 使用 `kubectl diff` 证明收敛

拒绝。真实 K3s 门证明 kubectl 会隐式从 `$PATH` 启动外部 `diff`，扩大未固定的 executable authority。受审 convergence read 只调用
同一 pinned kubectl，并直接验证 live object identity、managed field ownership 和完整期望字段。

### 自动 `--force-conflicts` 或失败后删除资源

拒绝。强夺其他 field manager 或跨资源猜测回滚会扩大故障；冲突必须失败关闭，多资源非原子事实必须进入 receipt 与人工恢复流程。

### 在集群内新增持续部署 controller

拒绝。当前缺口是显式 release rollout 的最后一跳，不值得新增常驻 availability、credential、certificate 与升级故障域。

## 验证

- 定向契约 10/10，覆盖 lock/report/manifest/annotation、cluster UID、文件权限、kubeconfig executable auth、server dry-run、apply、live
  convergence、field manager、receipt 重签、response replay、closed CLI 与低敏失败；
- 隔离三节点 K3s `v1.34.3+k3s1`/Linux arm64 真实运行 6 个资源、4 个零副本 Deployment；preflight、server-side apply、live
  convergence 与 offline receipt audit 全部通过，固定 manager 为 `qinglong3-catalog-lock`，临时 Docker container/network 零残留；
- 最终 live cluster UID 为 `7b2a5391-41a3-4905-90cc-3b831bef0058`，preflight digest 为
  `sha256:7c6db6236a704cd7791f94268b3883d6385a75a993a14d1611791f885fb65404`，receipt digest 为
  `sha256:58817a667bccf28c068fff40619cf13d2d0a1be84153de66a137b005feb536ba`。该 synthetic lock 只验证目标 apply 语义，不冒充公开
  GHCR catalog ceremony；
- 完整 backend、18-package、边界审计与制品结果记录在 QL-RFC-0001 D-341。
