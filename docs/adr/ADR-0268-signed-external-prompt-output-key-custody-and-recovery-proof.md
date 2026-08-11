# ADR-0268：签名的外部 Prompt 输出密钥托管与恢复证明

- 状态：Proposed
- 日期：2026-08-03
- 关联：RFC D-244、D-245、D-247、D-249；ADR-0261、ADR-0262、ADR-0266

## 背景

QingLong 已能用 Kubernetes Secret CAS 完成 Prompt 输出 key rotation/retirement，并以
PostgreSQL append-only preparation/completion 抵抗响应丢失和主库晋升。但 Kubernetes
Secret 不是最终 KMS/HSM，也不是灾难备份。`create Secret` 不能按 `resourceNames` 收紧，
因此 QingLong Job 不应为了首次 provision 或灾难恢复取得 namespace 范围的 create 权限；
常驻 control 更不能持有 KMS unwrap、HSM session 或对象存储删除 authority。

即使 key material 已安全退役，现有 durable fact 仍保留 `keyId + materialProof +
catalogDigest`。这允许一个外部托管系统恢复 32 字节 material 后，在不重新激活该 key、
不改写生产 Secret 的情况下，证明它与原始 rotation/retirement 事实相同，并实际打开一份
历史 Artifact。

## 决策

### 1. KMS/HSM 与 QingLong runtime 分权

首次生成、wrap/unwrap、HSM quorum、wrapped blob 存储、备份复制和外部 Secret create 均由
部署方的独立 authority 负责。QingLong runtime、cluster-control、AI Pool 和 migration role
不得取得云 SDK credential、KMS decrypt、HSM session、Secret create 或 backup delete。

### 2. 外部托管必须产生签名 receipt

新增 `qinglong/plugin-package-prompt-output-external-custody-receipt@v1`。receipt 只保存：

- custody/key identity、material proof、source generation/catalog digest；
- provider 名、wrapping key reference digest；
- wrapped material digest/bytes；
- Ed25519 signing public key digest、receipt digest 与 signature。

receipt 不包含 plaintext key、wrapped blob、KMS key ARN/path、credential、Artifact ciphertext
或模型输出。QingLong 只接受显式 pinned Ed25519 public key；换 key 必须是外部受审 ceremony，
不能由 receipt 自报信任根。

receipt 与 wrapped blob 必须装入单一
`qinglong/plugin-package-prompt-output-external-custody-bundle@v1`。bundle digest 使用独立 domain，
绑定 schema、custody ID、receipt digest、wrapped material digest/bytes；wrapped material 使用
canonical base64url。Verifier 不再接受两个独立文件，避免复制中断或跨 generation 拼接形成
“新 receipt + 旧 blob”的部分状态。bundle 是 provider-neutral contract，不包含 endpoint、KMS key
path、token 或 provider credential。

### 3. wrapped backup 与恢复 material 分别验证

`@qinglong/ai/plugin-package-prompt-output-external-custody` 提供两个纯 caller-driven gate：

1. 对 wrapped blob 复算 bytes/SHA-256，并验证 receipt digest、签名和 pinned key；
2. 对外部 unwrap 后的 32 字节 material 复算 domain-separated material proof，要求与
   rotation completion 或 retirement preparation 的 durable `keyId/materialProof/catalogDigest`
   完全一致，再使用正式 AES-256-GCM/AAD 逻辑打开 exact Artifact。

成功只返回 content-free recovery proof：custody/receipt/key/material proof、Artifact/content
digest、output bytes、request/recovery identity 和 verification time。不得返回 plaintext、
key、wrapped bytes、provider reference 或路径。

### 4. 恢复不等于重新激活

首版 recovery proof 不更新生产 Secret、不删除 retirement record、不改变 active key、
不写 ModelInvocation/Artifact，也不把恢复 material 挂给常驻 runtime。实际明文交付、
重建生产 keyring 或 re-encrypt 属于后续显式审批产品；不能因为一次验证成功就静默撤销
retirement 或绕过 `artifact.read`。

### 5. 资源与包边界

