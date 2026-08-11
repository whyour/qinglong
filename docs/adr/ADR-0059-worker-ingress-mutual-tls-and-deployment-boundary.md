# ADR-0059：Worker Ingress Mutual TLS 与部署边界

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-06、D-37、D-40、D-50、D-57、D-58
- 关联 ADR：ADR-0038、ADR-0040、ADR-0045、ADR-0051、ADR-0058

## 上下文

ADR-0058 建立了 Worker 专属 credential、listener、数据库角色和 append-only attestation，但 bearer secret 若经明文 HTTP 发送，任何旁路观察者都可在 credential 过期前冒充设备。仅在反向代理文档中建议 TLS 也不够：应用无法证明代理配置、客户端证书校验和 transport peer 仍符合安全假设，部署变量还可能把 edge/standalone 静态拉入 cluster bundle。

Worker ingress 需要一个默认无法降级的生产传输边界，同时不能把 X.509 subject 直接提升为 Worker 业务身份，也不能让证书文件、PostgreSQL credential 或 pepper 在禁用 Profile 中被读取。

## 决策

### 1. 启用 Worker ingress 必须使用 TLS 1.3 mutual TLS

启用的 Worker application 在绑定 socket 或打开数据库前要求 `mutualTls`。listener 只协商 TLS 1.3，要求客户端证书，并由显式 client CA 验证；无客户端证书、未知 CA、明文 HTTP 和旧 TLS 都不能到达 `/livez`、`/readyz` 或 admission pipeline。代码不提供 `allow-insecure-worker-http` 逃生开关。

mTLS 只建立受审 transport；`ql3w` credential 仍建立 Worker principal，path Worker ID、Session generation 和 Run Lease fence 仍需逐层验证。当前实现不从证书 CN/SAN 推导 Worker ID，避免把 PKI 命名、设备身份和执行 authority 混为一体。

### 2. listener 拥有独立且有硬上限的资源预算

Worker listener 是与 Project API 分离的 server，因此自然拥有独立 authentication shield、peer/global 窗口和 in-flight 集合。部署配置进一步固定 64 KiB request/response、最多 256 个 in-flight、最多 16 个 PostgreSQL connection、10 秒 TLS handshake、请求与 drain 上限。TLS 拒绝发生在认证、body 和数据库访问前。

这些限制是单副本 transport protection，不冒充跨副本 quota、安全审计或 Worker credential decision。TLS handshake flood 的跨节点防护仍应由受审 L4/L7 边界承担，但它不能终止 mTLS 后伪造应用已验证客户端证书，除非未来新增显式 proxy-attestation 协议。

### 3. TLS material 经文件边界加载和验证

部署配置只接受绝对路径。文件必须是有界 regular file，私钥不得 group/world writable；加载后必须证明：私钥可解析、服务证书和 client CA 当前有效、client CA 具备 CA 属性、服务证书公钥与私钥完全匹配。私钥解析临时 buffer 在失败路径清零，wire error 不包含文件路径、PEM 或底层解析细节。

配置不把 PEM 放入环境变量、日志或领域 DTO。ADR-0060 进一步定义外部 CA enrollment、CA bundle/CRL 和显式热重载；本 ADR 的启动安全边界保持不变。

### 4. Profile gate 先于 secret、文件和数据库配置

`QL3_WORKER_INGRESS_ENABLED=false` 时只解析部署 Profile，不读取 Worker pepper、TLS 路径或 PostgreSQL URL。启用时必须是 `cluster-control`，使用独立 `QL3_POSTGRES_WORKER_INGRESS_URL`、application name 和有界 Pool；PostgreSQL TLS 默认 `verify-full`，只有独立的二次显式 gate 才允许在本机测试中关闭。

配置模块只生产 HTTP options 和 worker-ingress database opener，不构造 Repository 或业务 pipeline。外层 assembly 继续遵守 `runtime-core → port ← adapter → Profile composition`。

## 被否决的替代方案

1. **保留明文 HTTP，依赖用户自行放反代**：应用无法证明长期 Worker secret 已被加密，也无法证明代理确实验证客户端证书。
2. **只做 server TLS**：能保护窃听，但任意网络客户端仍可消耗 Worker credential 认证预算；mTLS 提供独立的 transport possession gate。
3. **只信任证书 CN 作为 Worker ID**：会让 CA 命名直接获得业务 authority，绕过 credential version/revoke 和 Session fence。
4. **把 PEM 全部放环境变量**：扩大进程环境、诊断和编排元数据泄漏面，也不利于 K8s Secret/只读文件轮换。
5. **让 Worker listener 复用 Project API server**：共享 socket、rate budget 和 Pool 会重新合并故障域与权限边界。

## 影响与未完成项

正向影响：

- 长期 Worker credential 不再允许经明文 transport 发送；
- 无可信客户端证书的请求在 HTTP route、body 和数据库前失败；
- Worker listener 的请求、速率和 Pool 预算可独立配置；
- edge/standalone 禁用路径不读取 cluster secret 或 TLS 文件；
- 真实 PostgreSQL ingress 现在通过 TLS 1.3 mTLS 端到端验证。

仍未完成：

- 外部 CA adapter/部署模板、Worker 本地 CSR/续期/原子安装与到期告警；
- OCSP、reload 编排/audit 和完整 credential enrollment/recovery 产品流程；
- 受审 proxy/LB termination attestation 与 TLS handshake abuse metrics；
- Linux 多架构、低内存 control node 和大规模证书握手压测；
- 完整 ACK/completion/expiry/cancellation/retry PostgreSQL lifecycle。

## 验证

1. HTTP surface test 证明只协商 TLS 1.3、无客户端证书握手失败、受信客户端证书可访问 probe。
2. Worker application test 证明缺少 mTLS 时在 bind 和 database open 前失败。
3. config test 证明 disabled Profile 不读取 secret/TLS/数据库，启用配置有硬上限，拒绝相对路径、弱 pepper、不安全 PostgreSQL、错配 key/cert 和非 CA。
4. PostgreSQL 16.14 真实测试证明 mTLS request 仍按 credential→audit→body→Session 顺序执行，并保持四角色最小权限。
5. edge import 与 cluster dependency audit 继续证明该入口不会污染 edge/standalone 产物。
