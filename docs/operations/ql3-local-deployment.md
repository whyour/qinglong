# QingLong 3.0 Edge/Standalone 部署准备

本流程把 [Fresh 初始化](./ql3-local-fresh-setup.md) 与 application v2 配置组合成
一个可重放的私有部署 bundle。它生成文件，但不会自动安装或启动宿主机服务。

部署者可以使用 [`ql3 deploy`](./ql3-local-cli.md) 统一入口；文中的
`ql3-local-deploy` 专用 binary 继续保持完全兼容。root-only
`ql3-service-bridge` 不属于统一子命令，仍按独立 authority 流程执行。

## 1. 前置条件

- Node.js 24.18.x；
- 已安装 `ql3-local-deploy` 与 `ql3-local-application`；
- 使用最终运行 QingLong 的同一个 POSIX 用户；
- command file 的父目录为当前 UID 的 canonical `0700` 目录；
- Compose 的 catalog-bound Local v2 selection 也必须位于当前 UID 的 canonical
  `0700` 目录中，文件自身为 canonical、current-UID、单链接 `0600`；
- 生产环境建议使用非 root 用户。只有 root-only 路由器才将
  `allowRootService` 明确设为 `true`。

deployment root 可以尚不存在。路径只能包含受 supervisor 安全解析的
ASCII 路径字符，不能包含空格、shell 元字符、`%`、路径穿越或 symlink。

### Production Profile 运行制品

路由设备/NAS 上应部署 release assembler 或 local application 镜像产生的 production
artifact，不要直接复制 workspace `dist` 或完整开发安装。受支持的 assembler 会先以
`pnpm pack -> offline install` 形成并核对精确 production closure，再只从内部
`node_modules/@qinglong/**` 删除运行时不消费的 `.d.ts` 与 `.map`。不要手工删除第三方文件、
JavaScript、`package.json`、assets 或 migration；这会使 artifact inventory、SBOM 和升级行为
不可复验。

发布前必须执行全部十档 Profile audit，而不只是当前设备使用的一档：

```sh
pnpm audit:artifact:edge:ql3
pnpm audit:artifact:standalone:ql3
pnpm audit:artifact:edge-adopted:ql3
pnpm audit:artifact:standalone-adopted:ql3
pnpm audit:artifact:edge-application:ql3
pnpm audit:artifact:standalone-application:ql3
pnpm audit:artifact:edge-ai:ql3
pnpm audit:artifact:standalone-ai:ql3
pnpm audit:artifact:edge-application-ai:ql3
pnpm audit:artifact:standalone-application-ai:ql3
pnpm audit:local-image:ql3
```

报告中的 import RSS delta 只衡量 entrypoint 加载增量：storage/adopted/AI-only 上限为
16 MiB，application/application-ai 为 24 MiB。它不替代 Edge 96 MiB 总物理进程预算、
cgroup 峰值、cold start 或固定设备证据。

## 2. 创建命令

以下示例生成 systemd 描述符。`nodeExecutable` 和
`applicationEntrypoint` 必须填写 `realpath` 后的 canonical 文件：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.prepare",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "profile": "edge",
    "instanceId": "router-edge-1",
    "busyTimeoutMs": 100,
    "service": {
      "kind": "systemd",
      "nodeExecutable": "/opt/node-v24/bin/node",
      "applicationEntrypoint": "/opt/qinglong-app/dist/cli.js",
      "allowRootService": false
    }
  },
  "request": {
    "ownerPepperKeyId": "owner-v1",
    "registerMutationId": "REPLACE_WITH_UUID_V4",
    "activateMutationId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "registeredAtMs": 1785254400000,
    "activatedAtMs": 1785254400001
  }
}
```

命令文件必须为 `0600`：

```sh
chmod 0600 /secure/operator/qinglong3-deployment.json
ql3-local-deploy prepare \
  --command-file /secure/operator/qinglong3-deployment.json
```

首次成功返回 `prepared`；结果未知或进程中断时保留原文件并原样重跑，收敛后返回
`existing`。不得替换 mutation ID 或时间来“重试”。输出不包含路径、镜像、digest
或任何密钥材料。

准备器固定创建：

```text
/opt/qinglong3/
├── qinglong3.sqlite
├── local-application.json
├── local-application.json.active.json  # Linux 首次 active 后原子发布
├── local-secret-keyring.json
├── owner-peppers/
├── owner-pepper-backup/
├── receipts/
├── artifacts/
├── plugin-staging/
├── plugin-activation/
└── service/
```

所有目录为当前 UID `0700`；application config 和非可执行描述符为 `0600`。
启动凭据同样为 `0600`，最大 4 KiB，每次成功激活只原子替换一次；它不是日志，
不能仅凭文件存在判断服务 ready，必须同时核验 current boot 和 live PID。

不使用 Compose preflight 的 systemd/OpenRC 部署，可在启动前运行
[`ql3-local-readiness`](./ql3-local-readiness.md)；它与 application/Compose 共用正式
`@qinglong/local-sqlite` readiness authority，不会隐式 migration 或修改数据库。

### 2.1 重启后读取持久部署状态

`prepare`、revision 或 apply 的终端响应丢失后，先用只读状态命令确认磁盘事实。它仍只接受
当前 UID 私有的 `0600` command file：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.status",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "allowRootService": false
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-deployment-status.json
ql3-local-deploy status \
  --command-file /secure/operator/qinglong3-deployment-status.json
```

状态结果固定为 `status=observed`、`observation=durable`。它验证 deployment root、application
v2 配置和三选一 service descriptor 的当前 UID/权限/基本绑定，并返回 Profile 与 service kind；
Compose 还返回当前不可变 revision 的 `generation`、可选 `rollbackTargetGeneration`，以及
revision/rollout/restore/evidence-collection 四个事务围栏。

`transition=stable` 只表示没有观察到这四类持久锁；`transition=recovery_required` 表示至少一个
原命令可能仍需重放。后者不证明服务已宕机，也不授权手工删除锁，应找到对应的原私有 command
file 并按本章流程原样重放。状态入口不会扫描 receipt/snapshot 历史，不打开 SQLite，不连接
Docker/systemd/OpenRC，不启动或停止服务；一次调用只读取固定数量的小文件，适用于低配路由设备。

结果中的 `runtime.health=unobserved` 是刻意的边界：实时健康仍必须由 systemd/OpenRC/Docker 和
application `event=active` 共同证明。状态输出不包含 deployment path、instance ID、镜像、digest、
mutation、rollout/restore ID、socket 或密钥材料，不能替代 readiness、Compose preflight 或 rollout
receipt。

### 2.2 adopted 2.x 的 Docker legacy silence gate

已有 2.x SQLite 部署必须先完成
[`inspect → stage → verify → activation`](./ql3-local-sqlite-adoption.md)，取得真实、未手写的 manifest、activation 与 digest。
下列 silence/cutover 命令只消费该证据，不负责隐式迁移数据库。source、target 和 recovery 必须一直保留到回退或 reconciliation
正式闭合。

