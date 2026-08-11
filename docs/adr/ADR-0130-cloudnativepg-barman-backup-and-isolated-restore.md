# ADR-0130：CloudNativePG Barman 备份与隔离恢复

- 状态：Proposed（CNPG-I 配置、私有 ObjectStore 边界、定时备份、隔离恢复清单、
  6 项配置 mutation gate，以及 Barman v0.13.0 release/controller/sidecar 的
  exact candidate lock 与 6 项供应链 mutation gate，以及 ADR-0131 的
  cert-manager v1.20.3/Kubernetes 1.32.8 兼容选择、Release manifest/OCI
  双平台供应链锁和 mutation gate 已完成；
  9 项非密钥灾备 evidence mutation gate 已固定 latest/PITR/rotation/RTO/RPO
  完成条件；真实对象存储与证书轮换演练仍是 Release Gate）
- 日期：2026-08-03
- 关联 RFC：QL-RFC-0001 D-06、D-123、D-127、D-128
- 关联 ADR：ADR-0125、ADR-0127、ADR-0128、ADR-0129、ADR-0131

> 2026-08-10 当前增量：直接执行 `ql3-cloudnativepg-barman-live-contract` 也必须在任何临时目录、
> Docker network/container 或 K3s 状态创建前，以 `statfs` 证明临时数据所在文件系统至少有 35 GiB
> 可用空间；不再只依赖 GitHub workflow 的外层 shell 检查。当前开发机只有
> 10,918,137,856 bytes 可用，真实调用已证明立即失败且前后 `ql3-barman-dr-*` 临时目录、容器与网络
> 都为零；因此没有把容量不足伪装为 live restore 通过。相关 DR 静态/报告门 44/44、backup/Barman/
> cert-manager 审计 compatible；独立 PostgreSQL 18.4 arm64 HA contract 同轮 `gates.passed=true` 且
> 容器、命名卷和网络零残留。D-128 仍必须在不少于 35 GiB 的候选 runner 上取得 current-source
> continuous WAL、latest restore、PITR、证书轮换和 RPO/RTO 私有报告后才能 Accepted。

## 背景

CloudNativePG 三实例同步复制只保护节点故障时的已确认写入，不保护误删除、错误
migration、凭据破坏、整个集群或存储故障。ADR-0129 已明确“三副本不代表备份”，
但若只提交一个对象存储 YAML，又会留下多套 WAL authority、把恢复凭据变成写入
凭据、原地覆盖源集群或将清单存在误报为恢复证据等风险。

CloudNativePG 的 Barman Cloud 已把对象存储能力迁移到 CNPG-I plugin。QL3 不再
引入 deprecated in-tree `spec.backup.barmanObjectStore`，也不在应用包内增加
Kubernetes、Barman 或对象存储依赖。

## 决策

### 1. 备份能力只属于 Cluster 部署层

`components/barman-cloud-backup` 是显式启用的 Kustomize Component：

- 为 `ql3-postgres` 安装且只安装一个
  `barman-cloud.cloudnative-pg.io` plugin；
- 该 plugin 是唯一 WAL archiver，绑定 `ql3-postgres-backup` ObjectStore；
- `ScheduledBackup/ql3-postgres-daily` 使用六字段 cron
  `0 0 0 * * *`、`method: plugin`、`target: prefer-standby` 和
  `backupOwnerReference: self`；
- 禁止同时出现 in-tree backup 或第二个 WAL archiver。

该能力不增加 workspace package、npm importer、edge/standalone/worker 闭包、
QL3 timer 或数据库 connection。Barman plugin 与其证书依赖由 cluster-admin
安装，不能由 cluster-control Pod 自助安装。

### 2. ObjectStore 是部署私有输入

共享 Component 不包含 ObjectStore 和 Secret，只提交带占位符的 schema example。
私有 overlay 必须：

- 使用支持 versioning 的专用 bucket/prefix，并在 provider 层启用 object lock 或
  等价不可变保护及受审 lifecycle；
- 只使用 HTTPS endpoint；
- 从独立 Secret 引用 access key，不在 ObjectStore、Kustomization、日志或 RFC
  中保存密钥；
- 对 WAL 和 base backup 使用 LZ4 与服务端 AES256，WAL 上传并发固定为 2；
- 将 Barman retention 固定为 30 天；provider lifecycle 不得早于该窗口删除仍被
  catalog 引用的对象；
- 每个源 Cluster 使用独立 ObjectStore 和 server prefix，不能让两个写入集群共享
  同一 `serverName`。

Secret manager、对象存储 IAM、bucket versioning/object lock 和跨故障域复制仍是
部署 authority；Kubernetes Secret 或 CRD 的存在不能证明这些策略已生效。

### 3. 恢复永远创建新 Cluster

`operations/cloudnative-pg-restore` 创建独立
`Cluster/ql3-postgres-restore`，保留 ADR-0129 的三实例同步 HA、digest-pinned
PostgreSQL 和非 superuser 边界。它通过 external cluster
`ql3-postgres-origin` 与 recovery-only ObjectStore
`ql3-postgres-recovery-source` 读取源 `serverName: ql3-postgres`。

