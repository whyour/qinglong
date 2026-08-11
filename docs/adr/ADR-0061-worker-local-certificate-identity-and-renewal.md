# ADR-0061：Worker 本地证书身份与显式续期

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-23、D-37、D-58、D-59、D-60
- 关联 ADR：ADR-0012、ADR-0040、ADR-0058、ADR-0059、ADR-0060

## 上下文

ADR-0059/0060 已建立 Worker ingress 的 TLS 1.3 mutual TLS 与服务端信任热重载，但 Worker 侧仍缺少可独立部署的证书生命周期。若把私钥交给 control-plane 生成、直接覆盖正在使用的 PEM 文件，或让每个 Worker 自带一个常驻续期 timer，会分别扩大 CA/私钥 blast radius、制造断电后的混合身份，并让低性能路由设备承担不可见的常驻成本。

Worker transport certificate 还不能取代 `ql3w` credential：前者只证明某个客户端持有外部 CA 签发的私钥，后者才绑定 QingLong Worker principal；Session generation/version 与 Run Lease 继续独立 fencing。

## 决策

### 1. 独立 Worker package，不反向依赖控制面

Worker 证书能力放入独立 `@qinglong/worker-runtime` workspace。该 package 不依赖 legacy 根应用、runtime-core、cluster-control、cluster-postgres、Express、Drizzle 或任一数据库 driver；根 edge importer 也禁止依赖或加载它。

证书 enrollment 使用 exact-pinned `@peculiar/x509` 和 `reflect-metadata`，但只通过 enrollment 子入口和续期时的 dynamic import 加载。package 主入口只加载 Node 内建的证书校验、文件存储与协调器，steady state 不把 ASN.1/PKI 实现带入内存。禁用 Worker Profile 时不得安装到 edge 专属产物。

### 2. 私钥只在 Worker 本地生成

Worker 生成 ECDSA P-256/SHA-256 可导出 key pair，并创建带 `clientAuth`、`digitalSignature` 和 non-CA 约束的 PKCS#10 CSR。Worker ID 只进入 CSR subject 的描述字段，不建立 QingLong authority。

CA adapter 只取得 CSR、Worker ID、当前已验证 leaf fingerprint 和 AbortSignal，返回证书链；它不得返回或覆盖本地 trust anchor，也不能取得待安装私钥。当前 package 不提供匿名 enrollment endpoint，不持有 CA signing key，也不选择 cert-manager、SPIFFE/SPIRE、Vault 或离线 CA。

私钥以 Buffer 短暂存在；成功或失败后协调器都调用 `dispose()` 清零它。该措施不宣称能够清理 native heap、调用方副本、页缓存或受控硬件中的密钥。

### 3. 安装前完整验证，信任只来自本地配置

安装前必须验证：

- PEM 总量、证书数量和输入形状有硬上限；
- leaf 当前有效、不是 CA、包含 client-auth EKU，且剩余有效期达到 policy 下限；
- private key 与 leaf SPKI constant-time 匹配；
- 每个 intermediate/trust anchor 当前有效且是 CA；
- 有界证书路径可到达本地提供的 1 至 16 个 trust anchor；
- identity fingerprint 取 leaf DER SHA-256，不因 PEM 排版或附带 intermediate 改变。

Issuer response 不能成为 trust source。证书 subject/SAN/serial/fingerprint 都不能替代 `ql3w` credential、Worker Session 或 Run Lease。

### 4. 代际目录与单文件 active commit

身份 root 由单个 Worker runtime 独占，必须是绝对路径；root/generation 目录权限为 `0700`，private key、certificate chain 和 metadata 为 `0600`，读取拒绝 symlink、不安全权限、超限文件和畸形 manifest。

安装顺序固定为：

1. 在同一 `generations/` 目录创建 staging generation；
2. 独占创建并 `fsync` key、chain、metadata；
3. `fsync` staging 后 rename 为正式 generation；
4. `fsync generations/`；
5. 独占创建临时 active manifest，`fsync` 后 rename 为 `active.json`；
6. 在 rename 完成时标记 generation 已提交，再 `fsync` identity root；
7. 最后有界清理旧 generation，失败只报告 `cleanupPending`，不得回滚 active identity。

即使 active rename 后的目录 `fsync` 报错，也不得删除已经可见的新 generation。旧 generation 默认保留一份用于运维取证；总 generation 数有硬上限，达到上限时 fail closed，不做无界扫描。

