# ADR-0395：Owner 确认的 Plugin Package Secret 首次绑定

- 状态：Proposed
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
- package boundary、cluster dependency、cluster deployment、CloudNativePG 审计零 finding；workspace 仍为 18 包且没有 single-source/shallow-source package。完整 18-package 串行测试与 backend 1,188 pass/2 条件 skip/0 fail 均通过。PostgreSQL 18.4 arm64 physical HA 125 gate、timeline `1→2` 已通过，报告 SHA-256 为 `7d54b2194420f9f14919aec7b67d744ba51ef5f3e3b681bbda8b44cc00e4f3f6`。Cluster Secret binding 产品 HTTP/CLI transport 与 Kubernetes live exercise 仍待完成，因此本 ADR 保持 Proposed。