adopted target 不得直接使用旧 v1 配置启动。当前第一条可达的 cutover 产品路径只接管由
Docker 精确容器 ID 标识的 2.x owner；systemd/OpenRC legacy、Kubernetes 和远端 cluster
不允许伪装成 Docker evidence。先确保 deployment root 与其 `service/` 都是当前 UID 的
canonical `0700` 目录，再准备私有命令：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.cutover.legacy-stop",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "dockerExecutable": "/usr/bin/docker",
    "dockerSocketPath": "/var/run/docker.sock",
    "allowRootService": false
  },
  "request": {
    "cutoverId": "router-edge-1-ql3",
    "profile": "edge",
    "instanceId": "router-edge-1",
    "activationPath": "/opt/qinglong/private/qinglong3-activation.json",
    "legacySourcePath": "/opt/qinglong/data/database.sqlite",
    "targetDatabasePath": "/opt/qinglong/data/database.ql3.sqlite",
    "recoveryPath": "/opt/qinglong/data/database.recovery.sqlite",
    "manifestPath": "/opt/qinglong/private/qinglong3-adoption.json",
    "expectedLegacyDatabasePath": "/ql/data/database.sqlite",
    "expectedActivationDigest": "REPLACE_WITH_64_HEX_ACTIVATION_DIGEST",
    "expectedLegacyContainerId": "REPLACE_WITH_FULL_64_HEX_CONTAINER_ID",
    "requestedAtMs": 1786291200000
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-cutover.json
ql3-local-deploy cutover-legacy-stop \
  --command-file /secure/operator/qinglong3-cutover.json
```

控制器先验证 `legacySourcePath` 的 SHA-256 path digest 与 activation 一致并发布
`0001-legacy-stop-requested.json`，再对精确容器执行
`update --restart=no`、`stop` 和 `inspect`。只有容器 ID 不漂移、`Running=false`、
`Restarting=false`、`Pid=0` 且 restart policy 为 `no` 时，才以 hard-link no-replace
并且唯一 Docker bind mount 能把宿主机 `legacySourcePath` 精确映射到
`expectedLegacyDatabasePath` 时，才发布
`service/cutovers/<cutoverId>/0002-legacy-stopped.json`。调用中断后必须原样重放同一
command file；已提交重放不会重新打开 Docker socket 或再次停止容器。失败时请求记录保留，
commitment 不存在，3.0 adopted 进程必然拒绝启动。

把返回的 `commitmentDigest` 和上述 commitment 的运行时可见绝对路径写入 application v3
配置的 `cutover.expectedCommitmentDigest`/`commitmentPath`。Compose target 使用 bind mount
后的 `/var/lib/qinglong3/...` 路径，systemd target 使用宿主机路径。

此命令本身只证明一个已禁用自动重启的 Docker legacy owner 已静默，并关闭“跳过旧实例停机直接
启动 adopted 3.0”的旁路。target start/restart 必须继续执行下一节的 ADR-0310 barrier；人工
`manual_required` resolution 使用 2.4 节的 ADR-0313 双阶段命令。写后回退仍未完成，因此不得宣称
D-64 全部完成，也不得自动重启 2.x。

### 2.3 Docker adopted target 启动与重启屏障

ADR-0310 已补齐上述段落中的 Docker target barrier；ADR-0313 又补齐 Docker `manual_required` 的实例级
lineage、只读诊断与双阶段新 ceremony 授权。写后回退仍未完成。target 容器必须由 operator 预先创建但保持停止，并满足：完整 ID、受审核镜像引用和精确 Docker content ID、
`restart=no`、read-only rootfs、非 privileged、`no-new-privileges`，以及能把宿主机 Application v3 config、
legacy commitment、activation 和 source 精确映射到 config 中路径的唯一读写 bind mount。自动重启策略
`unless-stopped`/`always` 会绕过每代 Legacy recheck，因此 adopted target 不允许使用。

首次启动使用 generation 1：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.cutover.target-start",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "dockerExecutable": "/usr/bin/docker",
    "dockerSocketPath": "/var/run/docker.sock",
    "allowRootService": false
  },
  "request": {
    "cutoverId": "router-edge-1-ql3",
    "profile": "edge",
    "instanceId": "router-edge-1",
    "activationPath": "/opt/qinglong/private/qinglong3-activation.json",
    "legacySourcePath": "/opt/qinglong/data/database.sqlite",
    "targetDatabasePath": "/opt/qinglong/data/database.ql3.sqlite",
    "recoveryPath": "/opt/qinglong/data/database.recovery.sqlite",
    "manifestPath": "/opt/qinglong/private/qinglong3-adoption.json",
    "expectedLegacyDatabasePath": "/ql/data/database.sqlite",
    "expectedActivationDigest": "REPLACE_WITH_64_HEX_ACTIVATION_DIGEST",
    "expectedLegacyCommitmentDigest": "REPLACE_WITH_64_HEX_COMMITMENT_DIGEST",
    "expectedLegacyContainerId": "REPLACE_WITH_FULL_64_HEX_LEGACY_ID",
    "expectedTargetContainerId": "REPLACE_WITH_FULL_64_HEX_TARGET_ID",
    "targetImage": {
      "authority": "registry-digest",
      "reference": "registry.example/qinglong3@sha256:REPLACE_WITH_64_HEX_DIGEST",
      "imageId": "sha256:REPLACE_WITH_DOCKER_IMAGE_CONTENT_ID"
    },
    "applicationConfigPath": "/opt/qinglong3/local-application.json",
    "expectedTargetApplicationConfigPath": "/var/lib/qinglong3/local-application.json",
    "expectedTargetCommitmentPath": "/var/lib/qinglong3/service/cutovers/router-edge-1-ql3/0002-legacy-stopped.json",
    "generation": 1,
    "requestedAtMs": 1786291201000
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-target-start.json
ql3-local-deploy cutover-target-start \
  --command-file /secure/operator/qinglong3-target-start.json
```

正式 registry 部署必须使用 `authority=registry-digest`，`reference` 仍只接受不可变
`name@sha256:...`；`imageId` 从创建目标容器的同一 Docker daemon 读取。下载型 Alpha Trial Kit
没有可诚实声称的 registry RepoDigest，必须改用 `authority=local-image-id`、bundle manifest 中的
本地 image reference 和 exact image ID。两种模式都会同时核对 `docker inspect` 的
`Config.Image` 与 `.Image`，不会把 mutable local tag 单独当作权威。

controller 先写固定的 `0003-target-start-decision.json`，其中状态为
`target_start_requested`，然后至多调用一次 `docker container start <exact-id>`。只有同一容器处于
running、identity/mount/config digest 不漂移，且 Application 写出一个校验通过的新 Linux startup receipt，
才写 `0004-target-start-outcome.json` 的 `target_active`。start 响应丢失或 controller 崩溃后必须原样重放；
屏障已存在时只 inspect，绝不再次 start。

若有任何未知结果，outcome 为 terminal `manual_required`。同一 generation 原样重放只返回 `existing` 且不
打开 Docker socket；不得删除 journal、修改 requestedAt 或创建一个“重试”命令来绕过人工检查，也不得自动
重启 2.x。

曾 active 的 target 停止后，restart 命令必须把 operation 改为
`local.deployment.cutover.target-restart`、generation 严格加一并使用新的 `requestedAtMs`，其余 reviewed
identity 保持一致：

```sh
ql3-local-deploy cutover-target-restart \
  --command-file /secure/operator/qinglong3-target-restart-generation-2.json
```

每代 restart 固定追加：

```text
legacy_recheck_requested
legacy_reverified | manual_required
target_restart_requested | manual_required
target_active | manual_required
```

Legacy container 必须再次证明与 `0002` 相同的完整 identity/source binding 且仍为 stopped + restart=no；
上一代 startup receipt 必须仍在，restart 后必须出现不同 receipt。当前每个 cutover 最多支持 15 个 target
generation（60 条 target journal record），达到上限后必须进入新的受审 cutover/recovery ceremony，不能清理
旧记录腾位置。

### 2.3.1 离线 Docker adopted target descriptor

`local.deployment.adopted.prepare|verify` 的 service 现在可以显式选择：

```json
{
  "kind": "docker-target",
  "targetImage": {
    "authority": "local-image-id",
    "reference": "qinglong3-local-application:ci-amd64",
    "imageId": "sha256:REPLACE_WITH_TRIAL_KIT_IMAGE_ID"
  },
  "allowRootService": false
}
```

它生成 `service/docker-target.json` 和同一份 Application v4 配置，固定 numeric UID:GID、
`restart=no`、无网络、read-only rootfs、drop ALL、no-new-privileges、Profile memory/PID 上限、
deployment root 可写 mount 与 legacy source 只读 mount。该 descriptor 是内容绑定的创建输入，
不是启动授权；operator 仍须先按 descriptor 创建并保持容器停止，再把容器完整 ID 和同一个
`targetImage` 交给 `target-start`。因此离线 Trial Kit 不需要伪造 GHCR catalog/release selection，
正式 Compose 路径也不因 Alpha 便利性而放宽。

### 2.4 `manual_required` 诊断与双阶段新 Ceremony

每个实例的当前 cutover 由以下私有 CAS head 固定：

```text
service/cutover-instances/<instanceId>/head.json
```

进入 `manual_required` 后，先从该 head 取得 `headDigest` 和 `sourceRecordDigest`，不得通过更换
`cutoverId`、删除旧 journal 或重写 requestedAt 重试。准备一个 `0600` command file；以下三个 operation
共用 exact request，diagnose/prepare 的 `expectedPreparationDigest` 必须是 64 个 `0`，commit 时替换为
prepare 返回的 digest：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.cutover.manual-diagnose",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "dockerExecutable": "/usr/bin/docker",
    "dockerSocketPath": "/var/run/docker.sock",
    "allowRootService": false
  },
  "request": {
    "profile": "edge",
    "instanceId": "router-edge-1",
    "currentCutoverId": "router-edge-1-ql3",
    "nextCutoverId": "router-edge-1-ql3-recovery-1",
    "currentActivationDigest": "REPLACE_WITH_CURRENT_64_HEX_ACTIVATION_DIGEST",
    "nextActivationDigest": "REPLACE_WITH_REVIEWED_NEXT_64_HEX_ACTIVATION_DIGEST",
    "expectedInstanceHeadDigest": "REPLACE_WITH_64_HEX_HEAD_DIGEST",
    "expectedManualRecordDigest": "REPLACE_WITH_64_HEX_SOURCE_RECORD_DIGEST",
    "expectedLegacyContainerId": "REPLACE_WITH_FULL_64_HEX_LEGACY_ID",
    "expectedTargetContainerId": "REPLACE_WITH_FULL_64_HEX_TARGET_ID",
    "expectedPreparationDigest": "0000000000000000000000000000000000000000000000000000000000000000",
    "requestedAtMs": 1786291300000
  }
}
```

```sh
ql3-local-deploy cutover-manual-diagnose \
  --command-file /secure/operator/qinglong3-cutover-diagnose.json
