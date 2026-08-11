# QingLong 3.0 Edge/Standalone SQLite Readiness 诊断

本命令用于诊断已初始化的 fresh 或 adopted QingLong 3.0 SQLite authority。它不会执行 migration、
修复 schema 或改变 journal mode。

## 使用

安装后的产品入口：

```sh
ql3-local-readiness \
  --database=/opt/qinglong3/qinglong3.sqlite \
  --profile=edge \
  --busy-timeout-ms=1000
```

仓库入口：

```sh
pnpm audit:schema:ql3 -- \
  --database=/opt/qinglong3/qinglong3.sqlite \
  --profile=edge \
  --busy-timeout-ms=1000
```

`--profile` 必须与部署配置一致：edge 要求 `DELETE` journal，standalone 要求 `WAL`。数据库必须
是当前运行用户所有的 canonical、非 symlink、精确 `0600` regular file。

成功返回低敏 JSON：

```json
{
  "schemaVersion": 1,
  "operation": "local.readiness.inspect",
  "status": "ready",
  "profile": "edge",
  "storage": {
    "contractName": "local-control-core",
    "contractVersion": 42,
    "migrationCount": 84,
    "tableCount": 76,
    "sqliteVersion": "3.x",
    "journalMode": "delete"
  }
}
```

`tableCount` 和 SQLite version 会随正式 schema 演进，以实际输出为准。结果不会包含数据库路径、业务行、credential、
Secret 或 digest。失败只输出稳定错误 code/name；修复前不要通过 chmod 放宽文件权限、绕过
symlink 检查或对用户库执行 `drizzle-kit push`。

旧 `back/migrations` Shadow schema 诊断必须显式使用：

```sh
pnpm audit:legacy-schema:ql3 -- \
  --database=/absolute/path/to/legacy.sqlite \
  --json
```

legacy 报告不能作为 fresh/adopted 3.0 readiness 证据。
