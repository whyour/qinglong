# ADR-0395：Owner 确认的 Plugin Package Secret 首次绑定

- 状态：Accepted
- 日期：2026-08-13
- 关联 RFC：QL-RFC-0001 D-306B1
- 关联 ADR：ADR-0364、ADR-0393、ADR-0394

## 问题

D-305 已提供按 Package generation 不可变的 Secret binding ledger，D-306A 已让 materialization 消费该 binding，但部署者仍缺少受支持的产品入口。直接开放 repository 会绕过 User、Project Policy、Owner confirmation、Secret version existence 与当前 generation fence；让既有 generation 原地改绑则会使同一 materialized revision 在不同时间指向不同 Secret。

QingLong 3.0 同时面向低配路由设备和集群节点。本机产品入口不能引入常驻进程、第二条 SQLite 连接、watcher、timer 或 cache；Cluster 后续入口必须复用 separation-of-duty Approved Action，而不是复制 Local Owner authority。

## 决策

1. D-306B 拆成两个可独立验证的阶段：B1 只允许当前 active、尚未绑定 generation 的首次 binding；B2 才通过新 Package generation 完成 rebind、rotation 与 revocation。任何阶段都不得更新或删除历史 binding。
2. B1 使用共享、content-free 的 `qinglong/plugin-package-secret-binding-plan@v1`。服务端从当前 installation、admission proposal、lock、Manifest 与 resource generation 重建目标和 canonical entries，调用方不能提交 generation、Manifest digest、lock digest 或 binding digest。
3. Local 入口复用短生命周期 `ql3-package` 私有 command-file 链路。plan 与 execute 都要求强 `local-console` User、`secret.manage` 和当前 Project `owner`；execute 在 human confirmation 后进入既有单 SQLite operation authority，并在同一 `BEGIN IMMEDIATE` transaction 内重新验证 Owner fence、当前 generation、Package provenance、精确 Secret version existence、content-free audit 与 binding publish。
4. plan 只包含 SecretRef 元数据，不包含 Secret 明文；响应只返回目标摘要、canonical entry、plan/binding digest 与 created/existing 状态。required requirement 不能为 `null`，optional requirement 可以显式为 `null`，所有非空引用必须同 Project且固定 version。
5. plan 后撤销 Owner 必须使 execute 回滚且不留下 audit/binding。完全相同的 plan 与 audit identity 可以 exact replay；同一当前 generation 的第二次 bind/rebind、不同 audit identity 或任何 provenance drift 必须失败关闭，并提示通过新 generation 执行 B2。
6. workspace package 继续按部署制品、authority、依赖隔离、adapter 与多消费者裁决，不按文件数合并。D-306 的 Runtime contract/plan 归入同包 `plugin-package/secret-binding/{binding,plan}`，SQLite repository/administration 归入同包 `plugin-package/secret-binding/{repository,administration}`；稳定公开 subpath 不变，不保留旧物理路径 wrapper，也不为单个 plan 新增微型 package。
7. Local 实现不新增 package、migration、表、索引、依赖、进程、listener、连接、timer、watcher 或 cache。Cluster B1 复用 package-manager/package-executor 最小权限：manager 从数据库快照重建 plan 并提交 separation-of-duty Approval，短生命周期 executor 有界消费 approved queue、复验 requester `secret.manage` fence、执行 Approved Action，再以 metadata-only projected Secret existence proof 发布不可变 binding。产品 HTTP/CLI transport 与 Kubernetes live exercise 完成后，本 ADR 才能进入 Accepted。

## 明确不在 B1 中完成

- 不允许对已经绑定的 generation 原地 rebind、rotate 或 revoke。
- 不读取、解密、输出或复制 Secret value。
- 不让常驻 Local application、Cluster Control 或 Worker 获得管理 authority。
- 不以 Local Owner confirmation 替代 Cluster separation-of-duty Approved Action。

## 验证

- Runtime contract：plan canonicalization、digest/shape drift、Local/Cluster authority 派生与稳定 package subpath。
- Local 产品纵切面：真实 Package proposal/approval/activation，缺失 Secret version 拒绝，plan 后撤权原子回滚，恢复 Owner 后首次 publish、exact replay、重复 bind 与 audit identity drift 拒绝。
- 完整 18-package clean build/test；需要本机 TLS listener 的 Worker 测试在允许回环监听的等价环境复跑。
- package/dependency/edge/service-manager/local-image 审计与 GitNexus compare-to-`develop` 变更影响检查。

