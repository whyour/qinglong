# ADR-0524：Exact Headless 升级切换链演练

- 状态：Accepted（D-426b2b 同源双架构阶段实物已交付）
- 日期：2026-08-30
- 决策：D-426b2b
- 关联：ADR-0520、ADR-0521、ADR-0522、ADR-0523

## 上下文

ADR-0523 已修正 Apply 后 Adopted Target 的回退基线，但仓库内单元测试不能证明用户下载到的 Docker archive 具备完整控制器能力。阶段产物必须从将要上传的 exact bundle 走通 reviewed stage、Owner 认证、apply、真实 Docker legacy stop、target start/stop 和 clean `rollback_candidate`。

短生命周期 Operator 此前不含 Docker client，无法在容器内通过受约束的 Docker socket 执行既有 controller。另一方面，Console 镜像入口是 Local API，而 adopted target 证据当前只接受 `local-application-process@v3/v4`；把 Console fresh journey 标记为已验证切换会形成错误承诺。

## 决策

1. Operator runtime 增加固定 Alpine 版本的 `docker-cli`，不包含 daemon、Compose、listener、timer 或常驻进程；现有无网络、只读 rootfs、128 MiB、0.5 CPU、32 PID 边界不变。
2. Trial Kit v8 新增 canonical `upgrade-cutover-rehearsal.sh`，并将其文件摘要绑定到 bundle manifest、offline auditor 与 Local milestone v5。
3. 脚本仅允许 headless Trial Kit，在全新 rehearsal root 和两个专用合成容器上执行：
   - exact bundle checksum/load/image identity；
   - reviewed SQLite 与 data-directory stage/verify/activation；
   - fresh Owner ceremony、credential presentation、transform/apply/verify；
   - Docker socket 上的 legacy stop、offline image target start/stop；
   - Application v4 post-apply baseline 与最终 `rollback_candidate`。
4. Legacy root 在 Operator、合成 Legacy 与 target 中均为只读绑定；演练前后主 SQLite SHA-256 必须一致，WAL/journal 不得出现。
5. 成功后写入私有 `cutover-summary.json`，固定 `status=rollback_candidate`、`legacySource=unchanged`、`target=stopped`；CI 删除两个已停止合成容器后才可上传产物。
6. Console 继续执行 exact readiness/stage，`legacyUpgradeCutover=not_applicable`。在 target evidence 支持 Local API 入口前，不得将其写成 `passed`。

## 产物闭包

- `qinglong/alpha-local-trial-kit@v8` / verification v6 / audit v5；
- `qinglong/alpha-local-milestone@v5` / audit v5；
- Stage Index v2 只接受新的 Local milestone v5；
- headless 原生 amd64、arm64 artifact job 必须执行 exact cutover rehearsal；普通源码 CI、模拟 Docker 或单架构结果都不能替代该门。

本 ADR 不授权生产 cutover、真实 2.x 容器停机、Legacy restart/rollback 或数据目录替换。新阶段实物只有在同源双架构 artifact 与 milestone 均由成功终态 workflow 闭合后成立。

## 验证

- back：1657 total / 1655 pass / 2 conditional skip / 0 fail；
- Local Owner CLI：308 total / 301 pass / 7 conditional skip / 0 fail；
- Trial Kit、Local milestone、Stage Index 聚焦测试：29/29；
- package boundary 保持 18 个 workspace package、无 single/shallow package、零 finding；
- Operator image、milestone workflow、Stage Index workflow auditor 均为 compatible。

提交 `79045a0d439074994812d9cd682f933b9e415706` 的显式 Local headless [run 33326143744](https://github.com/whyour/qinglong/actions/runs/33326143744) 已完成 `42 success / 2 expected scope skip / 0 fail`。两个原生架构都从将要上传的 exact Trial Kit 实跑 readiness、reviewed stage、Owner credential presentation、transform/apply、真实 Docker legacy stop、只读 target cutover probe start/stop，并得到 clean `rollback_candidate`；普通 Application 启动命令不能冒充 probe。最终器生成同 run 的 milestone v5，三个 artifact ID 为 amd64 `9736356778`、arm64 `9736354298`、milestone `9736502478`，保留至 2026-09-29。

下载后的 milestone 与两个 Trial Kit 已再次用仓库离线 auditor 审计，三者均返回 `compatible=true`。Docker archive 为 amd64 `226122240` bytes / `sha256:1e1c5c83fd2c39b3bbe7b194113998a96cbe810e69d34858c3f40d2638837c60`，arm64 `221521920` bytes / `sha256:dcec37f65382d7d8c06f448780878ec2474e45d6e64b2febb764b1836898d2d6`；两个 verification v6 都把 `legacyUpgradeReadiness`、`legacyUpgradeStage`、`legacyUpgradeCutover` 标记为 `passed`。同 run 的跨架构资源证据还在 128 MiB、0.5 CPU、64 PID 的 CI stress envelope 下记录 x64 `77967360` bytes、arm64 `72581120` bytes peak，并明确该数据不是固定物理设备最低配置承诺。

## 后续

D-426b2c 已由 ADR-0525 实现为 Console Local API 外层入口与 Application 内层配置的双重证据，且保持 headless 既有 command/journal shape；同源 exact Console 双架构 artifact 与 milestone 已由成功终态 CI 交付并完成下载后离线审计。D-426c 继续处理 target 写入后的 capture、review、reconciliation 与恢复，不得削弱 headless 已闭合的离线镜像和回退基线。