```

diagnose 只对两个完整 container ID 执行 inspect，返回 `stopped|running|unknown` 和低敏 digest，不会
执行 update/stop/start/restart。只有 operator 已在该命令之外处理现场，并且 diagnose 显示 legacy 与 target
都为 `stopped`，才可把 operation 改为
`local.deployment.cutover.manual-resolution-prepare` 后执行：

```sh
ql3-local-deploy cutover-manual-resolution-prepare \
  --command-file /secure/operator/qinglong3-cutover-resolution-prepare.json
```

记录返回的 `preparationDigest`。第二次确认必须使用新的私有 command file，把 operation 改为
`local.deployment.cutover.manual-resolution-commit` 并把该 digest 写入
`expectedPreparationDigest`：

```sh
ql3-local-deploy cutover-manual-resolution-commit \
  --command-file /secure/operator/qinglong3-cutover-resolution-commit.json
```

commit 会重新 inspect；任一容器不再 stopped、restart policy 漂移、identity digest 变化或 head 被其他
operator 抢先更新都会失败。成功只把实例 head CAS 到新 cutover 的 `resolution_authorized`，不会控制容器。
随后必须为新 cutover 重新执行 2.2 的 legacy-stop，取得新的 commitment，再生成绑定新 cutover 的
Application v3 config 并从 generation 1 开始 target ceremony。旧命令此后会在打开 Docker 前因 stale head
失败；commit 响应丢失时原样重放会返回 `existing` 且不重新 inspect。

### 2.5 Docker Target 显式停止与数据分类

ADR-0314 要求 2.3 节 target start/restart command 同时提交宿主机 `targetDatabasePath`、
`recoveryPath` 和 `manifestPath`。Application v3 config 中必须有对应的 container-side
`storage.targetPath`、`storage.recoveryPath`、`storage.manifestPath`；controller 会在 start barrier 前证明
六类 adopted authority path 都由唯一 read-write bind mapping 解释。旧 command file 缺少这三个字段会
失败关闭，不能继续作为 3.0 target 启动凭据。

正常停止当前 active generation 时，复制该 generation 的完整 target command，把 operation 改为：

```json
"operation": "local.deployment.cutover.target-stop"
```

并设置新的 `requestedAtMs`。generation、container/image/config、activation、commitment 和全部路径必须
保持与当前 active journal 一致：

```sh
ql3-local-deploy cutover-target-stop \
  --command-file /secure/operator/qinglong3-target-stop.json
```

controller 先 inspect 当前 active identity，再发布 `target_stop_requested` barrier；随后对完整 target ID
执行 `update --restart=no`、`stop --time 30` 和 stopped inspect。barrier 后崩溃可以原样重放并幂等
stop-and-verify；已经存在 `target_stopped` 时重放返回 `existing`，不再打开 Docker socket。无法证明停止
结果会写 terminal `manual_required`，绝不启动 legacy。

成功 stop 后返回以下三种低敏 disposition 之一：

```text
rollback_candidate
reconciliation_required
manual_review
```

- `rollback_candidate`：target 主文件仍等于 activation 的 `targetSha256`、source 仍等于 activation 的
  `sourceSha256`，
  且两者均没有 `-wal`、`-shm`、`-journal` sidecar。
- `reconciliation_required`：target 主文件已经变化，或发现 target SQLite sidecar；必须保留 target 并进入
  后续数据域 reconciliation，不能启动 2.x。
- `manual_review`：activation/文件稳定身份不能证明，或 target 未写但 source 已偏离 activation 时原始 source；不得猜测。

`rollback_candidate` 本身不是 legacy restart 授权。实例 head 成功后进入 `target_stopped`，旧 restart
command 会在 Docker authority 前失败；只有下一节的双阶段 ceremony 可以请求启动 2.x。

### 2.6 双阶段 Legacy rollback

只有 2.5 返回 `reconciliation=rollback_candidate` 时才能继续。以 exact target-stop command 为基础，保留
全部 path/container/image/config/generation 字段和原 `requestedAtMs`，增加 stop 返回的 head/record digest、
独立的 rollback 时间，并把 operation 改为 prepare：

```json
{
  "operation": "local.deployment.cutover.legacy-rollback-prepare",
  "request": {
    "expectedInstanceHeadDigest": "REPLACE_WITH_TARGET_STOP_INSTANCE_HEAD_DIGEST",
    "expectedStoppedRecordDigest": "REPLACE_WITH_TARGET_STOP_RECORD_DIGEST",
    "expectedPreparationDigest": "0000000000000000000000000000000000000000000000000000000000000000",
    "rollbackRequestedAtMs": 1786291900000
  }
}
```

上例只展示新增/替换字段；实际 command file 必须包含 2.5 target-stop 的完整 exact `options` 和 `request`，
不能只提交这个片段。写为当前 UID 私有 `0600` 文件后执行：

```sh
ql3-local-deploy cutover-legacy-rollback-prepare \
  --command-file /secure/operator/qinglong3-legacy-rollback-prepare.json
```

prepare 会重新 inspect 两个容器并复验 target/source 数据证据，不控制容器、不修改数据库。只有 exact
rollback candidate 且实例 head 未变化时，才返回 `state=rollback_prepared` 和 `preparationDigest`。

operator 复核结果后，复制同一完整命令，保持所有字段（包括两个时间）不变，只把 operation 改为
`local.deployment.cutover.legacy-rollback-commit`，并将返回的 digest 写入 `expectedPreparationDigest`：

```sh
ql3-local-deploy cutover-legacy-rollback-commit \
  --command-file /secure/operator/qinglong3-legacy-rollback-commit.json
```

commit 在 start barrier 前后都重新证明 legacy/target stopped 和数据未漂移，然后只启动冻结的完整 legacy
container ID。成功必须同时证明 legacy running、target stopped，返回 `state=legacy_running`。这只证明容器
状态与绑定，不代表应用健康/readiness。任一结果 unknown、identity drift 或 target 同时 running 都进入 terminal
`manual_required`；不要改 command、换 cutover ID 或手工删除 journal 重试。

barrier 后崩溃时原样重放 commit。重放只 inspect，绝不盲目重复 `docker start`：若第一次 start 已成功，会
补写 exact outcome；若无法证明，则安全收敛为 `manual_required`。整个流程不删除/覆盖 target，不把 target
数据库写回 source。`reconciliation_required` 或 `manual_review` 必须停止在 2.5，等待独立数据恢复流程。

### 2.7 Legacy core readiness proof

`legacy_running` 只证明 legacy init/process running 与 target stopped。要把回滚实例推进为 core ready，必须创建独立的私有
`0600` command file；不要把探针塞进 root bridge，也不要手工用可变 URL 的 `curl` 结果替代：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.cutover.legacy-readiness-probe",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "allowRootService": false
  },
  "request": {
    "cutoverId": "cutover-20260820-01",
    "profile": "edge",
    "instanceId": "local-default",
    "generation": 1,
    "expectedActivationDigest": "REPLACE_WITH_64_HEX_ACTIVATION_DIGEST",
    "expectedInstanceHeadDigest": "REPLACE_WITH_LEGACY_RUNNING_HEAD_DIGEST",
    "expectedLegacyRunningRecordDigest": "REPLACE_WITH_LEGACY_RUNNING_SOURCE_RECORD_DIGEST",
    "legacyHttpPort": 5700,
    "expectedLegacyVersion": "2.21.0",
    "requestedAtMs": 1787236200000
  }
}
```

```sh
ql3-local-deploy cutover-legacy-readiness-probe \
  --command-file /secure/operator/qinglong3-legacy-readiness.json
```

