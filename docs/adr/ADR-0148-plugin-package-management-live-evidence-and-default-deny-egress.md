# ADR-0148：Plugin Package 管理 Live Evidence 与默认拒绝 Egress

- 状态：Accepted（证据协议、采集器、审计器、默认拒绝 egress 与静态门已实现；真实报告待采集）
- 日期：2026-07-25
- 关联：ADR-0144 至 ADR-0147、QL-RFC-0001 D-142/D-143

## 背景

管理入口已经具备 TLS 1.3、外部强身份验证、双 User separation-of-duty、双副本清单、
durable quota 和全副本重启 keyset ledger，但这些单元/静态/本机 HA 证据不能替代：

- 真实外部 IdP 的两名不同 User；
- 三控制面、至少两工作节点的真实 Kubernetes；
- CNI 实际执行的 ingress/egress NetworkPolicy；
- 双 Pod 零不可用 keyset/TLS rotation；
- manager role 对 Kubernetes Secret、executor mutation 和公网 egress 的真实否定。

CI 自签两枚 JWT 只能验证协议路径，不能被记录为真实 IdP 证据。仅看到两个 Ready Pod
也不能证明请求、轮换或网络隔离。

## 决策

### 1. 版本化低敏证据

新增 `qinglong/plugin-package-management-live-evidence@v1` 和
`ql3-plugin-package-management-live-evidence-audit.cjs`。报告最大 1 MiB，必须为绝对
路径上的 non-symlink regular file，且不可 group/world writable。

报告精确绑定：

- Kubernetes 精确 `gitVersion`（至少 1.32，允许受限的 managed-distribution
  suffix）、架构、CNI 名称/版本、三控制面和至少两工作节点；
- management/PostgreSQL 实际 image ID；
- 两个 Ready management replica、两个不同 Pod/Node identity 摘要、零 token mount；
- `ql3_package_manager`、25 migration、capability v24、38 表；
- 非本机、非 IP、非保留测试域名的 canonical HTTPS OIDC issuer；
- discovery/JWKS 摘要、两名不同 User subject 摘要和 MFA/hardware assurance；
- 三个严格递增 keyset generation、最终 durable ledger generation 与 revoked 数量；
- propose、自批拒绝、另一 User approve、authorized inspect 和 durable Audit；
- labelled/unlabelled ingress、错误端口、Kubernetes API/公网/PostgreSQL egress；
- Secret read 与 executor mutation 权限否定；
- overlap、新 key、旧 key revoke、TLS serial/Secret generation 变化和 TLS 1.3；
- 九个独立 summary gate 与总 `passed`。

报告禁止出现 assertion、Authorization、bearer/token、password、Secret、DSN、
connection string、private key 或 JWT-like material。这个审计器验证报告契约，不凭空
生成事实；没有真实采集报告时，生产 gate 仍未通过。

### 2. 拒绝测试身份冒充生产证据

issuer 必须是 canonical HTTPS URL，并拒绝：

- localhost、`.localhost`、`.local`；
- `.test`、`.invalid`、`.example`；
- 任意 IP literal；
- userinfo、query、fragment 或非规范 URL。

两名 User 的 subject 只记录 SHA-256 摘要但必须不同，assurance 只能是
`multi_factor` 或 `hardware`。CI fixture 可以继续用于回归，但不能通过 live evidence
审计。

### 3. 默认拒绝管理 Pod egress

基础 management NetworkPolicy 现在同时声明 `Ingress` 与 `Egress`：

- ingress 只接受同命名空间带
  `qinglong.io/plugin-package-management-client=true` 的客户端访问 TCP 8443；
- base egress 只允许 kube-system `kube-dns` 的 UDP/TCP 53；
- CloudNativePG overlay 只额外允许同命名空间
  `cnpg.io/cluster=ql3-postgres` 的 TCP 5432；
- 外部 PostgreSQL 或不同 DNS 实现必须在私有 overlay 精确声明目标，不能回退为 `{}`、
  namespace-wide 或公网 egress。

