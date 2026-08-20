# QingLong 2.x SQLite 接管到 3.0

本流程把已有 QingLong 2.x `database.sqlite` 以不覆盖 source 的方式接管为 3.0 adopted storage。它只处理单个 SQLite 主库；
scripts、configs、logs 和其他 data directory 文件不在本流程内。

全部命令由最终运行 QingLong 的同一个 POSIX 用户执行。`ql3-adoption` 是一次性 CLI，不启动服务，也不会自动执行 cutover 或
Legacy rollback。

## 1. 空间与停机前检查

- `deploymentRoot` 及输出父目录必须是当前 UID、canonical、非 symlink 的 `0700` 目录；
- command file 必须是当前 UID、canonical、单链接 `0600` 文件；
- source 必须是当前 UID 的 canonical 普通单链接文件，且 group/world 不可写；生产环境建议 `0600`；
- target、recovery、manifest、activation 必须尚不存在，并全部位于 `deploymentRoot` 内；
- source、target、recovery、manifest、activation 五个路径必须互不相同；
- 预留 recovery + target 两份数据库以及 SQLite 临时/sidecar 余量。不要以删除 recovery 的方式解决空间不足。

inspect 和 Online Backup 可以在 2.x 仍可读时执行，但最终 stage review 后到 activation/cutover 期间必须停止外部 writer，并保证
source 不再漂移。activation prepare 会尝试取得 source/target write fence；无法取得时失败关闭。

低配设备说明：四个阶段都是 one-shot 进程，没有后台 timer、监听端口或自动重试；schema inventory 最多 4096 项，manifest 最多
256 KiB，SQLite backup 按页复制而不是把整个数据库载入 JS heap。制品审计的 import RSS 不是迁移峰值承诺，正式升级前仍需在目标
路由器/NAS 上测量可用空间、耗时、峰值 RSS 和断电恢复。

## 2. Inspect：生成待审核计划

```json
{
  "schemaVersion": 1,
  "operation": "local-sqlite.adoption.inspect",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "profile": "edge",
    "sourcePath": "/opt/qinglong/data/database.sqlite",
    "legacyTimezone": "Asia/Shanghai"
  }
}
```

```sh
chmod 0600 /secure/operator/ql3-sqlite-inspect.json
ql3-adoption run --command-file /secure/operator/ql3-sqlite-inspect.json
```

记录返回的 `planDigest`，审核 schema catalog、table names 与 task inventory。不要在审核后修改 source；若 source 变化，重新 inspect，
不要沿用旧 digest。

## 3. Stage：生成 recovery、target 与 manifest

```json
{
  "schemaVersion": 1,
  "operation": "local-sqlite.adoption.stage",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "profile": "edge",
    "sourcePath": "/opt/qinglong/data/database.sqlite",
    "targetPath": "/opt/qinglong3/artifacts/qinglong3.sqlite",
    "recoveryPath": "/opt/qinglong3/artifacts/database.pre-ql3.sqlite",
    "manifestPath": "/opt/qinglong3/artifacts/qinglong3-adoption.json",
    "expectedPlanDigest": "REPLACE_WITH_INSPECT_PLAN_DIGEST",
    "legacyTimezone": "Asia/Shanghai"
  }
}
```

```sh
chmod 0600 /secure/operator/ql3-sqlite-stage.json
ql3-adoption run --command-file /secure/operator/ql3-sqlite-stage.json
```

stage 通过 SQLite Online Backup 创建独立 recovery 和 target，只在 target 上执行 3.0 migration，并以 `0600` no-replace 文件发布
结果。source 不会被覆盖。任一输出已存在时不要删除后盲目重跑，应先把现有文件和命令结果作为一次未完成 ceremony 调查。

## 4. Verify：独立复验 staged 结果

```json
{
  "schemaVersion": 1,
  "operation": "local-sqlite.adoption.verify",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "profile": "edge",
    "targetPath": "/opt/qinglong3/artifacts/qinglong3.sqlite",
    "recoveryPath": "/opt/qinglong3/artifacts/database.pre-ql3.sqlite",
    "manifestPath": "/opt/qinglong3/artifacts/qinglong3-adoption.json"
  }
}
```

```sh
chmod 0600 /secure/operator/ql3-sqlite-verify.json
ql3-adoption run --command-file /secure/operator/ql3-sqlite-verify.json
```

记录返回的 `manifestDigest`。verify 只接受与 manifest 一致的 recovery/target、完整 migration 和通过的 adopted readiness。

## 5. Prepare activation：冻结三份物理事实

```json
{
  "schemaVersion": 1,
  "operation": "local-sqlite.activation.prepare",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "profile": "edge",
    "sourcePath": "/opt/qinglong/data/database.sqlite",
    "targetPath": "/opt/qinglong3/artifacts/qinglong3.sqlite",
    "recoveryPath": "/opt/qinglong3/artifacts/database.pre-ql3.sqlite",
    "manifestPath": "/opt/qinglong3/artifacts/qinglong3-adoption.json",
    "activationPath": "/opt/qinglong3/artifacts/qinglong3-activation.json",
    "expectedManifestDigest": "REPLACE_WITH_VERIFY_MANIFEST_DIGEST"
  }
}
```

```sh
chmod 0600 /secure/operator/ql3-sqlite-activation.json
ql3-adoption run --command-file /secure/operator/ql3-sqlite-activation.json
```

activation 分别记录 `sourceSha256`、`recoverySha256` 和 `targetSha256`。SQLite Online Backup 的 recovery 与 source 可以逻辑等价
但物理字节不同，因此不能比较两者哈希来判断 clean rollback。记录返回的 `activationDigest`，并把 exact activation path/digest
交给 adopted application 和后续 cutover 命令。

## 6. Cutover 与回退判定

完成 activation 后，继续执行 [Edge/Standalone 部署准备](./ql3-local-deployment.md) 中的 legacy silence、target start/stop 和双阶段
rollback ceremony。不要仅凭 activation 启动两个 writer。

target stop 后的数据分类为：

- `rollback_candidate`：target/source 都保持 activation 时字节且双方 sidecar clear；
- `reconciliation_required`：target 已接受写入或存在 target sidecar；保留三份数据库，禁止自动启动 2.x；
- `manual_review`：source 漂移、activation 或稳定文件身份无法证明；禁止猜测。

证据字段 `sourceMatchesActivation` 表示 source 与 activation 时的原 source 哈希相同，不表示 source 与 Online Backup recovery 文件
物理相同。`rollback_candidate` 也不是启动授权，仍须走双阶段 Legacy rollback。

## 7. 当前边界

本流程不迁移完整 2.x data directory，不做 target 写后的自动逆迁移，不连接 Cluster 控制面，也没有云端恢复服务。任何
`reconciliation_required` 必须保留现场并等待后续显式数据域工具；不要把 target 覆盖回 source。