能力留在既有 `@qinglong/ai` subpath，不新增 workspace package、第三方依赖、数据库表、
timer、watcher、listener、Pool 或云 SDK。Edge/Standalone/Cluster 默认均不加载；只有外部
恢复 ceremony 显式调用时付费。

### 6. 恢复必须由两个独立强身份共同授权

新增 `qinglong/plugin-package-prompt-output-external-recovery-authorization@v1`。授权固定
`artifact.read` 与 `lost-key-recovery-verification`，并绑定 recovery/request、custody receipt、
key、Artifact、Policy digest、请求者身份和最长 15 分钟有效期。两个 approver 必须使用不同
User、authentication、Ed25519 signing key，且均不得是请求者；每个认证在批准时最多 5 分钟。
两份签名覆盖同一个 canonical authorization digest，不能分别批准不同 Artifact 或 key 后拼接。

trusted approver public key 由 verifier 的私有 workspace 显式 pin，authorization 不能自报信任根。
过期、self-approval、重复 User/auth/key、签名或 exact fact 漂移全部失败关闭。

### 7. Verifier 是无网络、无数据库的隔离产品入口

`ql3-prompt-output-key-recovery-verify` 只读一个私有 workspace：authorization、custody receipt、
wrapped blob、外部 unwrap 得到的 32 字节 material、durable fact、Artifact 及三个 pinned public
key。所有文件必须是稳定、单 hard-link、不可写/执行、不可跟随 symlink 的 regular file；私有
文件禁止 `other` 读取。CLI 完成后清零持有的 recovered/wrapped material buffer，stdout 只有
authorization-bound content-free proof。

Kubernetes reference Job 位于独立 `qinglong3-recovery` namespace，不属于默认 Cluster
Kustomization。它没有 Role/RoleBinding、ServiceAccount token、env/envFrom、数据库连接、Secret
API、KMS endpoint 或 ingress/egress，只读一个由外部部署 authority 预置的 PVC。这个 Job 不能
执行 unwrap；因此 KMS credential 也不会因“恢复验证”进入 QingLong Pod。

### 8. 首个具体 adapter 是外部 Vault Transit CLI

仓库提供 caller-driven `custody:vault-transit:ql3` wrap/unwrap adapter，但不把 Vault SDK、token、
socket 或 timer 装入任何 QL3 package/runtime。production 只允许 HTTPS + 显式 CA，token 只从私有
只读文件读取；HTTP 仅允许 `127.0.0.1` 测试 fixture。wrap 调用 Transit encrypt 后生成签名 receipt
和单一 `0400`、no-replace bundle；exact replay 只验证已有 bundle，不重打 Vault。unwrap 先验证
bundle、pinned signing key、Vault endpoint/mount/key/version 的摘要绑定，再调用 Transit decrypt，
仅在 32 字节 material proof 完全一致后创建 `0400`、no-replace 文件。错误和成功 stdout 均不包含
token、material、wrapped blob、endpoint、key name 或路径。

## 当前证据

- Ed25519 receipt digest/signature 和 signing-key digest 可复算；错误 key/signature 失败关闭；
- wrapped blob bytes/digest 漂移失败关闭；
- provider-neutral atomic bundle 已替代 receipt/blob 双文件输入；跨 bundle blob 替换、digest 漂移、
  extra field 与 signing authority drift 均失败关闭；
- recovered material 必须同时匹配 signed receipt 与 durable key fact；
- 使用正式 Artifact AES-256-GCM/AAD 路径打开历史密文，输出 proof 不含明文或 key；
- 两个不同强 User、authentication 和 Ed25519 key 对同一个 15 分钟 authorization 签名；请求者
  self-approval、重复身份/会话/key、过期、签名和 exact fact 漂移失败关闭；
- package CLI 已从只读私有 workspace 完成 exact recovery，并在退出时清零 material/wrapped
  buffer；输出不含明文、key 或 wrapped blob；
- 隔离 Kubernetes Job 可由 Kustomize 渲染；deployment auditor 证明零 RBAC/token/env/network/
  database/KMS authority、deny-all NetworkPolicy 和 read-only PVC；
