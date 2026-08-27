# ADR-0510：跨 Profile Alpha 阶段交付索引

- 状态：Accepted（首份实际 stage index 待维护者授权）
- 日期：2026-08-28
- 决策：D-415
- 关联：ADR-0503、ADR-0506、ADR-0508、ADR-0509

## 背景

QingLong 3.0 已开发约二十天。D-413 与 D-414 分别闭合了双架构 Local Alpha Trial Kit 和四角色乘双架构 Cluster Integration Candidate，但部署者仍需自行理解两个 milestone、十个大归档、三种 Profile 和不同成熟度。

两个 milestone 分别成功不能自动证明它们来自同一源码与同一次完整 CI。维护者也缺少一个最外层、机器可读的阶段交付入口来回答“本次 Alpha 到底交付了什么”和“路由器或集群节点应该下载哪些文件”。

## 决策

### 1. 只有完整 `all` 运行才生成最外层索引

新增 `alpha-stage-index` 后置 job，仅在显式 `produce_alpha_artifacts=true + alpha_artifact_scope=all` 时运行，并只依赖已经成功的 `local-alpha-milestone` 与 `cluster-alpha-milestone`。它重新下载两个小索引并调用各自的离线 auditor，要求 version、source revision、workflow ref/SHA、run ID/attempt 完全一致。

成功后上传三文件 `qinglong/alpha-stage-index@v1`。其 maturity 固定为 `alpha_stage_delivery_not_public_release`，并记录两个 milestone artifact 名和 manifest digest。普通 push/PR、只生成 Local 或只生成 Cluster 的运行都不会产生该索引。

### 2. 部署选择进入机器可读契约

索引为 amd64、arm64 分别固定：

- Edge/Standalone 选择一个 Local Trial Kit；稳态角色只有 Application，Operator 是短生命周期角色；
- Cluster 最小集选择 control、admin、worker；control-ai 是显式可选项；
- 部署者只下载目标架构，不要求复制另一架构或无关角色。

跨索引 auditor 必须同时持有 stage、Local milestone、Cluster milestone，逐层复审并核对 manifest digest 和选择结果，拒绝跨 run 混用、内容篡改、额外文件或选择漂移。

### 3. Stage index 不获得正式发布权威

该名称刻意使用 `stage index`，不复用 Public Release Set 的 OCI release catalog。它不提供受保护 tag、GHCR immutable digest、签名、attestation、生产 deployment lock、HA、升级或 LTS 承诺。Local 与 Cluster 原有 maturity 不被最外层索引抬高。

## 被拒绝的替代方案

- 只写一页人工说明：无法绑定 exact source/run，也不能阻止部署选择和产物清单漂移。
- 把十个大归档再次合并：浪费下载与存储，尤其伤害低配设备和只需要部分 Cluster 角色的用户。
- 每次普通 CI 都生成阶段索引：没有实际可下载归档时索引会形成伪里程碑。
- 直接使用正式 release catalog：Alpha archive 没有 public immutable digest、签名和受保护 tag，不具备该 authority。

## 影响

- 显式 `scope=all` 增加两个小 artifact 下载、一次纯本地交叉审计和一个三文件小索引；
- Local-only/Cluster-only 授权继续独立工作，不被强迫生成另一部署档位的大归档；
- 不新增 workspace package、runtime dependency、镜像 layer、端口、daemon、timer、连接池或稳态 RSS；
- 低配设备获得明确的单 Trial Kit 选择，集群节点获得最小三角色与可选 AI 的精确选择。

## 验证

- 正向测试覆盖同 run 的两个 milestone 闭合、十个 artifact 选择与三 Profile 报告；
- 负向测试覆盖跨 attempt 混用、stage 内容篡改、额外文件、缺少 milestone dependency 和 scope 漂移；
- workflow audit 固定 `all` 条件、双 milestone dependency 和 `finalize → audit → upload` 顺序；
- 首份真实索引仍需维护者显式授权 `produce_alpha_artifacts=true + alpha_artifact_scope=all`。
