# QingLong 2.x Data Directory 接管

本流程先为完整 QingLong 2.x `data` 目录生成一个只读、确定性、按 Profile 有界的 3.0 接管计划，再把审核过的资产 no-replace
暂存、转换并稳定校验。它不会删除或修改源文件，也不替代 [SQLite 接管流程](./ql3-local-sqlite-adoption.md)。

## 1. 前置条件

- 使用最终运行 QingLong 的同一个 POSIX 用户执行；
- `dataRoot` 必须是绝对、canonical、非根、非 symlink 的目录；
- `dataRoot` 必须由当前 UID 拥有，且 group/world 不可写；
- command file 继续遵守 `ql3-adoption` 的当前 UID、canonical、单链接、`0600` 私有文件要求；
- 生产盘点建议先停止 2.x writer。若文件或目录在盘点中变化，命令会失败关闭，不会给出部分成功计划。
- stage 前必须已经完成 SQLite inspect、stage、verify 与 activation，并保留五个绝对路径和 `activationDigest`；
- `deploymentRoot` 与 `stagingRoot` 的父目录必须是当前 UID 拥有的 canonical `0700` 目录；`stagingRoot` 必须尚不存在且位于
  `deploymentRoot` 内、`dataRoot` 外。
- transform 前创建私有 canonical `0700` transformation parent；`transformationRoot` 必须尚不存在，位于 `deploymentRoot` 内，且与
  `dataRoot`、`stagingRoot` 互不包含。

## 2. 执行 inspect

Edge/低配路由设备：

```json
{
  "schemaVersion": 1,
  "operation": "local-data-directory.adoption.inspect",
  "options": {
    "dataRoot": "/opt/qinglong/data",
    "profile": "edge"
  }
}
```

Standalone/NAS：

```json
{
  "schemaVersion": 1,
  "operation": "local-data-directory.adoption.inspect",
  "options": {
    "dataRoot": "/opt/qinglong/data",
    "profile": "standalone"
  }
}
```

```sh
chmod 0600 /secure/operator/ql3-data-directory-inspect.json
ql3-adoption run --command-file /secure/operator/ql3-data-directory-inspect.json
```

命令成功时返回 `status=inspected` 和 `qinglong3-legacy-data-directory-adoption-plan`。保存完整 JSON 和 `planDigest`，但不要把它
当作已经授权复制的 manifest。

## 3. 审核处置矩阵

| 类别 | 默认处置 | 说明 |
| --- | --- | --- |
| `config` | `transform` | 迁移到 3.0 配置模型，不原样覆盖 |
| `scripts` | `copy_reviewed` | 审核兼容性和安全后复制 |
| `db` | `transform` | 主 SQLite 走独立流程；审核 Keyv 和 sidecar |
| `upload` | `copy_reviewed` | 审核文件类型与容量后复制 |
| `ssh.d` | `transform` | 进入后续私有凭据交付，不进入普通归档 |
| `log`、`syslog`、`bak` | `retain_external` | 作为历史/恢复资产另行保留 |
| `repo`、`raw`、`dep_cache`、`deps` | `regenerate` | 在目标架构重新 checkout/安装 |

`recursive_content` 类别会稳定读取普通单链接文件并生成摘要；`root_only` 类别只检查类别根，不扫描内部内容。

## 4. 解释 assessment

- `reviewable`：没有未知顶层条目，也没有 unsafe 条目；仍需 operator 审核分类、数量、字节和数据库识别计数；
- `manual_review`：出现未知顶层条目或 unsafe 条目；不得继续自动 staging；
- `broadReadableEntries > 0`：存在 group/world 可读条目，是敏感性审核信号，但不等同于可被外部修改；
- `activeSqliteSidecars > 0`：发现 `database.sqlite-*` 或 `keyv.sqlite-*` 活跃 sidecar，先停止 writer 并完成 SQLite
  checkpoint/一致性处置后重新盘点；
- `primaryDatabaseFiles` 应按生产布局识别 `db/database.sqlite`；`legacyKeyValueDatabaseFiles` 识别 `db/keyv.sqlite`。

