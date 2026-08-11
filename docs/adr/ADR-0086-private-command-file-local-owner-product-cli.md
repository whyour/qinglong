# ADR-0086：私有命令文件驱动的 Local Owner 产品 CLI

- 状态：Proposed（Owner provisioning/claim/delivery acknowledgement/credential recovery CLI 已完成；fresh database 与 pepper setup、Linux/路由器实机门禁待完成）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-74、D-76、D-77、D-78、D-80、D-82、D-83、D-84
- 关联 ADR：ADR-0077、ADR-0078、ADR-0079、ADR-0081、ADR-0082、ADR-0083、ADR-0085

## 上下文

本机 Owner provisioning、challenge、原子 claim、delivery acknowledgement 与 credential recovery 已有短生命周期安全核心，但调用方若要先从 ready 文件读取 credential/challenge secret，再把两个 secret 通过 argv、stdin、环境变量或通用 JSON transport 交回 claim，会人为扩大密钥暴露面。GC CLI 已证明私有持久命令文件适合作为低频、可重放的本机运维 intent，但其文件读取协议不应复制到每个 CLI。

目标部署既可能是只有一个 Node.js 进程和 SQLite connection 预算的路由设备，也可能是 cluster 节点。前者需要零常驻成本；后者不能借用本机 POSIX UID 绕过独立的 cluster 身份、审批和管理面。

## 决策

### 1. 提取共享叶子命令文件协议

独立 `@qinglong/local-command-file` 只负责读取 JSON：路径必须绝对、规范且不超过 4096 bytes；real/effective POSIX UID 必须一致；文件必须由当前 UID 拥有，是 `0600`、1–16 KiB 的普通非 symlink 文件，并通过 `lstat → O_NOFOLLOW open → fstat` 的 device/inode/size 复核。解析后清零输入 Buffer。

该 package 不理解 Owner、GC、SQLite 或 runtime contract，也没有第三方生产依赖。`ql3-owner-gc` 与 `ql3-owner` 均复用它，各自继续拥有 versioned exact-shape command schema；共享文件安全不等于共享领域 authority。

### 2. 产品入口只接受 durable intent

`ql3-owner run --command-file /absolute/private-command.json` 是唯一二进制接口。命令固定为 `schemaVersion: 1`、exact top-level shape，并在调用前持久化 operation、options、mutation/request identity。当前开放七个 operation：

1. `owner.identity.provision`
2. `owner.challenge.issue`
3. `owner.claim.from-deliveries`
4. `owner.delivery.inspect`
5. `owner.delivery.acknowledge`
6. `owner.credential-recovery.issue`
7. `owner.credential-recovery.complete`

CLI 不从 PID、时间或进程内随机值生成幂等 identity，不从 stdin/env/flags 接收领域字段。每个 invocation 只打开一个 `LocalOwnerConsole`，执行一个 operation，并在成功或失败后等待唯一 close fence；不增加 daemon、listener、timer、watcher 或第二 SQLite connection。

### 3. Claim 在受信组合根内部消费 ready secret

`owner.claim.from-deliveries` 只携带 Project、claim mutation/request 和 credential/challenge delivery mutation ID。console 内部先查询 challenge 数据库事实：未消费时才读取两个私有 ready record，把 token 直接交给 bootstrap service；secret 不跨 CLI transport，也不进入返回值。

若 claim 已提交，console 只读取 challenge/provisioning 数据库事实，严格验证 Project、claim mutation/request、binding 和 credential ID/version 后返回 `existing`。因此 credential/challenge ready 文件确认并删除后，相同命令仍可精确重放，且不会重新请求 entropy 或要求恢复 secret。

### 4. 输出只提供继续 ceremony 所需的低敏事实

provision、challenge 与 recovery issue 只返回 identity、状态、expiry，以及 ready 文件仍存在时的 path/delivery digest；digest 用于后续精确 acknowledgement，不是 secret。claim 只返回 Project、challenge、subject、role、binding version 和时间；acknowledgement 只返回 purpose/kind/state/mutation/request/TTL；recovery completion 只返回 credential identity 与状态。

所有成功结果和错误均为单行 JSON。任何结果字段名不得包含 secret/token；CLI 不打印命令文件内容、ready record、pepper material、数据库 proof 或 destruction proof。已确认 delivery 的 issue 精确重放返回 `delivery: null`，而不是重建或泄漏 secret。

### 5. Package authority 与部署边界保持分离

`@qinglong/local-owner-cli` 的生产依赖只允许 `@qinglong/local-command-file` 和 `@qinglong/local-owner-console`。它不得直接导入 bootstrap、credential recovery、keyring、SQLite、runtime 或 GC authority；这些能力只能经受审 console facade 到达。CLI 不进入 edge/standalone/application 常驻制品，也不能用于 cluster 管理。

该入口假设 database migration 已完成，且目标 pepper material 已在 catalog 中注册并激活。它不是 fresh setup authority：建库、pepper no-replace provision、独立备份、register/activate 和恢复证明仍需后续独立 setup CLI/installer，不能由 product CLI 在启动时猜测或自动完成。

## 被否决的替代方案

1. **把 credential/challenge token 作为 claim flags/stdin JSON**：扩大进程列表、shell、管道和诊断泄漏面，拒绝。
2. **CLI 直接读取 secret 后返回给上层 orchestrator**：让 transport 成为不必要的密钥通道，拒绝。
3. **把全部 Owner 与 GC 操作做成一个超权 CLI**：混合 setup、认证、恢复和破坏性 authority，拒绝。
4. **启动时自动生成并激活 pepper**：隐式改变备份与身份根，且无法证明独立故障域，拒绝。
5. **本机 CLI 复用于 cluster 节点管理**：POSIX UID 不是多租户集群 principal/approval，拒绝。
6. **为路由设备保留 Owner daemon**：低频 ceremony 不值得常驻连接、timer 和内存，拒绝。

## 验收证据

1. `@qinglong/local-command-file` 2 项测试覆盖私有 JSON 成功路径，以及相对路径、`0644`、symlink、超限和 malformed JSON 拒绝。
2. `@qinglong/local-owner-console` 19 项测试包含 transport-free claim、提交后数据库事实重放、staged delivery/recovery、篡改/权限/目录预算和 ENOSPC/EROFS 代码故障门禁。
3. `@qinglong/local-owner-cli` 2 项真实 migrated SQLite 端到端测试完成 provision→challenge→inspect→claim→两类 acknowledgement→文件删除后 claim replay→recovery issue→acknowledgement→complete，并检查结果不存在 secret/token 字段；另覆盖 widened command 与 command-file-only binary。
4. dependency/source audit 登记 32 个 QL3 importer，CLI 只拥有两个允许的生产依赖，`findings=[]`；32 个 Profile importer 的 production advisory 均为零。
5. 六种 Profile 制品均未导入 CLI。最大 standalone-application 为 2,389,798 bytes、495 files、58 loaded modules、11,829,248 bytes RSS delta，继续低于 4 MiB/512 files/16 MiB 门禁。

## 未完成项

Owner ceremony 产品 CLI 已实现，但完整 fresh install 仍缺 database/pepper setup CLI、安装事务与备份恢复指引；Secret/Project/Role/Approval 管理 CLI、HTTP/UI 也未开放。production rollout 还需 Linux x64/arm64 root/rootless read-only 容器、volume ownership、固定物理路由器 RSS/闪存写放大，以及真实断电、ENOSPC、EROFS 证据。完成这些门禁前，`ql3-owner` 只能作为本机短生命周期 alpha 产品入口，不能代表 QingLong 3.0 已整体可发布。
