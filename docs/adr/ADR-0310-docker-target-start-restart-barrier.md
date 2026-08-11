# ADR-0310：Docker Target 启动/重启屏障与人工终态

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-17、D-63、D-64、D-65、D-259
- 关联 ADR：ADR-0065、ADR-0243、ADR-0308、ADR-0309

## 背景

ADR-0309 已让 deployment owner 以真实 Docker controller 把 2.x owner 收敛为
`legacy_stopped`，并让 adopted Application v3 在取得 signal、SQLite、Secret、Plugin Package、AI
和 lifecycle authority 前消费该 commitment。但“旧实例已经停止”不等于“可以用一条无状态 shell
命令反复启动 3.0”：若 controller 在 Docker start 已产生副作用后崩溃，自动重试可能重复启动；若 target
曾 active 后旧实例被人工拉起，直接重启 target 又可能形成双 owner。

已删除的 ADR-0065 孵化包记录过正确状态语义，但它没有 production consumer。该语义必须进入现有
`ql3-local-deploy` 产品，而不是恢复第二十个 workspace package。低配路由器也不能为此安装 daemon、
watcher、数据库连接或进程管理 framework。

编辑前 GitNexus 显示部署 CLI `main` 为 LOW、1 个直接文件调用和 0 条产品执行流；新 supervisor 建立后，
重放入口为 LOW，journal path/read helper 为 MEDIUM、最多 6 个包内直接调用者且仍为 0 条产品执行流，
没有 HIGH/CRITICAL 风险。

## 决策

### 1. 继续使用现有 deployment product

新增两个显式命令，但不新增 package：

```text
ql3-local-deploy cutover-target-start
ql3-local-deploy cutover-target-restart
```

二者只存在于 `@qinglong/local-owner-cli/deployment/cutover`。Application 不导入 Owner CLI、Docker、
journal writer 或 controller；Cluster/Worker/PostgreSQL 产物也不取得本机 Docker authority。

### 2. Target identity 在 start 前冻结

命令只接受完整 64 hex 的 legacy/target container ID 和不可变 `repo@sha256` target image。首次启动或重启
前，controller 必须同时证明：

- target 为 `created|exited|dead`，`Running=false`、`Restarting=false`、`Paused=false`、`Pid=0`；
- restart policy 为 `no`，root filesystem 只读、非 privileged 且启用 `no-new-privileges`；
- `Cmd` 精确读取受审 Application v3 config；
- 当前 UID 私有 config 仍绑定 cutover/Profile/instance/activation/legacy commitment；
- 一个且仅一个读写 bind mapping 能分别解释 config、commitment、activation 和 legacy source 在 target
  内的路径；
- container Created/Image/Name/ID、config digest 和 mount mapping 形成低敏 digest，随后不可漂移。

deployment controller 不把 `container name`、短 ID、PID、operator boolean 或单独的 Docker exit code当作身份。

### 3. 每代 start 只能跨越一次持久屏障

首次 generation 固定为 1：

```text
0001 legacy_stop_requested
0002 legacy_stopped
0003 target_start_requested | manual_required
0004 target_active          | manual_required
```

`0003` 先通过现有 hard-link no-replace primitive 原子发布，再调用一次
`docker container start <exact-id>`。若 controller 在屏障后崩溃，原命令重放只能 inspect，不能再次 start。
只有同一 target identity/binding 已 running，并且 Application 写出了新的、校验通过的 Linux startup receipt，
才发布 `target_active`。

start 响应失败或丢失也不直接等于失败：controller 在 Edge 30 秒/120 次、Standalone 60 秒/240 次的有界窗口
内只做 inspect。窗口结束仍不能证明 active 时发布 terminal `manual_required`，错误正文不入 journal，只保存
有限 reason、uncertain state 和 domain-separated error digest。

### 4. 每次 restart 都重新证明 Legacy 静默

generation 2..15 固定追加四条：

```text
legacy_recheck_requested
legacy_reverified | manual_required
target_restart_requested | manual_required
target_active | manual_required
```

Legacy inspect 必须重新得到与 `0002` 相同的完整 container identity digest 和 source bind digest，并再次证明
stopped + restart=no。只有 `legacy_reverified` 的 record digest 才能成为 restart request 的直接前驱；即使攻击者
重算后段 JSON 自身 digest，只要把它从该前驱链拆开仍会失败关闭。