管理 Pod 不需要访问 IdP discovery/JWKS；受审 keyset 仍由独立部署 authority 投影，
避免把网络发现、watcher 或新 credential 放进公网 parser 进程。

### 4. 采集事实，而不是接受最终布尔值

新增 `ql3-plugin-package-management-live-evidence-collect.cjs`，但不新增 workspace
package、常驻进程或第三方依赖。它只由集群 operator 显式运行，edge/standalone
制品与运行时不导入。

采集器拒绝输入 `gates`、`passed` 等最终判断。它直接：

- 从显式 kubeconfig/context 查询 Kubernetes server、Ready/schedulable Node、
  management Deployment/Service/ServiceAccount/Pod、CloudNativePG Pod、CNI DaemonSet
  和实际 container image ID；
- 以 `kubectl auth can-i --as=system:serviceaccount:...` 验证 manager 不能读取 Secret，
  不能 create Job、patch Deployment 或 update ConfigMap；
- 精确比较已部署的 CloudNativePG management NetworkPolicy，空 selector、额外 peer/
  port、`ipBlock` 或其他宽化均拒绝；
- 仅把 `service=<name>` 交给 `psql`，通过 mode 0600 的 `PGSERVICEFILE` 以
  `ql3_package_manager` 查询 PostgreSQL 18.4、25 migration、capability v24、38 表、
  三条指定 durable Audit 和最终 keyset ledger；
- 从外部 HTTPS issuer 获取 discovery/JWKS，禁止 redirect，限制每份 1 MiB，验证
  discovery issuer 并对原始响应计算 SHA-256；
- 将私有 exercise 中的 User subject、TLS serial 和 Secret resourceVersion 加域后
  摘要化，不把原值、三个 Audit UUID 或 probe transcript 写入最终报告。

标准 API 无法重放的真实 HTTP 四眼、CNI 数据面探针和三阶段轮换仍由私有 exercise
记录原始 HTTP status/operation/error、probe outcome 与三份 readiness sample。该文件
必须是 canonical、non-symlink、最大 1 MiB、mode 0600，24 小时后过期，并且不得包含
assertion、credential 或预计算 gate。采集器从这些原始字段派生最终 boolean；这提高
了可复核性，但不能阻止拥有主机权限的人伪造输入，因此真实运行日志和变更记录仍属于
发布审计链。

### 5. 三阶段真实 exercise runner

新增 caller-driven `ql3-plugin-package-management-live-exercise.cjs`，将 raw exercise
拆为 `before → overlap → revoked → finalize`，不新增 workspace package、第三方依赖
或常驻进程：

- `before` 真实执行 requester propose、自批 403、reviewer approve/inspect，并用
  tokenless、non-root、无 Secret 的临时 Pod 验证 labelled/unlabelled/错误端口 ingress；
  两个 management Pod 内分别验证 Kubernetes API/公网 deny 与 PostgreSQL allow；
- operator 随后必须人工把 keyset 切到 old/new overlap、增加 generation，并轮换 TLS
  Secret 后以零不可用 rollout 进入 `overlap`；同一 old/new assertion 都必须返回 200；
- operator 再显式 revoke old kid、增加 generation且保持 overlap TLS，进入
  `revoked`；runner 要求 overlap 中完全相同的 old/new assertion，旧 assertion 在仍未
  过期时返回 401，新 assertion 继续返回 200；
- 每阶段写入一个新的 mode 0600、不可覆盖状态文件。状态只保存 assertion SHA-256，
  不保存 assertion 本身，并以 `previousStateSha256` 形成顺序链；该摘要链只证明连续
  性，不是主机签名，拥有主机写权限者仍可重算，因此 operator 日志和发布变更记录仍是
  信任边界；
- `finalize` 只接受三阶段严格递增时间/generation、三份双副本 TLS 1.3 readiness
  sample 和五分钟内的 revoked 状态，再生成 collector 接受的私有 raw exercise。

runner 会写入一条专用 Package proposal/approval/Audit，但不会 consume、dispatch、
下载或激活 Package。`action-input` 必须是经过复核、无生产副作用的专用证据提案。
所有 assertion 文件、action input、kubeconfig 和阶段状态都必须是 canonical mode
0600 文件；临时探测 Pod 删除失败会使该阶段失败。

