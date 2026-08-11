# ADR-0102：物理 Edge Legacy adoption 规模证据协议

- 状态：Accepted（100,000-row recorder、私有 no-replace report 与契约门禁已实现；固定真实设备报告、块设备/NAND 写放大和断电证据待采集）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-08、D-23、D-61、D-62、D-85、D-86、D-87、D-94、D-96、D-97、D-99、D-100、D-101
- 关联 ADR：ADR-0088、ADR-0095、ADR-0097、ADR-0098、ADR-0100、ADR-0101

## 背景

既有 physical TaskDefinition scale recorder 只测 100/1,000/10,000 次正式 Repository append，并明确排除 `legacy_crontab_adoption`。ADR-0101 虽通过逻辑、回滚和制品门禁，仍没有证明 32 MiB/100,000-row review、authenticated carrier 和单事务 Task/Trigger publication 在真实低配 Linux 设备上的 RSS、耗时与写入量。

不能把 macOS、容器或 VM 结果冒充物理路由设备，也不能把 SQLite 文件大小或进程 `/proc/<pid>/io` 冒充 NAND 级写放大。

## 决策

新增独立脚本 `ql3-physical-edge-adoption-scale.cjs` 和根命令 `evidence:physical-edge-adoption-scale`，不新增 workspace package或常驻依赖。manifest 固定 edge、100,000 行和 32 MiB review 上限；记录器要求原生 Linux Node 24.18+、匹配架构/文件系统、无 virtualization indicator。

记录器不自动生成或清理 adoption 数据，避免在真实部署上隐式执行破坏性准备。操作者必须显式提供同一 `dataPath` 内、当前 UID `0600` 的已准备 issue/commit command；两者必须绑定同一 deployment root、target/source/review/authorization、credential、pepper、issuer、plan 和 decision。运行前必须证明 source 恰有 100,000 行、review 非空且不超过 32 MiB、target ledger 为零、authorization 尚不存在。

记录器真实启动现有 `ql3-adoption` binary 执行 issue→commit，分别以 10 ms cadence 采样 child RSS 和 `/proc/<pid>/io`，限制 stdout/stderr 为 64 KiB；最终必须得到一个 ledger、100,000 Task 和 100,000 Trigger。报告只保存低敏计数、耗时、peak RSS、process read/write/cancelled-write bytes 与 SQLite logical/allocated bytes，使用 canonical SHA-256、当前 UID `0600` no-replace publication，并提供严格 importer validation。

报告永久保持 `supported:false`。严格 importer 已接入统一 physical Edge evidence 聚合器；只有 device/Profile/boot/architecture/filesystem 全部与基线证据一致时，聚合报告才增加 `legacy_adoption_100000_row_scaling` collected evidence，并从 remaining evidence 中移除同一项。它仍明确不证明 whole-device flash/NAND write amplification、power-loss survival、human review UI throughput、Scheduler/Run admission 或 cluster/PostgreSQL adoption；这些结论需要块设备计数器、稳定空载窗口、断电重启和独立集群 ceremony。

## 验收证据

1. 独立记录器三项契约测试通过：固定 100,000/32 MiB manifest、同一 data root 的 issue/commit 配对、digest/scope/tamper validation。
2. 统一聚合器增加一项 same-device/same-boot 导入测试；记录器与聚合器目标测试共 14/14，通过 widened shape、foreign owner、跨设备及跨 boot 拒绝路径。
3. backend 完整回归为 669/669；记录器语法检查通过。macOS 上不运行 workload，因而没有生成或伪造物理设备报告。
4. 新能力位于 `scripts/` 与 backend contract test；ADR-0106 收敛后当前仍为 23 个 importer，且本 ADR 不增加 package、runtime timer 或 Profile closure。

## 后续约束

下一步是在固定 arm64/arm 物理 Edge 候选机上准备专用可丢弃 fixture并采集 report，再增加同 boot 块设备 sectors-written、sync/fdatasync 可观测量和受控断电恢复报告。只有这些证据齐全后，才能为具体设备/文件系统定义支持等级；逻辑 recorder 通过本身不能形成最低硬件承诺。
