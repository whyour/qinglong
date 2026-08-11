# ADR-0100：私有流式 Legacy adoption review-file 与产品签发 CLI

- 状态：Accepted（review-file、正式 Identity/POSIX 认证装配、`ql3-adoption decision.issue` 与逻辑/制品门禁已实现；commit 已由 ADR-0101 完成，物理写放大证据待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-04、D-08、D-16、D-17、D-23、D-61、D-62、D-78、D-84、D-85、D-86、D-95、D-96、D-97、D-98、D-99
- 关联 ADR：ADR-0085、ADR-0086、ADR-0087、ADR-0095、ADR-0096、ADR-0097、ADR-0098、ADR-0099

## 背景

ADR-0099 已关闭专用 HMAC keyring 和可信 issuer capability，但仍只接受调用者提供的 `Iterable`。产品若把最多 100,000 个决定先解析为数组，会使内存随迁移规模增长；若把 reviewer Principal 写进 command JSON，则 assurance 可以自报；若每遍按路径重开 review 文件，攻击者可在 receipt、HMAC 或公开 publication 之间替换输入。

本机部署已有稳定 Identity credential、SQLite pepper provenance catalog 和最多 8 key 的 POSIX pepper keyring。它们必须复用，但 Owner credential pepper 不能兼作 adoption HMAC key。该能力只服务本机短生命周期管理面，不满足新增 workspace package 的 D-85 门槛。

## 决策

### 1. review-file 是有界、私有、同 descriptor 的 NDJSON

`@qinglong/local-admin/decision-issuer` 新增 `withPrivateLegacyCrontabAdoptionDecisionReviewFile()`。格式固定为一个 exact header 和零至 100,000 个 exact decision row：header 绑定 `decisionId/profile/planDigest/inventoryDigest`；row 只含既有 decision contract。每行最多 64 KiB、全文件最多 32 MiB，读取 chunk 固定 64 KiB，不缓存 decision 数组。

父目录和文件必须是当前 real/effective UID 的精确 `0700/0600` real path。入口执行 `lstat→O_NOFOLLOW open→fstat`，首次顺序扫描完成格式校验、计数和 SHA-256；后续 iterable 始终使用同一 descriptor 和显式 offset，可重复多遍。最终 authorization hard-link 前再次验证 descriptor/path/parent identity 和全文件 digest；consumer 返回后再复核一次，替换、原地修改、宽权限和 symlink 均失败关闭。

### 2. 复用现有 Local Owner CLI importer

产品入口位于 `@qinglong/local-owner-cli/adoption`，binary 为 `ql3-adoption`。没有新增第 28 个 package、timer、watcher、sidecar 或第三方依赖。原 `ql3-owner` command 与输出保持不变。

`ql3-adoption run --command-file <absolute path>` 的普通私有 command file 只包含路径、profile、plan/decision identity 和有界 lifetime。credential token 不允许成为 command 字段，也不进入 argv、stdout 或 stderr；它只存在独立、同 UID `0600` credential-presentation file，读取时使用 `O_NOFOLLOW`、既有 inode 和 1 KiB 上限，buffer 在解析后擦除。

dependency audit 只允许 `src/adoption.ts` 导入 `local-admin` 根与 `/decision-issuer`、`local-identity`、`local-owner-keyring` 和 `local-sqlite/bootstrap` 五个精确入口；其他 CLI source、runtime Profile 和 application composition 仍被拒绝。

### 3. 正式 Identity credential 与 POSIX proof 合成 strong User

CLI 先冻结 deployment root、数据库、legacy source、review、credential、issuer keyring、Owner pepper keyring 和 authorization parent 的当前 UID、inode、类型及 `0700/0600` 边界，并要求 authority files 不共享 inode、authorization target 尚不存在。

随后以 `openLocalSqliteBootstrapDatabase()` 取得正式 credential/pepper repositories，通过 `createLocalIdentityKeyringAuthenticator()` 精确验证 credential version、User 状态、record 指定的 pepper key、catalog active/retired 状态和 material digest。单因素 credential 的 User subject 被保留；credential authentication ID 与 POSIX proof digest 经 domain-separated SHA-256 合成新的 authentication ID，assurance 固定为 `local_console`，expiry 取两种证明的较早值且最长 60 秒。

每次 issuer authority confirmation 都重验 POSIX identity；认证后还重读 credential version/state、pepper binding、catalog state/digest 与 keyring material digest。issuer 调整为先完成认证、再读取可信 clock 生成 `issuedAtMs`，防止真实 authenticator 在后几毫秒生成的 `authenticatedAtMs` 被错误判为未来。弱/无效 credential 仍在 adoption HMAC key access 和 authorization publication 前失败。

### 4. 当前产品范围

本切片只开放 `legacy-crontab.decision.issue`：它把已经人工生成的 review-file 签成 ADR-0097 carrier，不自动生成 approve、不修改 legacy/target 数据库，也不绕过 ADR-0098 Policy/fence/audit/transaction。后续 ADR-0101 已在同一 binary 中接入 mutation/project/request IDs、当前 reviewer 重新认证与原子 commit；该能力不回溯改变本 ADR 的签发边界。

## 被否决的替代方案

1. **新增 `ql3-adoption-cli` package**：单部署、单 consumer、无独立供应链责任，不满足 D-85。
2. **把 decisions 放进 command JSON**：会产生全数组内存和持久 intent 复制，拒绝。
3. **每次迭代重新按路径打开 review-file**：无法证明 receipt、HMAC 和 publication 消费同一 inode，拒绝。
4. **把 token 放进 argv、环境变量或普通 command JSON**：扩大 shell history、进程检查和持久日志暴露面，拒绝。
5. **只用 API credential 的 single-factor assurance**：不满足高风险人工 adoption 的强认证要求，拒绝。
6. **把 Owner pepper 复用为 carrier HMAC key**：合并认证与授权载体的泄露/轮换域，拒绝。
7. **为了最终复核在四次 authority check 中都重散列 32 MiB review**：造成不必要 I/O；issuer identity 复核与仅在 publication 前执行的 decision-stream digest 复核保持独立。

## 验收证据

1. local-admin 35 项测试通过；新增测试覆盖同 descriptor 重复迭代、digest confirmation、宽权限、symlink、处理中 replacement、widened record 和 header identity mismatch。
2. local-owner-cli 5 项测试通过；端到端使用真实 SQLite Identity、pepper catalog/POSIX keyring 和 adoption issuer keyring签发并重新验证 carrier，同时覆盖 token 不进入 command/output、widened intent、无效 credential 和原 `ql3-owner` 回归。
3. dependency boundary 23 项、backend 665 项及完整 dependency audit 通过：27 importer、local-admin 9 source files、local-owner-cli 4 source files、无 finding。
4. 六种 Profile 制品门禁通过。base edge/standalone 为 1,489,761/1,489,887 bytes、216 files、34 modules；adopted 为 1,722,866/1,723,037 bytes、240 files、37 modules；application 为 2,010,793/2,010,901 bytes、301 files、64 modules。最大 RSS delta 抽样为 11,829,248 bytes，均低于既有预算。

## 后续约束

ADR-0101 已为同一 `ql3-adoption` binary 增加显式 commit command，并复用 ADR-0098 publisher。下一切片应补 32 MiB/100,000-row review、carrier 和原子 publication 的物理 Edge 峰值 RSS、读取量、fsync/写放大证据。Scheduler/Run admission 仍是独立 Gate；cluster 管理面必须使用远程强身份和独立 KMS/HSM adapter，不得复用本机 credential file、Owner pepper 或 issuer file keyring。
