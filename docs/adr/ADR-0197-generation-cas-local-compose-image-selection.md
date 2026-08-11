# ADR-0197：基于 Generation CAS 的本机 Compose 镜像选择

- 状态：Accepted（选择事务与产品 CLI 已实现；真实切流和设备门仍待完成）
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-184、D-185、D-186、D-187
- 关联 ADR：ADR-0194、ADR-0195、ADR-0196

## 背景

D-184 生成包含不可变镜像 digest 的 `compose.yaml`，适合首次部署，却把长期不应
变化的 sandbox、资源限制、volume 和网络策略与每次发布都变化的镜像选择放在同一
文件。直接允许覆盖该文件会同时扩大升级 authority，并且在进程中断、两个 operator
竞争或回退多代版本时无法区分安全模板漂移和合法镜像变化。

控制器若直接调用 `docker compose pull/up/down`，又会把本地文件提交、远端 registry、
Docker daemon、进程健康和 SQLite capability 合并成一个实际上不具备 ACID 的操作。
在路由设备上，这还会扩大短生命周期 CLI 的依赖和常驻成本。

## 决策

### 1. 稳定模板与可变选择分离

Compose 基础 descriptor 固定不携带 image；私有 selection 是第二个 override 文件：

```yaml
x-qinglong-image-selection:
  schema: qinglong/local-compose-image-selection@v1
  generation: 1
services:
  qinglong3:
    image: registry.example/qinglong3-local@sha256:...
```

operator 必须按固定顺序同时传入 `service/compose.yaml` 和私有
`service/compose.image.yaml`：

```text
docker compose \
  -f /opt/qinglong3/service/compose.yaml \
  -f /opt/qinglong3/service/compose.image.yaml ...
```

`compose.image.yaml` 是唯一活动镜像选择，权限为当前 UID `0600`。它同时记录 schema、
generation、previous generation、rollback target、mutation、变更时间和完整 OCI
digest。字段采用固定顺序和安全 YAML 子集；未知、重复、非 canonical 或 mutable
image 均拒绝。它不使用 Compose interpolation，因此 shell、`.env` 或 ambient
environment 不能覆盖 image authority。

ADR-0198 在不改变 selection authority 的前提下，为 service 重复派生
generation/mutation label，并为基础模板加入 instance-scoped project name；parser
要求 metadata 与 label exact 相等。

D-184 fresh prepare 为 Compose 创建 generation 1，并在
`service/revisions/1.yaml` 保存完全相同的不可变记录。revision 目录为当前 UID
`0700`。

### 2. Upgrade 和 rollback 都创建新 generation

入口继续属于既有 `@qinglong/local-owner-cli/local-deployment`：

```text
ql3-local-deploy compose-revision \
  --command-file /absolute/private-command.json
```

upgrade command 固定当前 `expectedGeneration`、新的 `@sha256` image、
UUID v4 mutation 和时间。rollback 不接受调用方重新提交旧 image，只接受小于当前
generation 的 `targetGeneration`；控制器从同一 revision 目录读取、复核并复制其
image。回退也创建新的 generation，而不是把 head 数字倒退，因此历史和 CAS 始终
单调。

每次操作最多读取当前 selection、一个 rollback target 和本次 revision，使用常数级
内存。generation 上限为 100,000；每代只增加一个不足 64 KiB、实际为数百字节的
私有文件，不引入数据库表、timer、watcher、listener、第三方依赖或第 23 个
workspace package。

### 3. 单文件原子切换和结果未知恢复

控制器按以下顺序执行：

1. 复核 deployment、service、revision 目录的 canonical/current-UID/`0700`
   identity；
2. 严格读取 active selection，要求当前 generation 等于 expected，或已经是同一
   mutation 的 exact next generation；
3. 以完整 normalized command 创建 deterministic no-replace lock；不同 intent
   冲突失败关闭；
4. 再读 active selection，关闭 lock 获取窗口中的变更；
5. no-replace 发布新的 immutable revision；
6. 在同一目录完整写入 stage、`fsync`，再次复核 expected active bytes，再以
   `rename` 原子替换 `compose.image.yaml` 并 `fsync` service 目录；
7. 精确复核并移除 command lock。

崩溃发生在 stage、revision publication、active rename 或 lock cleanup 窗口时，
operator 必须原样重放同一 command。若 active 已是 exact next selection，重放只补齐
缺失 revision/清理 lock 并返回 `existing`；不得换 mutation 或时间来猜测结果。
stale generation、active/revision/stage/lock 的 identity 或内容漂移均拒绝。

### 4. Selection activation 不等于运行中容器切流

本控制器明确不：

- 拉取、构建或验证镜像；
- 调用 Docker daemon 或 Compose；
- start、stop、restart 服务；
- 打开、迁移、备份或降级 SQLite；
- 删除历史 revision；
- 宣称旧 image 一定兼容当前数据库 capability。

operator 必须先按 D-186 验证 exact release digest 并预取镜像，再提交 selection，
检查 `docker compose ... config --images`，最后显式执行 `up -d` 并观察应用
`active`/`stopped` 事件。镜像选择回退只恢复 desired image，不等于数据回退；目标
image 与当前 SQLite capability 的兼容证据属于独立 release gate。

## 验收

- Compose fresh prepare 生成稳定模板、generation 1 active selection 和 immutable
  revision；
- upgrade `1 → 2`、exact replay 和 rollback `2 → 3(target=1)` 收敛；
- rollback 只读取历史 revision，历史 drift 拒绝；
- stale expected generation 和不同 command lock 拒绝；
- stage 与 active-switch response-loss 窗口可由原命令恢复；
- CLI 只接收私有 command file，输出仅含 operation/status/generation/kind；
- 本机 Docker Compose v5.3.1 双 `-f` `config --images` 精确返回 selection 中的
  digest；
- `local-owner-cli` 全量测试通过，workspace package 和生产依赖数量不变。

## 未包含

- 自动 Docker service activation 和健康回退；
- systemd/OpenRC 二进制或系统包 revision；
- SQLite schema/capability downgrade；
- remote signature verification 与真实 GHCR release；
- 路由器断电、ENOSPC、闪存寿命和镜像垃圾回收策略。
