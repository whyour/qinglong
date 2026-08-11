# QingLong 3.0 Worker 管理 PKI 吊销轮换证据

本流程用两个短生命周期阶段证明生产 Worker management 客户端证书吊销已经跨全部副本生效。runner 只观察
指定 Deployment/Pod 并发起 `worker-credential.inspect`；它不会读取 Secret、更新 CRL、patch Deployment、
执行 credential delivery 或消费审批。

## 前置条件

准备以下 canonical absolute paths：

- 旧、新两份 mode 0600 production client config；两者必须使用同一 HTTPS endpoint、TLS server name 和
  服务端 TLS trust bundle，
  但引用不同、当前有效且具备 clientAuth EKU 的 certificate/private-key pair；
- 一份显式 client issuer CA 文件，必须只含一张当前有效 CA，并同时签发旧/新客户端证书；它用于验证客户端
  issuer 与 CRL issuer，不要求等于 client config `caFile` 指向的服务端 TLS trust；
- mode 0600、短生命周期、强认证的 external User assertion，绑定 Worker audience/type/purpose；
- mode 0600 的同一份 `worker-credential.inspect` command；
- mode 0600 Kubernetes evidence config 和它引用的独立 kubeconfig；
- 当前 CRL 文件；文件可以被组读取，但不能 group/other writable；
- 已通过 audit 的 D-229 ceremony report 与 D-230 durable audit report；
- canonical private directory 中两个尚不存在的输出路径。

client config 的 exact schema 与 production client 相同：

```json
{"schemaVersion":1,"endpoint":"https://management.example.org/api/v3/worker-credentials/management","servername":"management.example.org","caFile":"/absolute/private/server-ca.crt","clientCertificateFile":"/absolute/private/old-client.crt","clientPrivateKeyFile":"/absolute/private/old-client.key","requestTimeoutMs":15000}
```

`caFile` 只验证管理 API 的服务端证书。`--client-issuer-ca` 只验证客户端证书和 CRL；生产部署可以也通常应该
使用不同的 server PKI 与 client PKI。D-232 v1 曾错误要求前者签发客户端证书，v2 报告已拒绝该耦合。

Kubernetes evidence config 固定观察生产对象：

```json
{"schemaVersion":1,"kubeconfigFile":"/absolute/private/evidence-kubeconfig.json","context":"production-evidence","namespace":"qinglong3-system","deployment":"ql3-worker-credential-management","labelSelector":"app.kubernetes.io/name=ql3-worker-credential-management,app.kubernetes.io/component=worker-credential-management","apiTimeoutMs":15000}
```

kubeconfig 必须是单 cluster、单 context、单 static user 的严格 v1 JSON，只允许 embedded CA 加 static token，
或 embedded client certificate/key；禁止 exec/auth-provider、外部文件引用和多 context。给该身份的 RBAC 只允许：

```text
get deployments.apps/ql3-worker-credential-management
list pods
```

runner 会用 `kubectl auth can-i` 验证这两项允许，并验证 Secret/ConfigMap/Deployment 列表、所有相关 mutation、
Pod exec/port-forward 和 ServiceAccount TokenRequest 均拒绝。RBAC 仍应通过 `resourceNames` 约束 Deployment；
Pod list 的保密边界必须由专用 namespace 与 admission policy 配合，因为 Kubernetes RBAC 不能按 label selector
限制 list。

## 阶段一：吊销前

先计算当前 CRL 原始字节摘要，并由独立 deployment operator 在私有 overlay 中替换提交态的全零占位注解：

```bash
openssl dgst -sha256 /absolute/private/current-client.crl
kubectl -n qinglong3-system patch deployment/ql3-worker-credential-management \
  --type=merge \
  --patch='{"spec":{"template":{"metadata":{"annotations":{"qinglong.io/worker-credential-management-client-crl-sha256":"sha256:REPLACE_WITH_64_LOWERCASE_HEX"}}}}}'
kubectl -n qinglong3-system rollout status deployment/ql3-worker-credential-management
```

