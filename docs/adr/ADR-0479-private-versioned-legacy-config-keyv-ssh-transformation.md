# ADR-0479：私有、版本化的 Legacy Config、Keyv 与 SSH 转换

- 状态：Accepted
- 日期：2026-08-21
- 关联：QL-RFC-0001、ADR-0207、ADR-0395、ADR-0476、ADR-0477、ADR-0478

## 上下文

ADR-0478 已把 QingLong 2.x `config`、`db` 与 `ssh.d` 固定为私有、稳定、可重复校验的 `transform-input`，但暂存副本还不能直接成为
3.0 配置。三类输入具有不同风险：

- `config/config.sh` 是可执行 shell，不是声明式配置；直接 `source` 会把命令替换、文件读取和进程启动引入迁移 authority；
- Keyv v4 的 `keyv(key,value)` 同时缓存 `authInfo`、`apps` 和 `lang`；其中认证材料必须作废，`apps/lang` 又与主数据库事实重复；
- `ssh.d` 同时保存私钥和可执行 SSH client policy，历史配置可能含 `ProxyCommand` 与 `StrictHostKeyChecking no`。

QingLong 3.0 同时面向低配路由设备和集群节点。转换必须是短生命周期、有硬预算、无网络、无常驻缓存的本地 ceremony；同时产物要绑定
Project，以便后续由 Local Owner 或 Cluster separation-of-duty 流程认证提交，而不是让迁移工具直接获得目标数据库写 authority。

## 决策

### 1. 扩展既有领域而不增加 workspace package

在 `@qinglong/local-owner-cli` 的 `lifecycle/data-directory-adoption/transformation/` 增加两个 exact operation：

- `local-data-directory.adoption.transform`；
- `local-data-directory.adoption.transform.verify`。

实现按 `config`、`keyv`、`ssh`、私有文件系统、目标模型、manifest 与 orchestration 分层，但仍属于同一个一次性 Local Owner capability。
不新增 workspace package、第三方依赖、binary、daemon、listener、watcher、timer、网络请求或目标数据库连接。

### 2. 只转换已验证的 D-385 snapshot

命令提交完整 D-385 binding：`deploymentRoot`、`dataRoot`、`stagingRoot`、`profile`、SQLite binding 与
`expectedManifestDigest`，并增加 `transformationRoot` 和 `projectId`。transform 在写目标前验证一次 D-385 stage，转换后再次验证并要求
低敏 evidence 逐字段相同；transform.verify 在目标校验前后执行同样的源验证。转换只读取
`stagingRoot/payload/transform-input`，不从当前 2.x `dataRoot` 直接解析秘密。

`transformationRoot` 必须是私有 `deploymentRoot` 内、`dataRoot` 与 `stagingRoot` 外的不存在路径；其父目录为当前 UID 拥有的 canonical
`0700` 目录。所有目标目录为 `0700`、文件为 `0600`，写入均 no-replace。

### 3. `config.sh` 永不执行

转换器不调用 shell，也不展开变量、命令替换、转义或重定向。它只识别单行的简单 assignment：可选 `export`、受限 identifier，以及
简单单引号、无插值双引号或安全 unquoted literal。

- 非空 exported assignment 生成 Project-scoped Secret import draft 和独立 `qinglong3-local-secret-value` 私有文件；
- 空 export 只计数并省略；
- 非 export assignment 作为已退役 legacy setting，只记录名称和值摘要；
- 重复 assignment、无法声明式解析的行和其他 config 资产都使 assessment 变为 `manual_required`，不会被执行或激活。

单个 `config.sh` 上限 256 KiB，单个 Secret 明文上限 16 KiB。

### 4. Keyv 只读、防御式读取并消除旧认证 authority

只接受 reviewed Keyv v4 shape：`keyv(key VARCHAR(255) PRIMARY KEY, value TEXT)`。SQLite 以 read-only、defensive、
`trusted_schema=OFF`、`query_only=ON`、`mmap_size=0` 打开，执行有界 `integrity_check(1)`；打开前后文件身份必须稳定。

- `keyv:authInfo` 映射为 `credential_reissue/retired`，只保留值摘要，不复制认证材料；
- `keyv:apps` 映射为 `main_database_apps_reconciliation`；
- `keyv:lang` 只接受 Keyv envelope 中的 `zh|en`，映射为主数据库 system setting reconciliation；
- 未知 row、未知 schema object、非法 locale 或其他数据库资产只计数/摘要并转人工复核。

Edge 最多读取 256 rows/4 MiB，Standalone 最多 2,048 rows/16 MiB；单 row 最高 1 MiB。Keyv 模型始终
`activation=disabled`，不会写目标数据库。

### 5. SSH 私钥与历史 client policy 分离

只将同目录 `<alias>` 私钥与 `<alias>.config` 的严格配对转成 Secret draft 和 disabled binding。私钥限制 16 KiB，config 限制 64 KiB；
config 必须恰有一个 `Host` 和一个 basename 与 alias 相同的 `IdentityFile`。

目标只保存 host pattern、配置摘要和风险布尔值。历史 `ProxyCommand` 文本和 `StrictHostKeyChecking no` 不会继承；所有 binding 固定
`hostKeyPolicy=operator_verification_required`、`activation=disabled`。无法配对、无法解析或嵌套的条目只进入人工复核证据。

### 6. 目标模型、内容无关 manifest 与恢复状态分离

成功产物固定为：

