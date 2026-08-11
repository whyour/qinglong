# ADR-0060：Worker Certificate Lifecycle 与原子信任重载

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-23、D-37、D-57、D-58、D-59
- 关联 ADR：ADR-0040、ADR-0057、ADR-0058、ADR-0059、ADR-0061

## 上下文

ADR-0059 已让 Worker listener 强制使用 TLS 1.3 mutual TLS，但启动时只读取一次 key、certificate 和 client CA。若证书更新必须重启整个 control-plane，轮换会与数据库、recovery、admission 生命周期耦合；若长期不轮换，泄露后的暴露窗口又不可接受。更危险的做法是让常驻 `cluster-control` 持有 CA 私钥并开放未认证 enrollment API：任一入口漏洞都会从执行面接管扩大为设备身份签发权。

需要把“谁签发证书”“QingLong 信任哪些证书”“Worker 的业务身份是谁”拆成三个独立边界，并让低资源 edge/standalone 在禁用集群能力时继续保持零 watcher、零 timer、零 PKI 依赖。

## 决策

### 1. CA 签发权在 QingLong 常驻控制面之外

Worker 私钥在 Worker 或受审硬件/Secret provider 中生成，CSR 由部署者选择的外部 CA、集群证书控制器或人工离线 ceremony 签发。`cluster-control` 和 `worker-ingress` 数据库角色不得取得 CA 私钥，也不新增“先匿名提交 CSR、再由控制面签发”的 bootstrap endpoint。

证书 enrollment 只建立 transport possession；Operator 仍需通过短生命周期 `cluster-admin` authority 独立签发 `ql3w` credential。Worker 只有同时通过 mTLS、`ql3w` authentication 和 Worker Session generation/version fence 才能取得业务 authority。证书 subject、SAN、serial 或 fingerprint 都不能自行成为 Worker ID。

### 2. CA bundle 支持有界重叠轮换

client CA 文件允许包含 1 至 16 张当前有效的 PEM CA certificate。轮换采用显式重叠窗口：先把新 CA 加入 bundle，待 Worker 换证后移除旧 CA。每次读取都重新验证文件是有界 regular file、所有 certificate 当前有效且具备 CA 属性；bundle 中的额外文本、空 bundle 和超过上限都 fail closed。

服务端 key/certificate 仍要求匹配，证书与 CA/CRL 文件仍使用绝对路径和 1 MiB 文件上限。私钥不得 group/world writable。失败路径清零已经读取的私钥、证书、CA 和 CRL Buffer，不把路径、PEM 或 OpenSSL detail 放入 wire error。

### 3. CRL 是显式、可选的即时吊销输入

部署可配置一个有界 PEM CRL 文件。CRL 由外部 CA 生成，QingLong 只消费并交给 Node/OpenSSL secure context；格式错误、签名/issuer 不可用于当前 trust context 或已吊销客户端证书都会在 TLS 层 fail closed。没有 CRL 的部署必须使用短寿命客户端证书，并通过 CA bundle 移除或外部 PKI 策略控制撤权窗口。

CRL 不替代 `ql3w` revoke：transport certificate 与业务 credential 是相互独立的两把锁，任意一层撤权都应阻止新的有效请求。

### 4. 热重载替换 secure context，不重绑 listener

启用 mTLS 的 HTTP surface 暴露显式 `reloadMutualTls()`，Worker application 只转发为 `reloadTransport()`。调用方先通过同一文件校验器重新加载完整 key/certificate/CA/CRL 快照，再一次性替换 TLS secure context。无效新材料返回稳定 configuration error，旧 context 和 listener 保持可用；成功后返回单调的进程内 TLS generation。

成功 reload 同时轮换 TLS ticket key、关闭 idle connection，并提升 generation。reload 前已建立的 keep-alive socket 若再次发起请求，会在 probe、route、Authentication、body 和数据库之前收到 `tls_context_reloaded` 并关闭连接；新握手必须使用新 context。reload 前已经进入 handler 的请求按原 admission/drain 语义完成，不把证书撤销误写成业务事务回滚。

