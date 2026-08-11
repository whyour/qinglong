# ADR-0220：Plugin Package 当前安装清单查询

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-140、D-141、D-142、D-174、D-176、D-175、D-207、D-210
- 关联 ADR：ADR-0142、ADR-0143、ADR-0144、ADR-0184、ADR-0186、ADR-0217

## 背景

QingLong 3.0 的 Plugin Package 已有以下写入和恢复链路：

| 能力 | 当前状态 |
| --- | --- |
| install / reinstall / upgrade / rollback | 已实现 |
| proposal / approval / consume / dispatch | 已实现 |
| staged / activating / failed recovery | 已实现 |
| publisher revoke / quarantine / capability withdrawal | 已实现 |
| 精确查询当前安装 | D-210 前缺失 |
| 分页查询 Project 当前安装清单 | D-210 前缺失 |
| disable / uninstall | 未定义，后续独立状态机 |

管理 CLI 和 Cluster transport 虽然能检查 proposal/approval，却不能回答“某个 Project
当前装了什么、哪个版本可用、是否已经因 publisher 撤销而隔离”。部署者只能直接查
SQLite/PostgreSQL；这既不是稳定产品 API，也会暴露内部 schema 和过宽数据库权限。

此外，安全隔离采用 append-only overlay，而不是改写 install history。一个 install
record 可以仍是 `active`，但对应 lock 已有 quarantine event 和 withdrawal receipt。
仅回显 `install.state` 会把已撤回能力误报为可用。

## 决策

### 1. 独立只读 port，不扩大 mutation authority

`@qinglong/runtime-core/plugin-package-install` 增加
`PluginPackageInstallInventoryRepository`：

- `findCurrent(projectId, packageName)`；
- `listCurrentPage({ projectId, limit, after? })`。

该接口与既有 `PluginPackageInstallRepository` 分离。查询 composition 只依赖 inventory
port，不因复用同一个具体 adapter 而取得 admit/stage/activate/fail 等写能力。

清单只读取 current head，不返回历史 revision；顺序固定为 Package name 升序，游标仅含
最后一项 Package name。core 与 Cluster 页大小为 `1..64`，使用 `limit + 1` 判定
`truncated`，禁止 offset、任意排序、模糊查询和无界数组。

### 2. 查询结果必须感知 quarantine

SQLite 和 PostgreSQL 使用相同语义：

1. 从 `(project_id, package_name)` current head 取得精确 install record；
2. 只连接同时匹配 Project、Package、installation、lock 和 install record digest 的
   quarantine event；
3. quarantine event 必须存在对应 withdrawal receipt；
4. event、receipt 与 record 的 canonical JSON、digest 和 target binding 必须重新规范化
   并完全一致。

无隔离事实时返回 `quarantine: null`。event/receipt 只有一侧存在、JSON 损坏、target
漂移或出现多个 current 结果时失败关闭，不降级成“未隔离”。

产品层派生：

- 存在完整 quarantine fact：`availability=quarantined`；
- 无 quarantine 且 install state 为 `active`：`availability=active`；
- 其他 install state：`availability=not_active`。

因此安全 availability 不由可变缓存或 install enum 推断。

### 3. Local 产品入口与低配预算

既有 `ql3-package` 增加：

- `plugin-package.installation.inspect`；
- `plugin-package.installation.list`。

命令继续使用 Owner credential、pepper、私有命令文件和 Project Policy 认证。认证成功后
才动态加载 SQLite inventory adapter；只读命令不构造 proposal、approval、dispatcher 或
Package executor service。

Profile 预算固定为：

| Profile | 默认页 | 最大页 |
| --- | ---: | ---: |
| Edge / 路由设备 | 8 | 16 |
| Standalone | 32 | 64 |

每次仍是一次命令、一个短进程、一个 SQLite authority；不增加后台 timer、watcher、
listener、缓存或常驻连接。

### 4. Cluster 管理入口

Cluster 复用现有独立 `cluster-admin` management process，不接入常驻
`cluster-control`：

- 只接受受信 transport 注入的 active `multi_factor|hardware` User principal；
- 使用目标 Project 的 `package.manage`；
- 复用 durable `plugin-package.inspect` quota；
- 由 package-manager PostgreSQL authority 执行只读 exact/keyset 查询；
- 页大小硬限 64。