恢复约束：

- 恢复 ObjectStore 使用独立、尽可能 read/list-only 的凭据；
- 恢复 Cluster 不配置 WAL archiver，避免把新 WAL 写回恢复源；
- 不设置 `cnpg.io/skipEmptyWalArchiveCheck`；
- 不修改、缩容、暂停或覆盖源 Cluster；
- 只有另行创建全新 destination ObjectStore、完成 WAL archive 健康检查和切换
  审批后，恢复 Cluster 才能成为新的生产写入源；
- 原地 restore、复用源写凭据或在 source bucket 上以相同 server name 开启归档
  一律拒绝。

### 4. 恢复演练以证据报告为完成条件

每次发布候选至少执行一次 latest restore，并按发布策略定期执行 PITR：

1. 记录 operator、PostgreSQL、Barman plugin/sidecar 的实际 platform imageID、
   CRD version、对象存储策略摘要和非密钥 IAM identity；
2. 在源库写入唯一 `before_backup` marker，强制 WAL switch，并等待归档健康；
3. 创建显式 Backup，等待其 Completed，记录 backup name、begin/end WAL、
   server name 和完成时间；
4. 写入唯一 `after_backup` marker，再强制 WAL switch并等待后续 WAL 可恢复；
5. 以独立恢复凭据创建 `ql3-postgres-restore`，不得改动源集群；
6. latest restore 必须同时看到两个 marker；PITR 到二者之间时必须只看到
   `before_backup`；
7. 复验 52 条 core migration、`control-core` capability v51、当前完整 schema、
   受审 function、十二个非特权 role、
   database owner、schema GRANT、`remote_apply`、三实例 ready 和应用 readiness；
8. 记录从创建恢复 Cluster 到数据库 ready、schema ready、应用 ready 的分段 RTO，
   以及最后可恢复 WAL 与故障时刻之间的 RPO；
9. 保存非密钥 JSON 报告、operator event 和 Backup/Cluster condition；失败时保留
   恢复环境供取证，不自动删除源对象。

清单可渲染、Backup 为 Completed 或 Pod 为 Ready 都不能单独替代上述报告。没有
marker、schema/role 和 RTO/RPO 证据时，不得宣称恢复成功。

`ql3-cloudnativepg-dr-evidence-audit.cjs` 把该报告固定为 exact-shape、最大 1 MiB、
不可 group/world writable 的非密钥 JSON。它拒绝密码、token、access key、私钥和
含密码 DSN，并交叉验证：

- actual CNPG/PostgreSQL/Barman/cert-manager imageID；
- 两个有序 marker、backup begin/end WAL、无 gap 连续归档；
- latest 同时包含两个 marker，PITR 只包含第一个且 target time 位于二者之间；
- 52 条 core migration、capability v51、当前完整 schema、受审 function、十二个
  非特权 role、
  数据库 owner 与同步 HA；
- writer/read-only recovery identity 分离、versioning/immutability/30 天 lifecycle；
- client/server serial 与 Secret resourceVersion 推进，轮换后仍完成 WAL、backup、
  latest restore 和 PITR；
- 每个部署显式给出 RPO、database RTO、application RTO 目标，observed 值不得超标。

### 5. Plugin 安装供应链独立锁定

`operators/barman-cloud/plugin-lock.json` 已把 Barman Cloud plugin `0.13.0`
绑定到：

- release manifest SHA-256
  `d2e71e7b06822448f1a421f05781846cfdb9cc621e7ef32eef5e20c5133213b0`；
- controller index
  `sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96`；
- sidecar index
  `sha256:990361af3319f9e23aafa0f6d7981f99bf1f69b4e6a85cf1bc7d71d6f09bb288`；
- 两个 image 的 `linux/amd64`、`linux/arm64` platform manifest；
- CloudNativePG `>=1.26.0` compatibility 与本项目受审的 `1.30.0` baseline。

该 lock 明确 `releaseReady: false`，且共享目录不得出现安装 manifest。ADR-0131
已锁定兼容 Kubernetes 1.32.8 的 cert-manager v1.20.3 Release manifest SHA-256、
controller/cainjector/webhook OCI index 与 amd64/arm64 子 manifest，并固定 Barman
client/server Certificate 身份与轮换窗口。tag-only installer 只能在下载摘要匹配后
按锁改写使用；供应链锁完成仍不等于 cert-manager API、mTLS 轮换或灾备演练完成。

## 替代方案

- **继续使用 in-tree `barmanObjectStore`**：拒绝。它复制新旧配置模型，并阻塞
  CNPG-I 迁移。
- **把 ObjectStore example 直接加入公共 Kustomization**：拒绝。占位符可能被
  误应用，也会迫使所有部署共享 endpoint、Secret 名称和保留策略。
- **恢复覆盖现有 Cluster/PVC**：拒绝。会同时破坏故障源、回滚点和取证证据。
- **恢复 Cluster 直接向源 ObjectStore 归档**：拒绝。相同 server name 可覆盖或
  混淆恢复源 WAL。