package 不注册文件 watcher、signal handler 或周期 timer。Kubernetes Secret 更新、systemd reload、SIGHUP 或管理编排由 Profile artifact 在更外层显式拥有；edge/standalone 和禁用 Worker ingress 的进程不加载文件、不运行后台任务。

### 5. 内存中的旧材料有明确释放点

HTTP surface 为 Node secure context 复制输入材料。成功切换后清零上一代 JavaScript Buffer，失败时清零候选 Buffer，listener 关闭时清零当前 Buffer。该措施缩短进程堆中的明文私钥驻留，不宣称能够清除 OpenSSL/native heap、操作系统页缓存或调用方仍持有的副本；部署仍应使用只读 Secret mount、最小 UID 权限与节点级内存保护。

## 被否决的替代方案

1. **让 cluster-control 自建 CA 并在线签发**：把常驻网络入口升级为根身份 authority，权限和灾难恢复边界不可接受。
2. **证书 CN 直接等于 Worker principal**：绕过 `ql3w` revoke、Session replacement 与 Run Lease fence。
3. **每次轮换重启完整控制面**：把 transport 维护与 PostgreSQL/recovery/admission 故障域重新耦合。
4. **默认文件 watcher 自动 reload**：在 Secret 的多文件非原子更新时间窗内反复读取混合快照，并给低资源部署增加常驻 watcher/timer。
5. **reload 后保留所有旧 keep-alive 连接**：旧 CA 或已吊销证书可通过长期连接继续请求。
6. **只使用长期证书且没有 CRL/短寿命策略**：丢失设备的撤权时间没有可执行上限。

## 影响与未完成项

正向影响：

- 常驻 control-plane 不持有 CA 签发私钥；
- server certificate、client CA bundle 和 CRL 可在 listener 不重绑的情况下更新；
- CA 双信任窗口支持大规模 Worker 渐进换证；
- 已吊销客户端在 TLS handshake 被拒绝，旧 socket 不能跨 generation 继续请求；
- 禁用集群能力的设备继续保持零 PKI watcher 和零后台成本。

仍未完成：

- 具体外部 CA（cert-manager、SPIFFE/SPIRE、Vault PKI 或离线 CA）的 adapter/部署模板；
- Worker 本地 CSR、原子安装与续期协调已由 ADR-0061 孵化，production 单 cadence 触发与 transport fail-close/recovery 已由 ADR-0238 完成；仍缺具体 CA adapter、部署 reload controller 和到期告警；
- ADR-0239 已完成 Kubernetes identity generation 的显式 Recreate 与单节点 PVC evidence；
  仍缺 ingress SIGHUP/reload controller、生产 RBAC、低敏审计、CA overlap 分区与回滚；
- OCSP、TLS handshake abuse metrics、证书到期指标和大规模轮换压测；
- `ql3w` credential 的用户可见 enrollment/recovery 产品流程；
- 完整 ACK/completion/expiry/cancellation/retry Worker 生命周期。

## 验证

1. HTTP surface test 证明 empty CRL 允许受信客户端，reload revoked CRL 后同一客户端握手失败，恢复 CRL 后可重新握手，listener address 不变。
2. reload invalid certificate 失败后，旧 secure context 仍能服务受信客户端。
3. Worker application test 证明只有 active mTLS ingress 暴露显式 transport reload，并保持 stop/Pool 生命周期幂等。
4. config test 证明 CA bundle 为 1 至 16 张有效 CA、可读取可选 CRL，拒绝相对 CRL 路径、非 CA、混入文本和畸形 CRL。
5. cluster-control 全量测试继续覆盖主控制面默认明文行为、TLS 1.3、admission ordering、drain 与 edge import isolation。
6. Worker runtime test 证明本地私钥/CSR、证书链验证、原子 generation 安装、持久化退避和 steady-state PKI lazy load。
