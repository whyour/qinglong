# ADR-0078：POSIX 本机 Owner Console 证明与 Secret 交付门禁

- 状态：Proposed（POSIX proof、staged Secret 恢复、摘要绑定确认与 Owner ceremony CLI 已实现；fresh setup 和实机故障门禁待完成）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-27、D-74、D-76、D-77、D-78
- 关联 ADR：ADR-0063、ADR-0075、ADR-0076、ADR-0077、ADR-0079

> ADR-0087 现行增量：原 `@qinglong/local-owner-bootstrap` 与 `@qinglong/local-owner-credential-recovery` 已物理合并为无聚合根入口的 `@qinglong/local-owner-ceremony/bootstrap` 与 `/credential-recovery`；本文中的旧包名保留为当时实现证据，现行依赖与权限门禁以新 subpath 为准。

## 上下文

ADR-0077 已提供默认不可达的 Identity provisioning、challenge 与原子首 Owner claim，但 `provision/issue` 请求仍携带结构化 `issuer`。包边界能够阻止默认 application 导入 authority，却不能把一段调用方构造的 JSON 变成可信 `local_console` 事实。

直接增加 CLI 还有另一个崩溃窗口：数据库事务可能已经提交，而 credential/challenge plaintext 尚未写入用户指定文件。此时 exact replay 按设计只能返回 `null`，如果没有先暂存、提交后发布和重启恢复协议，fresh install 会得到无法取回的凭据。3.0 不以“多数时候能写成功”替代可恢复交付。

## 决策

### 1. Authority 在组合根绑定，不进入请求 DTO

`ProvisionLocalIdentityRequest` 与 `IssueLocalOwnerBootstrapRequest` 不再包含 `issuer`。`createLocalOwnerBootstrapService` 在构造时绑定短时 `local_console` authority，并在每次操作时重新验证其时间和 subject/assurance；公开请求若添加 issuer、User、principal 或 credential identity 会被 exact-shape 校验拒绝。

这不是把 TypeScript 对象当成不可伪造 capability。真正的生产入口只能是受依赖审计保护的 `@qinglong/local-owner-console` 组合根；默认 runtime/application 和其他 package 不能导入 bootstrap authority。

### 2. POSIX 证明绑定部署根、数据库、pepper 与进程用户

短生命周期 console 要求 real/effective UID 存在且相同；显式 `deploymentRoot` 必须是当前 UID 拥有的真实 `0700` 目录，数据库和 pepper 必须是该根下经逐段验证、无 symlink 的真实 `0600` 普通文件。路径必须是规范化、有界绝对路径，两个 authority 文件不能同路径或共享 inode。

该证明表达“当前进程已取得这个私有部署目录的 OS 文件权限”，不把 `localhost`、TTY、环境变量或 HTTP body 当成身份。容器中能否执行该短命令、volume ownership 与宿主管理权限是否等价，仍由部署模板和实机证据负责；库本身不伪造宿主 attestation。

### 3. 打开前后和每次操作都复核路径身份

组合根先捕获 root/intermediate/database/pepper 的 `(device,inode,uid,mode,type)`，再打开唯一 SQLite bootstrap connection，打开后立即复核一次；每次 provisioning/issue/claim 前再次复核。路径替换、权限放宽、UID 变化或 symlink 都在触发数据库 authority 前 fail closed。

console 不增加 listener、timer、watcher、scanner、cache、sidecar 或第二 SQLite connection，关闭继续复用同一 operation authority 的幂等 close fence。

### 4. Pepper 只从私有普通文件读取

pepper 不接受 argv、环境变量、stdin 或 JSON。组合根以 `O_RDONLY|O_NOFOLLOW` 打开已证明的 `0600` 文件，比较 fd 与路径的 device/inode，施加 32–256 bytes 上限，只接受无空白的 base64url 内容，并在转成短生命周期字符串后清零读取 Buffer。

本 ADR 不负责 pepper 创建、轮换、备份或恢复；这些动作需要 no-replace 文件发布、版本化引用与恢复策略，不能由 migration/application 启动时自动生成。

### 5. Secret 可恢复交付已实现，但 CLI 继续受剩余门禁

`@qinglong/local-owner-console` 已按 ADR-0079 实现有界、私有、no-replace 的 staged secret record：数据库提交前耐久暂存，提交并核对数据库事实后原子发布；重启以 mutation/database 事实恢复。启用 delivery 后 provision/issue 响应始终返回 `token: null`，明文只存在于私有 ready record，不进入 stdout、日志或错误。

该包仍不声明 `bin`；ADR-0086 由独立 `@qinglong/local-owner-cli` 组合它，并以 command-file-only 的 `ql3-owner` 开放 provisioning/claim/delivery acknowledgement/credential recovery。ADR-0080/0081/0082/0083/0084 已补齐 pepper no-replace provision/backup/restore、ready record 摘要绑定确认、SQLite acknowledgement ledger、pepper/credential rotation 与可恢复 tombstone retention/GC；fresh setup、rotation 管理命令、断电/真实 ENOSPC/只读文件系统和 Linux/容器权限证据仍未完成。HTTP/UI 继续禁止，因为它们还需要独立的 origin/CSRF/rate-limit/transport 与恢复设计。

## 被否决的替代方案

1. **请求继续携带 issuer**：让 transport 字段冒充平台 authority，拒绝。
2. **只检查 `stdin.isTTY` 或 loopback**：两者都不证明部署文件权限或调用者身份，拒绝。
3. **pepper 通过 argv/env/stdin**：会进入进程列表、诊断或继承边界，拒绝。
4. **事务成功后直接写 secret 文件**：崩溃或 ENOSPC 会永久丢失一次性 secret，拒绝。
5. **为 console 另开常驻服务或 watcher**：扩大攻击面并破坏路由设备零常驻成本，拒绝。
6. **把本机 POSIX proof 复用于 cluster-control**：集群仍使用独立 PostgreSQL/cluster-admin/Worker 身份与传输边界，拒绝。

## 验收证据

1. `@qinglong/local-owner-bootstrap` 8 项真实 SQLite 测试在 issuer 构造期绑定和跨进程时间漂移后继续通过；请求注入 issuer/identity 被拒绝，稳定 authentication identity 不变时 exact replay 成功，不同 identity 冲突。
2. `@qinglong/local-owner-console` 19 项测试通过：私有 POSIX proof、完整 provision/issue/transport-free claim、预提交 pending 保留、数据库提交后 credential/challenge 自动恢复、文件删除后数据库事实重放、权限/摘要篡改与 64 条目录预算 fail closed、数据库 inode 替换、幂等关闭与无 `bin`/默认 runtime 导出。
3. dependency audit 登记 32 个 QL3 package importer；只有 local-owner-console 可以直接导入 local-owner-bootstrap，产品 CLI 只能导入 console facade，默认根继续禁止全部 QL3 authority 包。
4. 32 个 QL3 production importer 的 low/moderate/high/critical advisory 均为零；legacy 根 3 low/9 moderate/2 high 独立可见。

## 未完成项

credential `pepper_key_id` provenance、受审 keyring/active CAS、credential rotate/revoke/recovery、versioned acknowledgement tombstone retention/GC 与 Owner ceremony CLI 已由 ADR-0083/0084/0086 完成；仍需 Linux rootless/root 容器与 volume ownership 证据、真实断电/ENOSPC/只读文件系统故障注入、固定低配路由设备 RSS/闪存写放大门禁，以及 fresh setup/rotation 运维入口。ready record 显式确认、安全删除与 SQLite 账本已由 ADR-0081/0082 完成。
