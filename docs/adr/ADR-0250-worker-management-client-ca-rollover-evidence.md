# ADR-0250：Worker 管理客户端 CA 三阶段生产证据

- 状态：Accepted（证据协议、runner、离线 auditor 与测试已实现；生产等价环境报告待采集）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-229、D-230、D-233、D-234
- 关联 ADR：ADR-0245、ADR-0246、ADR-0248、ADR-0249

## 背景

ADR-0249 已约束 manager 如何加载有界 CA/CRL bundle，以及 old → overlap → new 的运行时阶段，但单元测试和
提交态摘要不能证明生产等价集群真的按该顺序完成了全部副本替换。只观察最终 old client 401 也无法排除：

- 某个副本从未加载 overlap 或 new-only trust；
- overlap 缺少 old/new 任一 issuer 的当前 CRL；
- 只更新 Secret 而没有推进 Deployment generation；
- 服务端 TLS trust CA 被错误当成客户端证书 issuer CA；
- 变更主体、OIDC ceremony 或持久审计记录在三个阶段之间漂移。

D-232 证明同一 CA 下的单张客户端证书吊销，是独立的 revocation 证据；跨 CA rollover 不能错误要求 old/new
客户端共同由管理 API 的服务端 TLS trust CA 签发，也不能把 D-232 报告伪装成跨 CA 信任集合证据。

## 决策

1. 新增 caller-driven 三阶段 runner。阶段状态必须写入新的 canonical、owner-private、`0600`、no-replace 文件：
   old 输出 `old-state`，overlap 摘要绑定并读取 old-state，new 摘要绑定并读取 old/overlap 两份状态后输出最终报告。
2. 每阶段读取两份生产 client config。两者必须使用相同 HTTPS endpoint、servername、服务端 trust bundle 和
   inspect command，但使用不同客户端证书。服务端 trust bundle 只用于验证服务端 TLS；client certificate
   issuer 必须独立地从本阶段 service-side client CA bundle 求得，禁止要求两条 PKI 链同源。
3. trust 集合必须精确为 `old`、`old + new`、`new`。每个 active client CA subject 必须恰有一份当前有效 CRL，
   不允许遗漏、多余 issuer 或重复 CA/CRL。old/new client 的真实请求矩阵固定为 `200/401`、`200/200`、
   `401/200`，拒绝结果只能是统一的 `client_certificate_required`。
4. 每阶段都必须观察同一 Deployment UID、同一 cluster/collector authority、严格递增 generation、三个不同
   resourceVersion，以及每代两个 Ready、tokenless、分布在不同 Node 的 Pod。相邻阶段 Pod UID 必须全量替换，
   三阶段合计六个唯一 Pod UID；CA/CRL 原始 bundle 摘要必须与 Pod-template 两个注解精确一致。
5. Kubernetes collector authority 只能 `get` 指定 Deployment、`list` 指定 Pods；Secret/ConfigMap read、扩大
   Deployment list、所有 mutation、exec/port-forward 和 TokenRequest 必须保持拒绝。runner 不修改 Secret、
   Deployment、PKI 或 RBAC，同一主体不能既执行变更又自证。
6. 最终报告摘要绑定 D-229 live ceremony、D-230 durable audit、old-state 和 overlap-state。三阶段外部 issuer、
   subject digest、transport、cluster、collector 和 Deployment identity 必须一致；实际 subject 必须属于已审
   requester/reviewer，durable audit 必须继续绑定同一 ceremony。
7. 输出只保留域分离 SHA-256、状态码、generation 和低敏布尔事实；禁止原始证书、CA、CRL、JWT、private key、
   Kubeconfig/token、Secret/DSN 和 Pod/Node/Deployment 原始 identity。独立离线 auditor 只接受 exact v1 shape，
   任一 extra field、false gate 或敏感键都不兼容。
8. 实现是 repository script 和既有顶层命令，不新增 workspace package、第三方依赖、migration、controller、
   watcher、timer、sidecar、listener、Pool 或连接。Edge、Standalone 与 Worker Profile 不装配，低配设备零稳态成本。

## 失败与恢复

- old 或 overlap 状态不兼容、摘要链断裂：停止，不执行后续客户端请求，也不覆盖任何已存在 evidence 文件；
- overlap 不含精确 old+new，或任一 CRL issuer 缺失：保持 old/既有 overlap，不允许退休 old；
- generation 未前进、resourceVersion 复用、旧 Pod 残留或副本未收敛：该阶段失败，推进新的完整 rollout 后重采；
- new-only 阶段 old 仍成功或 new 失败：不得签发通过报告；经受审变更恢复 exact overlap 并生成新 generation；
- ceremony/durable audit 或 operator identity 漂移：重新完成受审 ceremony，不允许拼接不同变更会话的报告；
- 最终报告只证明被观察的生产等价环境和时间窗口，不自动证明未来 CRL 发布 SLO、PKI compromise 响应或所有
  外部 caller 已永久删除 old material。

## 被拒绝的替代方案

### 只保留最终 new-only 截图或 rollout status

拒绝。它不能证明 overlap 可用、CRL 覆盖、旧 Pod 全退役，也不能把真实双证书请求与具体 trust generation 绑定。

### 复用 D-232 并要求 server CA 签发 client certificate

拒绝。D-232 是同 issuer 的证书吊销证据；服务端 TLS trust 和服务端接受的 client issuer 是两条独立信任链。
混合两者会拒绝正确的生产 PKI 拓扑，并掩盖跨 CA overlap 的真实缺口。

### 让 runner 修改 Secret、Deployment 或 RBAC

拒绝。自变更、自授权和自证明无法形成独立证据，还会让短期采集凭据取得 client material custody。

### 为 evidence protocol 新建 package 或常驻 controller

拒绝。能力只有发布阶段的短期 operator 使用者，拆出单文件 package 会继续细碎化 `packages/`；常驻 watcher 或
controller 又会给低配部署增加空闲成本和新的 authority。

## 验证

- 三阶段 runner/auditor 定向 8/8：happy path、overlap 缺 old CA、generation 未变、Pod UID 复用、collector
  Secret read 扩权、ceremony identity 漂移、false/widened/sensitive/malformed report 与 exact CLI；
- happy path 精确证明 trust set `old → old+new → new`、访问矩阵 `old=[200,200,401]`、
  `new=[401,200,200]`，三代 generation/resourceVersion 和六个唯一 Pod UID；
- 输出 old/overlap/final 三份文件均为 `0600` no-replace，离线 auditor 可独立重判最终 exact v1 报告；
- workspace package 数与第三方依赖不变；生产外部 PKI/IdP/ingress 多节点联合报告仍是发布门。
