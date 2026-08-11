# ADR-0363：有界 Application Shutdown Receipt 与物理 Service Stop 证据

- 状态：Proposed（产品 receipt、Owner consumer、真实 manager 组合门与物理 recorder 协议已完成；固定实机报告待采集）
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-196、D-274、D-275、ADR-0204、ADR-0206、ADR-0362

## 上下文

root service bridge 的 stop outcome 能证明 systemd/OpenRC 最终观察到 service
inactive、原 receipted PID/start identity 已消失，但不能单独证明 Application 完成了
有序 drain。manager 超时后 SIGKILL、进程崩溃或强制退出都可能产生相同的“PID
不存在”终态。native application recorder 可以从 stdout 看到 `stopped`，真实
init-managed release 则不能依赖 journal/syslog 的持久化与轮转策略。

因此物理 Edge 的 graceful-stop Gate 需要一个由 Application 在资源释放成功后发布的
持久事实，再与 root bridge outcome 和实时进程终态交叉验证。

## 决策

### 1. Shutdown receipt 属于现有 Local Application 生产进程

`@qinglong/local-application` 仅在收到首个 SIGINT/SIGTERM 且
`application.stop()` 返回 `stopped` 后发布：

```text
<absolute-config-path>.stopped.json
```

schema 为 `qinglong/local-application-shutdown-receipt@v1`，最大 4 KiB，包含：

- instance、Profile、signal 与固定 `stopResult=stopped`；
- 原 startup receipt SHA-256；
- 同一 boot ID、PID/start ticks、Node executable/version；
- stop 完成时的 Linux boot age；
- domain-separated SHA-256。

`timed_out`、非 Linux、startup receipt 未成功发布或 shutdown receipt 发布失败均不能
形成 graceful 事实。Linux 发布失败会让 Application CLI 失败关闭。

### 2. Startup/shutdown 共享一个文件安全协议

同 package 的 `production-process/lifecycleReceiptFile.ts` 统一实现：

- current real/effective UID 必须一致；
- parent 必须为当前 UID 控制且 group/other 不可写；
- deterministic stage 使用 `O_EXCL|O_NOFOLLOW`，只复用 owner `0600`、single-link、
  有界旧 stage；
- write→fsync→parent identity recheck→atomic rename→final inode/mode/link/size recheck；
- directory fsync 在不支持的文件系统上保持 best effort。

每次启动和停止各只替换一个 current 小文件，不追加历史，不启动 timer、watcher、
listener 或清理 daemon。实现留在现有 `@qinglong/local-application` 的
`production-process/` 领域目录，不新增 package 或依赖。

### 3. Owner cutover stop 必须验证三种独立事实

adopted service stop 只有同时满足下列条件才可推进 `target_stopped`：

1. root bridge outcome 绑定当前 stop intent 且 manager state 为 `stopped`；
2. shutdown receipt 以 SIGTERM、startup receipt digest、boot、PID/start、Node 和
   `stoppedBootAgeMs >= activeBootAgeMs` 绑定上一代 active record；
3. exact receipted PID/start identity 已不存在。

缺失或漂移的 shutdown receipt 进入 `manual_required`，原因固定为
`application_shutdown_receipt_unproved`。service cutover record 新增
`shutdownReceiptDigest`，使 instance head 的 source record 对 graceful 事实形成摘要
链。PID 消失不再单独足以推进 lineage。

### 4. 物理 stop recorder 复用同一双 authority 协议

非 package 命令 `evidence:physical-edge-direct-service-stop` 提供：

- `prepare`：读取并复验同 boot 的 direct start session/report、实时 receipt/PID 和
  active/enabled init 状态，以 Owner 发布 fresh stop intent，输出固定 root bridge
  command；可选 `--root-command-output` 在 Owner data path 内以 `0600`、no-replace
  写出与 stdout 完全相同的 command handoff；
- `resume`：以 Owner 消费 stopped outcome，验证 shutdown receipt、旧进程身份消失、
  service inactive 但仍 enabled，发布 `physical_edge_direct_service_stop_candidate`。