输出不会包含 `dataRoot` 原文、任意文件名或文件内容。未知名称只进入摘要。不要尝试从摘要反推或把摘要当作内容备份。

## 5. Profile 预算

| Profile | 最大条目 | 最大哈希字节 | 单文件上限 | 最大深度 |
| --- | ---: | ---: | ---: | ---: |
| Edge | 8,192 | 512 MiB | 64 MiB | 32 |
| Standalone | 65,536 | 4 GiB | 512 MiB | 64 |

超过任一限制都会以 `LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID` 失败。不要为了通过门禁临时改名、删除或排除资产；先保留
现场并决定它应拆分为外部恢复资产、在目标重新生成，还是进入后续人工迁移协议。

## 6. 执行私有 stage

审核 `assessment=reviewable`、`primaryDatabaseFiles=1`、所有 `activeSqliteSidecars=0` 后，提交完整 plan 与 SQLite activation 双围栏：

```json
{
  "schemaVersion": 1,
  "operation": "local-data-directory.adoption.stage",
  "options": {
    "deploymentRoot": "/opt/qinglong3/adoption",
    "dataRoot": "/opt/qinglong/data",
    "stagingRoot": "/opt/qinglong3/adoption/staging/reviewed-data",
    "profile": "edge",
    "expectedPlanDigest": "<64-hex-directory-plan-digest>",
    "sqlite": {
      "sourcePath": "/opt/qinglong/data/db/database.sqlite",
      "targetPath": "/opt/qinglong3/adoption/sqlite/qinglong3.sqlite",
      "recoveryPath": "/opt/qinglong3/adoption/sqlite/database.pre-ql3.sqlite",
      "manifestPath": "/opt/qinglong3/adoption/sqlite/adoption.json",
      "activationPath": "/opt/qinglong3/adoption/sqlite/activation.json",
      "expectedActivationDigest": "<64-hex-sqlite-activation-digest>"
    }
  }
}
```

成功结果为 `status=staged`。暂存区固定包含 `payload/copy-reviewed/{scripts,upload}`、
`payload/transform-input/{config,db,ssh.d}` 与私有 `manifest.json`；不存在的类别不会被制造。`db/database.sqlite` 及其 sidecar 不复制，
主库恢复继续以 SQLite adoption 的 recovery/target/activation 为权威。日志、备份和缓存也不会进入 payload。

所有目录归一化为 `0700`，所有文件归一化为 `0600`。复制使用 64 KiB 缓冲，并再次执行当前 Profile 的条目、字节、单文件和深度预算。

## 7. 执行稳定 verify

保存 stage 返回的 `manifestDigest`，使用同一组路径和 SQLite activation 执行：

```json
{
  "schemaVersion": 1,
  "operation": "local-data-directory.adoption.verify",
  "options": {
    "deploymentRoot": "/opt/qinglong3/adoption",
    "dataRoot": "/opt/qinglong/data",
    "stagingRoot": "/opt/qinglong3/adoption/staging/reviewed-data",
    "profile": "edge",
    "expectedManifestDigest": "<64-hex-directory-manifest-digest>",
    "sqlite": {
      "sourcePath": "/opt/qinglong/data/db/database.sqlite",
      "targetPath": "/opt/qinglong3/adoption/sqlite/qinglong3.sqlite",
      "recoveryPath": "/opt/qinglong3/adoption/sqlite/database.pre-ql3.sqlite",
      "manifestPath": "/opt/qinglong3/adoption/sqlite/adoption.json",
      "activationPath": "/opt/qinglong3/adoption/sqlite/activation.json",
      "expectedActivationDigest": "<64-hex-sqlite-activation-digest>"
    }
  }
}
```

verify 会重新验证目录计划、SQLite activation/source/target、清单 exact shape、私有权限和完整 payload 语义摘要。成功结果为
`status=verified`，且 evidence 应与 stage 的低敏 evidence 一致。

## 8. 准备版本化转换模型