`expectedInstanceHeadDigest` 取 2.6 Owner consume 返回的 `legacy_running` head；
`expectedLegacyRunningRecordDigest` 取该 head 绑定的 source record digest。Docker 与 systemd/OpenRC 使用相同命令，因为它只操作
共同的 Owner instance lineage。

探针固定请求 `GET http://127.0.0.1:<legacyHttpPort>/api/system`，不接受其他 host/path/header/credential，不跟随重定向；
每次请求最多 2 秒、响应最多 32 KiB。Edge 总预算 30 秒/最多 60 次，Standalone 总预算 60 秒/最多 120 次。
只有 HTTP/envelope 成功、`isInitialized=true` 且 version 精确等于命令中的 2.x version 才会发布
`legacy-readiness-gN.json` 并 CAS 到 `legacy_ready`。

`not_ready` 会给出 `unavailable|http_rejected|response_too_large|response_invalid|not_initialized|version_mismatch`，保持
`legacy_running` 不变；处理原因后必须原样重放，不要换 cutover/generation 绕过证据链。成功命令的 exact replay 只读取既有收据，
不会再次发网络请求。`legacy_ready` 是 2.x HTTP core 与初始化证明，不代表任务、订阅、外部 provider、通知或 Cluster Worker 全健康。

## 3. systemd

命令中使用 `"kind": "systemd"`。成功后检查：

```text
/opt/qinglong3/service/qinglong3.service
```

该 unit 固定运行 UID/GID、`SIGTERM`、30 秒 stop budget、`0077` umask、
no-new-privileges、只写 deployment root，以及 Edge/Standalone 各自的
memory/PID/fd 上限。

检查后由管理员显式安装：

```sh
sudo install -o root -g root -m 0644 \
  /opt/qinglong3/service/qinglong3.service \
  /etc/systemd/system/qinglong3.service
sudo systemctl daemon-reload
sudo systemctl enable --now qinglong3.service
```

只有日志出现 `event=active` 才表示应用 admission 已开放。

## 4. OpenRC

把 service 改为：

```json
{
  "kind": "openrc",
  "nodeExecutable": "/opt/node-v24/bin/node",
  "applicationEntrypoint": "/opt/qinglong-app/dist/cli.js",
  "allowRootService": false
}
```

准备器生成 `service/qinglong3.openrc`，使用前台 `supervise-daemon`、固定运行
UID/GID、5 秒 respawn delay、30 秒 TERM 后 KILL 和 Profile fd 上限。检查后：

```sh
sudo install -o root -g root -m 0755 \
  /opt/qinglong3/service/qinglong3.openrc \
  /etc/init.d/qinglong3
sudo rc-update add qinglong3 default
sudo rc-service qinglong3 start
```

## 5. Rootless Compose

Compose 命令不再接受裸 image 字段。先按
[Release-set 部署流程](./ql3-release-set-deployment.md) 在可信工作站生成并审计
catalog-bound Local v2 selection，再把该私有文件及 audit 返回的 exact
`selectionDigest` 交给目标机：

```json
{
  "kind": "compose",
  "releaseSelection": {
    "path": "/secure/operator/qinglong3-local-selection-3.0.0.json",
    "expectedSelectionDigest": "sha256:REPLACE_WITH_64_HEX_DIGEST"
  },
  "allowRootService": false
}
```

目标机只做一次有界私有 JSON 读取、canonical shape/self-digest/catalog binding
校验并取出唯一 `ghcr.io/<owner>/qinglong3-local-application@sha256:...`。它不运行
Cosign、GitHub CLI、regctl 或 Kustomize，不访问网络，也不会因此获得 rollout authority。
旧 `image` 输入失败关闭，不提供手工复制旁路。

它生成 `service/compose.yaml`，固定 numeric UID:GID、read-only rootfs、唯一 bind
mount、无网络、drop all capabilities、no-new-privileges、16 MiB tmpfs 与
Profile memory/PID 上限。application config 自动使用容器内
`/var/lib/qinglong3` 路径。

镜像 digest 不再直接写入稳定模板。fresh prepare 同时生成：

```text
service/
├── compose.yaml
├── compose.image.yaml
├── revisions/
│   └── 1.yaml
├── rollouts/
├── rollout-backups/
├── restores/
└── restore-safeguards/
```

执行 Compose 时必须显式传入 selection 文件：

```sh
docker compose \
  -f /opt/qinglong3/service/compose.yaml \
  -f /opt/qinglong3/service/compose.image.yaml \
  config --images
```

输出必须精确等于已审核的 `@sha256` image。不得省略或调换第二个 override 文件，
也不得另加第三个 Compose 文件覆盖 image。

基础文件包含从 `instanceId` 派生的稳定 Compose project name；override 使用 v2
revision 格式持久保存 selection/release-set/catalog manifest/catalog consumption report
digest、release identity、immutable catalog reference 与 root policy，并把 generation、
mutation 和核心 provenance 写入 container label。不要使用 `-p`、`COMPOSE_PROJECT_NAME`
或第三个 override 改写这些身份。

当前仓库仍没有可引用的本机远端 release digest。ADR-0195 已提供
AI-excluded 候选镜像的锁定构建和 live contract；ADR-0196 已把本机 profile
接入唯一 `.github/workflows/ql3-image-release.yml` 的 SBOM、provenance、
签名和远端回读契约，但 workflow 成功记录本身仍是 Release Gate：

```sh
docker build \
  --file deploy/containers/ql3-local-application/Dockerfile \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --tag qinglong3-local-application:candidate \
  .
node scripts/ql3-local-image-live-contract.cjs \
  --image=qinglong3-local-application:candidate \
  --profile=edge
node scripts/ql3-local-image-live-contract.cjs \
  --image=qinglong3-local-application:candidate \
  --profile=standalone
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "$PWD:/audit:ro" --workdir /audit --entrypoint node \
  qinglong3-local-application:candidate \
  scripts/ql3-local-image-inventory.cjs \
  --inventory-root=/opt/qinglong/node_modules
pnpm sbom:local-image:ql3
pnpm audit:image-release:ql3
```

本地 tag/image ID 不是可发布 authority。只有 release workflow 返回的
`ghcr.io/<owner>/qinglong3-local-application@sha256:...`，且同一 release-set 的
双架构 manifest、Cosign、SLSA、CycloneDX、immutable catalog ceremony 与 deployment-lock
audit 全部成功后，才可把 Local v2 selection 的路径和 digest 写入 Compose 私有输入；
永远不得替换成裸 digest 或 mutable tag。

## 6. Compose 镜像升级和选择回退