只有 operator 使用上面的 mutation authority；不要授予 evidence kubeconfig。Deployment 的注解必须位于 Pod
template，因此改变摘要会创建新 generation。随后运行：

```bash
export QL3_WORKER_CREDENTIAL_MANAGEMENT_PKI_ROTATION_EVIDENCE=1

pnpm evidence:worker-management-pki-rotation:ql3 -- \
  --phase=before \
  --old-config=/absolute/private/old-client.json \
  --new-config=/absolute/private/new-client.json \
  --assertion=/absolute/private/operator.jwt \
  --command=/absolute/private/inspect-command.json \
  --kubernetes=/absolute/private/kubernetes-evidence.json \
  --client-issuer-ca=/absolute/private/client-issuer-ca.pem \
  --crl=/absolute/private/current-client.crl \
  --output=/absolute/private/pki-rotation-before.json
```

成功条件是同一 Deployment 已收敛到两个不同 Node 上的 Ready Pod，注解等于 CRL SHA-256，collector 权限精确
只读，且旧、新证书调用同一 inspect command 均为 200。before-state 仅包含摘要和低敏事实，mode 为 0600。

## 操作暂停：由独立 PKI/Deployment operator 完成吊销

停止 runner。使用生产 PKI 流程吊销旧证书，发布同一 issuer 的新 CRL，确保 CRL number 和 lastUpdate 增加；
更新 `ql3-worker-credential-management-tls` 中的 `client.crl`，把新 CRL 原始字节摘要写入 Pod template 注解，
并完成 `maxUnavailable=0` rollout。保留 PKI change ticket、Secret revision 和 rollout 日志，但不要把 Secret
内容并入证据报告。

不要只重启一个 Pod，也不要在旧 Pod 存活时进入 after 阶段。替代证书不得被吊销或更换，旧/new client config、
assertion、inspect command、kubeconfig 和 endpoint 必须与 before 阶段相同。
`--client-issuer-ca` 也必须保持同一 canonical 文件内容；如需轮换 CA，应改用 D-234 三阶段 CA rollover 证据，
不能把 D-232 的单 issuer 吊销流程扩成隐式 overlap。

## 阶段二：吊销后

```bash
pnpm evidence:worker-management-pki-rotation:ql3 -- \
  --phase=after \
  --before=/absolute/private/pki-rotation-before.json \
  --old-config=/absolute/private/old-client.json \
  --new-config=/absolute/private/new-client.json \
  --assertion=/absolute/private/operator.jwt \
  --command=/absolute/private/inspect-command.json \
  --kubernetes=/absolute/private/kubernetes-evidence.json \
  --client-issuer-ca=/absolute/private/client-issuer-ca.pem \
  --crl=/absolute/private/rotated-client.crl \
  --ceremony-report=/absolute/private/worker-management-ceremony.json \
  --durable-audit-report=/absolute/private/worker-management-durable-audit.json \
  --output=/absolute/private/worker-management-pki-rotation.json

unset QL3_WORKER_CREDENTIAL_MANAGEMENT_PKI_ROTATION_EVIDENCE

pnpm audit:worker-management-pki-rotation:ql3 -- \
  --report=/absolute/private/worker-management-pki-rotation.json
```

after 阶段要求 CRL 单调前进、Deployment UID 不变但 generation/resourceVersion 改变、旧 Pod UID 全部退役、
两个新 Pod 在不同 Node Ready，并观察旧证书 401 `client_certificate_required`、新证书 200。当前 assertion
subject 必须与 D-229/D-230 的 requester 或 reviewer 摘要一致。

最终报告不包含证书、私钥、JWT、Kubernetes token、Pod/Node/Deployment 原始 UID、Secret 或 DSN。将报告与
D-229/D-230 报告、PKI ticket 和 rollout 日志一起保存；不要把 private input 文件或 evidence kubeconfig 放进
低敏报告归档。完成后按部署凭据流程撤销 evidence 身份。