Cluster client 不只校验 exact JSON shape，还校验响应 Project、Package identity、
Package name 严格递增、请求游标之后的顺序、`next` 必须等于末项，以及
availability/quarantine/failure 事实完整性。远端不能用格式正确但语义漂移的响应欺骗
operator。

### 5. 低敏产品摘要

Local/Cluster 只返回：

- installation / Project / Package / version / operation；
- state、generation、active/previous lock digest、recovery action；
- failure 摘要；
- derived availability；
- quarantine reason/mode/event/time 与 withdrawal status/receipt/time；
- record version/time/digest。

不返回 source locator、完整 manifest、approval/stage reference、authentication ID、
credential、数据库 DSN 或内部命令内容。

### 6. 不在本决策实现 disable / uninstall

正常停用和卸载不是查询，也不能等同于安全 quarantine：

- 必须定义 Task、Tool、Workflow、Prompt 与 Secret binding 的撤出顺序；
- 必须处理 durable running、completion/recovery 与新 start barrier；
- 必须保留安装、审批、执行和审计历史；
- 必须检查跨 Package/Workflow 引用；
- uninstall 必须区分逻辑退役、物理制品回收和失败恢复。

这些语义需要独立、可重放、双方言原子的状态机 RFC。D-210 不删除任何安装或历史，
也不把 quarantine 当作用户可选的 disable。

## 不采用方案

### 直接暴露数据库表

拒绝。会把 schema 变成公共 API，绕过认证、Project fence、配额、边界校验和脱敏。

### 把查询方法加入管理 mutation service

拒绝。会迫使只读入口装配 proposal、approval、dispatcher 和 executor authority。

### 全量或 offset 分页

拒绝。并发安装时会重复/遗漏，且无法给路由设备提供确定内存上限。

### 新建 inventory package 或常驻同步 daemon

拒绝。没有独立部署或依赖隔离价值，违反 D-175/D-207，并增加低配设备安装、SBOM、
空闲 RSS 和维护成本。

### 顺便删除、disable 或复用 quarantine

拒绝。删除破坏历史；quarantine 表达 publisher/lock 安全撤回，不表达用户正常退役。

## 影响

- workspace 保持 20 个 package；
- 不新增 migration、第三方依赖、进程、端口或后台资源；
- mutation repository contract 和既有写路径不变；
- Local 与 Cluster 获得一致的 current inventory 语义；
- Cluster transport public operation 从 9 个增加为 11 个；
- disable/uninstall 明确列为后续独立状态机，而不是缺省删除行为。

## 验证

1. GitNexus impact：SQLite repository 为 HIGH（24 upstream、4 direct），PostgreSQL
   repository 为 HIGH（4 upstream、2 direct）；transport normalizer 为 HIGH（6
   upstream、2 direct）；新增服务/transport/client/HA 场景入口为 LOW。实现只增加只读
   方法并保持既有 mutation 语义不变；
2. runtime-core page/cursor、SQLite exact/list、双方言共享 repository contract、
   Local 完整 Package 生命周期、Cluster service/transport/client 定向回归通过；
3. Local 生命周期在 publisher revoke 后证明 install record 仍为 active，但 inspect/list
   均输出 `availability=quarantined`、精确 reason 和 withdrawal status，且不泄露敏感
   material；
4. Cluster 三包 TypeScript 闭包通过；`cluster-admin` 全包 132 pass、1 条真实
   Kubernetes 条件 skip，TLS client 6/6，覆盖 11 个公开 operation、跨 Project、
   重复/乱序 keyset、错误 next cursor 与不完整 quarantine 响应拒绝；
5. PostgreSQL 18.4 arm64 physical HA 使用公开
   `PostgresPluginPackageInstallRepository` 在隔离后和 timeline 1→2 提升后复验
   current exact/list，event/receipt 完全一致；
6. HA 输出
   `pluginPackageQuarantineInventorySurvivesPromotion=true`，36 个具体 gate 与总
   `passed=true`；临时依赖 link 由 trap 清理，Docker 资源由 HA fixture 清理。

当前未完成证据是六个 Local Profile 的正式 bytes/files/RSS artifact matrix：它仍由
exact local-sqlite Drizzle RC 未物化阻断。该限制不影响 D-210 的 Cluster HA 结论，也
不能用从受审本机镜像临时提取的依赖替代正式 lockfile 安装与远端 CI。
