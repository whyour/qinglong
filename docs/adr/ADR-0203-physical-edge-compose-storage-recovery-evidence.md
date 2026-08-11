# ADR-0203：物理 Edge Compose 存储恢复候选证据

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-86、D-87、D-175、D-192、D-193
- 关联 ADR：ADR-0088、ADR-0200、ADR-0201、ADR-0202

## 背景

ADR-0202 已证明 Compose recovery evidence collection 的逻辑状态机、崩溃重放和
保留底线，但开发机与容器测试不能回答两个物理 Edge 问题：

1. collection 在真实路由设备分区上会产生多少可观测写入；
2. durable rename stage 跨 Linux 重启后，正式 commit/replay 是否仍能收敛并回收
   snapshot 占用。

这两个问题也不能直接等同于“突发断电已通过”。Linux block statistics 可能在重启
后重置，partition sectors 不是 eMMC/NAND FTL 内部写入量；普通 reboot 也不能证明
电源在某条 fsync 指令之后被物理切断。

## 决策

### 1. 记录器是两阶段、短生命周期工具

根命令 `evidence:physical-edge-compose-storage` 提供 `prepare` 和 `resume`。它是
repository script，不新增 workspace package、生产依赖、daemon、timer、watcher、
端口或后台扫描。

prepare 在 operator 提供的专用数据挂载内创建一个可丢弃 Edge scratch deployment，
通过正式 local deployment API：

1. 准备 Compose Edge deployment 并扩展 SQLite allocated pages；
2. 推进 generation 2、3、4，创建 3 份真实 rollout backup 与 terminal receipt；
3. 对最老 backup 执行 production evidence collection prepare；
4. 把该 backup rename 为生产协议的确定性 `.ql3-collection-stage` 并 fsync 目录；
5. 发布 `0600`、no-replace、SHA-256 绑定的 session，然后停止并要求 operator
   外部重启。

工具永不调用 reboot、poweroff 或设备管理接口。

### 2. 专用真实块设备和路径边界

data path 必须是 canonical、当前 UID 拥有、`0700`、读写的 Linux mountpoint，
mount source 必须直接解析为 `/dev/*` block device；root filesystem、overlay、
容器 bind path、共享生产 deployment 和 symlink 均不接受。

session 只接受 exact shape，并绑定：

- device manifest digest、UID、boot ID、架构、文件系统、mount 与 block device；
- 固定的 `.ql3-compose-storage-<session UUID>` scratch deployment；
- generation 4、collection UUID、最老 rollout UUID 和 snapshot 完整事实；
- production prepare/commit command 的 exact shape、相同 options 和单调时间；
- target/stage 的确定性绝对路径及 prepare barrier tree。

resume 会再次 realpath 并检查 data root、deployment root、session 和 output 均未逃逸
专用挂载。即使当前用户重算 session digest，也不能把 production commit 指向任意
其他 deployment。

### 3. 跨启动只形成两个独立写入上界

prepare 在同一 boot 内记录操作前后 partition `sectors written` 差值；session 的
最终发布发生在 barrier 之后，因此不包含在 prepare 数值内。resume 在新 boot 内
重新取起始计数，并只对 production commit、exact replay、SQLite inspect 和结果
检查后的差值计量；它不包含 boot 自身写入。

两个差值分别除以本阶段逻辑 snapshot bytes，并向上取整为 permille 上界。不得跨
boot 相减，也不得把该数值命名为 whole-device 或 FTL write amplification。manifest
显式声明两个独立阈值，超出任一阈值即候选失败。

### 4. Resume 必须使用正式恢复路径

resume 只接受不同 boot ID、相同 UID/device/filesystem/architecture。它执行 session
内绑定的 production collection commit，再原样重放同一 commit，并验证：

- 首次结果为 `collected`，重放为 `existing`；
- 主 SQLite 仍通过 v35 snapshot inspection；
- deterministic stage 已消失，content-bound tombstone 已存在；
- 3 份 rollout backup 收集最老一份后正好保留 2 份；
- deployment tree allocated bytes 至少回收一页，且算术与 target snapshot
  bytes 一致。

报告以 `0600`、no-replace、SHA-256 发布，永久为 `supported:false`。

### 5. 聚合器不得扩大结论

统一 physical Edge aggregator 只导入同 device/Profile/architecture/filesystem 和
当前 resume boot 的私有 digest-bound 报告。成功时新增
`compose_sqlite_collection_reboot_and_partition_write_upper_bound`，但仍保留：

- `power_loss_restart`；
- `whole_device_cpu_wakeups_and_flash_write_amplification`；
- release signature 与其他尚未完成的物理证据。

报告明确不证明真实突发断电来源、生产主 deployment、FTL/NAND 写放大、长期耐久、
MTD/UBI/UBIFS 设备写放大、Compose restore replacement 的断电窗口或
Standalone/Cluster。MTD/UBI 需要独立计量适配器，不能套用 block-sector 阈值。

## 验收证据

- 新 recorder manifest/CLI/block-stat/session/report 契约测试 6/6；
- 聚合器路径、私有文件、不同 boot/device binding 与不扩大断电声明测试 12/12；
- 合计专项 18/18；
- session 的 deployment/path/production command 漂移即使重算 SHA-256 仍失败关闭；
- 没有新增 workspace package 和生产依赖。

本地 macOS 开发机没有执行物理阶段。Accepted 表示协议与门禁已实现，不表示任何具体
路由设备已经获得支持；真实报告必须在固定 arm/arm64 设备、专用可丢弃分区上采集。

## 被拒绝的替代方案

- **在 Docker Desktop 或 loop file 上采数字**：不能代表设备 block/FTL 路径。
- **把 MTD/UBI 当作 `/dev` block device**：观测与磨损语义不同，必须独立设计。
- **跨 boot 直接相减 `/sys/class/block/*/stat`**：计数可能重置，结果无效。
- **脚本自动 reboot/poweroff**：扩大破坏权限，仍不能证明突发断电时点。
- **复用生产 deployment**：会污染用户恢复历史，并把证据工具变成生产 GC authority。
- **从 `process.io` 或 SQLite 文件大小推导闪存写放大**：观测层级错误。
- **新增 storage-evidence package/daemon**：没有独立交付边界，并增加 Edge 常驻成本。