不支持多个 Worker 进程共享 identity root、NFS/对象存储目录，或不保证同目录原子 rename/fsync 语义的文件系统。Profile composition 必须保证单 owner。

### 5. 续期协调器由外层显式触发

package 不注册 timer、watcher、signal handler、网络 client 或数据库连接。`WorkerCertificateRenewalCoordinator.run()` 只执行一次检查；edge 可以由低频已有 maintenance tick/cron 调用，集群节点可以由 Profile lifecycle 或外部 Secret controller 触发。

同一进程的并发调用合并为一个 in-flight operation。策略具有硬边界：renew-before 1 小时至 30 天、签发证书最小有效期 1 小时至 365 天且必须大于 renew-before、单次操作 1 至 120 秒、退避基数 1 秒至 1 小时、最大退避不超过 6 小时、连续失败计数最多 16。

失败使用 50%–100% jitter 的指数退避，并把失败次数、下次尝试、最后尝试和最后成功时间原子写入 `renewal.json`，避免重启后形成 CA retry storm。调用方主动 Abort 只终止本次操作，不计为签发失败；内部 timeout、trust/enrollment/issuance/install 失败进入退避。证书到期或本地身份不可验证时返回 `unavailable`，不得继续建立新的受信 transport。

协调器只返回稳定、低敏状态和时间，不返回 PEM、private key、CA adapter 错误、文件内容或远端响应。告警/metric 由 Profile 根据 `notAfterMs`、`nextAttemptAtMs` 和结果状态产生。

## 被否决的替代方案

1. **由 cluster-control 生成 Worker private key**：扩大常驻入口权限，并让密钥跨网络和服务边界流动。
2. **CA response 同时下发 trust root**：被攻陷的 enrollment transport 可以自行建立信任。
3. **直接覆盖固定 key/certificate 文件**：断电或多文件更新会留下 key/certificate 混合代际。
4. **默认后台 timer/watch Secret 文件**：增加 edge 常驻成本，并与部署平台的调度/更新语义竞争。
5. **续期失败后进程内立即重试**：重启会清空退避并对 CA 形成惊群。
6. **证书到期后继续使用旧连接**：把明确失效的 transport possession 变成隐式宽限期。
7. **在根 package 直接加入 PKI 依赖**：即使 dynamic import，也会扩大 edge 安装体积和供应链。

## 影响与未完成项

正向影响：

- Worker 私钥不离开本地 identity boundary；
- 外部 CA、QingLong credential 和 Session/Lease authority 保持分离；
- 安装和断电恢复只需裁决一个 active pointer；
- edge/cluster 可选择不同触发 cadence，共享相同一次性协调语义；
- 失败退避跨重启持久化，过期身份 fail closed；
- steady-state Worker 主入口不加载 PKI enrollment library。

仍未完成：

- cert-manager、SPIFFE/SPIRE、Vault PKI 或离线 CA adapter 与部署模板；
- production maintenance tick 与 Session fail-close/recovery 已由 ADR-0238 完成；Kubernetes
  identity generation/Recreate/单节点 PVC 已由 ADR-0239 完成；仍缺 ingress reload
  controller、生产 RBAC、CA overlap 分区/回滚与正式 PKI adapter；
- `ql3w` credential enrollment/recovery 产品流程；
- 证书到期/续期失败 metric、低敏 audit 和用户告警；
- TPM/PKCS#11/non-exportable key provider；
- 固定路由器、断电/文件系统故障注入与 x64/arm64 资源基线；
- 完整 Worker transport、ACK/completion/Artifact 生命周期。

## 验证

1. 真实 P-256 CSR 可以验签，private key dispose 后 Buffer 被清零。
2. 真实测试 CA 签发的 client certificate 在 key、EKU、有效期和 trust chain 全部匹配时可安装/重读，错配 key 被拒绝。
3. generation retention 有界，文件/目录权限分别保持 `0600`/`0700`。
4. 并发续期调用只签发一次；新身份安装后再次调用返回 `not_due`。
5. CA 失败产生持久化 jitter backoff，重启/重复调用在窗口内不再次访问 CA。
6. 调用方 Abort 不写失败退避；identity 到期/不可验证时结果为 unavailable。
7. package 主入口加载测试证明没有载入 `@peculiar/x509`。
8. edge 与 cluster dependency audit 同时证明根 importer 隔离和 Worker package 的 exact dependency/source boundary。
