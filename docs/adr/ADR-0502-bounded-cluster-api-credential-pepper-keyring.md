# ADR-0502：有界 Cluster API Credential Pepper Keyring

- 状态：Accepted
- 日期：2026-08-26
- 决策：D-407
- 关联：ADR-0049、ADR-0050、ADR-0080、ADR-0083、ADR-0500、ADR-0501

## 背景

PostgreSQL API credential record 已保存 `pepperKeyId`，但 Cluster Control 运行时仍只装载一个 pepper，Security Administration 签发时也固定写入 `legacy-v1`。这意味着数据库虽然保留了密钥来源，却无法在不中断全部旧 credential 的情况下切换 pepper；如果认证端通过遍历所有历史 pepper 猜测摘要，又会扩大每个未认证请求的 CPU 成本和 timing surface。

QingLong 3.0 同时服务低配路由设备与集群节点。pepper rotation 只能进入 Cluster opt-in 路径，不能给 Edge/Standalone 增加 package、依赖、watcher、timer、连接池或常驻资源；Cluster 的认证热路径也必须保持一次精确摘要计算，而不是随历史 key 数线性增长。

## 决策

### 1. 运行时只接受最多两个显式 generation

`runtime-core` 提供 schema v1 keyring：一个 `activePepperKeyId` 和 1–2 个唯一 `{pepperKeyId,pepper}`。每个 ID 与 32-byte canonical base64url material 都使用既有 credential contract 校验，active ID 必须存在于 keys。原单 pepper 配置只通过显式 `legacy-v1` singleton bridge 保持兼容，不允许自动发现、环境合并或第三代历史 key。

Cluster Control 可从 `QL3_API_CREDENTIAL_PEPPER_KEYRING_FILE` 读取不超过 2 KiB 的 canonical 私有 JSON；它与旧 `QL3_API_CREDENTIAL_PEPPER` 必须二选一。文件必须是 canonical absolute regular file、不可为 symlink、不可向 group/world 写入，并在稳定 inode/mtime/size 下读取。Kubernetes 的 kubelet Secret volume 使用 symlink-backed Atomic Writer，不能直接满足该运行时边界；部署因此只把投影挂给同 UID 的 hardened init container，由它固定解析一个 `..data` generation，将 CA 与 keyring 以 no-replace 方式复制到 1 MiB memory-backed Pod-private volume 并收紧为 `0400` 普通文件。常驻容器只读挂载物化后的 volume，不可访问原始投影。运行时不安装 watcher；切换 keyring 后由部署系统执行受控滚动重启，新 Pod 在启动前重新物化。

### 2. 认证严格按 durable key ID 选择

认证先读取 credential record，再用其 `pepperKeyId` 精确选择一把 pepper，并只计算一次摘要。未知 key ID、缺失 material、畸形 keyring 或存储不可用都返回统一 unavailable；不得回退 active key、legacy key或遍历其他 key。未知 credential 的 timing dummy work 只使用 active key，不产生多 key 探测。

因此 overlap 期间旧 credential 继续使用旧 key，新 credential 使用新 key，但每个请求成本仍为常数。keyring 不进入日志、响应、审计详情或错误字段。

### 3. 新签发只绑定 active generation

Security Administration 使用 keyring 的 active key 计算新 token digest，并把 exact active ID 写入 credential record。`credential.issue`、`credential.rotate` 的 mutation/replay、私有 delivery 和同事务 audit 语义不变；旧 raw pepper 参数仍只映射成 `legacy-v1` singleton bridge。

CLI 在 `--pepper` 与 `--pepper-keyring` 中必须精确选择一个。keyring 文件属于短生命周期 admin authority，不进入 command JSON，也不复制到输出或数据库。

### 4. 退休前只做有界引用检查

新增只读 `pepper.references` 管理操作，输入仅为 exact `pepperKeyId` 和 1–64 的 limit。PostgreSQL 使用 `statement_timestamp()`，只返回该 key 当前最新、active、未过期 credential ID、观察时间与 `hasMore`；结果行、时间、ID、重复项或空集表示发生漂移时全部失败关闭。

该查询用于人工轮换 ceremony 的退休前判断，不删除 credential、keyring material 或历史记录，也不修改 active key。结果大小有界，但当前查询仍可能检查历史 credential versions；大规模生产数据上的索引/查询计划证据是独立门禁，不能把输出上限解释为数据库成本已经完全有界。

## 轮换顺序

1. overlap：部署 `{old,new}`，active 仍为 old，滚动重启并确认旧 credential 可认证；
2. activate：把 active 切到 new，再滚动重启，之后的新 issue/rotate 都绑定 new；
3. converge：轮换或撤销 old credential，分页执行 `pepper.references`，直到得到同一稳定部署下的空引用结果；
4. contract：从 keyring 删除 old，滚动重启并确认 old credential 失败、new credential 成功。

