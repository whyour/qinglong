# ADR-0198：绑定 Digest 的本机 Compose Rollout Preflight

- 状态：Accepted（只读 preflight 已实现；真实 apply/健康处置见 ADR-0199）
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-184、D-185、D-186、D-187、D-188
- 关联 ADR：ADR-0194、ADR-0195、ADR-0196、ADR-0197

## 背景

ADR-0197 已把 desired image 切换收敛为 generation CAS，但“某个 digest 已签名”和
“该 image 能安全打开当前 deployment”是两种不同事实。旧 image 可能只支持较早
SQLite capability；本机 tag/image ID 可能没有 registry identity；Compose 两个文件
也可能被错误顺序、错误 project 或错误 daemon 解释。

原 Compose descriptor 未声明 project name。Compose 默认从配置目录名派生 project，
所有标准 deployment 都位于名为 `service` 的目录，因此同一 Docker daemon 上的多个
QingLong 实例可能共享 project identity。

在没有这些事实时直接实现自动 `up` 或自动 rollback，会把镜像供应链、Docker
副作用、SQLite migration 和健康判断错误地包装成一个不存在的事务。

## 决策

### 1. Image config 声明可审计兼容窗口

AI-excluded local image 固定增加：

```text
io.qinglong.local.application-config=2
io.qinglong.local.compose-selection=1
io.qinglong.local.sqlite-contract-min=35
io.qinglong.local.sqlite-contract-max=35
```

同时保留并复核 `io.qinglong.profile=edge,standalone`、
`io.qinglong.ai=excluded`、OCI source/revision/version、numeric
`65532:65532` 和唯一 entrypoint。min/max 是该 image 可打开的 SQLite contract
闭区间，不是“最新版本”提示；当前 image 只接受 exact v35。

这些 label 同时进入：

- Dockerfile 静态 mutation audit；
- native amd64/arm64 image inspect；
- OCI layout 双平台 config exact audit；
- pushed digest 的 release preflight。

调用方 command 中不得复制或声明这些 label。preflight 只信 Docker daemon 对 exact
RepoDigest 返回的 image config。

### 2. Project 与容器 revision 身份稳定

基础 `compose.yaml` 的 top-level `name` 从 instance ID 生成：

```text
ql3-<bounded-slug>-<domain-separated-sha256-prefix>
```

`.` 会转为 `-`，摘要关闭 slug 碰撞。名称不依赖 deployment root，目录移动不会静默
创建第二个 project；重复 instance ID 也不会在同一 daemon 上被当作两个实例。

`compose.image.yaml` 除 exact image 外，向 `qinglong3` service 写入：

```text
io.qinglong.deployment.generation
io.qinglong.deployment.mutation
```

两者由 canonical selection 重复派生并在解析时交叉复核，不能由 operator 单独填写。
后续 apply/recovery 可据此识别 container 对应的 durable desired revision。

### 3. Preflight 是现有短生命周期 CLI 的只读操作

入口继续复用现有 package 和 binary：

```text
ql3-local-deploy compose-preflight \
  --command-file /absolute/private-command.json
```

command 只含 deployment root、canonical Docker executable、canonical Unix socket、
root acknowledgement 和 expected generation。Docker executable 必须是 root 或当前
UID 拥有、不可 group/world write 的 canonical regular executable。socket 必须是
root 或当前 UID 拥有、非 symlink、非 world-writable 的 canonical Unix socket。
CLI 不使用 ambient Docker context。

检查顺序：

1. 复核 deployment/service/revision 目录与 active/archive exact；
2. 从 application v2 读取 instance/Profile/busy timeout，再用正式 renderer 重建并
   byte-exact 复核 application config 与 Compose descriptor；
3. 对 host SQLite 执行完整 read-only readiness：quick/foreign-key check、70 条
   migration history、schema、Plugin Package evidence 与 contract v35；
4. 以显式 `--host unix://...` 和一次性 `0700` 空 Docker config 执行
   `image inspect`；要求本地 RepoDigests 包含 active exact reference，并复核
   OS/arch/user/entrypoint/source/revision/version/Profile/AI 与 compatibility labels；
5. 对 base + selection 执行真实 `docker compose config --format json`，精确复核
   project、image、generation/mutation label、UID:GID、read-only root、network
   none、drop ALL、no-new-privileges、memory/PID、command、唯一 bind 和 tmpfs。

成功输出仅含 ready、generation、Profile、SQLite contract、architecture 和 service
kind，不输出 root、socket、executable、image/digest 或 mutation。

### 4. Preflight 不执行 rollout

本命令不得：

- pull/build/push image；
- create/start/stop/restart/remove container；
- 打开可写 SQLite、执行 migration 或创建 backup；
- 写 deployment receipt、修改 selection 或自动 rollback；
- 把本地 registry evidence 宣称为正式 release。

正式 operator 仍须先完成 D-186 signature/attestation verify 和显式 pull，再运行本
门。共享 release workflow 对 local pushed digest 的只读检查已由 ADR-0199 的 Edge
与 Standalone 真实 rollout gate 包含并加强。

## 验收

- application config v2、selection v1、SQLite `35..35` 四项 label 在
  Dockerfile/native image/OCI layout/release workflow 中锁定；
- Compose project name 对 instance 稳定，selection label 与 generation/mutation
  exact；
- stale generation、active/archive/config/descriptor drift、非 socket、错误
  RepoDigest、标签窗口或 Compose 合并均拒绝；
- 完整真实 SQLite v35 readiness 在 Docker 之前执行；
- CLI 输出低敏且不产生 Docker container 副作用；
- `local-owner-cli` 36/36、镜像/OCI/release 专项 36/36；
- arm64 Docker Compose v5.3.1 对 Edge/Standalone 的 localhost exact manifest
  live preflight 均 compatible；
- workspace 保持 22 packages，无新增生产依赖。

## 未包含

- `docker compose up`、active event、receipt 与失败 rollback（由 ADR-0199 实现）；
- SQLite migration 前 backup、写后 capability 识别和旧 image compatibility；
- systemd/OpenRC 制品 compatibility/preflight；
- 正式 GHCR 双架构 workflow 成功记录和物理路由设备门。
