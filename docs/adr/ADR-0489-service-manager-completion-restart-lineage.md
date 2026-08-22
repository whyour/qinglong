# ADR-0489：Service Manager 完成围栏重启谱系

- 状态：Accepted
- 日期：2026-08-22
- 决策：D-395
- 关联：ADR-0487、ADR-0488

## 背景

ADR-0488 建立 `reconciliation_completed`，并允许直接 Docker target 在下一 generation 重启，但 systemd/OpenRC 仍保持失败关闭。既有 Service Manager v1 intent 的 `previousRecordDigest` 同时承担“上一代 service active record”和“当前 instance head source record”两种含义；在 reconciliation 开始前二者相等，在 completed head 上却必然分离：历史 active record 仍用于排除旧 startup receipt，当前 head source 已变成 completion receipt digest。

忽略其中任意一条比较都会形成越权：只认历史 active record 会跳过八领域 completion，只认 completed head 则无法证明新 startup receipt 相对上一代发生变化。

## 决策

### 1. v2 intent 只表示 completed restart

`qinglong3-local-service-manager-intent` 接受 schema v2，但 v2 只允许 adopted、generation ≥ 2 的 `restart`。其 lineage 保留 `previousRecordDigest` 作为上一代 Service Manager active record，并新增一个内聚 `completionFence`：

- `expectedInstanceHeadDigest`：精确绑定当前 `reconciliation_completed` head；
- `expectedCompletionDigest`：必须等于该 head 的 `sourceRecordDigest`。

Owner 在 intent publish 前和 root outcome consume 后都重新读取 head；同时按 generation 打开上一代 active record，复验 record digest、Profile、instance 与 activation。intent 时间不得早于 completed head。调用方不能用 v2 表示 fresh install、普通 active restart、stop 或第一代 start。

### 2. v1 不被静默升级

v1 intent、普通 `target_active → restart` 和既有 v1/v2 service journal 继续按原契约解析。v1 intent 即使携带额外 completion 字段也因 exact-shape 失败；v2 缺少 completion fence 同样失败。completed head 不对 v1 放宽，因此旧 command、stale intent 或 root bridge replay 不能意外获得新 authority。

### 3. v3 journal 保存双谱系证据

由 v2 intent 产生的 Service Manager cutover record 使用 schema v3，在既有 manager outcome、application/activation/commitment、target identity、legacy data application 与 startup receipt 证据外，显式保存 completion fence。record 自身 digest 和 intent digest 共同覆盖上一代 service record 与 completed head；普通路径仍写既有 schema。

发布顺序保持 record-first、head-second。若 record 已发布而进程丢失响应，重放只在 v3 record、intent、outcome、completed head 和 completion fence 全部一致时把 head CAS 到 generation N 的 `target_active`；不会再次执行 root manager mutation 或接受旧 startup receipt。若 manager active 但新 receipt 无法证明，则允许从 completed head 窄化到 `manual_required`，该终态也能精确重放。

### 4. 部署与代码边界

实现留在既有 `@qinglong/local-owner-cli/deployment/service-manager` 内，没有新增 workspace package、常驻进程、timer、watcher、listener、Pool、SQL migration 或 production dependency。Edge/Standalone 只在显式管理命令中读取一个 current head 和一个上一代 service record；systemd/OpenRC root bridge 仍只消费 content-bounded intent，不读取 SQLite 或 reconciliation 大对象。

Cluster 不复用本机文件 journal。Kubernetes rollout、PostgreSQL completion 和多副本 restart authority 仍需各自的事务/CAS 与 HA evidence。

## 被拒绝的替代方案

### 把 `previousRecordDigest` 改成 completion digest

拒绝。它会失去上一代 startup receipt 和 Service Manager journal 的连续性，无法证明 restart 产生了新进程证据。

### completed head 对所有 v1 restart 自动放行

拒绝。旧 intent 没有声明或 digest-bind completion head，放行会把协议升级变成隐式权限扩大。

### 先推进 head、再补 service record

拒绝。响应丢失会留下 restart-ready head，却没有 manager outcome、startup receipt 或 process identity 的 durable record。

## 验收证据

- Service Manager contract/cutover、legacy rollback 与 reconciliation focused 组合门为 `75 total / 73 pass / 2 conditional Docker skip / 0 fail`，覆盖 v1/v2 exact shape、systemd/OpenRC contract、上一代 record 与 completed head 双重漂移拒绝、新 startup receipt、record-first response-loss replay，以及缺失新 receipt 时的 `manual_required` 收敛。
- HIGH/CRITICAL 影响范围通过完整 Local Owner `271 total / 264 pass / 7 conditional Docker skip / 0 fail`；18-package clean build/逐包测试为 `2917 total / 2895 pass / 22 conditional integration skip / 0 fail`。Worker receipt 测试在完整矩阵中复现约 `1.004 s` 的合法完成，轮询预算由 1 秒修正为 5 秒后 Worker Runtime 为 `134/134`，生产执行语义不变。
- dependency/package boundary 组合门 `70/70`，Edge import audit 为 122 modules、0 forbidden；workspace 保持 18 packages、无 single-source/shallow package，Local Owner 为 `172 source / 171 nested / 1 root binary entry`。
- 本机 root systemd/OpenRC Docker 门因 Docker Desktop 存储 `ENOSPC` 条件跳过，未清理用户匿名卷；同一提交仍必须通过远程全新 runner 的 root/non-root service bridge 和多架构门，不能用聚焦测试替代。
- 不新增 production dependency、SQL migration、daemon、timer、watcher、listener、Pool、PostgreSQL role/ACL、cluster workload、package 或 `src/` 根平铺文件。