升级前先完成 release catalog consumption ceremony 与 Local deployment-lock audit，并按
独立下载策略把 selection 绑定的 exact image 预取到设备。随后创建新的私有 command file：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.compose.upgrade",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "allowRootService": false
  },
  "request": {
    "expectedGeneration": 1,
    "releaseSelection": {
      "path": "/secure/operator/qinglong3-local-selection-3.0.1.json",
      "expectedSelectionDigest": "sha256:REPLACE_WITH_64_HEX_DIGEST"
    },
    "mutationId": "REPLACE_WITH_UUID_V4",
    "changedAtMs": 1785254500000
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-compose-upgrade.json
ql3-local-deploy compose-revision \
  --command-file /secure/operator/qinglong3-compose-upgrade.json
```

成功返回 generation 2，并把完整 catalog provenance 固化到 immutable revision。结果未知时原样重放同一文件；
不要修改 selection path/digest、mutation、时间或 expected generation。再次用 `config --images` 检查 selection，再由 operator
先执行 rollout preflight。Docker 路径和 socket 都必须使用 `realpath`；典型
rootful Linux 分别为 `/usr/bin/docker` 与 `/var/run/docker.sock`，rootless socket
通常位于 `/run/user/<uid>/docker.sock`：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.compose.preflight",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "dockerExecutable": "/usr/bin/docker",
    "dockerSocketPath": "/var/run/docker.sock",
    "allowRootService": false
  },
  "request": {
    "expectedGeneration": 2
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-compose-preflight.json
ql3-local-deploy compose-preflight \
  --command-file /secure/operator/qinglong3-compose-preflight.json
```

只有返回 `status=ready`、预期 generation/Profile 和 SQLite contract 后，才创建
私有 apply command。image 必须同时声明覆盖当前数据库的 read min/max，并且
`io.qinglong.local.sqlite-write-contract` 必须精确等于数据库 contract；只有读取
兼容而写契约不同仍会失败关闭。apply 会再次执行同一 preflight；
`failureRollback*` 是候选失败时创建下一 rollback generation 的预授权身份，不是
随意时间戳：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.compose.apply",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "dockerExecutable": "/usr/bin/docker",
    "dockerSocketPath": "/var/run/docker.sock",
    "allowRootService": false
  },
  "request": {
    "expectedGeneration": 2,
    "rolloutId": "REPLACE_WITH_UUID_V4",
    "startedAtMs": 1785254550000,
    "failureRollbackMutationId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "failureRollbackChangedAtMs": 1785254550001
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-compose-apply.json
ql3-local-deploy compose-apply \
  --command-file /secure/operator/qinglong3-compose-apply.json
```

`status=active` 且退出码 0 才表示候选成功。`status=rolled_back` 表示候选失败、旧
digest 已在新的单调 generation 上恢复 active；`status=failed_stopped` 表示初始
generation 无历史可回，service 已停止。后二者退出码为 2，不能作为发布成功。结果
未知时必须原样重放同一 command file；receipt 已存在时不会重新创建容器，rollback
selection 已推进但 receipt 未写时也只继续恢复旧 digest，不重启坏候选。

成功/失败结果以 command digest 绑定的 canonical `0600` receipt 保存在
`service/rollouts/<rolloutId>.json`。Generation 2 起，apply 会在任何
`compose up` 前在线创建
`service/rollout-backups/<rolloutId>.sqlite`，并把 SQLite contract、write
contract、`unchanged|changed|recovery_unknown` 写观察、snapshot SHA-256/bytes/
page facts 一并写入 receipt。receipt 重放会重新检查 snapshot；缺失或漂移均失败
关闭，不会重启容器。

snapshot 是升级前恢复证据，不是自动 data rollback 授权。候选失败后控制器只切回
旧 image，并让旧 image 对当前数据库重新通过完整 read/write contract preflight；
不会用 snapshot 覆盖当前数据库。`changed` 表示观察窗口内有其他 SQLite 连接提交，
`recovery_unknown` 表示响应丢失前无法证明是否写入，或不健康候选的观察连接已
无法可靠读取 `data_version`；两者都需要 operator 在后续显式 restore 流程中审查。
健康候选的观察读取失败仍不会发布 active receipt。不要修改 receipt/snapshot、删除
`.compose-rollout.lock` 或手工倒退 `compose.image.yaml`；rollback 本身无法产生
`active` 时锁会保留并失败关闭。

`rollout-backups` 最多保留 8 个 final snapshot。达到上限时新的 generation 2+
rollout 会在启动候选前失败；当前版本不会自动删除任何恢复点。应停止继续升级并
保留现场，等待受审的 snapshot GC/归档 operation，而不是手工删除文件。

### 显式恢复失败 rollout 的 SQLite

只有同时满足以下条件时才进入 data restore：

- 原 `compose-apply` 已把 selection 推进到 rollback generation，但旧 image 仍未
  恢复 active；
- 原 `.compose-rollout.lock`、rollout snapshot 和 revision 历史都保持原样；
- operator 已判断应放弃候选写入并恢复升级前数据；
- 已停止其他会访问该 SQLite 的宿主机进程。

不要为了进入恢复流程手工创建、修改或删除 lock/receipt/snapshot。先创建 prepare
命令；`expectedGeneration` 是当前 rollback generation，`sourceRolloutId` 是失败
apply 的原 rollout ID，`restoreId` 必须是新的 UUID：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.compose.restore.prepare",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "dockerExecutable": "/usr/bin/docker",
    "dockerSocketPath": "/var/run/docker.sock",
    "allowRootService": false
  },
  "request": {
    "expectedGeneration": 3,
    "restoreId": "REPLACE_WITH_NEW_UUID_V4",
    "sourceRolloutId": "REPLACE_WITH_FAILED_APPLY_ROLLOUT_UUID_V4",
    "preparedAtMs": 1785254700000
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-compose-restore-prepare.json
ql3-local-deploy compose-restore-prepare \
  --command-file /secure/operator/qinglong3-compose-restore-prepare.json
```

prepare 会停止并 inspect Compose、把当前 SQLite checkpoint 为 self-contained
文件、记录 current/source SHA，并在
`service/restore-safeguards/<restoreId>.sqlite` 保存覆盖前 safeguard。它不会覆盖
数据库，成功返回 `status=prepared`、`service.state=stopped`。结果未知时只重放
同一 prepare 文件。

prepare 后不要启动服务，也不要写 SQLite。完成 source/current/safeguard 和数据
丢弃影响审查后，用同一个 restore ID 和 generation 提交：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.compose.restore.commit",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "dockerExecutable": "/usr/bin/docker",
    "dockerSocketPath": "/var/run/docker.sock",
    "allowRootService": false
  },
  "request": {
    "expectedGeneration": 3,
    "restoreId": "REPLACE_WITH_THE_SAME_UUID_V4",
    "committedAtMs": 1785254700001
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-compose-restore-commit.json
ql3-local-deploy compose-restore-commit \
  --command-file /secure/operator/qinglong3-compose-restore-commit.json
```

commit 会重新停服并以 prepare 时 current SHA 围栏后续写入。任何 SHA、sidecar、
generation、lock、snapshot、权限或 receipt 漂移都必须保留现场并失败关闭。结果
未知时原样重放 commit；`status=existing, service.state=unchanged` 表示 durable
commit 已存在，本次回放没有再停止后来可能已启动的服务。

commit 成功只恢复数据库并删除 `.compose-restore.lock`，不会启动容器，也不会删除
原 `.compose-rollout.lock`。最后必须原样重放最初失败的
`compose-apply --command-file ...`；它会让 rollback image 对已恢复数据库重新执行
preflight、启动并发布原 rollout receipt。只有该命令返回 `status=rolled_back`
才表示服务恢复完成。restore safeguard 最多保留 4 份，当前版本不会自动 GC；达到
上限时停止恢复操作，不得手工删除证据。

需要恢复 generation 1 的 image 时，回退命令不重复提交 image，只引用已存在历史：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.compose.rollback",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "allowRootService": false
  },
  "request": {
    "expectedGeneration": 2,
    "targetGeneration": 1,
    "mutationId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "changedAtMs": 1785254600000
  }
}
```

回退成功创建 generation 3，generation 不倒退。随后以
`expectedGeneration=3` 重新运行 preflight 和 compose-apply。此操作只恢复 desired
image，不降级或恢复 SQLite；旧 image 的 OCI compatibility window 必须覆盖
preflight 实际观察到的当前数据库 capability，write contract 也必须与当前 durable
contract 精确相等。任何 stale generation、revision/lock/stage/snapshot 漂移都应
保留现场并原样重放当前 in-flight command，不要手工删除 lock、receipt、snapshot
或历史文件。

preflight 不联网、不 pull image、不启动或停止容器。exact RepoDigest 必须已经由
operator 在 D-186 签名/attestation 验证后显式 pull 到同一个 Docker socket；tag、
image ID、其他 Docker context 或调用方手写兼容标签均不接受。

### 显式收集已终结的 Compose 恢复证据

不要手工删除 `rollout-backups/*.sqlite` 或
`restore-safeguards/*.sqlite`。只有 rollout 已有 terminal receipt，或 restore 已有
commit receipt，并且没有 `.compose-revision.lock`、`.compose-rollout.lock`、
`.compose-restore.lock` 时，才可创建 collection prepare command。

Edge 单次只能选 1 个文件，且收集后至少保留 2 个 rollout backup 或 1 个 restore
safeguard；Standalone 单次最多 4 个，保留底线为 4/2。每一类必须从最老的 receipt
开始连续选择，不能跳过旧 UUID 删除较新的证据。

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.compose.evidence-collection.prepare",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "allowRootService": false
  },
  "request": {
    "expectedGeneration": 4,
    "collectionId": "REPLACE_WITH_NEW_UUID_V4",
    "rolloutIds": ["REPLACE_WITH_OLDEST_TERMINAL_ROLLOUT_UUID_V4"],
    "restoreIds": [],
    "preparedAtMs": 1785254800000
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-compose-collect-prepare.json
ql3-local-deploy compose-evidence-collect-prepare \
  --command-file /secure/operator/qinglong3-compose-collect-prepare.json
```

prepare 返回 `status=prepared` 时不会移动或删除 snapshot；结果中的 counts/bytes
可用于最终确认。此时 collection lock 会阻止 image revision、rollout 和 restore。
不要改动候选文件、receipt、selection 或 lock。确认后使用同一 collection ID 和
generation 提交：

```json
{
  "schemaVersion": 1,
  "operation": "local.deployment.compose.evidence-collection.commit",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "allowRootService": false
  },
  "request": {
    "expectedGeneration": 4,
    "collectionId": "REPLACE_WITH_THE_SAME_UUID_V4",
    "committedAtMs": 1785254800001
  }
}
```

```sh
chmod 0600 /secure/operator/qinglong3-compose-collect-commit.json
ql3-local-deploy compose-evidence-collect-commit \
  --command-file /secure/operator/qinglong3-compose-collect-commit.json
