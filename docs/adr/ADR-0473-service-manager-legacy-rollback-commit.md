# ADR-0473：Service Manager Legacy Rollback Commit

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-64、D-274、D-275、D-379、D-380
- 关联 ADR：ADR-0314、ADR-0315、ADR-0362、ADR-0363、ADR-0472

## 背景

ADR-0472 已使 systemd/OpenRC adopted cutover 能在 Owner authority 内把安全候选推进到
`rollback_prepared`，但它刻意不授予 root mutation，也不能证明旧服务已经重新运行。若 root 直接把
`rollback_prepared` 当作启动授权，Owner 的数据判断、init mutation 与最终实例状态会混成一个不可审计步骤；若在响应丢失后
再次执行 `start`，又可能越过崩溃窗口重复副作用。

本阶段还必须同时适配低配路由设备和集群节点：回滚不能引入新 daemon、watcher、连接池或部署对象，也不能为了源码目录变密就
制造单文件 workspace package。编辑前 GitNexus 对 preparation、service bridge、deployment CLI、live actor 与 Docker gate
涉及的既有符号完成 upstream impact；均为 LOW，最多 3 个直接/累计上游、0 条已识别 execution flow。

## 决策

### 1. Owner 授权与 root mutation 分离

Owner 只能通过私有命令文件执行：

```text
ql3-local-deploy service-legacy-rollback-authorize --command-file <private.json>
```

授权必须重新验证当前 instance head、`rollback_prepared` record、Application 原始字节摘要、legacy-silence commitment 原始字节
摘要、目标 descriptor 摘要和 manager kind，并 no-replace 发布 `legacy_restart_requested`。preparation 不是 root 授权，root bridge
只接受这一种当前 head 和 exact authorization digest。

### 2. root bridge 只允许固定服务和固定 argv

root bridge 的唯一新操作是 `local.deployment.service-manager.legacy-rollback.execute`。它只允许：

- legacy 服务名 `qinglong` 与 target 服务名 `qinglong3`；
- systemd descriptor `/etc/systemd/system/qinglong.service` 或 OpenRC descriptor `/etc/init.d/qinglong`；
- 受审的固定 `systemctl` 或 `rc-service` argv，不接受 shell、任意 executable、服务名或路径；
- 启动前同时证明 legacy inactive、target inactive，并复验 Owner application/commitment/authorization 与 descriptor 原始摘要。

bridge 在任何 start 前先 no-replace 写 durable root barrier。barrier 之后的所有重放都只能 inspect，永不再次 start。

### 3. 响应丢失按双服务观察收敛

若 manager 实际完成 start 但响应丢失，重放读取 barrier 并检查两个固定服务：只有 legacy active、target inactive，且进程身份与
manager 观察一致时，root outcome 才是 proved running。若 barrier 已存在但无法证明上述事实，结果固定为 unproved，交给 Owner
终结为 `manual_required`；不得猜测、删除 barrier、替换 descriptor 或自动启动 target。

root outcome 先于 Owner outcome 持久化，因此 root 成功后 Owner 进程崩溃仍可用相同输入恢复，不重复 init mutation。

### 4. Owner 是实例终态唯一写者

Owner 通过：

```text
ql3-local-deploy service-legacy-rollback-consume --command-file <private.json>
```

消费 exact root outcome。只有 root 证明 legacy running、target stopped，且 authorization/head/digest 全部一致时，才 CAS 到
`legacy_running`；任一不确定、漂移或双服务冲突都进入 `manual_required`。exact replay 返回同一 completion，不覆盖已存在的不同
Owner outcome。

`legacy_running` 只证明 init/process running 与 target stopped，不代表 QingLong 2.x HTTP、任务调度、数据库或业务健康。

### 5. 保持部署与 package 边界

实现留在现有 `@qinglong/local-owner-cli`。为避免 `service-manager/` 继续平铺超过直接源码文件阈值，回滚子域内聚为：

```text
service-manager/legacy-rollback/
  preparation.ts
  contract.ts
  consumer.ts
  bridge.ts
```

不新增 workspace package、production dependency、binary、daemon、timer、watcher、socket、数据库连接、systemd/OpenRC unit 或
Kubernetes workload。root bridge 仍是显式短生命周期命令。

## 被否决方案

1. **把 `rollback_prepared` 直接交给 root**：准备事实不是启动授权，拒绝。
2. **barrier 重放再次调用 start**：响应丢失会重复副作用，拒绝。
3. **root 直接写 instance head**：会混淆 OS mutation 与 Owner 状态 authority，拒绝。
4. **只检查 legacy active**：target 同时运行时会制造双主，拒绝。
5. **把 `legacy_running` 宣称为业务健康**：init/process 观察不足以证明 2.x readiness，拒绝。
6. **新建 rollback package 或 daemon**：没有独立交付/依赖/生命周期依据，并放大路由设备闭包，拒绝。

## 验收证据

- 聚焦 Owner/contract 门 `16/16`；Local Owner 全量 `181 total / 176 pass / 5 conditional skip / 0 fail`。
- 18-package clean build/逐包测试单次退出 0；backend 全量
  `1,523 total / 1,521 pass / 2 conditional skip / 0 fail`。
- package boundary、Service Bridge import、Edge import、Cluster dependency、Cluster/Worker deployment、Console 与 Console
  distribution 八项审计全部 compatible/passed。workspace 仍为 18 packages、`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`；Local Owner 为 `111 source / 110 nested / 1 root binary entry`。
- 14 档 Local artifact audit 全部 compatible。基础 Edge/Standalone 为 `2,598,669 / 2,598,747` bytes、316 files、
  57 loaded modules；Adopted 为 `2,817,964 / 2,818,087` bytes、58 loaded modules；Application+AI 为
  `4,501,822 / 4,501,954` bytes；MCP 为 `7,324,601 / 7,324,709` bytes。回滚 authority 未进入基础运行闭包。
- systemd live actor 已覆盖 root/non-root 成功、真实 manager start、响应丢失后的 inspect-only 收敛、Owner
  `legacy_running` 消费与 exact replay；root barrier-crash 场景证明没有第二次 start，legacy/target 均保持 inactive，Owner 收敛为
  `manual_required`。
- OpenRC actor 因本机缺少 Alpine/OpenRC 基础镜像，拉取 `node:24-alpine` 时 credential helper 挂起而未执行；因此本 ADR
  不宣称 systemd/OpenRC 全组合门闭合。临时 systemd 容器、测试镜像和临时 tag 均已清理。
- 本阶段不修改 SQL、migration、PostgreSQL repository/role/Pool 或 HA 语义，因此不重新生成 PostgreSQL HA 证据。

## 未完成

- OpenRC root/non-root success 与 root barrier-crash live actor；
- `legacy_running` 后有界、可重放的 2.x readiness/health proof；
- 固定物理 Edge 的完整 prepare/authorize/execute/consume 回滚证据；
- `reconciliation_required` 的 export、冲突裁决与受审回灌。

本 ADR 关闭 service-manager 回滚的安全 commit 与进程级收敛，不代表 QingLong 3.0 升级/回退 Gate 已全部完成。
