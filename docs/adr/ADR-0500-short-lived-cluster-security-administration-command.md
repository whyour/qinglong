# ADR-0500：短生命周期 Cluster Security Administration 产品命令

- 状态：Accepted
- 日期：2026-08-25
- 决策：D-405
- 关联：ADR-0049、ADR-0050、ADR-0051、ADR-0276、ADR-0301

## 背景

ADR-0050 已把 Identity register/enable/disable、API credential issue/rotate/revoke、不可变 mutation ledger、强 actor、同事务 audit 与有界 audit query 收口到独立的 `@qinglong/cluster-admin` authority，并明确禁止常驻 `cluster-control` 获得 admin 数据库角色。但原切片只有 application service，没有受审产品入口。部署用户只能自行编写 composition root，容易重新引入常驻高权限进程、宽泛数据库连接池、secret stdout 或未经隔离的认证用途。

QingLong 3.0 同时面向低性能路由设备和 Cluster 节点。该入口只属于 Cluster Admin 镜像；不能进入 Edge/Standalone 制品，也不能为了操作便利新增 listener、daemon、timer、watcher 或常驻连接池。

## 决策

### 1. 在既有 Cluster Admin package 内增加短生命周期命令

`@qinglong/cluster-admin` 增加 `ql3-security-admin`，并由 `ql3-cluster-admin security` facade 到达同一安装内的固定目标。它继续位于 ADR-0301 已确定的 `security-administration/` 领域目录，不为一个共享相同镜像、依赖、升级和故障生命周期的 composition root 新建 workspace package。纯命令协议/runner 与 POSIX/PostgreSQL production runtime 分成两个领域内文件，避免再形成根目录平铺或单个超大 composition 文件。

命令不监听端口，也不读取 home、ambient Kubernetes context 或默认凭据。每次调用只执行一个 exact-shape JSON operation，然后关闭 PostgreSQL authority：

- `identity.register`、`identity.enable`、`identity.disable`；
- `credential.issue`、`credential.rotate`、`credential.revoke`；
- `audit.list`。

未知字段、相对路径、非规范路径、无界 audit query 和 operation/request shape 混淆都在获得数据库 authority 前失败关闭。

### 2. 独立强身份用途

管理命令只接受 dedicated JWT assertion profile：

- `typ=ql3-security-administration+jwt`；
- `purpose=security-administration`；
- 独立 audience 与 keyset generation/revocation ledger；
- 复用既有强认证规则，只接受当前、未撤销且满足 assurance 的 principal。

Plugin Package、Worker Credential、Automation、Approval、Run、Provider Credential 或其他管理面的 assertion 不能跨用途复用。assertion、keyset、pepper 与 command 都必须是显式绝对文件；私有材料拒绝 group/world 权限，读取时拒绝 symlink、大小越界和读中变更。

### 3. Admin 数据库 authority 保持一次性和最小化

命令使用独立的 `QL3_POSTGRES_ADMIN_*` 配置，只打开 admin role，Pool 上限为一个连接，并设置短 connection/idle/lifetime 边界。默认要求 PostgreSQL `verify-full` 与显式 DNS server name；只有同时指定 `TLS_MODE=disable` 和明确的不安全 opt-in 才允许测试环境禁用 TLS。

启动先验证 ADR-0050 admin schema/readiness，随后复用既有 Repository 与 `ClusterAdministrationService`。成功、拒绝、异常和 readiness 失败都关闭数据库 authority。runtime、migration 与 admin credential 仍不得混用。

### 4. Credential 只交付到私有 no-replace 文件

issue/rotate 的一次性 bearer token 不写 stdout、stderr、日志、audit 或命令结果。调用者必须提供一个尚不存在的 delivery path，其父目录必须是真实私有目录。publisher 在同目录创建 `0600` 临时文件，完整写入并 `fsync`，再以 hard-link no-replace 发布并同步父目录；已有目标永不覆盖。

stdout 只返回 delivery basename 与内容 SHA-256。语义重放仍遵循 ADR-0050：数据库返回 `token=null` 时不得重新生成或重新发布材料。若首次成功后的交付响应丢失，操作者只能以新的 mutation ID 执行 rotate，不能恢复旧 secret。

### 5. 本切片不是远程管理平面

该命令关闭“已有 administration service 但没有受审产品入口”的缺口，但不增加 HTTP/API/UI、远程 listener、全局 quota 或后台 retention/export。生产使用仍应由一次性 Job、受控运维工作站或等价的短生命周期执行环境注入 assertion、keyset、pepper 与 admin database credential，并在完成后销毁运行环境。

双人复核、break-glass、pepper rotation、audit retention/export/alert 和完整 Kubernetes Job ceremony 仍是后续门禁，不能由本命令的存在推断为已经完成。

## 被拒绝的替代方案

### 把命令加入 Cluster Control HTTP API

拒绝。它会让常驻业务进程获得 admin 数据库权限，并把 credential 签发和 audit 读取暴露到远程攻击面。

### 新建一个 workspace package 或常驻 Admin Deployment

拒绝。该 composition root 与 `cluster-admin` 共享镜像、依赖、权限和升级生命周期；拆包只会制造单文件 package，常驻 Deployment 则扩大高权限驻留时间和资源占用。

### 把 token 返回 stdout 或保存进 PostgreSQL

拒绝。shell history、日志采集、CI 输出和数据库备份都会成为 bearer custody 面，且破坏 ADR-0050 的不可恢复语义。

### 自动发现默认 keyset、pepper 或数据库凭据

拒绝。ambient authority 会让同一命令在工作站、Pod 和路由设备上取得不同且不可审计的权限来源。

## 验证

- 新命令测试覆盖强身份注入、authority 必关闭、敏感 Buffer 清零、credential 私有交付、精确重放不再发布、有界 audit query、widened shape 拒绝，以及真实 `0600` no-replace 文件语义。
- keyset 测试证明 Security Administration 的 type、purpose 与 audience 不能和其他管理面混用。
- product facade 与 admin-image live contract 冻结固定 target、无 shell delegation、`--help` 和无网络/只读容器运行边界。
- `@qinglong/cluster-admin` 完整回归为 448 total / 445 pass / 3 conditional skip / 0 fail。
- 18-package clean build/test 退出 0；backend 为 1575 total / 1573 pass / 2 conditional skip / 0 fail。
- 真实 arm64 Cluster Admin 镜像在 non-root、read-only rootfs、`network=none`、`cap-drop=ALL`、`no-new-privileges`、32 PID、128 MiB 和 0.25 CPU 下通过 12 个产品命令 live contract。PostgreSQL 18.6 arm64 physical HA 在 timeline 1→2 promotion 后通过 147 gates，content-free report SHA-256 为 `8fbb606773080dae15de5e31db5726abb8700862b51e4616b5f3f50e0b8374f3`。
- package boundary 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Cluster dependency、122-module Edge import、Cluster deployment、image release 与 service-manager bridge 审计全部 compatible。

## 影响与剩余门禁

D-405 提供了第一个可直接使用、默认无 listener 的 Cluster Identity/API Credential/Audit 管理入口，同时不改变 Edge/Standalone package、依赖或常驻资源。它只关闭 ADR-0050 的产品入口缺口；远程管理 API/UI、双人复核或 break-glass、pepper 生命周期、audit retention/export/alert 和生产部署 ceremony 仍需后续 ADR 独立证明。