restart 前 target 必须停止、identity/binding 不漂移，磁盘上的 startup receipt 必须等于上一代
`target_active`；restart 后必须出现不同 receipt。这样 supported controller 路径不会把旧 active receipt
误认成新进程，也不会跳过 Legacy recheck。

### 5. `manual_required` 不可自动离开

本批支持四个有限 reason：

```text
legacy_silence_unproved
target_preflight_unproved
target_start_result_unproved
target_restart_result_unproved
```

同一 generation 的 decision/outcome 使用固定中性文件名，因此 requested/active 与 manual 两个并发 writer
竞争同一个 no-replace inode，不会各自在不同文件中“双赢”。终态原命令只验证磁盘链并返回 `existing`，不重新
打开 Docker socket。任何路径都不自动启动 2.x。

### 6. 资源与源码结构

该能力是一条人工触发的一次性命令：没有常驻 timer、watcher、listener、daemon、数据库连接或目录历史扫描；
每代固定最多四个小 JSON，最多 15 代/60 条 target 记录，沿用 cutover catalog 的 64 项上限。轮询仅存在于
启动命令生命周期中。

实现没有形成新的顶层 package，也没有把所有逻辑塞进一个根文件。`cutover/` 内部分为 target command
contract、Docker/application evidence、journal primitive、record evidence 和 supervisor；workspace 根源码
仍只有公共/二进制入口。

## 被否决方案

1. **start 失败后直接重试**：失败可能发生在 Docker 已完成副作用之后，拒绝。
2. **只看容器 running**：无法证明正确 Application 已取得并报告 active，拒绝；必须同时消费新 startup receipt。
3. **复用上一代 Legacy commitment 直接 restart**：旧实例可能已被人工拉起，拒绝；每代重新 inspect。
4. **让 Docker `unless-stopped` 自动恢复 adopted target**：会绕过 restart generation 和 Legacy recheck，拒绝；
   target 必须 `restart=no`。
5. **为 supervisor 新建 workspace package**：没有新的 artifact/dependency/consumer 边界，拒绝。
6. **让 Application 调 Docker 或写 deployment journal**：会把常驻 runtime 提升为部署 owner，拒绝。

## 验收证据

- 新专项 6/6：正常首次启动与无 Docker 重放、屏障崩溃 inspect-only、未知 start 进入 manual、restart 前
  Legacy reproof、Legacy 漂移禁止 restart、自洽但断链的 restart record 失败关闭。
- `@qinglong/local-owner-cli` 完整沙箱外回归 116/116；沙箱内唯一失败是既有 provider test 不能监听
  `127.0.0.1` 的 EPERM，沙箱外原样通过。
- Application 43 项为 40 pass/3 条件 skip；package boundary 8/8、dependency 48/48、完整 19-package clean
  build/test 与 Backend 1,114（1,112 pass/2 条件 skip）通过。
- workspace 为 781 source/32 root/749 nested，Owner CLI 为 56/1/55；package strict TypeScript/closure check
  通过，workspace package 仍为 19，不新增 production dependency。
- 四个常驻 Application 制品仍 compatible：Edge/Standalone 为 4,744,898/4,745,042 bytes、432 files、
  110 modules；AI 两档为 6,132,511/6,132,667 bytes、496 files、109 modules；最大实测 RSS delta
  21,528,576 bytes，低于 24 MiB 门，Owner controller 未进入闭包。
- 最终 GitNexus 为 43,641 nodes/99,242 edges/1,711 clusters/272 flows；主入口和 evidence parser 为 LOW，
  journal read/path 为 MEDIUM、5 个包内直接调用者、0 process；`detect_changes` all/compare `develop` 仍为
  12 files/31 symbols 与 14/34、low/0 process。QL3 孵化树未完整进入 Git baseline，因此 diff graph 只作
  补充，不替代逐符号 impact、运行测试与 artifact 门。
- 本批未改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，不重复生成 PostgreSQL HA 物理晋升证据。

## 未完成

- systemd/OpenRC legacy 与 target controller；
- `manual_required` 的只读诊断、双确认 resolution 与新 cutover ceremony（后续已由 ADR-0313 关闭）；
- target 显式 stop 与最小写后分类（后续已由 ADR-0314 关闭；数据域 reconciliation/rollback 仍未完成）；
- adopted Compose target 的受审 create/config 生成器及真实 Docker live/crash gate；
- Cluster/Kubernetes 独立 cutover authority。

因此本 ADR 关闭 Docker target start/restart 的产品状态机与保守终态，不宣称 D-64 或 QingLong 3.0 整体完成。
