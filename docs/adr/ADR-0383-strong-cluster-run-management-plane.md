# ADR-0383：强认证的 Cluster Run Management Plane

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-295
- 前置决策：ADR-0039、ADR-0056、ADR-0356、ADR-0364、ADR-0366、ADR-0381、ADR-0382
- Supersedes：ADR-0382 中“复用 `ql3_runtime` 且不新增 role/migration”的产品装配决策；ADR-0382 的共享语义与 PostgreSQL 原子事务仍有效

## 上下文

ADR-0382 已证明 PostgreSQL 手动 Run retry 的原子语义与 HA 收敛，但现有 Cluster Control bearer 只能建立 `single_factor` User，不能承载会再次执行外部副作用的人工恢复操作。直接把 repository 接进通用 Cluster HTTP 会混合普通控制面与强人类认证 authority；继续使用 `ql3_runtime` 又会使常驻 runtime 持有本不需要的人工恢复权限。

QingLong 同时服务低资源路由设备与多节点集群。新能力不能让 Edge/Standalone 增加进程、连接、timer 或 Cluster 依赖，也不应为了一个内聚领域再制造单文件 workspace package。

## 决策

### 1. 能力归属既有 Cluster Admin package

Run management 作为 `@qinglong/cluster-admin` 内的 `run-management/` 领域目录发布 service、transport、HTTPS process、client 与两个 CLI，不新增 workspace package。PostgreSQL adapter 仍归属 `@qinglong/cluster-postgres/run-manager`。根目录只保留协议装配入口，领域源码不得重新平铺。

### 2. 独立、显式启用的强认证进程

管理端只在 `QL3_PROFILE=cluster-admin` 且 `QL3_RUN_MANAGEMENT_ENABLED=true` 时创建资源；关闭时不读取证书、keyset 或数据库配置，也不创建 Pool、listener、timer、watcher 或 cache。服务使用独立 HTTPS 端口 `8448` 和固定 route `/api/v3/runs/management`，同时要求：

1. 受信 client CA 与 CRL 校验的 mTLS；
2. purpose-bound OIDC assertion：`aud=qinglong3-run-management`、`typ=ql3-run-management+jwt`、`ql3_purpose=run-management`；
3. 五分钟内的 `multi_factor|hardware` User；
4. 精确的 `qinglong/run-manual-retry@v1` command envelope，不接受调用方指定新 Run/Attempt/Event identity；
5. route admission 与数据库事务内分别重验 identity/Policy/audit fence。

Assertion keyset generation 使用 durable PostgreSQL ledger 的独立 `run-management` authority，不能与 Plugin、Worker、automation 或 Approval keyset 互换。client 是 caller-driven 的一次性命令，不引入常驻 agent。

### 3. 专用最小权限数据库角色

Migration `pg-0056-run-management-boundary` / capability v55 引入 `ql3_run_manager`。该角色只读 Project/RoleBinding/Task/execution revision，只对 Runs、Attempts、Events、security audit 和本 authority 的 identity ledger 取得精确所需权限；它没有 migration、admin、Worker、AI、Approval 或任意表 DELETE 权限，也没有更新既有 Run 的权限。

`SECURITY DEFINER` 函数 `ql3.lock_run_management_policy_fence` 只负责锁定 Project 并验证 active owner/admin/operator binding，固定 `search_path`，并仅向 `ql3_runtime` 与 `ql3_run_manager` 授予 EXECUTE。repository 不以 `FOR UPDATE` 读取源/重放 Run，因此不因 PostgreSQL 锁语法扩大 table UPDATE privilege。

精确 replay 从 immutable created/queued Events 恢复最初创建事实，而不是依赖被重试 Run 当前仍为 queued；调度进展后相同 mutation 仍返回原始 durable identity。

### 4. 部署按 Profile 付费

默认 Edge、Standalone 及 Cluster base overlay 都不引用 Run management manifests。需要该能力的集群显式应用 `operations/run-management`；CloudNativePG overlay 使用专用 Secret、primary DNS 与最多两个数据库连接。生产模板为两副本、PDB、反亲和、只读根文件系统、无 ServiceAccount token、受限 ingress 与只到 DNS/PostgreSQL 的 egress。低配单机不承担这些资源。

## 验收

- service/transport/process/client/HTTPS 的单元与回环测试覆盖强认证、purpose isolation、错误映射、限流、drain 与 exact replay；
- PostgreSQL package 全量测试覆盖 migration checksum、schema/readiness、role privilege 与调度后 replay；
- CloudNativePG 静态审计必须固定十四个角色和非秘密 placeholder；Run management deployment 必须证明 opt-in、mTLS、专用 role 与私网 egress；
- 真实 PostgreSQL 18.4 HA 必须以迁移后角色完成 readiness、事务写入、同步复制与 promotion 后事实核验；
- 完整 workspace package/backend/dependency/package/Profile artifact 门全部通过，GitNexus staged scope 只包含本阶段预期 flow，才允许提交。

## 被否决的替代方案

1. **接入通用 Cluster Control bearer**：认证强度不足且会扩大普通控制面的恢复执行 authority。
2. **继续让 `ql3_runtime` 作为产品管理角色**：常驻 runtime 无需持有人工 retry 与身份 keyset 写权限。
3. **新增 `@qinglong/run-management` package**：没有独立依赖、制品或部署生命周期收益，会重新产生单文件/浅 package。
4. **每个 Cluster Control Pod 内置管理 listener**：副本与普通 runtime 同扩缩，增加攻击面和低配常驻资源。
5. **允许调用方提交新 aggregate identity**：会扩大 replay/conflict 表面并削弱 server-authored fact。

## 验收证据（2026-08-12）

- `@qinglong/cluster-postgres`：309 pass、1 个外部数据库条件 skip、0 fail；`@qinglong/cluster-admin`：281 pass、2 个外部集成条件 skip、0 fail；`@qinglong/cluster-control`：230 pass、2 skip、0 fail；
- 完整 18-package clean build/test 全部退出 0；backend 1,167 项中 1,165 pass、2 个环境条件 skip、0 fail；
- workspace 保持 18 个 package，源码为 1,070 个（1,052 个 nested）；`singleSourcePackages=[]`、`shallowSourcePackages=[]`。PostgreSQL ordered migration ledger 直属文件仍为 58，v55 migration 归入既有 `run-management` 领域目录，没有放宽 dense-directory cap；
- CloudNativePG 静态审计固定 14 个最小权限角色；Run Management deployment 静态门证明默认 overlay 不引用、mTLS/OIDC authority 私有、Pool 上限 2、无 ServiceAccount token、只读根和仅 DNS/PostgreSQL egress；
- PostgreSQL 18.4 arm64 physical HA：119 gates、timeline `1→2`，两个独立 `ql3_run_manager` Pool 完成 exact concurrent replay 与最后 quota slot 竞争，`run-management` keyset ledger 经双连接、重启、commit-response-loss 验证；报告 SHA-256 `6ca8ccfb48841589e10c6484f5c97ce72e24b123f3abb1066a639e63718e64c6`，离线审计 `compatible:true`。

## 影响

- PostgreSQL schema contract 从 v54 升至 v55，生产部署在启用管理面前必须先创建 `ql3_run_manager` 并运行 migration；
- Cluster Admin image 增加两个 opt-in binary，但默认 Profile 不启动它们；
- ADR-0382 的原子 repository 和既有 HA 证据继续成立，产品装配改由本 ADR 的强认证进程与专用角色承载；
- UI 仍需以同一 transport 展示 source/new Run linkage、终态原因和 retry preview，不得绕过该 authority。