- Vault Transit concrete adapter 的 8 项 protocol test 已覆盖 immutable wrap、exact replay、
  unwrap、wrong material、key authority drift、非 HTTPS production transport、unsafe authority
  file、bounded response 和 content-free CLI；
- opt-in live contract 已在 digest-pinned 官方 Vault 1.21.4 arm64 容器实际完成 TLS 1.3 + 显式
  私有 CA、错误 CA 拒绝、3-share/2-threshold init/unseal、persistent file barrier、Transit key
  create/encrypt、atomic bundle、整个容器替换、sealed 状态观察、re-unseal、同一 Transit key 存续、
  decrypt、无 Vault exact replay、双 User authorization 与正式 Artifact open，最终
  `gates.passed=true`。容器显式当前非 root UID/GID、read-only rootfs、no-new-privileges、capability
  仅 IPC_LOCK、随机 loopback 端口且成功/失败均零临时容器/私有目录残留；该证据仍是单宿主 file
  storage 和短期本地 CA/root token，不是 HA integrated storage、HSM auto-unseal、enterprise PKI
  或外部 IdP/CNPG restore；
- 独立 PostgreSQL 18 arm64 opt-in live contract 已用 digest-pinned 官方镜像和随机 loopback-only
  端口运行完整 QL3 core/AI migration，以 production repository 写入 materialized revision、automation
  publication、Prompt admission/start/completion/finalization、正式加密 Artifact 和 key-rotation
  preparation/completion，再生成 734,708-byte custom-format backup。backup 不含明文或 raw key；
  删除整个源容器及匿名卷后，不同容器/匿名卷恢复出相同 52 条 core、16 条 AI migration history
  digest，八类 lineage 行各 1，并由恢复后的 Artifact/rotation repository 重新读取 exact fact 与
  Artifact，交给既有双 User authorization + offline verifier 实际打开，最终 `gates.passed=true`。
  成功/失败都清理随机容器、匿名卷和私有目录。该门已证明 production schema lineage 的逻辑
  PostgreSQL backup→restore→recovery composition，但不替代 CloudNativePG Barman WAL/PITR；
- workspace 仍为 19，package consumer graph 和依赖树不变。

## 接受门

本 ADR 保持 Proposed，直到：

1. 在 production-grade 外部 KMS/HSM/Vault HA storage + HSM/受控 unseal authority 下完成
   generate→wrap→immutable backup→unwrap，并证明 QingLong Pod 无 KMS credential；当前 TLS 1.3/
   persistent single-host Vault live contract 已关闭 transport、barrier restart 和 seal threshold 的
   实现风险，但不替代外部 HA/HSM 门；
2. 把当前 pinned Ed25519 双人 authorization 接到真实外部 IdP/审批 ceremony，取得非 fixture
   的不同 User/authentication 证据；
3. 在隔离恢复环境中从 production schema lineage 的 PostgreSQL/CNPG backup 取得 exact Artifact
   和 durable key fact，完成 content-free recovery proof；当前独立 PostgreSQL logical backup 门
   已关闭完整 production tables、migration history、backup 序列化、源销毁、隔离 restore、
   production repository reopen 和 verifier composition 风险，但尚未替代 CloudNativePG Barman
   WAL/PITR；
4. 覆盖 receipt/backup 丢失、错误 KMS key version、签名轮换、material drift、Artifact
   篡改、COMMIT response-loss 和主库 promotion；
5. 明确实际 plaintext 导出、生产 keyring 重建或 bulk re-encrypt 的独立授权与审计策略。

## 不采用方案

### 在 cluster-control 内集成所有云 KMS SDK

拒绝。会把 provider 重依赖、长期 decrypt credential 和网络故障域带入全部控制面副本。

### 让 rotation Job 同时负责首次 Secret create

拒绝。Kubernetes RBAC 无法把 create 收紧到一个未来对象名。

### 只备份 Kubernetes Secret 或只保存 material hash

拒绝。前者没有独立外部 custody，后者无法恢复；两者都不能证明 wrapped blob 与原 key、
durable fact 和历史 Artifact 同时一致。

### 恢复后自动把旧 key 重新加入生产 keyring

拒绝。会绕过 retirement、审批、运行时 reload 和后续再次安全退役的状态机。
