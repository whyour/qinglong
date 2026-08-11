# ADR-0083：版本化 Owner Pepper Keyring 与 Credential Recovery

- 状态：Modified（本机 catalog/keyring/active CAS/exact-key authentication/material recovery、ack-first credential rollover、credential recovery CLI 与版本化 pepper material GC 核心已实现；fresh setup/rotation 运维入口和实机门禁尚未完成）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-75、D-76、D-79、D-80、D-81、D-82
- 关联 ADR：ADR-0063、ADR-0075、ADR-0076、ADR-0077、ADR-0078、ADR-0079、ADR-0080、ADR-0081、ADR-0082

> ADR-0087 现行增量：原 `@qinglong/local-owner-bootstrap` 与 `@qinglong/local-owner-credential-recovery` 已物理合并为无聚合根入口的 `@qinglong/local-owner-ceremony/bootstrap` 与 `/credential-recovery`；本文中的旧包名保留为当时实现证据，现行依赖与权限门禁以新 subpath 为准。

## 上下文

当前本机 credential 只保存 `secret_digest`，Owner console 只读取一个 pepper 文件。直接覆盖或 rename 该文件会让全部既有 credential 同时失效；保留多个文件但让认证器逐个尝试，又会产生随历史增长的成本、扩大 timing 面，并掩盖 credential 与 digest key 没有绑定的事实。

在线 rotation 同时跨越文件 material、SQLite key lifecycle、credential issue、secret delivery acknowledgement 和旧 credential revoke。文件系统与 SQLite 不能组成一个原子事务，因此必须明确唯一 active authority 和每个崩溃窗口的恢复顺序。

## 决策

### 1. Credential version 精确绑定 digest key

每条 `QingLong3ApiCredentials` version 必须拥有非空 `pepper_key_id` provenance，并外键绑定受审 key catalog。该字段属于通用 `ApiCredentialRecord`，不是 console 私有提示。当前跨方言切片已把它加入共享 record：SQLite 为避免重建被多个外键引用的 credential 表，使用一对一 binding table，并在 capability v10 将 binding 外键绑定本机 catalog；PostgreSQL 使用原生非空 column。两者均把旧数据显式标记为保留 ID `legacy-v1`。

认证顺序固定为解析 bounded token → 读取 latest credential → 规范化 record → 按 `pepper_key_id` 精确读取一把 key → 比较 catalog material digest → HMAC/timing-safe compare → 检查 credential/subject/lifetime。未知、缺失、重复或 digest 不符一律低敏 unavailable；不得回退到 active key，也不得遍历历史 key。

### 2. 文件 keyring 只保存 material，不决定 active

deployment 私有根下使用专用 `0700` keyring 目录，最多 8 个规范 key ID 对应的 `0600`、no-replace material 文件。每个 key 与 ADR-0080 相同，使用 32-byte CSPRNG、同目录临时文件、fsync、hard-link no-replace 和目录 fsync 发布；inspect 只返回 key ID、domain-separated material digest 与长度。

keyring 不保存 `active` symlink、可覆盖 manifest 或 latest 文件。打开 authority 时可做一次最多 8 项的有界目录验证，认证热路径只按 record key ID 精确打开文件，不做目录扫描、watcher、timer 或常驻明文 cache。

### 3. SQLite 是唯一 active-key authority

reviewed migration 新增 versioned current key catalog 与 append-only activation fact，至少保存：

- `pepper_key_id`、material digest、状态 `recovery_required|staged|active|retired`；
- 单调 generation、provision/activate/retire mutation ID；
- created/activated/retired 时间和独立备份 proof digest。

同一时刻最多一把 active key，并由 SQLite partial unique index兜底。register 与 activate/旧 key retire 在共享 `LocalSqliteOperationAuthority` 的 `BEGIN IMMEDIATE` 中执行；activate 必须匹配 expected active key ID、expected generation、staged material digest 和备份 proof，提交后 append activation 且 generation 单调增加。任意 retire 入口仍不开放；GC 只能消费已经由 activation CAS 标记为 retired 的 key，应用、文件或调用方不得自行决定 active key。

### 4. Rotation 按可恢复顺序执行

轮换顺序固定为：

