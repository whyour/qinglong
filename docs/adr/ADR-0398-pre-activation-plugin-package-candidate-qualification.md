# ADR-0398：Plugin Package 激活前候选资格校验与自动保留旧版本

- 状态：Proposed
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-306B2
- 关联 ADR：ADR-0153、ADR-0394、ADR-0396

## 问题

现有 Local 与 Cluster 启动恢复先发布 active pointer、把安装记录推进为
`active`，随后才读取 staged bytes、物化 Package Task/Workflow/Prompt/Tool 资源。
因此一个摘要正确但资源语义无效的升级可能先替换健康版本，再在任务发布阶段失败，
迫使整个启动门失败。安装状态机虽然保留 `previousActiveLockDigest`，却没有在指针切换前
使用该事实形成真正的失败隔离。

“先切换、失败后再把指针写回去”也不安全：回写会与并发发布竞争，Kubernetes
ConfigMap 和数据库 head 之间会出现第二次分布式提交窗口，并且历史 generation 可能被
静默重新激活。自动恢复应避免制造需要补偿的外部事实，而不是依赖补偿事务。

## 决策

1. 已存在旧 active 的 `upgrade|reinstall|rollback` 在 `staged → activating` 之前必须依次通过所有前置条件。Secret binding/transition
   receipt 先完成；随后从 staged install、immutable lock 和 content-addressed bytes
   构建目标 resource generation，读取有硬上限的 Manifest/资源并执行完整语义物化。
   generation 1 没有可回退的旧指针，并且 Secret-aware 首次安装仍需 ADR-0395 的
   post-activation B1 binding ceremony，因此不进入本 ADR 的候选物化门。
2. 候选 materialized revision 以既有 `generationDigest` repository key 在激活前发布。
   相同 revision exact replay 返回 existing；不同事实冲突。该 revision 尚不构成 active，
   Task reconciliation、Automation publication 与 Tool snapshot 仍只消费 active generation。
3. 确定性的候选语义错误或 durable revision 冲突把当前安装从 `staged` 原子推进为
   `failed(reason=activation_fact_conflict)`。状态机必须保留
   `activeLockDigest=previousActiveLockDigest`，并且 activation publisher 调用次数为零。
4. OCI、文件、SQLite/PostgreSQL 或 reader close 的瞬时不可用不写失败事实，安装保持
   `staged` 并由既有有界 recovery 重试。不得在不可区分时把可用性故障伪装成坏包。
5. active pointer 发布成功后，既有 Task publication recovery 复用预先持久化的 revision，
   只执行 generation-fenced reconciliation；它继续承担响应丢失与并发 superseded 检查。
6. Local 与 Cluster 必须使用同一个 runtime-core prerequisite sequence 和候选物化实现。
   Local 复用单 SQLite authority 与本地 staging reader；Cluster 复用 caller-driven recovery
   Job、单 PostgreSQL Pool、OCI reader 与 Kubernetes CAS publisher。
7. 本决策不增加 workspace package、migration、表、第三方依赖、daemon、timer、watcher、
   listener、连接池或常驻 cache。Edge/Standalone 只在已有启动恢复遇到 staged install 时
   按需读取候选字节；没有待恢复安装时只创建少量短生命周期对象，不增加后台 cadence。

## 接受条件

- 共享测试证明有效候选在激活前发布且 exact replay 不重复写；语义无效候选不发布 revision。
- 升级恢复测试证明 rejected 候选进入 failed、旧 active lock 保留且 publisher 未调用。
- Local 与 Cluster 组合测试证明恢复顺序一致，既有 active publication/reconciliation 不回归。
- 完整 18-package、backend、package/dependency/deployment/edge/import 审计通过。
- 真实 PostgreSQL/Kubernetes 门证明失败升级没有移动 active ConfigMap/head；physical HA 门通过。
- 固定物理低配设备证据仍由 ADR-0396 单独阻断，不能用开发机观测替代。

## 影响与替代方案

- 失败候选可能留下一个不可达、不可变的 materialized revision。它按 generation 有界，保留
  失败取证事实；物理清理由独立 retention/GC receipt 决定，不在失败路径同步删除。
- 不把 materialization 塞入 Kubernetes publisher。Publisher 只拥有 pointer CAS 与投影
  evidence；让它读取 OCI/PostgreSQL 会聚合执行和发布 authority。
- 不新增 `rolling_back` 状态。指针从未移动时，健康旧版本本来就仍是 active；新增补偿状态
  只会扩大恢复矩阵并让低配设备承担无收益的持久化协议。

## 当前验证

- Runtime Core 定向 21/21 通过，覆盖前置条件顺序、候选预物化、exact replay、无效语义拒绝、generation 1 B1 兼容和升级失败保留
  旧 `activeLockDigest`；拒绝路径的 activation publisher 调用次数为零。
- PostgreSQL/OCI/Kubernetes 现场门已升级为 `qinglong/plugin-package-recovery-e2e-live-contract@v2`：先用真实 signed OCI package
  激活 generation 1，再创建包含合法 Task 与循环 Workflow 的 generation 2；第一次 recovery 必须因 transition receipt 缺失而以
  `ClusterPluginPackageRecoveryRequiredError` 失败并留下 `staged`，提交 content-free transition receipt 后，第二次 recovery 必须把升级写为
  `failed(activation_fact_conflict)`，且 generation 2 materialized revision 数量仍为 0。现场门逐字比较 active ConfigMap 的 UID、
  `resourceVersion` 与完整 `active.json`，因此不能用“错误切换后再补偿回来”冒充旧版本未移动；OCI v1 六个路径各读取一次，v2 六个路径
  各读取两次，全部要求 HTTPS、exact Basic authentication、200 且无 redirect。最终 runtime rollout 仍只绑定最后一个成功 recovery Job，
  recovery ServiceAccount 继续只有 ConfigMap `get|create|update`，runtime 角色仍不能读取安装 authority。
- 18-package clean build/test 在允许 loopback TLS 的环境退出 0；backend 1196 项为
  1194 pass/2 条件 skip/0 fail。新增/更新的 recovery E2E 源码契约 7/7，Runtime Core 定向 21/21。package boundary 保持 18 个 package 且
  `singleSourcePackages=[]`、`shallowSourcePackages=[]`；cluster dependency、cluster deployment
  与 edge import 审计均无 finding。
- PostgreSQL `18.4` arm64 physical HA 通过 125 项门，timeline `1→2`，报告 SHA-256
  `8560469694c67776e5e4c70977f8bde8d4f5635f8e7d1c293ef449dc6da59f72`，临时 Docker
  资源已清理。本机已成功构建现场门所需 admin/control 镜像，但固定 `kindest/node:v1.32.8` 不在本地缓存，受限网络拉取数分钟无进度；
  门在创建任何 Kind 节点前被中止，并确认没有遗留集群或容器。因此 v2 门的代码与离线契约已完成，但仍不能计为真实 Kubernetes
  现场通过；远端 CI 成功记录与固定物理低配设备证据仍待完成，本 ADR 保持 Proposed。
