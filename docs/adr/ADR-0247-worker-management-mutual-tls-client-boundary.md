# ADR-0247：Worker 管理业务路由的客户端证书边界

- 状态：Accepted（运行时、生产客户端、Kubernetes 装配与门禁已实现）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-58、D-226、D-229、D-230、D-231
- 关联 ADR：ADR-0059、ADR-0148、ADR-0242、ADR-0245、ADR-0246

## 背景

Worker credential management 已用 Worker-purpose OIDC assertion 建立强 User 身份和双人职责分离，
但原 8444 listener 只验证服务端证书。任何能到达受限 NetworkPolicy 的 Pod 都可以进入 HTTP 解析、
Authorization 与 OIDC 验证边界；NetworkPolicy label 不是密码学客户端身份，也不能表达吊销。

另一方面，Kubernetes kubelet 的 HTTPS startup/readiness/liveness probe 不携带业务客户端证书。若在 TLS
握手阶段无条件拒绝无证书连接，会让标准 HTTP probe 失效并迫使部署增加第二 listener 或 sidecar，扩大
端口、镜像、资源和故障域。

## 决策

1. Worker credential management 的同一个 TLS 1.3 listener 请求并验证客户端证书。进程启用时必须同时
   读取有界 client CA 和 CRL；缺一、无效或相对路径均在 bind/数据库使用前失败关闭。
2. `/livez` 与 `/readyz` 保持无需客户端证书，以兼容 kubelet HTTPS probe。除此之外的所有路由必须先检查
   `TLSSocket.authorized`，再进行路径分派、rate limit、Authorization 读取、OIDC bind 或 body 读取；无证书、
   非受信证书和已吊销证书统一返回 401 `client_certificate_required`。
3. mTLS 只证明受信客户端设备/工作站持有证书，不建立 User、Project、Role 或审批 authority。业务请求仍
   必须携带独立的 Worker-purpose OIDC assertion，并继续通过强认证、Policy、职责分离与 durable audit。
   证书 subject、SAN、serial 和 fingerprint 均不得映射成 User。
4. production client config 必须同时引用 CA、client certificate 和匹配 private key。客户端在建立连接前
   验证 key/certificate 匹配；直接 HTTPS 与 Kubernetes tunnel 共用同一 TLS identity。
5. 服务端 TLS Secret 固定投影 server certificate/key、client CA 和 current CRL。caller-driven Job 使用
   独立、immutable `kubernetes.io/tls` Secret 投影 client identity，不与 assertion 或服务端 trust 合并。
6. CA/CRL 在进程启动时形成不可变 TLS snapshot。证书吊销或 CA 轮换必须更新 Secret 后滚动 Deployment；
   不增加 watcher、timer、动态 reload socket 或第二 listener。滚动策略保持两副本 `maxUnavailable=0`。
7. Plugin Package management 未选择本决策，不得因共享 HTTP/client 实现而被隐式要求 client certificate。
   Edge、Standalone 与 Worker Profile 不装配此 Cluster-only operation，零新增 package、依赖、migration、
   listener、Pool 或常驻成本。

## 安全顺序

业务请求的固定外层顺序为：TLS 1.3 server authentication → client certificate CA/CRL authorization →
Worker-purpose OIDC assertion → Project Policy/职责分离 → exact command/body → durable mutation/audit。
健康探针只能观测进程和数据库 readiness，不能调用业务 route。

服务端使用 `requestCert=true`、`rejectUnauthorized=false` 允许无证书 kubelet 完成 TLS 握手；这不表示业务
路由允许匿名访问。应用在任何业务解析前强制 `socket.authorized`。若未来基础设施支持独立携证 probe，
可另立 ADR 评估握手级硬拒绝，不能在本协议中静默改变 probe 行为。

## 失败与恢复

- 无证书、未知 CA、错误用途或 CRL 吊销都返回同一低敏 401，不暴露具体 PKI 原因；
- CA/CRL 配置错误使新 Pod 启动失败，旧 Ready Pod 在滚动期间继续服务；修复 Secret 后重新 rollout；
- client certificate/key 不匹配由客户端在连接前拒绝，不发送 assertion 或 command；
- 业务响应丢失仍按原 durable inspect/replay 规则恢复，mTLS 成功不等于 mutation 已提交；
- CRL 更新不会原地改变现有 Node TLS context，运维必须记录 Secret revision 与 Deployment rollout revision。

## 被拒绝的替代方案

### 只依赖 NetworkPolicy label

拒绝。label 是调度元数据，不是持有证明；被攻陷的同 namespace Pod 或错误 label 会直接到达 OIDC 边界，
也没有证书吊销语义。

### 用客户端证书替代 OIDC

拒绝。设备/工作站 identity 不能证明当前 User、强认证时间、Project Role 或双人审批，且会把 PKI subject
错误提升为业务 principal。

### 第二个无认证健康 listener 或 TLS sidecar

拒绝。额外端口/进程会扩大 NetworkPolicy、镜像、资源和 shutdown 故障域。单 listener 的健康例外更窄，
且业务路由在读取 header/body 前仍失败关闭。

### 在进程内 watch CRL

拒绝。watcher/timer 和部分 reload 会增加稳态成本及混合代际风险。首版使用 Kubernetes 原子 Secret 更新
加显式零不可用滚动，行为可审计且不影响低配 Profile。

## 验证

- Cluster Admin 定向测试覆盖 TLS 1.3、健康探针无证书 200、业务路由无证书 401、CRL 吊销证书 401、
  OIDC binder/transport 未被调用，以及 matching/mismatched client key；
- deployment audit 锁定 server CA/CRL env、四项 TLS Secret projection、独立 client identity Secret、
  client config 和 init/main mount，CloudNativePG 的全量 env patch 不得丢失新配置；
- 三节点 K3s gate 使用两个短期 client identity：先通过旧证书，随后更新 CRL 并滚动双副本，证明无证书
  业务请求与旧证书均 401、新证书 200；健康探针继续 TLS 1.3 无证书工作，并回归 OIDC key overlap/revoke、
  配额、一次性 committed Job、数据库故障 readiness fence 与恢复；
- PostgreSQL 18.4 arm64 physical HA 同步重跑完成 `remote_apply`、timeline 1→2、旧主 fence、
  `pg_rewind` 只读同步重入、双 fresh replica、Worker management quota/identity ledger 与总 gate；
- workspace 保持 19 个 package，未新增第三方依赖或 Edge/Standalone/Worker artifact。

## 尚未完成

- 在生产 PKI、外部 IdP 和生产 ingress 上采集 client certificate issuance/revocation、Deployment rollout、
  新请求拒绝以及 ADR-0245/0246 双报告的联合证据；
- 生产 CRL 保留、签名、发布延迟 SLO、CA rollover 和紧急吊销 runbook 仍需按实际 PKI 产品固定。
