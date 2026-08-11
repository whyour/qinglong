# ADR-0199：Generation-Fenced 本机 Compose Rollout

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-184、D-187、D-188、D-189
- 关联 ADR：ADR-0194、ADR-0197、ADR-0198

## 背景

ADR-0198 能证明本机 exact digest、当前 SQLite 和 Compose 合并结果兼容，但
`docker compose up -d` 的成功只表示 daemon 接受了创建请求，不表示应用完成存储、
Secret、Scheduler、Executor 和 Plugin Package recovery 激活。Docker 与 SQLite 也
不存在可同时提交 selection、容器状态和部署回执的事务。

因此 rollout 必须显式处理四个窗口：preflight 后 generation 被并发切换、候选容器
启动后没有 active、rollback selection 已提交但容器尚未恢复，以及 receipt 已落盘
但调用方没有收到响应。

## 决策

### 1. 复用现有部署 CLI，不拆新 package

入口为：

```text
ql3-local-deploy compose-apply --command-file /absolute/private-command.json
```

command 固定包含 deployment root、canonical Docker executable、explicit canonical
Unix socket、root acknowledgement、expected generation、rollout UUID、开始时间和
一组预授权的 failure rollback mutation/time。CLI 不接受 shell command、Compose
额外参数、健康字符串、image、container ID 或 caller 声明的 compatibility。

Docker 调用复用一个部署包内部 runner：显式 `--host unix://...`、一次性 `0700`
空 config、清理 proxy/context 环境、bounded output/timeout。该实现仍属于已有
`local-owner-cli` 的部署内聚模块，不形成新 workspace package 或常驻进程。

### 2. Rollout lock 与 revision CAS 双向 fencing

每次 apply 先以 normalized command 的 exact bytes 获取
`service/.compose-rollout.lock`。普通 `compose-revision` 在该锁存在时失败关闭；
只有同一 apply 的失败恢复可携带 exact lock intent 推进 rollback generation。

apply 获取锁后再次检查 active selection 与 immutable revision。正常路径只接受
expected generation；恢复路径只接受 `expected+1`、previous 指回 attempted
generation、rollback target 等于 attempted previous，且 mutation 等于 command
预授权值。其他状态均不能猜测。

### 3. Active 是应用事件，不是容器 Running

成功 apply 固定使用两个正式 Compose 文件，并增加：

```text
--detach --force-recreate --no-build --pull never --remove-orphans
```

随后只观察新 service container，逐项复核：

- container ID 与 Running 状态；
- exact `Config.Image`；
- generation/mutation labels；
- read-only rootfs、network none、非 privileged；
- 应用 stdout 中 schema v1、正确 Profile、AI excluded 的结构化 `active` 事件。

Edge 窗口固定 30 秒，Standalone 固定 60 秒；轮询次数同时有上限。没有
`active`、Docker 命令失败或 container identity 漂移都按候选失败处理，不能由
Compose restart policy 掩盖。

### 4. 失败是 generation-forward recovery

若 attempted generation 有 previous generation，控制器使用 command 中预授权的
mutation/time调用既有 rollback CAS，创建 `attempted+1` generation，image 来自私有
immutable历史 revision。随后对新 generation 重新执行完整 preflight、Compose
apply和 active 验证。

若初始 generation 没有 previous，控制器显式 stop，结果为 `failed_stopped`。旧
digest rollback 也无法 active 时，不写成功/回退 receipt、不删除 rollout lock，
由 operator 保留现场并原样重放。

返回语义：

- `active`：候选 generation 正常；
- `rolled_back`：坏候选已隔离，新的 rollback generation active；
- `failed_stopped`：没有可恢复历史，service 已停止。

后两者 CLI 输出结构化结果但退出码为 2，避免自动化把已恢复的失败候选误报为发布
成功。

### 5. Receipt 是确定性私有事实

`service/rollouts/<rolloutId>.json` 为当前 UID、`0600`、no-replace 的 canonical
receipt，绑定 normalized command digest、attempted/final generation、结果和
active event digest。recorded time 取 command 已授权的 rollback time，因此
stage/rename/fsync 任一窗口重放都生成相同 bytes。

receipt 已存在时先严格复核完整 shape、canonical bytes、command digest 与结果内部
一致性，然后直接返回，不再次操作 Docker。receipt 已发布但 lock 未清理时，同一
命令只清理 exact lock。rollback selection 已推进而 receipt 缺失时，同一命令只
继续 rollback apply，不重新启动失败候选。

## 发布门

`ql3-local-compose-rollout-live-contract.cjs` 对 release pushed local digest 的 Edge
和 Standalone 分别创建 fresh authority、运行真实 compose-apply、验证私有
receipt，再发送 SIGTERM，要求应用发布 `event=stopped` 且
`stopResult=stopped`，最后 `compose down`。任一 Profile 失败会阻断共享 image
release workflow。

## 验收证据

- `local-owner-cli` 40/40；
- image release contract 20/20；
- 22 importer dependency/source audit 和 Edge import audit 零 finding；
- workspace 保持 22 packages，无新增生产依赖；
- arm64 Docker Compose v5.3.1 上，Edge 128 MiB/64 PID 与 Standalone
  256 MiB/256 PID 对 localhost exact manifest `sha256:e696…9b70` 均返回
  rollout active、durable receipt、graceful cleanup；
- 清理后没有遗留带 QingLong deployment generation label 的容器。

本机 localhost digest 只是 live evidence，不替代 GHCR 双架构 manifest、签名和
attestation 的正式 release 记录。

## 未包含

- migration 前 backup、写后 SQLite capability 与旧 image 的数据回退判定；
- Docker daemon/主机断电、ENOSPC 和 stage/fsync 实机 fault matrix；
- systemd/OpenRC install、enable、健康与 rollback；
- 正式 GHCR release 成功记录和物理路由器长期资源证据。
