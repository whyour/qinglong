# ADR-0248：Worker 管理 PKI 吊销与滚动替换证据

- 状态：Accepted（证据协议、runner、离线审计与部署注解已实现；生产报告待采集）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-229、D-230、D-231、D-232
- 关联 ADR：ADR-0245、ADR-0246、ADR-0247
- 后续修正：客户端证书 issuer 与服务端 TLS trust 的分离由 ADR-0251/v2 取代本 ADR 中“同 endpoint/CA”的表述；v1 不再是兼容发布证据。

## 背景

ADR-0247 已要求 Worker credential management 在业务路由同时验证客户端证书与 Worker-purpose OIDC，
并以更新 CRL 后滚动双副本的方式完成吊销。但“某一旧证书曾成功、随后返回 401”不足以证明生产集群确实
加载了新 CRL：请求可能落到不同环境，Deployment 可能没有换代，旧 Pod 也可能仍存活。另一方面，让证据
采集器读取 TLS Secret 或自行 patch Deployment，会把观察者升级为 PKI/部署变更者，失去独立证明价值。

## 决策

1. 使用 caller-driven、两阶段、只读观察协议。`before` 证明旧证书与替代证书在同一 endpoint、CA、命令和
   Worker-purpose User assertion 下均返回 200；`after` 证明旧证书统一返回 401
   `client_certificate_required`、替代证书仍返回 200。
2. 两阶段之间只能由协议外的生产 PKI/Deployment operator 更新 CRL、计算原始 CRL 文件 SHA-256、把该摘要
   写入 Pod template 注解 `qinglong.io/worker-credential-management-client-crl-sha256`，再完成
   `maxUnavailable=0` rollout。证据 collector 不提供 mutate 子命令。
3. Kubernetes collector 身份只允许 `get` 指定 Deployment 与 `list` 带固定 selector 的 Pod；必须明确证明
   Secret get/list、ConfigMap get、Deployment list、Deployment/Secret/Pod create/update/patch/delete、
   Pod exec/port-forward 与 ServiceAccount TokenRequest 均被拒绝。
4. 每个阶段要求 Deployment observed generation 收敛、两副本 Ready、无 ServiceAccount token、位于两个不同
   Node。`after` 还要求同一 Deployment UID、generation 增加、resourceVersion 改变、CRL 注解改变且等于当前
   CRL 摘要，以及两个旧 Pod UID 全部消失。
5. CRL 必须由 OpenSSL 验证并提取 issuer、number、lastUpdate、nextUpdate；`after` 必须保持同一 issuer，
   CRL number 与 lastUpdate 单调增加，且 CRL 当前有效。
6. 最终报告必须摘要绑定 before-state、ADR-0245 external ceremony report 与 ADR-0246 durable audit report；
   当前操作者必须是 ceremony 的 requester 或 reviewer，并在 durable report 中存在相同摘要身份。
7. 报告只保存域分离 SHA-256、generation、HTTP 状态和布尔 gate。禁止证书、私钥、JWT、Kubernetes token、
   Pod/Node/Deployment 原始标识、Secret 内容和 DSN。before-state 与报告均以 no-replace 0600 文件写入并由
   独立 exact-shape auditor 验证。
8. 该协议只增加短生命周期脚本、测试、文档和 Pod template 注解；不增加 workspace package、第三方依赖、
   migration、controller、watcher、timer、sidecar、listener、Pool 或连接。Edge/Standalone/Worker 零稳态成本。

## 失败与恢复

- `before` 写出后若 operator 尚未完成吊销，保留该 state，修正变更后再执行一次新的 `after` 输出路径；
- CRL 未递增、注解与文件摘要不一致、rollout 未收敛、任一旧 Pod 仍存在或 collector 权限变宽均失败关闭，
  且不会写最终报告；
- `after` 的旧证书请求若超时、返回 200 或返回其他业务错误，不能解释为已吊销；替代证书非 200 也不能通过；
- runner 不执行回滚。生产 operator 必须按自身 PKI 记录判断修复或回滚，并重新从新的 before-state 开始；
- 报告只证明观察窗口内的联合事实，不替代 CA 私钥 custody、CRL 发布 SLO、证书库存或 ingress 日志。

## 被拒绝的替代方案

### 让 collector 读取或更新 Secret

拒绝。Secret read 会把证书/私钥/CRL custody 扩大给证据身份；Secret/Deployment write 又使同一主体既变更又
证明，无法形成独立控制。

### 只记录 rollout status 或 Pod 名称

拒绝。rollout status 不能证明旧 Pod UID 全部退役，也不能绑定当前 CRL 字节；Pod 名称既可能复用又会泄漏
基础设施标识。协议使用 UID 的域分离摘要与 CRL 原始字节摘要。

### 在 manager 中加入 CRL watcher 和证据端点

拒绝。watcher 会引入混合 TLS context、常驻资源和低配 Profile 供应链成本；自证端点由被测进程声明自身状态，
也弱于外部 read-only Kubernetes 观察和真实请求结果。

## 验证

- runner/auditor 定向测试覆盖两阶段成功、CRL number 不递增、generation 未改变、旧 Pod 未完全替换、Secret
  读取权限被放宽、false gate、widened shape、敏感字段和 CLI exact arguments；
- deployment audit 锁定提交态的全零注解占位符，要求生产私有 overlay 显式替换；
- D-232 不新增 package 或依赖，复用既有 Cluster Admin production client、D-229 ceremony validator 与
  D-230 durable audit validator；
- PostgreSQL 18.4 arm64 HA 重跑完成 `remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind` 只读重入、
  双 fresh control replicas、Worker management quota/keyset ledger 与总 gate；`ql3-ha-` Docker 资源零残留；
- 真实生产 PKI、external IdP、ingress 与多节点集群联合报告仍是发布门。
