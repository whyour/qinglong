# QingLong 2.x Data Directory 盘点

本流程为完整 QingLong 2.x `data` 目录生成一个只读、确定性、按 Profile 有界的 3.0 接管计划。它不会复制、压缩、删除或修改
任何文件，也不替代 [SQLite 接管流程](./ql3-local-sqlite-adoption.md)。

## 1. 前置条件

- 使用最终运行 QingLong 的同一个 POSIX 用户执行；
- `dataRoot` 必须是绝对、canonical、非根、非 symlink 的目录；
- `dataRoot` 必须由当前 UID 拥有，且 group/world 不可写；
- command file 继续遵守 `ql3-adoption` 的当前 UID、canonical、单链接、`0600` 私有文件要求；
- 生产盘点建议先停止 2.x writer。若文件或目录在盘点中变化，命令会失败关闭，不会给出部分成功计划。

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

## 6. 常见失败

- 根目录或条目 group/world 可写：修正 ownership/permission 后重新盘点；
- symlink、硬链接或特殊文件：保留现场，确认来源和目标后人工处置；盘点不会跟随或读取；
- 目录在盘点中变化：停止 2.x writer、同步器、下载器和仓库更新后重试；
- 单文件或总内容超过 Profile 预算：不要改用 `tar` 绕过；为该资产设计独立流式迁移/外部保留流程；
- 未知顶层条目：根据插件或用户资产来源登记明确处置，再进入后续 staging 设计。

## 7. 当前边界

本命令只生成只读计划。它尚不：

- 复制、压缩、删除或转换任何资产；
- 创建 no-replace stage、verify manifest 或 recovery；
- 把目录计划绑定到 SQLite `planDigest`、`manifestDigest` 或 `activationDigest`；
- 授权 service-manager/Compose cutover 或 Legacy rollback；
- 证明固定物理路由器/NAS 上的耗时、RSS、I/O、磁盘峰值和断电恢复。

在后续 D-385 stage/verify 合同完成前，保留 inspect 输出和原始 2.x data directory，不要把目录计划当作自动迁移完成证明。