```

commit 不连接 Docker，不停止或启动服务。它先把大文件 rename 到确定性 stage，
发布绑定 source receipt digest 和完整 SQLite facts 的小型 tombstone/commit
receipt，最后 unlink stage。命令结果未知时只能原样重放；`status=existing` 表示
原提交已持久化并完成残留 stage/lock 清理。

收集后，旧 `compose-apply` 和 `compose-restore-commit` command 仍应原样可回放：
前者不会重新执行 Compose up，后者会把缺失的大文件报告为
`source|safeguard=collected` 并保持 `service.state=unchanged`。tombstone、prepare/
commit receipt 都是回放证据，不得删除或编辑。当前没有自动 collection，也没有
tombstone compaction；物理断电或闪存寿命结论仍需独立设备门禁。

### 在物理 Edge 候选机记录跨启动 collection 证据

该流程只用于可丢弃的发布候选测试分区，不能指向生产
`/opt/qinglong3`。先准备专用、读写、当前测试 UID 拥有且 mode `0700` 的 Linux
mountpoint；mount source 必须直接解析到 `/dev/*`。manifest、session、output
均为当前 UID 的 `0600` 文件或待创建路径，并且 session/output 必须留在同一
mountpoint 内。MTD/UBI/UBIFS 不适用本流程，不得把它们的计数换算成本流程阈值。

manifest 示例：

```json
{
  "schemaVersion": 1,
  "evidenceClass": "physical_edge_compose_storage_candidate",
  "profile": "edge",
  "deviceId": "router-a1",
  "expectedArchitecture": "arm64",
  "expectedFilesystem": "ext4",
  "snapshotCount": 3,
  "databasePayloadBytes": 4194304,
  "maximumPrepareWriteAmplificationPermille": 50000,
  "maximumResumeWriteAmplificationPermille": 50000
}
```

阈值是该固定设备/文件系统候选的显式准入预算，不是全设备默认值。构建 package 后
执行 prepare：

```sh
pnpm run build:packages:ql3
pnpm evidence:physical-edge-compose-storage -- prepare \
  --manifest=/mnt/ql3-evidence/manifests/compose-storage.json \
  --data-path=/mnt/ql3-evidence \
  --session=/mnt/ql3-evidence/reports/compose-storage-session.json \
  --json
```

只有输出 `status=awaiting_external_reboot` 才能进入下一步。不要编辑 session、
scratch deployment 或 `.ql3-collection-stage`；工具不会自动重启。由 operator 在
工具之外执行正常设备重启，然后在新 boot 运行：

```sh
pnpm evidence:physical-edge-compose-storage -- resume \
  --manifest=/mnt/ql3-evidence/manifests/compose-storage.json \
  --session=/mnt/ql3-evidence/reports/compose-storage-session.json \
  --output=/mnt/ql3-evidence/reports/compose-storage-report.json \
  --json
```

resume 要求不同 boot ID、相同 UID/block device/架构/文件系统，并以正式
collection commit + exact replay 验证 SQLite、tombstone、stage 清理、两份
snapshot 保留和 allocated-byte 回收。任一漂移或阈值超限都返回失败，现场应保留
用于诊断。

报告始终 `supported=false`。prepare 数值不含最后的 session 文件发布，resume
数值不含设备启动本身；两者只是各自 boot 内 production recovery 操作的 partition
写入上界，不能跨 boot 相减，也不能称为突然断电、NAND/FTL 写放大或寿命证据。
完成后用基础 physical Edge recorder 的
`--compose-storage-evidence=<absolute-report-path>` 导入；即使导入通过，
`power_loss_restart` 仍必须由独立受控断电协议证明。

### 在物理 Edge 候选机记录 Native Application 首次 Active

该流程覆盖不安装 Docker 的 OpenRC/native Edge，但只允许使用最终
AI-excluded production package closure，不得把 workspace source 目录当成 release
artifact。artifact root 可以由 root 或测试 UID 拥有，但整个 tree 必须无 symlink/
hard link、group/other 不可写。先生成 inventory：

```sh
pnpm evidence:physical-edge-application-start -- inspect \
  --artifact-root=/opt/qinglong3-release \
  --json
```

把输出中的 `artifactSha256`、`artifactFiles`、`artifactBytes` 和 Node `sha256`
写入私有 `0600` manifest：

```json
{
  "schemaVersion": 1,
  "evidenceClass": "physical_edge_application_start_candidate",
  "profile": "edge",
  "deviceId": "router-a1",
  "expectedArchitecture": "arm64",
  "expectedFilesystem": "ext4",
  "expectedArtifactSha256": "REPLACE_WITH_64_HEX",
  "expectedArtifactFiles": 629,
  "expectedArtifactBytes": 5066155,
  "expectedNodeSha256": "REPLACE_WITH_64_HEX",
  "maximumBootAgeMs": 180000,
  "maximumFirstActiveMs": 30000,
  "maximumSampledRssBytes": 268435456,
  "sampleIntervalMs": 10
}
```

数字必须由该设备上的 inspect 和历史基线审查产生，示例不是全设备默认支持值。
data path 应是当前测试 UID 的 canonical `0700` 可丢弃目录。执行：

```sh
pnpm run build:packages:ql3
pnpm evidence:physical-edge-application-start -- prepare \
  --manifest=/opt/qinglong/evidence/application-start-manifest.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --artifact-root=/opt/qinglong3-release \
  --session=/opt/qinglong/evidence-scratch/application-start-session.json \
  --json
```

只有 `status=awaiting_external_reboot` 才能继续。工具不会安装 OpenRC service 或
自动重启；operator 在工具外重启设备，并在 `maximumBootAgeMs` 内运行：

```sh
pnpm evidence:physical-edge-application-start -- resume \
  --manifest=/opt/qinglong/evidence/application-start-manifest.json \
  --session=/opt/qinglong/evidence-scratch/application-start-session.json \
  --output=/opt/qinglong/evidence-scratch/application-start-report.json \
  --json
```

resume 启动正式 `ql3-local-application` CLI，要求唯一 `event=active`、
`aiStatus=deployment_excluded`，随后 SIGTERM graceful stop、exit 0、零 stderr 与
SQLite v35。报告中的 RSS 和 I/O 是从首个成功 `/proc` sample 到 active 的采样量；
recorder Node 已经预热 Node binary，安全 metadata preflight 也会预热目录/inode。
因此它不能被命名为完整 cold boot。基础报告用
`--application-start-evidence=<absolute-report-path>` 导入后仍要求
`power_on_cold_node_and_service_manager_start_to_first_ready`、release signature、
断电及 whole-device 资源证据。

### 在物理 Edge 候选机记录 Init-managed 首次 Active

该流程是 ADR-0205 的独立候选门，不覆盖或修改上一节的 warm-Node 报告。它只适合
可丢弃的物理 Linux 候选机；不要在生产实例、远程无人值守路由器或无法进入本地
recovery console 的设备上执行。

先运行相同 release root 的 inspect，把输出 artifact/Node identity 写入当前 UID
拥有的私有 `0600` manifest：

```sh
pnpm evidence:physical-edge-service-start -- inspect \
  --artifact-root=/opt/qinglong3-release \
  --json
```

systemd 示例；OpenRC 只把 `serviceManager` 改为 `openrc`：

```json
{
  "schemaVersion": 1,
  "evidenceClass": "physical_edge_service_start_candidate",
  "profile": "edge",
  "deviceId": "router-a1",
  "serviceManager": "systemd",
  "expectedArchitecture": "arm64",
  "expectedFilesystem": "ext4",
  "expectedArtifactSha256": "REPLACE_WITH_64_HEX",
  "expectedArtifactFiles": 629,
  "expectedArtifactBytes": 5066155,
  "expectedNodeSha256": "REPLACE_WITH_64_HEX",
  "maximumBootToActiveMs": 180000,
  "maximumServiceStartBootAgeMs": 60000,
  "maximumServiceStartToActiveMs": 30000
}
```

三个时延预算必须来自同型号设备的已审查基线。`maximumBootToActiveMs` 的起点是
Linux kernel uptime，不是 firmware 电源事件。准备专用、当前测试 UID 拥有且 mode
`0700` 的 data path，然后执行：

```sh
pnpm run build:packages:ql3
pnpm evidence:physical-edge-service-start -- prepare \
  --manifest=/opt/qinglong/evidence/service-start-manifest.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --artifact-root=/opt/qinglong3-release \
  --session=/opt/qinglong/evidence-scratch/service-start-session.json \
  --json
```

prepare 不会修改 `/etc` 或 service manager。只有输出
`status=awaiting_operator_install_enable_and_reboot` 才能继续。operator 必须审查
输出中的：

- `descriptorSource`、`descriptorDestination` 与 `descriptorSha256`；
- root owner/group、目标 mode 和 `install.arguments`；
- `enable.executable` 与逐参数 `enable.arguments`；
- 随机化的 `qinglong3-physical-<8hex>` service name。

以设备受审的 root 文件安装工具实现相同 owner/mode/source/destination 语义，并在
安装后重新核对 SHA-256。然后按输出的 manager/arguments enable；systemd 还需要在
enable 前执行受审的 `daemon-reload`。不要在命令中改写 service name、路径或
参数。工具不会替 operator 执行这些步骤。

正常重启设备。不要先手工启动 service；证据要求由新 boot 的 init 启动。在同一
boot 内、测试 service 仍保持 active 时，以 prepare 时的同一测试 UID 执行：

```sh
pnpm evidence:physical-edge-service-start -- resume \
  --manifest=/opt/qinglong/evidence/service-start-manifest.json \
  --session=/opt/qinglong/evidence-scratch/service-start-session.json \
  --output=/opt/qinglong/evidence-scratch/service-start-report.json \
  --json
```

resume 只读检查已安装 descriptor、systemd/OpenRC active+enabled、wrapper/Node
实时进程树、唯一 official active ordinal、artifact 和预算，然后 no-replace 发布
报告。它不会停止、disable 或删除测试 service。报告保存后，operator 应先用本地
console 按设备流程 stop/disable，再删除 exact session 指定的 descriptor 和
scratch deployment；不要使用通配符。清理步骤不属于证据报告，必须单独记录。

基础 physical Edge recorder 使用：

```sh
--service-start-evidence=/opt/qinglong/evidence-scratch/service-start-report.json
```

导入后增加
`kernel_boot_to_init_managed_native_application_active`，但仍保留
`firmware_and_bootloader_power_on_to_linux_kernel_clock` 与
`direct_release_unit_without_evidence_wrapper`。该结果也不证明 exclusive cold
page cache、service graceful stop、断电、Compose 或 release signature。

### 在物理 Edge 候选机记录直连 Release Unit 首次 Active

该流程关闭上一节的 evidence-wrapper 等价缺口。它必须使用新的 scratch
deployment 和固定 `qinglong3` service name，不能复用或覆盖 D-195 session。正式 descriptor
直接执行 exact Node binary 与 local-application CLI。

先 inspect：

```sh
pnpm evidence:physical-edge-direct-service-start -- inspect \
  --artifact-root=/opt/qinglong3-release \
  --json
```

创建当前 UID `0600` manifest；artifact/Node 数值必须来自该机 inspect：

```json
{
  "schemaVersion": 1,
  "evidenceClass": "physical_edge_direct_service_start_candidate",
  "profile": "edge",
  "deviceId": "router-a1",
  "serviceManager": "systemd",
  "expectedArchitecture": "arm64",
  "expectedFilesystem": "ext4",
  "expectedArtifactSha256": "REPLACE_WITH_64_HEX",
  "expectedArtifactFiles": 629,
  "expectedArtifactBytes": 5066155,
  "expectedNodeSha256": "REPLACE_WITH_64_HEX",
  "maximumBootToActiveMs": 180000,
  "maximumServiceStartBootAgeMs": 60000,
  "maximumServiceStartToActiveMs": 30000
}
```

OpenRC 只把 `serviceManager` 改为 `openrc`。准备：

```sh
pnpm run build:packages:ql3
pnpm evidence:physical-edge-direct-service-start -- prepare \
  --manifest=/opt/qinglong/evidence/direct-service-start-manifest.json \
  --data-path=/opt/qinglong/evidence-scratch \
  --artifact-root=/opt/qinglong3-release \
  --session=/opt/qinglong/evidence-scratch/direct-service-start-session.json \
  --root-command-output=/opt/qinglong/evidence-scratch/direct-service-start-root-command.json \
  --json
```

prepare 不修改 `/etc` 或 init manager。operator 必须逐项审查输出的 source、
destination、SHA-256、root install mode、固定 `qinglong3` service 名称与 manager
可执行文件。`--root-command-output` 以当前 Owner UID、`0600`、no-replace 写出与
stdout 中 `rootBridgeCommand` 完全相同的 handoff；不要手工摘抄或修改 JSON。

root operator 必须在 canonical root-owned `0700` 目录中，以受审的 no-replace 文件
安装工具把该 handoff 安装为 root-owned `0600` 文件，并在执行前复核源/目标 SHA-256
完全相同。然后以 root 执行 release 自带的 bridge：

```sh
ql3-service-bridge run --command-file \
  /run/qinglong3-evidence/direct-service-start-root-command.json
```

只有返回 `operation=local.deployment.service-manager.execute`、`state=active` 才能继续；
`manual_required` 必须停止采集并保留现场。bridge 负责 exact descriptor install、
enable 与 start，systemd 的 `daemon-reload` 也在同一受审路径内完成；不要另外执行
manager start/enable 来绕过 Owner intent/outcome。正常重启后，在同一测试 UID 下执行：

```sh
pnpm evidence:physical-edge-direct-service-start -- resume \
  --manifest=/opt/qinglong/evidence/direct-service-start-manifest.json \
  --session=/opt/qinglong/evidence-scratch/direct-service-start-session.json \
  --output=/opt/qinglong/evidence-scratch/direct-service-start-report.json \
  --json
```

resume 要求不同 boot、零 VM/container 指示、exact root-owned descriptor、current
startup receipt、live Node identity 和 init supervision。systemd 还交叉核对
`MainPID`/`ExecMainStartTimestampMonotonic`；OpenRC 交叉核对 default runlevel 与
`supervise-daemon` parent。clock tick rate 直接来自 `/proc/self/auxv`
`AT_CLKTCK`，不要求 OpenWrt/BusyBox 额外提供 `getconf`。start resume 本身不会
stop、disable 或清理；若要形成 graceful-stop 配对证据，必须立即继续下一段，不能
先重启、手工 stop 或删除 session。

基础 recorder 导入：

```sh
--direct-service-start-evidence=/opt/qinglong/evidence-scratch/direct-service-start-report.json
```

通过后增加
`kernel_boot_to_direct_init_managed_release_application_active`，并移除
`direct_release_unit_without_evidence_wrapper`；仍保留
`firmware_and_bootloader_power_on_to_linux_kernel_clock`。receipt 的单次
4 KiB logical 上限不是 whole-device/FTL 写放大证据，报告仍为
`supported=false`。

### 在同一物理 Edge 候选机记录直连 Release Unit Graceful Stop

该流程必须紧接上一段成功的 direct start resume，在同一设备、同一 boot、同一
Owner UID、同一 start session 和仍然 active+enabled 的 exact service 上执行。它不接受
普通 service-start report，也不能用重新启动后的新进程替换 active report 中的
PID/start identity。

先由 Owner UID 发布 fresh stop intent、stop session 与精确 root bridge handoff：

```sh
pnpm evidence:physical-edge-direct-service-stop -- prepare \
  --manifest=/opt/qinglong/evidence/direct-service-start-manifest.json \
  --session=/opt/qinglong/evidence-scratch/direct-service-start-session.json \
  --active-report=/opt/qinglong/evidence-scratch/direct-service-start-report.json \
  --stop-session=/opt/qinglong/evidence-scratch/direct-service-stop-session.json \
  --root-command-output=/opt/qinglong/evidence-scratch/direct-service-stop-root-command.json \
  --json
```

只有 `status=awaiting_root_service_bridge_stop` 才能继续。与 start 一样，root operator
必须把 handoff no-replace 安装到 canonical root-owned `0700` 目录中的 root-owned
`0600` 文件，复核源/目标 SHA-256 一致后执行：

```sh
ql3-service-bridge run --command-file \
  /run/qinglong3-evidence/direct-service-stop-root-command.json
```

只有 bridge 返回 `state=stopped` 才能 resume。此时不得 disable、删除 descriptor、
删除 shutdown receipt 或重启设备；证据要求 service 已 inactive 但仍 enabled，并要求
Application 已在 SIGTERM graceful drain 后发布与原 startup receipt、boot、PID/start、
Node identity 绑定的 `<application-config>.stopped.json`。仍由原 Owner UID 执行：

```sh
pnpm evidence:physical-edge-direct-service-stop -- resume \
  --manifest=/opt/qinglong/evidence/direct-service-start-manifest.json \
  --session=/opt/qinglong/evidence-scratch/direct-service-start-session.json \
  --active-report=/opt/qinglong/evidence-scratch/direct-service-start-report.json \
  --stop-session=/opt/qinglong/evidence-scratch/direct-service-stop-session.json \
  --output=/opt/qinglong/evidence-scratch/direct-service-stop-report.json \
  --json
```

统一 physical recorder 必须同时导入配对报告：

```sh
--direct-service-start-evidence=/opt/qinglong/evidence-scratch/direct-service-start-report.json
--direct-service-stop-evidence=/opt/qinglong/evidence-scratch/direct-service-stop-report.json
```

只有两份报告的 manifest、direct session、active report、boot、startup receipt 与
PID/start identity 全部精确匹配，聚合器才增加
`init_managed_graceful_application_stop`。stop report 仍为 `supported=false`，不证明
disable/descriptor removal、突然断电、firmware shutdown、whole-device flash 写放大或
release signature。报告成功保存并完成聚合后，operator 才可按受审流程 disable，删除
exact descriptor、root handoff 与 scratch deployment；不要使用通配符。

### 绑定物理报告、Release Archive 与源码 Revision

统一 physical report 已通过且包含 direct release start 后，才能执行 release
attestation。QingLong 只生成和验证 payload；发布私钥必须留在外部 HSM、KMS 或离线
签名环境。先以最终待发布 archive 和 exact 40 位小写 Git revision 生成 payload：

```sh
pnpm evidence:physical-edge-release -- prepare \
  --physical-report=/opt/qinglong/evidence/physical.json \
  --release-archive=/opt/qinglong/releases/qinglong3-edge.tar.gz \
  --repository=https://github.com/whyour/qinglong.git \
  --revision=<40-lowercase-git-revision> \
  --payload=/opt/qinglong/evidence/release-payload.json \
  --json
```

必须签署 `release-payload.json` 的原始字节，不能重新格式化或追加换行。将 64-byte
Ed25519 detached signature 安全传回设备并设为当前 UID `0600`；固定公钥可以只读，但
不得 group/other writable。随后重新指定期望 source，完成 verify-only finalization：

```sh
pnpm evidence:physical-edge-release -- finalize \
  --physical-report=/opt/qinglong/evidence/physical.json \
  --release-archive=/opt/qinglong/releases/qinglong3-edge.tar.gz \
  --payload=/opt/qinglong/evidence/release-payload.json \
  --signature=/opt/qinglong/evidence/release-payload.sig \
  --trusted-public-key=/etc/qinglong/release-ed25519.pub \
  --expected-repository=https://github.com/whyour/qinglong.git \
  --expected-revision=<40-lowercase-git-revision> \
  --output=/opt/qinglong/evidence/physical-release-evidence.json \
  --json
```

archive、payload、报告或 source revision 任一改变都必须重新 prepare 和外部签名，不能
复用旧 signature。验签成功只增加
`release_archive_signature_or_attestation`；输出仍是 `supported=false`，不得据此跳过
firmware/bootloader、整机写入、migration、断电或固定设备矩阵。公钥轮换/撤销与签名
透明记录由发布流程单独管理。

## 7. 后续 Owner ceremony

deployment prepare 只创建存储、Owner pepper 主备和 Local Secret keyring，不会
建立身份或抢占 Owner。服务启动前后均可按既有 `ql3-owner` 私有 command-file
流程完成 Identity provision、challenge、Owner claim 与 delivery
acknowledgement。

停止服务后再维护数据库、pepper 或 Secret keyring；必须等待
`event=stopped`，不能把发送 `SIGTERM` 视为已经释放 authority。

## 8. 创建或轮换 Local Secret

完成 Owner claim 后，`ql3-secret` 可以创建或轮换本机 Secret。它是单命令、单进程
authority，不会进入常驻 application，也不会启动端口、timer 或 watcher。

先在 deployment root 下创建当前 UID `0700` 的 operator input 目录。Secret value
文件必须是 `0600` exact-shape JSON；优先把该目录放在 tmpfs，尤其不要把“删除”
误当作路由器闪存上的安全擦除：

```json
{
  "schemaVersion": 1,
  "kind": "qinglong3-local-secret-value",
  "value": "REPLACE_WITH_SECRET_VALUE"
}
```

command file 不含 plaintext，只引用 value file：

```json
{
  "schemaVersion": 1,
  "operation": "secret.put",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "databasePath": "/opt/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-peppers",
    "credentialFilePath": "/opt/qinglong3/operator-input/owner-credential.json",
    "secretKeyringPath": "/opt/qinglong3/local-secret-keyring.json",
    "busyTimeoutMs": 100
  },
  "request": {
    "projectId": "default",
    "name": "EXAMPLE_TOKEN",
    "secretValueFilePath": "/opt/qinglong3/operator-input/example-token.value.json",
    "mutationId": "REPLACE_WITH_UUID_V4",
    "requestId": "secret-example-token-v1",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "expectedCurrentVersion": 0
  }
}
```

执行：

```sh
chmod 0600 \
  /opt/qinglong3/operator-input/example-token.value.json \
  /opt/qinglong3/operator-input/secret-put.json
ql3-secret run \
  --command-file /opt/qinglong3/operator-input/secret-put.json
```

创建使用 `expectedCurrentVersion: 0`；轮换必须填写当前精确版本，例如从 v1 轮换为
v2 时填写 `1` 并使用新的 mutation/failure-audit UUID。返回值只有
`inserted|existing`、version 和 opaque SecretRef，不包含 plaintext、credential、
key material 或文件路径。

如果调用结果未知，保留 command/value file 并原样重跑；不要更换 mutation ID
“重试”。确认 `inserted` 或 `existing` 后再删除 exact value file。CLI 不提供
decrypt、list-all、delete、key rotation 或远程 HTTP 入口；Secret keyring 自身的
维护仍必须停服务并遵守上一节的 authority 释放要求。

## 9. 授予、更新或撤销 Project Role

`ql3-policy` 只管理已经存在的 Project 和已经完成 Identity ceremony 的主体。它不
创建 User，也不签发 credential。command file 必须位于 deployment root 下、由当前
UID 持有并为 `0600`。

授予或更新 RoleBinding：

```json
{
  "schemaVersion": 1,
  "operation": "policy.role-binding.put",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "databasePath": "/opt/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-peppers",
    "credentialFilePath": "/opt/qinglong3/operator-input/owner-credential.json",
    "busyTimeoutMs": 100
  },
  "request": {
    "projectId": "default",
    "target": {
      "type": "user",
      "id": "operator-user"
    },
    "role": "operator",
    "mutationId": "REPLACE_WITH_UUID_V4",
    "requestId": "default-operator-user-v1",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "expectedCurrentVersion": 0
  }
}
```

执行：

```sh
chmod 0600 /opt/qinglong3/operator-input/policy-role-put.json
ql3-policy run \
  --command-file /opt/qinglong3/operator-input/policy-role-put.json
```

后续修改必须填写该 target 的当前精确版本并使用新的两个 UUID。撤销时 operation
改成 `policy.role-binding.revoke`、删除 `role` 字段，其余 identity 保持明确：

```json
{
  "projectId": "default",
  "target": {
    "type": "user",
    "id": "operator-user"
  },
  "mutationId": "REPLACE_WITH_UUID_V4",
  "requestId": "default-operator-user-revoke-v2",
  "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
  "expectedCurrentVersion": 1
}
```

若结果未知，必须原样重跑同一 command file。不要更换 mutation ID 猜测重试。

Owner 交接必须严格按以下顺序：

1. 为目标 User 完成 active Identity 与 credential ceremony；
2. 用目标 credential 实际完成一次认证；
3. 由当前 Owner 用 `policy.role-binding.put` 授予目标 `owner`；
4. 再次用目标 Owner credential 验证；
5. 最后用新的 mutation 执行原 Owner 的 revoke。

系统会拒绝没有 active credential 的 owner target，也会拒绝撤销最后一个最新
active User owner。admin/operator/viewer 不能执行 RoleBinding 管理，admin 也不能
借此自提升。该 CLI 不适用于 Cluster 节点的远程 Role 管理。
