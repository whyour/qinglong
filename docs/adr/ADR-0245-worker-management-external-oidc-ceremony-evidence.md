# ADR-0245：Worker 管理外部 OIDC 双用户 Ceremony 证据

- 状态：Accepted（证据协议、runner 与离线审计器已实现；真实外部报告待采集）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-58、D-226、D-228、D-229
- 关联 ADR：ADR-0148、ADR-0242、ADR-0244

## 背景

ADR-0244 已让 Worker Credential management 使用独立 JWT type/purpose，并由进程级、
PostgreSQL HA 和三节点 K3s fixture 证明生产装配。但 K3s fixture 的两名强 User assertion 由仓库内
确定性密钥签发，不能证明真实外部 IdP、真实不同人员或生产身份策略。

直接把原始 assertion、subject、session ID 或管理响应存为“证据”会扩大凭据与个人身份数据暴露；
直接执行 credential delivery 又会把身份验证与 Secret mutation 混成一个不可独立复核的门。

## 决策

1. 新增 caller-driven `ql3-worker-credential-management-live-ceremony.cjs`。它只允许固定顺序：
   requester `plan` → requester `propose` → requester `decide` 必须 403 → reviewer `decide` →
   reviewer `inspect`。runner 不接受 operation 参数，也没有 `execute`、TokenRequest 或 delivery 路径。
2. requester/reviewer assertion 必须来自同一个 canonical 外部 HTTPS issuer、拥有不同 User subject，
   并精确绑定：
   - `aud=qinglong3-worker-credential-management`；
   - `typ=ql3-worker-credential-management+jwt`；
   - `ql3_purpose=worker-credential-management`；
   - 有界 lifetime/authentication age、非 `none` algorithm、canonical compact encoding。
3. runner 在任何管理 mutation 前读取 OIDC discovery/JWKS，并复用生产 Worker management client 的
   TLS 1.3、CA/servername、canonical file、body/response/timeout 与 exact result validation。manager
   对两枚 assertion 的真实签名、keyset、assurance 和 Policy 验证仍是最终认证 authority；runner
   的 envelope 检查不是签名验证替代品。
4. ceremony 输入是 mode 0600 的 exact-shape 文件。所有 identifier 与 plan request 在首个网络请求前
   通过 production transport normalizer；requester/reviewer decision identity 必须不同。只接受新建
   `pending@1` approval，避免把已有决定误写为本次现场证据。
5. 输出使用 `qinglong/worker-credential-management-live-ceremony@v1`，写入 unused canonical mode
   0600 文件。只保留外部 issuer、discovery/JWKS SHA-256、domain-separated subject/key/request/project/
   action 摘要、plan/preview digest、五步状态和 `dispatchCreated=false`、
   `approvalConsumed=false`；禁止 assertion、JWT、Authorization、Secret、token、DSN、password 或私钥。
6. 独立 audit CLI 只读验证 exact report shape、外部 issuer、Worker profile、不同 subject digest、
   五步状态、未 dispatch/consume、全 true gate 与敏感材料扫描。runner 自审通过后才原子 no-replace
   写报告；没有真实报告时发布门仍未完成。
7. 该能力只增加两个短生命周期脚本和一个根级命令，不新增 workspace package、第三方依赖、
   migration、数据库角色、镜像、listener、timer、watcher、controller 或 sidecar。Edge/Standalone/
   Worker 常驻闭包不导入它。

## 失败与恢复

- OIDC discovery/JWKS、TLS、认证、self-deny、reviewer decision 或 inspect 任一步失败都不生成报告；
- `plan/propose` 已 durable 后失败时，operator 必须先 inspect。若 approval 仍为 `pending@1`，可用同一
  immutable ceremony 继续；若已决定，则本 runner 拒绝把它包装为新现场证据，应创建新的无执行
  ceremony identity；
- 主请求不做业务自动重试。生产 client 的无响应语义仍要求 durable inspection；缺少响应不能解释为
  rollback；
- 输出路径不可覆盖，防止把两次不同现场证据混为一份报告。

## 被拒绝的替代方案

### 把 K3s 自签 token 标为外部 IdP

拒绝。它只能证明协议与部署 wiring，不能证明外部 issuer、人员分离或生产 IdP policy。

### 接受一个 assertion 并在客户端改 subject

拒绝。subject 是 issuer 签名事实；客户端改写既不能通过签名，也不能证明两名人员。

### Ceremony 顺便 consume approval 或执行 delivery

拒绝。身份/职责分离证据不应产生 Worker credential、Kubernetes token 或 Secret mutation。执行证据由
ADR-0242 的独立 caller-driven executor gate 负责。

### 将原始 subject、JTI、request ID 或 assertion 写入报告

拒绝。这些值对离线合规判断没有必要，且会扩大个人信息、会话关联和 credential 泄漏面。域分离
摘要足以证明同份报告内部的不同身份与请求链。

## 验证

- runner/audit 7/7：外部双 User happy path、自批被错误接受时失败关闭、same-user、错误 purpose、
  `.test` issuer、过期/Plugin-type assertion、宽权限/symlink/已存在输出文件、widened/false-gate/敏感
  报告、五个 path-only CLI 参数；私有读取使用 `O_NOFOLLOW` 与 descriptor 前后 stat；
- happy path 明确观测五个 operation，零 `worker-credential.execute`，输出 mode 0600，并由独立 audit
  子进程再次判定 `compatible=true`；
- production client/transport 的 Cluster Admin 全量回归为 177 pass、0 fail、1 条真实 Kubernetes API
  条件 skip，继续覆盖 TLS 1.3、远端错误、exact response 和四个公开 operation；
- 根 back/legacy 全量回归为 881 pass、0 fail、2 条平台条件 skip；dependency、deployment、Edge
  audit 均 `compatible=true`、`findings=[]`，workspace importer 保持 19。

## 尚未完成

- 在真实外部 IdP 与生产等价 manager endpoint 上采集一份 mode 0600 report，并由 audit CLI 通过；
- 按 ADR-0246 用部署侧短期、exact SELECT-only PostgreSQL evidence role 采集 proposal/decision durable
  security audit；collector/audit 协议已实现，真实报告仍待采集；
- 外部 client certificate 的运行时/客户端/Kubernetes 协议已由 ADR-0247 补齐；生产 PKI、生产 ingress、
  证书或 IdP 身份撤销后的新请求失败关闭仍需现场证据，不能由本报告推导。