direct start 的 `prepare` 同样提供 `--root-command-output`。运维流程要求 operator
先把该 Owner handoff 精确安装到 canonical root-owned `0700` 目录中的 root-owned
`0600` 文件并复核摘要，再以 root 调用 `ql3-service-bridge run --command-file`；禁止
用手工 `systemctl`/`rc-service` 绕过 intent、barrier、outcome 与 Owner resume。start
bridge 必须返回 `active`，stop bridge 必须返回 `stopped`，然后才能分别 resume。

session/report 绑定 direct session、active report、startup receipt、boot、PID/start、
stop intent/outcome/observation digest。统一 physical importer 只在 stop report 与同一
direct start report 精确配对时增加
`init_managed_graceful_application_stop`；否则该项继续留在
`remainingRequiredEvidence`。

### 5. 证据边界

报告永久 `supported:false`。它不证明 disable/descriptor removal、突然断电恢复、
firmware shutdown、whole-device flash 写放大、release signature、Standalone 或
Cluster。graceful stop 也不能替代 power-loss Gate。

## 验收证据

- 2026-08-11 的真实 arm64 Local image 门发现 Linux runtime observation 的字段插入顺序与 receipt verifier 的 canonical 顺序不同，导致同一语义对象产生不同 digest；builder 已改为逐字段 canonical materialization，并增加 Linux 属性顺序回归。shutdown/process 专项 15 pass/1 Linux skip；修复后的同一镜像在 Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs、read-only root、network none 下均完成 active→graceful stop，SQLite integrity 为 `ok`。这修复的是既有 D-275 产品路径，不改变 receipt schema、authority 或固定物理设备剩余 Gate。
- Local Application startup/shutdown/process 专项：17 pass/2 条 Linux 条件 skip；
- Owner service cutover/intent/contract：14/14，包含无 shutdown receipt 必须
  `manual_required`；
- 真实 systemd/OpenRC × UID 0/10001 fresh+adopted 组合门全部通过，四组 adopted
  active→SIGTERM shutdown receipt→target_stopped；报告 SHA-256
  `28d5c29f91747f88b099c4918648199c21338fa48b9840c48d8027e70f14c954`，容器零残留；
- direct stop recorder/report/importer 与既有 physical 回归 35 pass/1 Linux skip；
- direct start/stop/aggregation handoff 与运维顺序专项 15 pass/1 Linux skip，回归固定
  start prepare→root bridge→start resume→stop prepare→root bridge→stop resume；
- service bridge 的 systemd/OpenRC × UID 0/10001 四容器组合门再次全绿，覆盖 root
  command file、exact replay、active/stopped observation、Owner outcome 与 adopted
  cutover；报告 SHA-256
  `0120972416d679ef3749e81e99f65ead5ca45bd29f43e4a1e624d675d8f4fc9a`，容器、卷、
  网络零残留；
- 完整 backend 回归 1,155 pass/2 条条件 skip、0 fail；本机遗留 SQLite binding 使用
  项目锁定的 node-gyp 12.4.0 构建并验证加载，未修改生产依赖声明；
- workspace 仍为 17 package；Local Application 15 source 中 13 nested、2 个根 entry，
  无 shallow/single-source package、无新增生产依赖或常驻资源。

固定物理 systemd/OpenRC 设备尚未执行 start prepare→root bridge→reboot→resume→stop
prepare→root bridge→stop resume，因此本 ADR 与 D-275 保持 Proposed。

## 不采用方案

- **只看 PID 消失**：无法区分 graceful drain、SIGKILL 与 crash。
- **只看 systemd/OpenRC stopped**：manager 不拥有 Application 内部资源释放事实。
- **解析 journal/syslog**：OpenRC/嵌入式日志持久化与轮转不统一。
- **新增 shutdown daemon/socket**：增加低配设备常驻内存、端口和 authority。
- **为两个 receipt 新建 package**：它们只有一个生产者并共享同一文件安全边界，拆包
  只会增加发布碎片。
- **把 graceful stop 当作断电证明**：两者故障模型相反，不能互相替代。
