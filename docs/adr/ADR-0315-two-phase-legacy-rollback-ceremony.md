# ADR-0315：双阶段 Legacy Rollback Ceremony

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-17、D-63、D-64、D-65、D-259
- 关联 ADR：ADR-0064、ADR-0065、ADR-0309、ADR-0310、ADR-0313、ADR-0314

## 背景

ADR-0314 已能停止当前 QingLong 3 target，并把数据证据保守分类为
`rollback_candidate|reconciliation_required|manual_review`。但 `rollback_candidate` 只是“target 尚未产生可见
新事实、legacy source 仍等于 recovery”的只读判断，不是启动 2.x 的授权。若 operator 在判断后直接运行
`docker start`，数据、容器或实例 lineage 可能已漂移，也没有 crash barrier 能阻止响应丢失后的重复副作用。

本机部署还需要兼容低性能路由器。回退协议不能引入数据库连接、常驻进程、watcher 或全历史扫描；同时必须让
较大的 Standalone 节点使用同一确定性 ceremony，而不是维护第二套语义。

编辑前 GitNexus 显示 rollback coordinator、instance head、target/legacy evidence 与 CLI 入口均为 LOW，最多
3 个直接调用、17 个累计上游符号、0 条 execution process；没有 HIGH/CRITICAL 风险。

## 决策

### 1. 只允许 exact rollback candidate 进入 prepare

新增两个短生命周期命令：

```text
ql3-local-deploy cutover-legacy-rollback-prepare
ql3-local-deploy cutover-legacy-rollback-commit
```

两者必须重读并验证同一 generation 的 target request、`target_active`、target stop request、
`target_stopped` 和 reconciliation evidence。command 必须提交 stop 返回的 exact `recordDigest` 与
`instanceHeadDigest`。只有 disposition 为 `rollback_candidate`，且实例 head 仍为相同
`target_stopped`，prepare 才继续。

prepare 重新证明 legacy/target 均 stopped、identity/application/source binding 不变，target/source 数据证据仍
等于 stop outcome；随后在实例私有目录 no-replace 写入 digest-bound preparation，并把 head CAS 为
`rollback_prepared`。它不执行 start/stop/update/restart，也不修改 SQLite。每实例最多保留 15 个 preparation；
任何 `rollback-*` 符号链接或非普通文件都失败关闭。

### 2. Commit 在副作用前后都重新证明双容器互斥

commit 必须携带 prepare 返回的 exact `preparationDigest`。它先复验 preparation、instance head、两容器 stopped
和数据证据，然后在 journal 固定写入 `legacy_restart_requested` barrier，并把 head 推进到同名状态。barrier
写入后、执行 start 前再次证明 legacy/target stopped 和数据未漂移，关闭 prepare/commit 与 barrier/start 之间的
TOCTOU 窗口。

随后只允许对冻结的完整 legacy container ID 执行一次 `docker container start`。最终 outcome 必须同时证明：

```text
legacy: running，identity/source binding 与原 commitment 一致
target: stopped，identity/application binding 与原 active evidence 一致
```

两项都成立才追加 `legacy_running` 并更新实例 head。任一项 unknown、漂移或 target 同时 running，均追加 terminal
`manual_required`，不得声称 rollback 成功。`legacy_running` 只证明受审容器已经运行，不等于应用健康、readiness
或业务数据完整。

### 3. Crash replay 以 inspect 收敛，不重复未知 start

rollback request/outcome 使用 generation 的 `4g+3`、`4g+4`，与 ADR-0314 stop 的 `4g+1`、`4g+2`
构成一条 append-only 链。preparation 存于 journal 外的实例目录，所以 15 generation 仍不超过既有 64 条 journal
文件上限。

- barrier 前崩溃：可原样重做只读 preflight。
- barrier 已写、start 尚未证明：重放只 inspect，不再盲目调用 start；legacy 未运行时进入 `manual_required`。
- start 已成功但响应丢失：重放 inspect 到 exact legacy running + target stopped，补写 outcome，不第二次 start。
- 已存在 outcome：校验 digest chain 后返回 `existing`，不打开 Docker socket。

这选择了安全的不确定性：可能要求人工确认一次已经失败的启动，但不会在未知状态下重复启动旧系统或形成双写。

### 4. 数据写后回退仍是独立 authority

`reconciliation_required` 和 `manual_review` 永远不能调用本 ceremony。协议不删除/覆盖 target，不把 target
SQLite 回灌 source，不执行 checkpoint，也不处理 Keyv、日志、配置和 Secret keyring。数据域 export、冲突清单、
人工选择和受审回灌必须由后续独立 ADR 定义。

### 5. 保持既有 package，按包内领域组织

实现位于现有 `@qinglong/local-owner-cli/src/deployment/cutover/`，按 contract、coordinator、共享 evidence 和
journal collaborator 分文件；没有为一次 rollback 新增 workspace package。package 是否独立由 deployable、authority、
依赖闭包或多 consumer 决定，不以“一个目录/一个文件”决定。当前 workspace 16 个包、790 个 source，其中 25 个
位于 `src` 根、765 个位于包内领域目录，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。

## 被否决方案

1. **stop 返回 rollback_candidate 后直接 start**：没有二次数据/容器证明和 durable barrier，拒绝。
2. **barrier 后重放 docker start**：响应丢失时可能重复副作用，拒绝。
3. **只证明 legacy running**：target 可能被并发启动并形成双写，拒绝。
4. **prepare 锁住 Docker socket 或启动常驻 supervisor**：不适合路由器资源边界，拒绝。
5. **将 rollback ceremony 拆成新 package**：没有独立交付或生产 consumer，不制造微包。
6. **把 reconciliation 合并进 rollback**：数据域冲突需要不同审批和恢复资产，拒绝。

## 验收证据

- cutover 专项 24/24，覆盖 exact prepare/commit、写后拒绝、prepare/commit drift、barrier crash、start response
  loss、barrier 后 target 竞争启动、legacy/target 同时 running、unsafe preparation entry 和 terminal manual。
- `@qinglong/local-owner-cli` 完整回归 134/134；16-package clean build/test 退出 0。
- package boundary schema v5 为 16/16、790 source、25 root、765 nested，且 findings、single-source、
  shallow-source 均为空。Edge import、Cluster dependency、Cluster deployment 全部 compatible。
- 十档 pack/install/import/RSS audit 全部 compatible，制品字节、文件数和加载模块数相对 ADR-0314 完全不变：
  最小 Edge/Standalone 为 3,623,093/3,623,129 bytes、331 files、49 modules；最大 Edge/Standalone
  Application AI 为 6,108,149/6,108,281 bytes、492 files、109 modules。
- 没有新增 production dependency、数据库连接、timer、watcher、listener、daemon、常驻进程或部署单元。
- 本批不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不重复生成 PostgreSQL HA 物理晋升证据。

## 未完成

- `reconciliation_required` 的数据域清单、export、冲突裁决和受审回灌；
- Keyv、日志、配置、Secret keyring 等多资产 backup/reconciliation manifest；
- systemd/OpenRC legacy rollback controller；
- adopted Compose live create/config 与真实 Docker crash/power-loss gate；
- Cluster/Kubernetes 独立 cutover authority；
- `legacy_running` 之后的应用 readiness/健康证明。

本 ADR 关闭 exact `rollback_candidate` 的双阶段 Docker Legacy restart ceremony，但不宣称写后无损回退或
QingLong 3.0 整体完成。