只有 stage verify 成功且 operator 已保存 `manifestDigest` 后才执行 transform。`projectId` 是后续 Secret 与 binding 的目标 Project，不能
使用占位值或其他环境的 Project：

```json
{
  "schemaVersion": 1,
  "operation": "local-data-directory.adoption.transform",
  "options": {
    "deploymentRoot": "/opt/qinglong3/adoption",
    "dataRoot": "/opt/qinglong/data",
    "stagingRoot": "/opt/qinglong3/adoption/staging/reviewed-data",
    "transformationRoot": "/opt/qinglong3/adoption/transformations/reviewed-data-v1",
    "projectId": "<target-project-id>",
    "profile": "edge",
    "expectedManifestDigest": "<64-hex-directory-manifest-digest>",
    "sqlite": {
      "sourcePath": "/opt/qinglong/data/db/database.sqlite",
      "targetPath": "/opt/qinglong3/adoption/sqlite/qinglong3.sqlite",
      "recoveryPath": "/opt/qinglong3/adoption/sqlite/database.pre-ql3.sqlite",
      "manifestPath": "/opt/qinglong3/adoption/sqlite/adoption.json",
      "activationPath": "/opt/qinglong3/adoption/sqlite/activation.json",
      "expectedActivationDigest": "<64-hex-sqlite-activation-digest>"
    }
  }
}
```

成功返回 `status=prepared`、`transformationDigest` 和低敏计数/摘要。私有 `model/` 包含 Project ID、环境变量名、SSH alias 和待导入
Secret 明文，必须按高敏迁移材料保护，不能写入日志、提交 Git、上传 issue 或复制进普通备份。

转换规则固定如下：

- 不执行 `config.sh`；简单非空 export 生成 Secret input，非 export setting 退役，复杂/重复行要求人工复核；
- `keyv:authInfo` 淘汰且必须重新签发 credential；`apps/lang` 只与主 SQLite authority reconciliation；未知 Keyv 内容人工复核；
- SSH 私钥和 config 分离；历史 `ProxyCommand` 与 `StrictHostKeyChecking no` 不继承，所有 binding 保持 disabled，必须人工核验 host key；
- Edge 最多 128 个 Secret draft、256 个 Keyv row/4 MiB；Standalone 为 512 个 Secret、2,048 row/16 MiB；单 Secret 16 KiB。

`assessment=manual_required` 不表示数据丢失：原始内容仍在 D-385 staging 中。operator 应审核 `manual-review.json` 和对应原始 snapshot，
不得手改 manifest 或把 disabled binding 直接启用。

## 9. 校验转换模型

保存 transform 返回的 `transformationDigest`，在相同 options 上增加该字段并执行：

```json
{
  "schemaVersion": 1,
  "operation": "local-data-directory.adoption.transform.verify",
  "options": {
    "deploymentRoot": "/opt/qinglong3/adoption",
    "dataRoot": "/opt/qinglong/data",
    "stagingRoot": "/opt/qinglong3/adoption/staging/reviewed-data",
    "transformationRoot": "/opt/qinglong3/adoption/transformations/reviewed-data-v1",
    "projectId": "<target-project-id>",
    "profile": "edge",
    "expectedManifestDigest": "<64-hex-directory-manifest-digest>",
    "expectedTransformationDigest": "<64-hex-transformation-digest>",
    "sqlite": {
      "sourcePath": "/opt/qinglong/data/db/database.sqlite",
      "targetPath": "/opt/qinglong3/adoption/sqlite/qinglong3.sqlite",
      "recoveryPath": "/opt/qinglong3/adoption/sqlite/database.pre-ql3.sqlite",
      "manifestPath": "/opt/qinglong3/adoption/sqlite/adoption.json",
      "activationPath": "/opt/qinglong3/adoption/sqlite/activation.json",
      "expectedActivationDigest": "<64-hex-sqlite-activation-digest>"
    }
  }
}
```

成功返回 `status=verified`，evidence 应与 transform 完全相同。verify 会在目标校验前后重新验证 D-385 staging、当前 2.x source 和 SQLite
activation，并检查目标 exact 文件集、私有 mode、Project/profile/path binding、Secret value digest 和完整模型树摘要。

