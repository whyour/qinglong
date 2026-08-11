# ADR-0281：同源绑定的跨架构 Linux 资源发布证据

- 状态：Accepted（证据协议、CI 归档与聚合门已实现；远端 runner 成功记录仍由实际 GitHub Actions 运行取得）
- 日期：2026-08-07
- 关联：D-05、D-07、D-87、D-213、D-251、D-257、ADR-0088、ADR-0278、ADR-0280

## 上下文

QingLong 3.0 CI 已在原生 Linux x64 与 arm64 runner 上分别执行 128 MiB Router stress、256 MiB Edge
release guard 和 512 MiB Cluster control guard。每档都会从容器内核对 cgroup v2、swap、OOM、CPU、PID、
non-root、只读挂载、seccomp、`NoNewPrivs` 与 workload 结果，但报告过去只存在于 job 日志中。

日志不能证明三个档位属于同一架构 job，也没有机器可验证地绑定 repository、commit、workflow、run 与
run attempt；发布审核者也无法拒绝把另一提交、另一重跑或重复架构的结果拼成“双架构证据”。同时，任何
归档机制都不能把共享 CI 容器结果误写成固定路由器的物理支持声明，或用控制面空载门代替 Cluster 容量测试。

## 决策

1. 新增 `scripts/ql3-linux-resource-release-evidence.cjs`。单架构 `bundle` 必须一次性读取三个 exact tier
   报告，并绑定 `repository/revision/workflow/runId/runAttempt` 与原生 `x64` 或 `arm64` 身份。
2. 输入采用 exact-shape、fail-closed JSON：未知顶层字段、缺档、档位顺序或 workload 集漂移、Node/UID/GID/
   架构漂移、资源限额扩宽、安全挂载缺失、`max/oom/oom_kill/oom_group_kill` 增量、失败 gate 或非空
   violation 都拒绝生成 bundle。
3. 输入必须是非符号链接的普通文件且不超过 8 MiB；规范化最多 32 层、100,000 个共享节点。输出使用
   `wx` 和 `0600` 创建，不覆盖已有证据。摘要使用固定 domain separator 的 SHA-256，避免与普通 JSON
   digest 混用。
4. matrix 中每个原生 runner 先把三档 stdout 写入 runner temp，再生成只属于当前架构和当前 workflow run
   的 bundle。上传 artifact 名包含 `run_id/run_attempt/architecture`，action 固定到完整 commit，缺文件和
   overwrite 均失败关闭。
5. 独立 `linux-resource-release-evidence` job 必须依赖整个原生 matrix，按精确名字分别下载 x64/arm64
   artifact，不使用 pattern 或 `merge-multiple`。`merge` 重新验证两个 bundle 的完整摘要、原生身份、精确
   tier 集与同一 source；缺失、重复架构、跨提交或跨 workflow run 混合都拒绝。
6. 合并产物只保存每个架构的 bundle digest 与逐档 envelope/peak/workload count 摘要，并显式记录三条
   limitation：CI cgroup 不是受支持最低硬件、不能替代断电/闪存/热环境/soak、GitHub workflow identity
   绑定不是密码学硬件证明。
7. 本门不增加 workspace package、生产 dependency、数据库、migration、Pool、timer、listener 或运行时
   authority；证据脚本只在 CI/发布审核面消费既有资源报告。

## 被拒绝的方案

- **继续只保留日志**：人工可读但无法精确拼接同一 commit/run 的三个档位与两个架构。
- **只上传三份原始 JSON**：没有 source binding、单架构完整性摘要或跨架构聚合门。
- **按 artifact pattern 自动合并**：可能吸收额外或错误架构，弱化 exact two-party contract。
- **由本机 arm64 伪造 x64 报告**：架构标签不是原生执行证据；x64 结果必须来自 x64 runner。
- **把 bundle digest 称为硬件 attestation**：摘要只检测内容漂移，不证明 runner 硬件或受信执行环境。
- **把 128 MiB 档升级为路由器最低配置**：缺少固定型号、内核、文件系统、闪存、断电和长期热环境证据。
- **用 512 MiB 控制面门推导集群容量**：没有副本、数据库延迟、吞吐、queue depth、failover 与恢复负载。

## 接受证据

- 新证据协议定向测试覆盖 native x64/arm64 正向 bundle/merge，以及架构漂移、失败 gate、OOM event、未知
  字段、摘要篡改、跨 source、重复架构、缺架构、共享节点预算、符号链接输入与输出覆盖失败路径。
- Workflow contract 固定三份原始报告、五个 source 字段、原生架构、完整 commit-pinned upload/download
  action、精确 artifact 名、matrix dependency 与禁止 pattern/merge-multiple/continue-on-error。
- Linux resource gate、证据协议、workflow、cluster image release、local image、Kubernetes live contract 与
  PostgreSQL TLS workflow 的本地定向审计共 73/73 通过。
- 完整 backend 为 1,110 tests、1,108 pass/2 skip/0 fail；完整 19-package clean build/test 门退出 0。Edge
  import、cluster dependency、package boundary、cluster deployment、worker deployment 与 local image 六项
  审计全部 compatible，workspace 仍为 19 个 package。
- 十档 artifact 的 package/file/module closure 与上一轮完全一致；最大 Standalone Application AI 为
  5,970,364 bytes，距 6 MiB 仍有 321,092 bytes，新增 CI-only evidence 脚本没有进入 production closure。
- PostgreSQL 18.4 arm64 physical-streaming HA `gates.passed=true`：timeline 1→2、旧主先 fencing、
  `pg_rewind` 只读同步 rejoin、两个 fresh control replica 与全部业务 gate 全绿；执行后 `ql3-ha-*`
  container/network/volume 零残留。
- 刷新后 GitNexus 为 42,603 nodes/96,672 edges/1,677 clusters/261 flows；新脚本关键符号均为 LOW、
  0 affected process，最高 `canonicalize` 为 3 direct/8 total。仓库范围 `detect_changes` all 与 compare
  `develop` 分别为 12 files/31 symbols、14/34，均 low/0 affected process；QL3 孵化树仍未 stage，因此新增
  文件的风险以刷新后逐符号 impact 结果为准。
- 本地只能验证协议与静态 CI contract；真实 x64 与 GitHub-hosted arm64 数值、artifact URL 和成功 run ID
  必须在该 workflow 实际运行后记录，不能在仓库内预造。

## 后续边界

- 在 GitHub Actions 实际取得同一 commit/run 的 x64、arm64 bundle 与 cross-architecture artifact，并把
  run URL、artifact digest 和保留策略纳入 release candidate 审核。
- 固定路由设备仍按 ADR-0088 采集明确型号、RAM、存储、内核、文件系统、断电、闪存、热环境与 soak
  证据；只有物理矩阵完成后才能讨论受支持最低配置。
- Cluster 容量继续使用独立的多节点 PostgreSQL/Worker/queue/failover 压测，不继承本门的 512 MiB 数字。
- 联网 production dependency vulnerability audit 因依赖元数据外发权限未获批准，本轮不重跑。
