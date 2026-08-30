# ADR-0524：Exact Headless 升级切换链演练

- 状态：Accepted（D-426b2b 源码候选；双架构阶段实物待本次 artifact run）
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

真实镜像构建、固定 Docker CLI、双架构 exact rehearsal 和新 artifact 摘要将在本提交的 GitHub artifact run 中补充。只有该 run 成功后，才把状态更新为“阶段实物已闭合”。

## 后续

D-426b2c 评估 Console adopted target 的显式双进程/入口证据模型；D-426c 继续处理 target 写入后的 capture、review、reconciliation 与恢复。两者都不得削弱 headless 已闭合的离线镜像和回退基线。