```text
transformationRoot/
  manifest.json
  model/
    config.json
    keyv.json
    ssh.json
    secret-imports.json
    manual-review.json
    secret-values/*.json
```

`model/` 是私有准备材料，会包含 Project ID、环境变量名、SSH alias 和待认证导入的明文 Secret；它不是日志、普通备份或可发布制品。
根 `manifest.json` 只包含 Profile、时间、Project/path 摘要、D-385 manifest digest、assessment、三类源的计数/摘要和目标模型树摘要，
不包含 Project ID、用户名称、文件名或秘密内容。transform.verify 要求根与模型 exact shape、所有模式/摘要/Secret value digest 和
`expectedTransformationDigest` 精确匹配。

transform 创建根后先持久化 `.incomplete`，只有 model、manifest 和最终静态校验完成后才删除。失败不会自动删除或覆盖残留；D-385
staging 继续是转换输入和恢复权威。成功状态仅为 `prepared`，不授权把 Secret、settings 或 SSH binding 写入/激活到 3.0。

### 7. Profile 资源边界

转换器不扫描 D-385 未纳入的资产，不启动 worker，不联网。Secret draft 总数在 Edge 最多 128、Standalone 最多 512；各输入还有独立
文件、row 和字节上限。超限失败时保留 `.incomplete`，operator 应保留现场、选择新的空路径重试，不能放宽成无界导入。

## 被拒绝的替代方案

### 执行或 source `config.sh`

拒绝。迁移输入不是可信程序，执行会把本机命令、文件和网络 authority 隐式授予旧配置。

### 原样复制 Keyv 或复用 `authInfo`

拒绝。Keyv 是重复 cache，不是 3.0 认证事实源；携带旧 token 会绕过 credential reissue，并可能覆盖主 SQLite 中更新的 App/System 事实。

### 原样启用 SSH config

拒绝。`ProxyCommand` 是进程执行面，host-key bypass 会把历史不安全策略升级为 3.0 默认策略。私钥、host identity 与 client policy 必须分离。

### 转换时直接提交目标数据库

拒绝。解析 legacy 输入和认证目标 mutation 是两个 authority 阶段。先发布可验证 prepared model，后续再由受认证、可审计、可重放的 apply
流程提交，才能保留失败恢复点和 Cluster separation-of-duty。

### 为每类转换再拆 workspace package

拒绝。三类转换共享同一个 D-385 source fence、manifest、恢复状态和部署生命周期。按领域子目录内聚能解决 `src` 平铺问题，同时避免
只有一两个文件、没有独立部署或依赖生命周期的 package。

## 影响

### 正面

- shell 配置、Keyv cache 和 SSH client policy 首次获得显式、版本化的 3.0 处置语义；
- 旧认证材料不会进入目标 Secret，危险 SSH policy 不会被继承；
- 私有 target model 可稳定验证，根 manifest 和 stdout 保持低敏；
- Edge 与 Standalone 使用同一协议、不同硬预算；Cluster 后续可复用 prepared model，但不能绕过审批；
- D-385 staging、失败 `.incomplete` 和成功 prepared model 各自具有清晰恢复角色。

### 代价与限制

- 简单 parser 会把复杂但可能无害的 shell 行转人工复核，这是有意的失败关闭；
- prepared model 含明文 Secret，operator 必须把整个 transformation root 当作高敏私有材料；
- 本阶段不迁移 `scripts/upload`，不提交目标数据库，不激活 SSH，不删除 legacy data；
- 尚未完成固定物理 Edge 的 RSS/I/O/ENOSPC/断电证明，也未接入 systemd/OpenRC/Compose cutover lineage。

## 验证

- D-386 data directory 聚焦套件 `10/10`，覆盖真实 ADR-0476 SQLite 链、D-385 stage、三类转换、exact verify/replay；
- 覆盖 stdout/manifest 脱敏、旧认证淘汰、SSH policy 禁用、目标与源 drift、未知内容 manual review、Edge Secret 预算、no-replace
  crash residue 与扩权 command；
- Local Owner `205 total / 200 pass / 5 conditional skip / 0 fail`；backend
  `1,535 total / 1,533 pass / 2 conditional skip / 0 fail`，`pnpm build:back` 通过；
- 18-package clean build/逐包测试单次退出 0；package boundary、Cluster dependency、Edge import、Service Bridge import、
  Cluster/Worker deployment、Console 与 Console distribution 八项架构审计全部 compatible/passed；
- 14 档 artifact audit 按顺序全部 compatible；基础 Edge/Standalone `2,598,669 / 2,598,747` bytes、316 files、57 modules，
  Adopted `2,818,404 / 2,818,527` bytes、336 files、58 modules，Application+AI `4,502,262 / 4,502,394` bytes、511 files、
  141 modules，MCP `7,324,601 / 7,324,709` bytes、802 files、227 modules；
- workspace 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Local Owner 为
  `129 source / 128 nested / 1 root binary entry`；GitNexus change audit 是提交前最后门禁；
- 本切片不修改 PostgreSQL schema、ACL、repository、role、Pool、连接或 failover 语义，不重新占有 PostgreSQL HA 证明。

## 后续

- D-387：为 prepared model 设计受认证、可审计、可重放的 apply/commit 与 Secret 零化/回收协议；
- 在固定物理 Edge/NAS 上执行 stage/transform/verify 的 RSS、I/O、磁盘峰值、ENOSPC 与受控断电演练；
- 将 transformation digest 接入 systemd/OpenRC/Compose cutover、rollback 和发布证据 lineage。