## 当前证据

- Runtime Core、Local SQLite、Local Owner CLI closure type-check 已通过；Local 产品定向纵切面 3/3。
- 18-package clean build/test 中除受限沙箱禁止绑定 `127.0.0.1` 导致的 Worker TLS 三项外，其余已执行测试均为 0 fail；同一 Worker 完整包在允许回环监听的环境为 133/133。
- Cluster 核心 authority 已完成：package-manager durable plan/proposal/decision、package-executor 有界 consumer/dispatch/handler、只读可选 Secret 投影与 immutable binding publish。`cluster-admin` 与 `cluster-postgres` 最终全包合计 638 pass/2 条件 skip；PostgreSQL 18 三角色真实纵切面 1/1，覆盖真实 install/activate、plan/propose/decide、consume/dispatch/bind、exact replay、manager 对 binding 表拒绝和 content-free 断言，并发现、修复 INSERT placeholder typmod 缺失。
- Cluster 产品入口已完成：复用既有 `/api/v3/plugin-packages/management` HTTPS route、TLS 1.3 服务端认证与 OIDC 强 User 身份、package-manager Pool、分布式 quota 与 `ql3-cluster-admin package` 一次性 client，开放 exact-shape 的 `plugin-package.secret-binding.plan|propose|decide|inspect`。响应仅含 content-free target、固定 version SecretRef、审批和 digest 摘要；client 会拒绝跨 Project、重复 requirement、action/approval/digest 漂移和扩展响应。management 进程不取得 Secret value、Kubernetes、executor 或最终 binding 表 authority，也不新增 listener、连接、进程或 workload。
- 当前 Cluster Admin runtime 镜像的统一产品 facade 已在 UID `10001:10001`、128 MiB、0.25 CPU、32 PIDs、read-only root、无网络、全 capability drop 和 `no-new-privileges` 下完成 live contract；七个子命令、operator context preflight/readiness 与 `package` 分派均通过。这是制品/CLI 资源门，不冒充 Kubernetes Secret projection 或多 Pod live exercise。
- 正式 transport 经 PostgreSQL 18 三角色真实纵切面 1/1，覆盖 install/activate、plan/exact replay/propose/separation-of-duty decide/authorized inspect、consumer/dispatch/bind、manager 最终表拒绝与 content-free 输出。`cluster-admin` 315 pass/3 条件 skip；完整 18-package clean build/test 退出 0，backend 1,188 pass/2 条件 skip/0 fail。package boundary、cluster dependency、cluster deployment、CloudNativePG、edge import、service-manager bridge、local image 七项审计零 finding；workspace 仍为 18 包且没有 single-source/shallow-source package。PostgreSQL 18.4 arm64 physical HA 125 gate、timeline `1→2` 已通过，报告 SHA-256 为 `6506b74721891cfd5709b1661562c204a310e99ed06131a25c464128f4ded4c6`。
- 三节点 K3s `v1.34.3+k3s1` arm64 现场门已完成真实 PostgreSQL `18.4` migration、两个 management Pod 跨节点反亲和、五次正式 HTTPS client `plan→跨副本 replay→propose→双人 decide→inspect`、真实 package-executor Job 与只读 Kubernetes Secret projection。management 与 executor ServiceAccount 均不能 `get/list secrets`、均不挂载 API token；management 不挂载 Package value，executor 只做 projection metadata existence check。数据库恰好发布一条 `approved-action-execution` binding，Approval consumed、execution succeeded，敏感值在 binding/plan/approval/execution JSON 中命中数为 0。低敏私有报告通过 16/16 gate 和独立 exact-shape 审计，SHA-256 为 `aaabb5ebea77c50bce671f91dd3051671fd20875c11a8f787fe8933f29dbfa4d`。本门不冒充 Kubernetes control-plane HA；PostgreSQL physical failover 继续由独立 125-gate 合约负责。B1 接受条件已满足，B2 rebind/rotation/revocation 作为后续新 generation 状态机继续推进。