- **三副本或成功 Backup condition 视为灾备完成**：拒绝。前者同步逻辑破坏，
  后者没有证明对象可读、WAL 连续、schema 可用或 RTO/RPO。

## 影响

- Cluster 部署增加 Barman plugin、证书和对象存储运维面，但不增加 QL3 应用常驻
  资源，也不影响路由器 Profile。
- 每日 base backup、连续 WAL、30 天保留和 provider 不可变策略会产生可预期的
  存储与请求费用。
- 恢复需要独立三节点容量和独立凭据；这是隔离证据的成本，不能通过原地恢复省略。
- 真实 cert-manager API/mTLS 轮换与灾备演练完成前，ADR 保持 Proposed。

## 验证

- `QL3_CLOUDNATIVEPG_BARMAN_LIVE=1 pnpm test:cloudnativepg-barman-live:ql3 -- --report=/absolute/private-dr-report.json`
  是一体化、显式 opt-in 的本地孵化门：它创建隔离的四节点 K3s、TLS MinIO、
  writer/read-only recovery ObjectStore、三实例 source/latest/PITR Cluster，使用正式
  `cluster-control` runtime 镜像运行 migration 与恢复后的 `/readyz`，并在 base backup
  前固化 52 条 migration、capability v51、十二 DatabaseRole 和 `ql3_migration`
  database owner。成功时 stdout 直接输出可由下述 DR evidence audit 消费的
  `qinglong/cloudnativepg-disaster-recovery@v1` exact report；静态测试或 runner
  源码存在不能替代该 live 成功记录。报告必须包含本次 workflow checkout 的
  40–64 hex `sourceRevision`，不能把另一 commit 的演练结果重命名后用于发布。
  `--report` 只接受绝对路径，在 Docker mutation
  前拒绝已有目标，成功后以同目录临时文件、`fsync`、原子 no-replace link 和 `0600`
  权限发布，避免半写或覆盖历史演练证据。
- `.github/workflows/ql3-cloudnativepg-dr-live.yml` 只允许手动触发，并在至少 35 GiB
  临时磁盘、checksum-locked operator manifest 和固定工具链上执行同一 runner。它在
  live 前后精确比较 dangling Docker volume 集合，验证隔离 container/network 零残留，
  禁止任何 prune；报告再次通过 evidence audit 后才作为保留 14 天的私有 artifact 上传。
- `.github/workflows/ql3-image-release.yml` 的 `cluster-dr-release-evidence` Job 在
  `ql3-production-release-evidence` 环境的 ephemeral private runner 上读取固定
  `/run/qinglong3-release-evidence/<source-commit>/cloudnativepg-dr-evidence.json`。
  它重新执行 backup、Barman、cert-manager 三项静态锁审计，再要求 live report 与发布
  commit 精确一致、年龄不超过 24 小时、未来偏差不超过 5 分钟。所有 image publisher
  同时依赖该 Job、Worker management private evidence 与 OS vulnerability Job；失败时
  publisher 不获得 registry/OIDC 写权限。静态 selection lock 仍保持
  `releaseReady:false`，因为只有每次发布的外部 live report 才能解除本次发布 blocker。
- runner 必须把 Registry 的 `/var/lib/registry` 以及每个 K3s 节点的 `/var/lib/cni`、
  `/var/lib/kubelet`、`/var/lib/rancher/k3s`、`/var/log` 全部 bind mount 到本次演练的
  `0700` 私有临时树，使镜像 `VOLUME` 不再隐式创建匿名卷；退出时仍以
  `docker rm -f -v` 作为兜底。每个 container/network 必须同时带固定 scope label 和
  随机 run label，使零残留检查及异常退出后的精确归因不依赖模糊名称匹配。历史卷的
  归因与删除属于独立运维动作，不能由 live gate 自动扩大清理范围。
- `pnpm audit:cloudnativepg-backup:ql3`
- `pnpm audit:barman-cloud-supply-chain:ql3`
- `pnpm audit:cert-manager-selection:ql3`
- `node --test test/back/ql3CloudNativePgBackupAudit.test.cjs`
- `node --test test/back/ql3BarmanCloudSupplyChainAudit.test.cjs`
- `node --test test/back/ql3CloudNativePgDrEvidenceAudit.test.cjs`
- `pnpm audit:cloudnativepg-dr-evidence:ql3 -- --report=/absolute/private-report.json`
- `pnpm gate:cloudnativepg-dr-release:ql3 -- --report=/run/qinglong3-release-evidence/$GITHUB_SHA/cloudnativepg-dr-evidence.json --source-commit=$GITHUB_SHA --release-version=3.0.0`
- `kubectl kustomize deploy/kubernetes/ql3-cluster/operations/cloudnative-pg-restore`
- 用部署私有 ObjectStore 渲染
  `components/barman-cloud-backup`，确认 shared Component 未包含 Secret/example
- 真实 Backup/WAL/latest restore/PITR 演练及非密钥 RTO/RPO 报告