## 10. 受认证提交 prepared model

只有 transform 返回 `assessment=ready`、transform.verify 成功，且目标 Project 已存在 active Owner/Admin RoleBinding 时才能 apply。先准备：

- deployment root 内 `0700` 的 Owner pepper keyring；
- deployment root 内 `0600` 的 Owner credential presentation；
- deployment root 内 `0600` 的 Local Secret keyring；
- 两个不同的 UUID v4：`mutationId` 与失败审计 `failureAuditEventId`。

credential token 和 Secret key material 不写入 command JSON。提交命令是在 transform.verify options 上增加以下 authority：

```json
{
  "schemaVersion": 1,
  "operation": "local-data-directory.adoption.apply",
  "options": {
    "deploymentRoot": "/opt/qinglong3/adoption",
    "dataRoot": "/opt/qinglong/data",
    "stagingRoot": "/opt/qinglong3/adoption/staging/reviewed-data",
    "transformationRoot": "/opt/qinglong3/adoption/transformations/reviewed-data-v1",
    "projectId": "<target-project-id>",
    "profile": "edge",
    "expectedManifestDigest": "<64-hex-directory-manifest-digest>",
    "expectedTransformationDigest": "<64-hex-transformation-digest>",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/adoption/owner-keys",
    "credentialFilePath": "/opt/qinglong3/adoption/owner-credential.json",
    "secretKeyringPath": "/opt/qinglong3/adoption/local-secret-keyring.json",
    "mutationId": "<uuid-v4>",
    "failureAuditEventId": "<different-uuid-v4>",
    "requestId": "legacy-data-apply-20260821",
    "sqlite": {
      "sourcePath": "/opt/qinglong/data/db/database.sqlite",
      "targetPath": "/opt/qinglong3/adoption/sqlite/qinglong3.sqlite",
      "recoveryPath": "/opt/qinglong3/adoption/sqlite/database.pre-ql3.sqlite",
      "manifestPath": "/opt/qinglong3/adoption/sqlite/adoption.json",
      "activationPath": "/opt/qinglong3/adoption/sqlite/activation.json",
      "expectedActivationDigest": "<64-hex-sqlite-activation-digest>"
    }
  }
}
```

apply 会以 Owner credential 建立强认证，要求目标 Project 的 `secret.manage`，并在一个 SQLite `BEGIN IMMEDIATE` 中提交所有加密 Secret、
逐项 `secret.create` 审计、父 `legacy-data.apply` 审计、disabled model 和 canonical receipt。任何一个目标 Secret 已存在都会回滚整个批次。
成功返回 `status=committed`、`databaseStatus=inserted` 和低敏 digest/count evidence，不返回 Secret 名称、Project ID 或明文。

成功后 transformation root 只剩 `manifest.json` 与 `commit.json`；`model/` 和其中的明文文件已逻辑覆盖并删除。结果固定声明
`physicalErasureGuaranteed=false`：闪存 FTL、CoW、快照或备份可能保留旧块。需要介质级保证时应使用加密卷并销毁卷密钥或执行设备级擦除。

apply 只把模型持久化为 `activation=disabled`，不会启用 SSH、执行配置、启动任务或切换服务。

## 11. 校验 committed application

保存 apply 返回的 `receiptDigest`。将原命令 operation 改为 `local-data-directory.adoption.apply.verify`，并在 options 增加：

```json
{
  "expectedReceiptDigest": "<64-hex-receipt-digest>"
}
```

verify 使用相同强认证和 exact mutation，读取 durable receipt，验证 transformation manifest 与最终 `commit.json`，但不修复中间状态。成功返回
`status=verified`、`databaseStatus=existing`。receipt、commit、Project/profile/transformation 或 root 文件集有任何漂移都会失败关闭。

## 12. 崩溃残留与恢复

stage 和 transform 都在创建目标根后立即写入 `.incomplete`。只有 payload/model 和 `manifest.json` 都持久化且静态校验通过后才删除。
这些阶段失败或进程崩溃后：

