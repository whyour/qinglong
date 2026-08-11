# ADR-0251：Worker 管理吊销证据的双 PKI 信任域分离

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-231、D-232、D-233、D-234
- 关联 ADR：ADR-0247、ADR-0248、ADR-0249、ADR-0250
- 取代范围：ADR-0248/D-232 中“同 endpoint/CA”的模糊约束，以及 PKI evidence v1

## 背景

D-232 v1 从 production client config 的 `caFile` 读取管理 API 服务端 TLS CA，同时要求该 CA 直接签发 old/new
客户端证书。这把两个独立方向的认证错误合并为一个 PKI：

- client → manager：client config 的 server trust bundle 验证管理 API 服务端证书；
- manager → client：manager 的 client trust bundle/CRL 验证客户端证书及吊销状态。

实际生产部署通常由 ingress/server PKI 和 operator/client PKI 分别管理。D-234 已显式要求服务端 trust 与客户端
issuer 分离；继续接受 D-232 v1 会拒绝正确拓扑，也会让后续统一 release gate 无法可靠绑定两类事实。

## 决策

1. D-232 报告和 before-state 升级为 schema/fixture v2，v1 不再构成兼容发布证据。离线 auditor 必须拒绝 v1，
   防止旧报告在修复后继续被提升为有效双 PKI 证明。
2. old/new production client config 仍必须使用同一 HTTPS endpoint、servername、server trust bundle 和 inspect
   command，但 `caFile` 只验证服务端 TLS。server trust bundle 必须是严格 UTF-8、只含 1–16 张唯一、当前有效
   且 `ca=true` 的 PEM CA；报告保留原始 bundle digest 和有序 authority fingerprint 集合。
3. runner 新增 exact `--client-issuer-ca` 输入。它必须只含一张当前有效 CA；old/new 两张 client certificate 都
   必须由它签发并验证通过，且证书仍需匹配各自 private key、非 CA、具备 clientAuth EKU、处于有效期。
4. OpenSSL 以 RFC2253 规范化 client issuer CA subject 与 CRL issuer；CRL issuer digest 必须精确等于显式 CA
   subject digest。before/after 必须继续使用同一 issuer CA bundle/certificate/subject，CRL number、lastUpdate
   和原始摘要按原 D-232 规则单调前进。
5. v2 transport 只报告 server trust bundle/authority digest；v2 PKI section 独立报告 client issuer bundle、CA
   fingerprint、subject digest 和 CRL facts。`serverTrustSeparatedFromClientIssuer` 表示两条链独立验证，不要求
   它们的 certificate 必须不同，但禁止通过同一个隐式字段证明两种方向。
6. D-232 继续只证明同一 client issuer 下的单证书吊销；跨 CA old→overlap→new 必须使用 D-234。runner 不读取
   Secret、不修改 Deployment/PKI/RBAC，不新增 package、依赖、migration 或常驻资源。

## 失败与迁移

- 缺少 `--client-issuer-ca`、文件含多张/非 CA/过期/重复/附加文本：在 Kubernetes/client 请求前失败关闭；
- old/new 任一证书不由显式 CA 签发，或 CRL issuer 不匹配该 CA：不创建 before/final 输出；
- server trust 或 client issuer 在 before/after 漂移：拒绝拼接两个阶段；
- 已保存的 v1 报告可作为历史原始记录保留，但不能通过 v2 auditor，也不能进入 D-235 统一 release evidence；
- 若组织确实使用同一根 CA，仍必须通过两个独立输入和两组摘要明确证明两个方向，不能省略 issuer 输入。

## 被拒绝的替代方案

### 保留 v1 并把字段改名

拒绝。只改名仍会让 client leaf 由 server trust CA 验证，无法支持双 PKI，也会让旧报告与新语义不可区分。

### 从客户端证书的 issuer 文本推断 CA

拒绝。issuer DN 不是签名证明，可能发生同名 CA；必须提供具体 CA certificate 并执行 `checkIssued` 与签名验证。

### 要求 D-234 替代所有 D-232 吊销证据

拒绝。CA rollover 与同 issuer 单证书 revocation 是两个正交控制；前者不能证明 CRL number 单调和被吊销 leaf
统一拒绝，后者也不能证明 trust overlap 与 CA 安全退休。

## 验证

- D-232 v2 runner/auditor 9/9：原两阶段/CRL/rollout/RBAC/报告/CLI 覆盖全部保留；
- 新增错误 issuer 负向测试，在任何 client access 前失败；
- 新增真实 OpenSSL 双 PKI 测试：server trust CA-A、client issuer CA-B，client config 与 issuer signature 均验证
  成功，两个 fingerprint 明确不同；
- `node --check` 与 D-232 定向测试通过；workspace package、第三方依赖和 Profile 闭包不变。
