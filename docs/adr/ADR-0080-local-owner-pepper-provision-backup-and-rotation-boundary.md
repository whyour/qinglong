# ADR-0080：本机 Owner Pepper Provision、备份与轮换边界

- 状态：Modified（provision/inspect/backup/restore、在线 credential rotation 与 retired 双材料 GC 安全核心已实现，最终 CLI 尚未实现）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-75、D-76、D-77、D-79
- 关联 ADR：ADR-0076、ADR-0077、ADR-0078、ADR-0079

## 上下文

Local Identity API credential 只在 SQLite 保存 peppered digest。Owner console 已拒绝从 argv、env、stdin 或请求读取 pepper，但 fresh deployment 仍需要显式生成、检查、备份和恢复 pepper 的受审入口。

credential record 现已具备跨方言 `pepper_key_id` provenance，SQLite capability v12 与 PostgreSQL capability v10 会把旧数据绑定到保留 ID `legacy-v1`。本机 catalog、active generation CAS、有界 keyring、Runtime exact-key authentication、同 key material recovery、新 credential acknowledgement 后 revoke 旧 version，以及 retired key 的 reference/retention/双材料 GC 核心均已完成。直接替换单 pepper 文件仍不是“轮换密钥”，3.0 继续区分文件生命周期、material recovery、credential rollover 与销毁裁决。

## 决策

### 1. Provision 显式、私有且不可覆盖

`provisionLocalOwnerPepper` 只接受规范化有界绝对 `deploymentRoot` 和其后代 `pepperPath`。root 与所有既有中间目录必须是当前 real/effective POSIX UID 私有拥有的真实 `0700` 目录。

函数从 CSPRNG 取得 32 bytes，转换为无换行 canonical base64url。材料先写入目标同目录的随机 `0600` 临时文件并 fsync，再以 hard link no-replace 发布目标、fsync 目录并重新读取验证。目标已存在时返回稳定 conflict，绝不覆盖或自动采用新 entropy。migration、application 和 console open 都不得自动调用 provision。

### 2. Inspect 只暴露低敏摘要

inspect 以 `O_RDONLY|O_NOFOLLOW` 打开当前 UID 拥有的 `0600` 普通文件，比较 path/fd device+inode、限制 32–256 bytes，并执行 canonical pepper validator。返回值只有：

- manifest version；
- domain-separated SHA-256 digest；
- serialized byte length。

它不返回 pepper、路径内容或可认证 credential 的 token。读取 Buffer 在使用后尽力清零。

### 3. Backup 必须离开 deployment 故障域

backup API 要求独立 `backupRoot`，该 root 和其中间目录同样必须是当前 UID 私有拥有、无 symlink 的真实 `0700` 目录。备份通过重新写入私有临时文件和 no-replace hard link 发布，因此与源文件内容一致但 inode 独立；已有 backup 永不覆盖。

`backupRoot` 可以是另一挂载点或离线介质的受控目录。把副本放在 deploymentRoot 内不能作为灾难恢复证据。

### 4. Restore 只恢复到缺失目标

restore 从独立 backup root 重新验证并读取材料，只在 pepper target 不存在时 no-replace 发布。已有目标一律 conflict；运维人员必须先通过 inspect/digest 和外部恢复流程裁决，库不会猜测哪个 pepper 更可信。

restore 成功后仍不自动启动 application、打开数据库或验证 credential。产品 CLI 需要把 restore 与显式 readiness/authentication 验证组成更高层 ceremony。

### 5. 永久禁止绕过协议的在线文件替换

存在 credential 后不得用 rename、copy 或重新 provision 替换 active pepper。安全 rotation 至少需要：

1. credential schema 保存 `pepper_key_id` 或等价版本 fence（已完成）；
2. 有界 pepper keyring，旧 key 在仍被 credential/备份引用时保留；
3. 新 credential issue/旧 credential revoke 或 recovery ceremony；
4. active key expected-version CAS 和崩溃恢复；
5. 认证器按 record key ID 精确选择 pepper，不做无界全 key 尝试；
6. migration、备份、回滚和审计证据。

这些条件已由 ADR-0083 的 catalog/recovery/GC 协议实现为短生命周期安全核心，但 API 仍有意不提供可绕过协议的 `rotateLocalOwnerPepper` 或原地文件替换；最终运维 CLI 必须组合受审 ceremony，而不是暴露单步覆盖。

## 被否决的替代方案

1. **首次 application 启动自动生成**：备份恢复时会静默创建新身份根，拒绝。
2. **默认 pepper 或从环境变量读取**：易泄漏且跨部署复用，拒绝。
3. **覆盖已有 pepper**：会使现有 credential 全部失效，拒绝。
4. **备份到 deploymentRoot 邻近文件**：与数据库和主 pepper 共享故障域，不足以证明恢复能力，拒绝。
5. **hard link 直接作为备份**：源/备份共享 inode，修改或损坏不是独立的，拒绝。
6. **认证时尝试所有历史 pepper**：成本随 key 数增长、隐藏 record/version 缺失并扩大 timing 面，拒绝。

## 验收证据

1. `@qinglong/local-owner-console` 21 项测试通过，其中 5 项覆盖 pepper no-replace provision、摘要 inspect、独立 inode backup、absence-only restore、已有备份保护、权限/symlink、熵源和 exact-shape 拒绝。
2. provision 使用固定 32-byte entropy，目标为 `0600` canonical base64url，调用方可变 entropy Buffer 在返回前清零。
3. backup root 与 deployment root 独立；backup/restore 均不覆盖已有目标。
4. package 继续无 `bin`、timer、watcher、listener、第二 SQLite connection，默认 application 不导入该 authority。

## 未完成项

credential provenance、受审本机 pepper catalog/keyring、原子 active-key fence、Runtime exact-key authentication、同 key material recovery、credential rollover/ack 后 revoke、reference inspection、跨备份保留策略、双材料 GC 与 versioned acknowledgement tombstone retention/GC 核心已完成；最终 CLI、真实 ENOSPC/只读/断电、Linux 容器与物理路由器证据仍未完成。ready secret 的摘要绑定确认与 SQLite 账本由 ADR-0081/0082 继续约束。