- 不要直接把残留目录当作恢复资产；
- 不要在原路径重试，stage/transform 会 no-replace 拒绝；
- 先保存现场用于诊断，再由 operator 显式移走残留目录，并使用一个新的空路径重试；
- verify 遇到 `.incomplete`、额外文件或缺失文件一律失败关闭。

apply 的数据库 COMMIT 是逻辑提交点。COMMIT 后清理使用 `.commit-incomplete` 和 `.reclaiming-model`。若 apply 失败且 transformation root 出现
这些条目：

- 不要重新 transform，也不要手工删除 marker/model；
- 查询错误和目标数据库 readiness，保留完整诊断现场；
- 使用完全相同的 command、mutation ID 和 digest 重放 `local-data-directory.adoption.apply`；
- exact replay 从 durable receipt 继续回收 model 并重建同一 `commit.json`，不会再次创建 Secret；
- 未知文件、marker 漂移、双 model 或 receipt 不一致必须人工调查，不能用 apply.verify 或手改文件绕过。

## 13. 常见失败

- 根目录或条目 group/world 可写：修正 ownership/permission 后重新盘点；
- symlink、硬链接或特殊文件：保留现场，确认来源和目标后人工处置；盘点不会跟随或读取；
- 目录在盘点中变化：停止 2.x writer、同步器、下载器和仓库更新后重试；
- 单文件或总内容超过 Profile 预算：不要改用 `tar` 绕过；为该资产设计独立流式迁移/外部保留流程；
- 未知顶层条目：根据插件或用户资产来源登记明确处置，再进入后续 staging 设计。
- activation 不匹配：重新执行 SQLite verify/activation，不能只替换 digest；
- `stagingRoot` 已存在：检查是否为崩溃残留，禁止覆盖或合并；
- stage/verify 后源或目标 drift：停止所有 writer，回到 inspect，生成并重新审核新的 plan。
- `transformationRoot` 已存在或有 `.incomplete`：保留诊断现场，显式移走后选择新的空路径，禁止覆盖或续写；
- Keyv schema、row 或字节超限：不要把数据库当 JSON dump 绕过，先确认版本和未知数据归属；
- `manual_required`：从 D-385 staging 审核相应原始输入；不要执行旧 shell、复用 `authInfo` 或启用旧 SSH config；
- transform verify drift：停止后续 apply，保留 D-385 staging 和 transformation root，重新建立新的版本化转换路径。
- credential rejected：核对 credential presentation、pepper keyring、有效期和目标数据库绑定，不要把 token 填进 command JSON；
- `APPLICATION_FORBIDDEN`：当前主体不是目标 Project 的 active owner/admin；通过正式 Policy 管理流程修复 RoleBinding 后使用新失败审计 ID重试；
- `ADOPTION_CONFLICT`：目标 Secret、mutation 或 transformation 已存在不一致事实；批次已回滚，禁止删除现有 Secret 强行导入；
- apply 在数据库 COMMIT 后清理失败：重放完全相同的 apply；不要生成新 mutation，否则会与 transformation 唯一约束冲突；
- apply.verify 报终态不完整：它不会恢复；改为重放原 apply。

## 14. 当前边界

本流程已经提供 inspect、私有 stage、版本化 transform、受认证原子 apply、崩溃恢复和三级稳定 verify。它仍不：

- 删除或修改任何源资产；
- 激活已提交的 settings/SSH binding、启动任务或切换服务；
- 把历史日志/备份复制到默认目标，或复用跨架构 repo/dependency cache；
- 授权 service-manager/Compose cutover 或 Legacy rollback；
- 证明固定物理路由器/NAS 上的耗时、RSS、I/O、磁盘峰值和断电恢复。

apply 成功只证明目标数据库中的 encrypted Secret、disabled model、audit 和 receipt 原子一致，并且 prepared 明文文件已逻辑回收；它仍不是
cutover 或 activation 授权。继续保留原始 2.x data directory、SQLite recovery、D-385 staging、manifest 和 `commit.json`，直到独立部署
lineage 与回滚门完成。