1. no-replace 发布新 material；
2. 写入独立故障域 backup，并验证不同 inode 与相同摘要；
3. 以 mutation 注册 staged key；
4. 以 expected-generation CAS 原子激活新 key并把旧 key标记 retired；
5. 此后的 credential issue 只能绑定新 active key；
6. 既有 credential 继续按自身 key ID 使用旧 key，直到显式 rollover/revoke。

在第 4 步前崩溃不会改变签发；第 4 步后崩溃由 SQLite active fact恢复，不能由文件时间或名称猜测。多余的 staged material 只能经受审 mutation 清理。

### 5. Credential recovery 先建后撤

Owner credential recovery 不修改旧 row。它以新 mutation 和当前 active key append 新 credential version/record，经 ADR-0079/0081/0082 的 staged delivery、digest acknowledgement 与 SQLite ledger 完成 possession proof；只有新交付已确认后，才能 append-only 写旧 credential revoked version 和低敏 security audit。

若新交付未确认、进程崩溃或 revoke CAS 失败，旧 credential 保持可用，新 mutation 可 exact replay；不得为了“单 active”先撤销旧 credential。策略可在完成后要求短 overlap deadline，但 deadline 到期仍必须由 durable supervisor/admin mutation 推进，不能由认证器临时猜测 revoked。

### 6. 旧 key 的保留与删除是独立裁决

retired 不等于可删除。删除 material 前必须证明：

- 没有 active/unexpired credential version 引用；
- 没有未确认 credential delivery 或 recovery mutation 引用；
- 对应 acknowledgement、security audit 和备份保留期已满足；
- 至少一把 active key 及其独立备份仍可验证；
- 版本化 GC mutation 已提交。

删除后必须分别 fsync runtime keyring 与独立 backup 目录并保存无 secret GC fact。启动不得扫描全部 credential 历史来推导可删性；repository 需要受审索引和 bounded reference query。

本机实现把删除固定为 `prepared → runtime unlink+fsync → backup unlink+fsync → completed`。公开 GC request 不接受调用方时间，短生命周期 authority 取得当前时间后，SQLite prepare 在 `BEGIN IMMEDIATE` 内重新检查 retired catalog 的 runtime/backup digest、当前及未来生效但未过期的 credential、未完成 recovery、active generation/material 与三类保留期；同一时刻最多一条 prepared 记录。最低保留期固定为 acknowledgement 7 天、security audit 30 天、backup 30 天，三者上限均为 10 年，策略以 domain-separated digest 进入精确重放事实。

只有短生命周期 `@qinglong/local-owner-maintenance/pepper-gc` 源文件可以导入 `@qinglong/local-owner-keyring/destructive` 和 `@qinglong/local-sqlite/pepper-gc`。它在 prepare 前验证 retired runtime/backup material，在每次删除前再次验证 active runtime/backup material；删除中途崩溃后，同一 mutation 以 absence proof 继续完成，既不会重建旧 material，也不会把“文件缺失”解释为未授权成功。maintenance 不提供聚合根入口，该 authority 不进入 edge/standalone application 常驻依赖闭包，也没有 `bin`、HTTP 或 timer。

### 7. 迁移不得静默猜测既有 pepper

已有无 `pepper_key_id` credential 迁移为保留 ID `legacy-v1`。当前 provenance 兼容阶段只允许显式配置为同一 key ID 的 singleton authority 解析它；缺失 binding、record/config key ID 不一致或非法 ID 均 fail closed。后续 catalog migration 必须先把它登记为 `recovery_required`，再由 operator 通过短生命周期本机 proof 绑定 legacy material digest、完成独立备份并激活。migration 不读取 pepper 文件、不自动生成 key，也不把当前路径中的任意文件当成 legacy material。

全新数据库没有隐式 key；必须显式 provision/register/backup/activate 后才能执行 Identity provisioning。

## 被否决的替代方案

1. **原地替换单 pepper 文件**：全部 credential 同时失效且无法分阶段恢复，拒绝。
2. **认证时依次尝试历史 key**：成本无界并扩大 timing 面，拒绝。
3. **文件 symlink/manifest 决定 active**：与 SQLite credential 形成双 authority，拒绝。
4. **rotation 时重新计算所有 digest**：服务端没有 credential plaintext，且会把 secret 恢复能力伪装成轮换，拒绝。
5. **先 revoke 旧 credential 再交付新 token**：任一交付故障都会永久锁死 Owner，拒绝。
6. **retire 立即删除 key**：仍有效的旧 credential 和备份会不可恢复，拒绝。
7. **migration 自动采用路径中现有文件**：路径权限不等于历史 digest provenance，拒绝。

