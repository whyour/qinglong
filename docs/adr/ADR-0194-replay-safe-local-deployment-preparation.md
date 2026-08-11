# ADR-0194：可重放的本机部署准备与 Supervisor 描述符

- 状态：Accepted（systemd、OpenRC、Compose 部署准备器与真实 fresh setup
  已实现）
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-40、D-62、D-175、D-183、
  D-184
- 关联 ADR：ADR-0063、ADR-0066、ADR-0086、ADR-0088、ADR-0185、
  ADR-0193

## 背景

ADR-0193 已关闭 fresh 数据库与常驻 application 的语义缺口，但操作员仍需手工创建
八个私有目录、复制两份 JSON、选择资源上限并自行拼接 supervisor 命令。手工步骤
容易产生宽权限目录、host/container 路径混用、可变镜像 tag、错误的停止信号或把
初始化命令误当成常驻进程。

直接在 CLI 中调用 `systemctl enable`、`rc-update` 或 `docker compose up` 又会引入
宿主机全局副作用。服务管理器调用没有与 SQLite mutation 相同的事务和精确重放
语义，也会迫使测试以 root 权限修改真实系统状态。

## 决策

### 1. 部署准备仍属于现有短生命周期 Owner CLI

`@qinglong/local-owner-cli/local-deployment` 与 `ql3-local-deploy` 负责部署文件
准备，不新增 workspace package。入口只接受：

```text
ql3-local-deploy prepare --command-file /absolute/private-command.json
```

command file 继续复用 `@qinglong/local-command-file` 的 canonical、当前 UID、
`0600`、no-follow 协议。命令必须是 exact
`local.deployment.prepare`，固定 Profile、instance、deployment root、D-183
mutation identity 和三种 service 之一。

实现保留在同一个 package 中，并按 contract validation、文件发布事务、
descriptor rendering 与薄 orchestration 四个内部模块组织。内部模块不是独立
发布或依赖边界，避免为了文件数量继续拆 workspace package，也避免部署协议、
文件事务和 supervisor 模板重新堆积为单个巨型源文件。

### 2. 文件事务无覆盖且可恢复

准备器以当前 POSIX UID/GID 创建并复核固定的 `0700` deployment、pepper、
backup、receipt、Artifact、Plugin staging/activation 与 service 目录。随后：

1. 复用 D-183 `executeLocalSetup` 收敛 migration 与 key authority；
2. 生成 exact `qinglong/local-application-process@v2` fresh 配置；
3. 生成 systemd、OpenRC 或 Compose 中唯一一种描述符；
4. 使用同目录 deterministic stage、完整写入、`fsync`、hard-link no-replace、
   directory `fsync` 和 stage cleanup 发布；
5. 已有目标只能在 owner、mode、link count、size 和完整字节全部一致时返回
   `existing`，否则失败关闭。

在执行 setup 前先检查已有 config/descriptor 与遗留 stage；已存在内容漂移不会先
改变数据库或密钥。崩溃发生在 stage、link 或 cleanup 窗口时，同一命令可以继续
收敛；不得生成新 mutation ID 来重试。

### 3. 三种描述符是显式 Profile contract

systemd/OpenRC 只接受 canonical regular Node executable 与 application entrypoint；
文件必须由 root 或当前 UID 拥有且不能 group/world writable。描述符固定
`SIGTERM`、30 秒停止预算、`0077` umask 和前台监督：

- Edge：128 MiB、64 PID、1024 fd；
- Standalone：256 MiB、256 PID、4096 fd。

Compose 只接受完整 `@sha256` image reference，并固定：

- numeric current UID:GID；
- read-only root filesystem；
- bind mount 唯一 deployment root；
- `network_mode: none`（fresh 默认 AI excluded）；
- drop all capabilities 与 `no-new-privileges`；
- 16 MiB noexec tmpfs、30 秒停止预算及同一 Profile memory/PID 上限。

container application config 使用 `/var/lib/qinglong3` 内部路径；host setup 仍对
bind source 执行。两套路径不能混写。

若当前 UID 为 0，命令必须显式写
`allowRootService: true`；非 root 必须为 `false`。这只是明确风险，不把 root
执行宣传为推荐配置。

### 4. 准备不等于系统启用

准备器不执行以下行为：

- 不复制文件到 `/etc`；
- 不调用 service manager 或 Docker daemon；
- 不拉取或构建镜像；
- 不签发、claim 或恢复 Owner；
- 不启用 AI、网络、Plugin online fetch；
- 不修改已存在的不同配置。

operator 必须检查 bundle，再显式安装和启动。发布镜像、系统包、签名、升级回滚与
真机 supervisor evidence 具有独立供应链和权限责任。

## 验收

- systemd fresh deployment 首次 `prepared`、原命令 `existing`；
- 八个目录均为当前 UID `0700`，application/unit 为 `0600`；
- 真实 SQLite `integrity_check=ok`；
- OpenRC 使用 `supervise-daemon`、TERM/KILL 有界停止和 `0077`；
- Compose 使用 digest image、read-only、network none、cap-drop、no-new-
  privileges 与 Profile 上限；
- command widening、mutable tag、root 未确认、权限或内容漂移均拒绝；
- CLI stdout/stderr 不包含路径、image、digest、material、token 或 secret；
- `local-owner-cli` package test 全量通过。

## 未包含

- 正式可发布的本机 OCI image 与 SBOM/provenance/signature；
- deb/rpm/apk/opkg 等系统包；
- `systemctl`、OpenRC、Compose 的真实安装/升级/回滚控制器；
- systemd/OpenRC 多发行版、rootless container 与 Linux x64/arm64 live matrix；
- 路由器断电、ENOSPC、只读文件系统与闪存写放大报告。