任何阶段都不得在仍有引用时删除 material。当前切片不实现 material destructive GC、持久 active-generation catalog、自动轮换调度或 Kubernetes Secret CAS；这些能力必须使用独立 ADR 和 live gate。

## 被拒绝的替代方案

### 认证时遍历所有 pepper

拒绝。它让未认证请求的成本随历史线性增长，扩大 timing surface，也掩盖 record 的 durable provenance 漂移。

### 无界 keyring 或永久保留所有历史 key

拒绝。Cluster 常驻 secret footprint、审计范围和错误配置 blast radius 会持续增长。3.0 首个轮换只允许 old/new 双代 overlap。

### 在进程内 watcher 自动热切换

拒绝。它增加后台 I/O、竞态和跨副本不可观察状态。初始产品基线使用显式配置更新和部署系统滚动重启。

### 同时给 Edge/Standalone 增加该 keyring

拒绝。D-407 只关闭 Cluster API credential 的结构缺口；本机 Owner credential 已有独立 catalog/keyring/GC ceremony，不能混合 authority。

## 验证

- keyring contract 覆盖 exact shape、1–2 key 上限、active membership、duplicate、invalid ID/material 和 singleton bridge；
- Cluster Control 覆盖 old/new overlap、stored key exact selection、unknown stored key fail-closed、旧环境变量 bridge、私有 keyring 文件与双来源拒绝；
- Security Administration 覆盖新 credential 绑定 active key、keyring CLI、引用查询 exact command/result 与旧单 pepper bridge；
- PostgreSQL repository 覆盖数据库时间、latest active/unexpired 过滤、limit+1、空引用与畸形行 fail-closed；
- Kubernetes Security Administration 只投影 `pepper-keyring.json`，stager 以 2 KiB 边界私有化到 memory-backed `0700/0600` 目录；常驻 Cluster Control 通过 init materializer 把 symlink-backed Secret generation 收敛成 Pod-private `0400` CA/keyring 普通文件，不再从 Secret 注入旧单值环境变量，也不向主容器暴露原始投影；
- overlap-old-active、activate-new、旧代引用 1→0 与 contract-new 已由远程 run `32893754795` 在 source `beb490c48c7d8ee4aee629924b5003fd8c73e9cb` 上完成受审 live 验收：K3s `v1.34.3+k3s1` 为 1 control-plane + 2 worker，CloudNativePG 1.30.0 管理 3 个 ready PostgreSQL 18.4 实例；三次 rollout 始终保持两个反亲和 Cluster Control 副本。五个真实 `/api/v3` probe 证明 old/new 在 overlap 期间认证成功但因无 Project role 返回 403，contract 后 old 返回 401、new 仍返回 403；数据库事实为两个 credential、四个 version、1 个旧代与 3 个新代 version、四次 authorization denied 与一次 authentication rejected。报告还证明 response-loss exact replay、RWO PVC 三个 no-replace delivery、网络/RBAC 拒绝与完整清理；content-free 离线复审为 `compatible=true/findings=[]`，报告 SHA-256 为 `d9e9fd1395adcef60f7f360959fcad27a9b2f0b132869bc1c75043dedd400ff6`；
- 当前 `cluster-admin` 完整回归为 459 total / 456 pass / 3 conditional skip / 0 fail，`cluster-control` 为 281 total / 279 pass / 2 conditional skip / 0 fail；`3.0.0-alpha.1` 身份下 18-package clean build/test 已完成（Worker Runtime 3 个 loopback 用例在沙箱外复验为 135/135）。物化修复后的治理/部署聚焦测试为 88/88，完整 backend 为 1599 total / 1597 pass / 2 conditional skip / 0 fail；source `f8934b401d724378fe5a6ea9dbe63e696b5480b9` 的远程 CI run `32898407637` 为 40/40，独立 Kubernetes deployment run `32898407590` 也已通过。

## 影响与剩余门禁

D-407 关闭了“数据库记录 key ID、运行时却只能使用一个固定 pepper”的结构性缺口。Edge/Standalone package、依赖和常驻路径零变化；Cluster 每个认证请求仍只解析 record 并计算一个摘要，管理引用检查只在显式短命令中打开一个 admin connection。

D-406 Kubernetes stager/Job 与常驻 Cluster Control manifest 已收敛为 keyring-only；旧单 pepper 只存在于通用 CLI/进程配置兼容桥。D-407 的真实 K3s/CNPG overlap→activate→contract 产品命令、运行时认证与权限边界门已经关闭，但这只是单 Docker host 上的应用合同证据，不是生产 control-plane HA、跨主机 STONITH/DR、加密 CSI 或外部 ingress TLS 证据。远程管理 API/UI、双人复核/break-glass、material GC、audit retention/export/alert 和大规模引用查询计划也仍未完成。