## 分阶段实现与验收

1. contract/provenance（已完成）：`ApiCredentialRecord` key ID、SQLite 一对一 binding、PostgreSQL column/capability v10、旧数据 `legacy-v1` backfill，以及 singleton authenticator 的 exact-ID fail-closed fence。
2. catalog/GC migration（本机已完成）：SQLite capability v12、24 条 migration、23 张 owned table、binding FK、credential recovery ledger、material GC ledger、`legacy-v1` 的 `recovery_required` 状态；迁移不读取或采用 material。PostgreSQL 只保留 credential provenance，不复制本机文件 lifecycle。
3. keyring（已完成）：独立低层 `@qinglong/local-owner-keyring` 提供最多 8 key、no-replace provision/inspect/独立 inode backup/absence-only restore、exact-ID loader，无 active 文件指针、watcher、timer 或常驻 cache；console 只兼容重导出，不再拥有文件实现。
4. repository（已完成本机核心）：register 与 activate/旧 active retire 的 expected-generation CAS、跨连接单 winner、精确 replay和 append-only activation 已完成；capability v11 加入按 key ID 的 indexed/bounded reference summary，区分 current credential、in-flight recovery 与 historical audit reference。capability v12 的 prepare 会在同一写事务重新裁决引用、保留期、active generation 与双摘要，complete 只接受绑定 prepare 的销毁 proof；跨连接最多一个 open GC，prepare/complete 均可 exact replay。
5. bootstrap/authentication（已完成）：console 新签发绑定已验证的 active key；常驻 SQLite Runtime 暴露同一 close fence 上的 catalog，认证按 record exact key ID 只接受 active/retired key，并重算 material digest；无 key、staged、recovery-required 或摘要不符均 fail closed。
6. material recovery（已完成）：独立备份可 absence-only 恢复同一 key，随后必须显式执行 `recovery_required → staged → active`；真实 SQLite+POSIX keyring 测试证明恢复前不会隐式采用 material。
7. credential recovery（本机 CLI 已完成）：独立 `@qinglong/local-owner-credential-recovery` 总是签发不同 credential ID，复用有界 staged delivery；SQLite recovery ledger 将 issue、delivery acknowledgement 与 completion/revoke 分态持久化。旧 credential 在 issue、发布失败、重启和 acknowledgement 前始终保持 active；只有 exact delivery digest 已确认后，completion 才在同一 `BEGIN IMMEDIATE` 中 append revoked 旧 version、pepper binding 与低敏 audit。双连接只能产生一个 open recovery，mutation 重放不再生成 secret，console 重启可恢复 ready 文件；ADR-0086 的 `ql3-owner` 已开放 issue→acknowledge→complete ceremony。fresh setup、备份丢失和断电实机演练仍未完成。
8. material GC（本机核心已完成）：独立 runtime/backup 文件销毁、目录 fsync、role-bound absence proof、prepared/completed ledger、调用方时间注入拒绝、catalog 双摘要复核、未来生效 credential 阻断、保留期阻断、active 双材料复验与 runtime 删除后崩溃恢复均有测试；破坏性子入口只能由短生命周期 GC authority 导入。
9. 六种 Profile production tarball 继续满足 4 MiB/512 files/16 MiB RSS；edge 热路径不增加连接、timer、watcher、目录扫描或历史 key 尝试。

## 未完成项

共享 record、SQLite capability v13 catalog/binding FK/activation generation/recovery/GC/acknowledgement tombstone ledger、有界 POSIX keyring、active CAS、Runtime exact-key authentication、`legacy-v1` material recovery、ack-first credential rollover、bounded pepper reference inspection、双材料 crash-safe GC、Owner credential recovery CLI，以及 PostgreSQL capability v10 credential provenance 已实现。ADR-0084 已完成可恢复 acknowledgement retention/GC；尚未实现 fresh database/pepper setup CLI 与 Linux/物理路由器断电/真实 ENOSPC 故障证据。单 pepper 原地覆盖继续永久禁止；在线轮换和销毁只能走 catalog/keyring/recovery/GC 协议。