## 验证

- live evidence audit：5/5；
- live evidence collector：7/7，覆盖真实对象派生、空 selector/策略宽化、manager-only
  SQL、OIDC 原始摘要与 SSRF/流式大小边界、低敏输出与私有文件边界；
- live exercise runner：6/6，覆盖强身份派生、私钥拒绝、三阶段摘要链、同 assertion
  撤销、篡改/跳阶段拒绝、tokenless/non-root/有界 probe Pod 与仅清理本轮成功创建的
  Pod；
- 上述 collector/audit 在只读、无网络的 `node:24-bookworm-slim` 容器中合并复验
  12/12；
- cluster deployment audit：`findings=[]`；
- deployment audit tests：新增公网 egress 和宽化 PostgreSQL selector 负向门；
- management base/CloudNativePG Kustomize 均可 render；
- 未新增 workspace package、第三方依赖、timer、watcher 或常驻进程。

## 尚未完成

必须由真实环境采集并通过：

```bash
export QL3_PLUGIN_PACKAGE_MANAGEMENT_LIVE_EXERCISE=1

pnpm evidence:plugin-package-management-live-exercise:ql3 -- before \
  --kubeconfig=/absolute/private/kubeconfig \
  --context=production \
  --endpoint=https://management.example.org/api/v3/plugin-packages/management \
  --ca-file=/absolute/private/management-ca.crt \
  --requester-assertion=/absolute/private/requester.jwt \
  --reviewer-assertion=/absolute/private/reviewer.jwt \
  --action-input=/absolute/private/evidence-action.json \
  --output-state=/absolute/private/management-before.json

# operator: old/new key overlap + generation increase + TLS Secret rotation +
# zero-unavailable rollout; old.jwt/new.jwt must remain valid through revoked.
pnpm evidence:plugin-package-management-live-exercise:ql3 -- overlap \
  --kubeconfig=/absolute/private/kubeconfig \
  --context=production \
  --endpoint=https://management.example.org/api/v3/plugin-packages/management \
  --ca-file=/absolute/private/management-ca.crt \
  --input-state=/absolute/private/management-before.json \
  --old-assertion=/absolute/private/old.jwt \
  --new-assertion=/absolute/private/new.jwt \
  --output-state=/absolute/private/management-overlap.json

# operator: explicitly revoke old kid + generation increase; keep overlap TLS.
pnpm evidence:plugin-package-management-live-exercise:ql3 -- revoked \
  --kubeconfig=/absolute/private/kubeconfig \
  --context=production \
  --endpoint=https://management.example.org/api/v3/plugin-packages/management \
  --ca-file=/absolute/private/management-ca.crt \
  --input-state=/absolute/private/management-overlap.json \
  --old-assertion=/absolute/private/old.jwt \
  --new-assertion=/absolute/private/new.jwt \
  --output-state=/absolute/private/management-revoked.json

unset QL3_PLUGIN_PACKAGE_MANAGEMENT_LIVE_EXERCISE
pnpm evidence:plugin-package-management-live-exercise:ql3 -- finalize \
  --input-state=/absolute/private/management-revoked.json \
  --output=/absolute/private/management-exercise.json

pnpm evidence:plugin-package-management-live:ql3 -- \
  --kubeconfig=/absolute/private/kubeconfig \
  --context=production \
  --cni-daemonset=kube-system/cilium \
  --cni-container=cilium-agent \
  --cni-name=cilium \
  --exercise=/absolute/private/management-exercise.json \
  --pg-service-file=/absolute/private/pg_service.conf \
  --pg-service=ql3_evidence \
  --output=/absolute/private/plugin-package-management-live.json

pnpm audit:plugin-package-management-live-evidence:ql3 -- \
  --report=/absolute/private/plugin-package-management-live.json
```

在报告不存在或审计失败时，真实 IdP 四眼、双 Pod ingress/rotation 与 Kubernetes
control-plane HA 仍是未完成状态，生产入口继续失败关闭。
