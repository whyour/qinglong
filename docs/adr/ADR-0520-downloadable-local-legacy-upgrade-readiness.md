# ADR-0520：可下载的 Local Legacy 升级就绪盘点

- 状态：Accepted（D-425 已交付同源双架构 Alpha 阶段实物）
- 日期：2026-08-30
- 对应 RFC 切片：D-425
- 关联 ADR：ADR-0476～ADR-0483、ADR-0503、ADR-0506、ADR-0511、ADR-0514

## 背景

QingLong 3.0 已经形成双架构 Local Trial Kit、Cluster bundle 和跨 Profile stage index，但当前可下载 Local quickstart 只支持 fresh 数据根。
ADR-0476～ADR-0483 已在产品 CLI 中完成真实形态 2.x SQLite、完整 data directory、私有暂存、转换、原子应用、部署 lineage、停止态
reconciliation bundle 和有界领域计划；部署用户仍无法从 Trial Kit 直接判断自己的 2.x 数据是否进入支持边界。

不能用“一键升级”掩盖这个缺口。SQLite stage 需要人工审核 `planDigest`，完整 data directory stage 又需要独立目录计划和 activation 双围栏；
在未展示计划前自动复制、迁移或 cutover 会越过现有安全协议。另一方面，仅把长篇运维文档放入源码仓库也不是阶段产物：路由器、NAS 用户需要
从已下载并审计的 exact Operator image 发起只读盘点，且不要求宿主安装 Node.js、jq 或 3.0 workspace。

## 决策

### 1. Trial Kit 增加 canonical `upgrade-readiness.sh`

Local Trial Kit 在既有 Docker archive、quickstart、SBOM 和 verification evidence 之外增加一个受 manifest、SHA256SUMS 和离线 auditor
共同绑定的 POSIX shell 入口：

```sh
sh upgrade-readiness.sh \
  edge \
  /opt/qinglong/data \
  /opt/qinglong3-alpha-upgrade-readiness
```

入口只接受 `edge|standalone`、一个现存 canonical 2.x data root 和一个尚不存在的私有 evidence root。路径字符集有界，legacy 与 evidence
root 必须不同；固定生产布局要求主库位于 `db/database.sqlite`。输出目录以当前 UID、`0700` 创建，command/result 为 `0600`。

### 2. 只运行两个正式产品 inspect

脚本通过 Trial Kit 中 exact、source-bound 的 Local Operator image 执行：

1. `local-sqlite.adoption.inspect`；
2. `local-data-directory.adoption.inspect`。

legacy root 以 Docker read-only bind mount 提供，Operator 使用当前宿主 UID:GID、只读 rootfs、`network=none`、drop-all capabilities、
`no-new-privileges`、128 MiB memory/swap、0.5 CPU、32 PID 和 8 MiB noexec tmpfs。结果只写入独立 evidence root。脚本不解析、改写或代替
operator 审核两个完整结果，也不运行 stage、activation、application、cutover、target stop 或 Legacy rollback。

成功只表示两个 plan 已生成；它不表示 `assessment=reviewable`、不授权复制或升级，也不能从 plan digest 反推内容。操作者必须停止活跃 writer、
审核 SQLite catalog/task inventory 与 data-directory disposition/预算/sidecar，再决定是否进入后续 rehearsal。

### 3. Artifact gate 必须运行将要上传的 exact 脚本

`ql3-ci.yml` 的显式 Local artifact job 在每个原生 amd64/arm64 runner 上：

- 创建包含 2.x `Crontabs`、`Dependences`、`Apps`、`Auths`、`Envs`、`Subscriptions`、`CrontabViews`、`CrontabStats`、
  `RunningInstances`、`PluginOwnedState` 和常见目录的私有生产形态 fixture；
- 运行 bundle 目录中将要上传的 `upgrade-readiness.sh`，而不是源码模板；
- 要求两个结果均为 `status=inspected`，并确认 source 未出现 SQLite WAL/journal；
- 只有整个 job 成功才上传 bundle。

verification evidence 升级为 `qinglong/alpha-local-trial-kit-verification@v4` 并增加 `legacyUpgradeReadiness=passed`。Trial Kit 升级为
`qinglong/alpha-local-trial-kit@v6`（manifest schemaVersion 7），auditor 升级为 `qinglong/alpha-local-trial-kit-audit@v3`；旧 v5 bundle 不会被
改名冒充 v6。

### 4. 不增加 package 或常驻能力

该切片只增加 artifact template、CI fixture 和文档，不增加 workspace package、第三方依赖、数据库 migration、listener、daemon、timer、
watcher、queue 或 Cluster authority。Operator 继续复用既有 Local adoption product CLI；Cluster 节点继续使用 PostgreSQL 专用升级、备份和
deployment-lock 协议。

## 不采用的方案

1. **在 readiness 脚本中自动 stage/activate**：绕过两个 plan digest 的人工审核和停写围栏，拒绝。
2. **把宿主 Node.js/jq 作为前置**：低配部署未必安装，且会扩大不可审计执行闭包，拒绝。
3. **把 2.x data root 以读写方式挂载以“顺便修复”权限或 sidecar**：readiness 只能报告，不能修改证据现场，拒绝。
4. **新增独立 migration package/image**：既有短生命周期 Operator 已拥有精确 adoption authority，新增交付单元只会重复依赖和扩大碎片化，拒绝。
5. **把 inspect 成功宣传为升级兼容**：unknown asset、预算、sidecar、manual task/config/SSH 仍需审核，拒绝。

## 验收与后续

源码候选必须通过 bundle/fixture/milestone 聚焦测试、完整 backend、18-package clean build/test、package/Cluster/Edge boundary、双架构普通 CI 与
显式 Local artifact run。v6 amd64/arm64 bundle 必须被同 run Local milestone 收录并通过 checksum/auditor，D-425 才能从源码候选升级为阶段实物。

该门已由提交 `d6571e4b89eaf29ed6277dd08bbd7ffb57a3705d` 关闭：普通 CI
[run 33295923855](https://github.com/whyour/qinglong/actions/runs/33295923855) 为 41 success/3 expected artifact-finalizer skip/0 fail，同源
Kubernetes deployment [run 33295923822](https://github.com/whyour/qinglong/actions/runs/33295923822) 成功；显式 Local headless artifact
[run 33300121149](https://github.com/whyour/qinglong/actions/runs/33300121149) 为 42 success/2 scope skip/0 fail。该 run 的两个原生架构 job 均实跑
将要上传的 exact readiness 脚本并由 `qinglong/alpha-local-trial-kit-audit@v3` 返回 `compatible=true`；下载后的 Local milestone 再由
`qinglong/alpha-local-milestone-audit@v3` 确认 source/run/attempt、amd64/arm64 和 v6 readiness digest 闭合。三个核心 artifact 保留至
2026-09-29，仍是 `alpha_candidate_not_public_release`，不构成正式发布或生产 cutover 授权。

D-425 是完整升级 rehearsal 的第一阶段，不重新定义最终目标。下一切片继续以两个已审核 plan digest 为显式输入，建立 side-by-side
SQLite/data-directory stage、verify、activation、adopted start、clean `rollback_candidate` 与写后 `reconciliation_required` 证据；在该门完成前，
Trial Kit 仍不得用于生产 cutover。
