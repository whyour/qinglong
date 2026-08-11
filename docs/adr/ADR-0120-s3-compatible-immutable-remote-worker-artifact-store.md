# ADR-0120：S3-compatible 不可变 Remote Worker Artifact Store

- 状态：Accepted（具体共享 store adapter 已实现，Worker execution composition 已由 ADR-0121 实现；range read、retention 与完整 Worker 产品生命周期仍默认关闭）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-14、D-17、D-85、D-114、D-115、D-116、D-119
- 关联 ADR：ADR-0026、ADR-0027、ADR-0087、ADR-0115、ADR-0116、ADR-0117

## 背景

ADR-0117 定义了跨副本可见、digest-authenticated、put-if-absent 的 Artifact store port，但没有
具体生产 adapter。直接对最终 key 做流式 `PutObject` 有一个难点：SHA-256 只有完整消费 body 后才
确定，不能在发送 header 前作为 immutable metadata 写入；若目标已经存在，服务端又可能在完整读取
body 前返回 precondition failure，调用方无法证明 replay 内容与既有对象一致。

controller 本地临时文件虽然能先算摘要再上传，却会让每个并发请求消耗最多 64 MiB Pod ephemeral
storage，并重新引入“本地盘被误当成集群 authority”的风险。全量内存缓冲则直接破坏固定内存目标。

## 决策

### 1. 留在 cluster-control 的独立懒加载子入口

adapter 位于既有 `@qinglong/cluster-control/s3-artifact-store`，实现 ADR-0117 的
`ClusterRemoteWorkerArtifactStore`，依赖精确版本 `@aws-sdk/client-s3@3.1093.0`。不新增 workspace
package、schema、数据库连接、timer、queue 或 socket ownership；S3 client 由外层 composition root
创建并持有。Edge/Standalone 闭包不得导入该 cluster-only subpath。

### 2. 临时流式上传后做不可覆盖的 server-side promotion

首次写入顺序固定为：

1. `HEAD` 最终 opaque key；若已存在，完整消费并以固定内存计算 incoming SHA-256，只有
   identity/length/digest/truncation 全等才返回 `already_stored`；
2. 将 body 一次流式 `PutObject` 到 CSPRNG 临时 key，声明 exact Content-Length、SHA-256 checksum、
   `If-None-Match: *` 和服务端加密；
3. `HEAD + ChecksumMode=ENABLED` 复验临时对象的 length、media type、owner nonce 与 full-object
   SHA-256；
4. 用同 bucket server-side `CopyObject` 提升到最终 key，设置 `If-None-Match: *`、替换为 canonical
   metadata，并继续要求 SHA-256 checksum 和服务端加密；
5. 再次 `HEAD` 最终对象。只有 S3 checksum、metadata digest、length、identity hash 和 truncation
   全部一致才返回 receipt；
6. 删除已证明由本次请求拥有的临时对象。删除失败只进入低敏 diagnostic，不能逆转已耐久 promotion。

Copy 的 409/412 竞争和 Put/Copy 成功但响应丢失都不能直接解释为失败或成功，只能通过最终
`inspect` 裁决。明确收到 Copy 成功才返回 `stored`；竞争或丢响应经证据恢复返回保守的
`already_stored`。永久对象从不被该 adapter 覆盖或删除。

### 3. key 与 metadata 不暴露业务 identity

最终 key 是 domain-separated SHA-256 identity digest 的两级 shard，不包含 Project、Run、Attempt 或
log Artifact ID。metadata 保存各 identity 的独立 domain-separated digest、byte length、content
SHA-256 和 `omitted|true|false` truncation，不保存原始业务 ID、Worker/Session、Lease token 或 callback
capability。`inspect` 从调用方 authority 重新派生并逐项比较。

临时 key 使用 UUID，另生成独立 256-bit owner nonce digest。若临时 ID 极端碰撞，未证明 owner nonce
的请求不得删除已有临时对象。部署必须对 `temporary/` 配置有界 lifecycle 作为崩溃垃圾回收，并让
runtime credential 只能删除该前缀；永久 `objects/` 的 delete/overwrite 权限不授予运行时。

### 4. 加密与 confused-deputy fence 必须显式

构造必须显式选择 SSE-S3 (`AES256`) 或 SSE-KMS，并在 KMS 模式给出 key ID；不提供明文 fallback。
AWS 部署可同时给出 12 位 `expectedBucketOwner`，它会传给 destination 与 Copy source 请求。若
S3-compatible 服务没有启用 KMS/SSE，启动配置或第一次写入必须失败，不能静默降级未加密对象。

### 5. 生产启用仍由更外层门禁控制

本 ADR 交付具体共享 store，但不自动注册 Worker Artifact/completion routes，也不自动启动 Worker
headless lifecycle。ADR-0121 已在 Worker 侧完成默认关闭的 production execution-plane composition；
最终 Cluster Worker ingress 与完整 Worker 产品部署仍必须同时持有独立 mTLS/`ql3w` listener、最小权限
PostgreSQL service、该 adapter、Secret provider、Session/credential lifecycle 与 shutdown ownership，
缺任一项继续 fail closed。
range read、retention、临时对象 lifecycle 的部署验证和本地 spool 删除仍是后续 Gate。

## 被否决的替代方案

1. **controller 本地临时文件**：并发磁盘成本随 64 MiB body 放大，并容易被误认为共享 authority。
2. **全量内存缓冲**：使 controller RSS 与 Artifact 大小和并发数相乘。
3. **直接最终 Put 后再补 metadata/tag**：内容与 receipt 不是一个不可变 publication，崩溃可见半状态。
4. **只信任 ETag**：单段、multipart、加密和不同 S3 实现的 ETag 语义不等于 canonical SHA-256。
5. **冲突后不消费 replay body**：无法证明同 identity 的内容一致，也会破坏 ingress complete-consumption gate。
6. **删除任何同名临时 key**：CSPRNG 碰撞或错误注入时会删除其他请求 authority。
7. **未配置 SSE 时明文继续**：把安全属性变成部署偶然行为。

## 验收证据

1. 11 个 adapter 单元测试覆盖首次写入、exact replay、不同内容、Copy race、Put/Copy 丢响应、
   metadata/checksum 漂移、短读/超读、零字节、SSE-KMS、expected owner、cleanup diagnostic、临时碰撞
   no-delete 与 pre-abort 零请求。
2. 真实 `minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`
   （`RELEASE.2025-09-07T16-13-09Z`）启用临时 static KMS 后，通过首次写入、HEAD checksum、条件 Copy、
   exact replay、不同内容拒绝和最终单对象集成验证。
3. 未配置 MinIO KMS 时 SSE-S3 明确返回 501，adapter fail closed；测试没有加入明文兼容开关。
4. 本切片完成时 workspace importer 保持 23、TypeScript source file 为 293；ADR-0121 后当前为 294，
   cluster/edge dependency audit 继续 `findings=[]`。
5. 默认 Cluster Control 与 `/production` 子入口的独立进程加载证据均不含 `@aws-sdk/*`，只有
   `/s3-artifact-store` 显式子入口加载 SDK；本切片完成时六种本机制品再次通过真实
   pack/offline install/import，最大为 2,457,770 bytes、409 files、72 loaded modules 与
   12,517,376 bytes RSS delta，且均不含 SDK；ADR-0121 后复跑的当前最大 RSS delta 为
   12,566,528 bytes。
