# ADR-0313：实例 Cutover Lineage 与双阶段人工恢复

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-17、D-63、D-64、D-65、D-259
- 关联 ADR：ADR-0065、ADR-0309、ADR-0310

## 背景

ADR-0310 已让未知的 Docker target start/restart 结果进入不可自动离开的
`manual_required`，但该终态只存在于 `service/cutovers/<cutoverId>/`。若没有实例级当前
lineage，调用方可以换一个 `cutoverId` 创建新 journal，从而把“不可重试”降级为“换 ID
重试”。同时，operator 还没有只读诊断和受审的新 ceremony 授权入口。

这个缺口必须在短生命周期 deployment authority 内关闭。低配路由器不能为恢复流程安装
数据库、daemon、timer 或 watcher；Application 也不能因此得到 Docker 或 journal 写权限。

编辑前 GitNexus 显示 legacy-stop 与 target 主入口均为 LOW、各 1 个直接命令文件包装器、
0 条已识别执行流程；统一终态 helper 为 MEDIUM、5 个包内直接调用者、0 条执行流程；CLI
`main` 为 LOW。没有 HIGH/CRITICAL 风险。

## 决策

### 1. 每个实例只有一个 durable lineage head

`ql3-local-deploy` 在现有 deployment root 内维护：

```text
service/cutover-instances/<instanceId>/head.json
```

目录固定为当前 UID 的 `0700`，head 固定为 `0600`。记录绑定 Profile、instance、cutover、
activation、revision、generation、前一 head digest 和来源 journal/preparation digest；head
自身也有规范化 SHA-256 digest。

首次 legacy-stop 在接触 Docker 前以 no-replace 方式认领实例。后续只允许：

```text
legacy_stop_requested -> legacy_stopped
legacy_stopped|target_active -> target_active|manual_required
manual_required -> resolution_authorized
resolution_authorized -> 新 cutover 的 legacy_stop_requested
```

head 的替换使用已有 `replaceExactFile(expected,next)` compare-and-swap。不同 cutover ID 在
旧 head 未经人工 resolution 时必须失败，且失败发生在新 journal 创建和 Docker authority
打开之前。target start/restart 同样必须先证明自己仍是实例 head；旧 ceremony 在 resolution
后不能继续运行。

### 2. Journal 是不可变事实，head 是可比较索引

`manual_required` journal 不删除、不覆盖，也不改写成成功。target journal 先落盘、head 后
同步；若在二者之间崩溃，原命令重放从不可变 journal 恢复并补齐 head，不会重复 start。
head 指向 terminal record digest，因此 operator 不能用另一个同名或自造记录替换来源事实。

### 3. 诊断只能 inspect

新增命令：

```text
ql3-local-deploy cutover-manual-diagnose
```

命令先验证 exact manual head 与其不可变 journal record，再对完整 legacy/target container ID
各执行一次 `docker container inspect`。输出只有 `stopped|running|unknown`、domain digest、
cutover ID 和 head digest，不返回 Docker 原文、路径、镜像名、PID 或错误正文，也不执行
`start`、`stop`、`restart`、`update`。

### 4. Resolution 必须 prepare/commit 双阶段确认

新增命令：

```text
ql3-local-deploy cutover-manual-resolution-prepare
ql3-local-deploy cutover-manual-resolution-commit
```

prepare 只有在 legacy 与 target 都被严格证明为 stopped 且 restart policy 为 `no` 时，才在旧
journal 中 no-replace 发布一个绑定 current/next cutover、current/next activation、manual head、
两个完整 container ID 和两份 inspection digest 的 preparation。running、ambiguous、inspect
失败或身份漂移都保持 `manual_required`。

commit 必须显式提交 preparation digest，重新 inspect 两个容器，并要求 observation digest 与
prepare 完全一致。随后才以 old head digest 为 expected value，把实例 head CAS 到新 cutover 的
`resolution_authorized`。commit 不启动或停止任何容器；CAS 后崩溃可由同一命令在不访问
Docker 的情况下返回 `existing`。只有新 cutover 的 legacy-stop 可以消费该授权并开始全新的
stop/commitment/target ceremony。

### 5. 保守支持边界

本版只授权“双容器均已由 operator 在 controller 外明确停止”的新 ceremony。若 target 仍在
运行，诊断会报告 `running`，prepare 拒绝；本命令不会猜测应采用当前 target、停止 target 或
恢复 legacy。target stop、写后数据对账与 rollback 是独立能力。

### 6. 资源与源码边界

实现继续位于现有 `@qinglong/local-owner-cli/deployment/cutover`，按 instance lineage、manual
command contract 和 manual coordinator 三个内部模块组织。没有新增 workspace package、生产
依赖、数据库连接、SQL/migration、后台进程或常驻资源。实例 catalog 最多 64 项，单 cutover
journal 仍最多 64 个小型私有文件；每次诊断/prepare/commit 固定两次 inspect。

## 被否决方案

1. **只在新命令中检查旧 cutover ID**：调用方仍能直接走 legacy-stop，不能关闭旁路。
2. **删除旧 journal 后重试**：销毁未知副作用的唯一审计事实，拒绝。
3. **prepare 后不重新 inspect 就 commit**：人工确认窗口内容器可能漂移，拒绝。
4. **resolution 自动 stop/start 容器**：把人工裁决重新变成未知外部副作用，拒绝。
5. **把 head 放入 SQLite/PostgreSQL**：deployment 恢复在数据库可用前也必须成立，并会给路由器
   增加第二 authority，拒绝。
6. **新建 cutover package**：没有独立 artifact、依赖闭包或 consumer 边界，拒绝。

## 验收证据

- cutover 专项 9/9：原 6 项 start/restart 门继续通过；新增换 ID 绕过失败、inspect-only
  diagnose + prepare/CAS commit + exact replay/new ceremony，以及 prepare 后容器漂移拒绝。
- `@qinglong/local-owner-cli` 完整沙箱外 119/119；沙箱内唯一失败仍是既有 provider test 监听
  `127.0.0.1` 被 EPERM，沙箱外原样通过。
- package 数保持 16；新增源码全部位于既有 `deployment/cutover/` 领域目录，没有根级平铺文件。
- 本批不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不重新生成 PostgreSQL
  HA 物理晋升证据。

## 未完成

- target 显式 stop 与最小写后分类（后续已由 ADR-0314 关闭）；仍 running target 的
  adoption/resolution、数据域对账与 rollback 仍未完成；
- systemd/OpenRC manual controller；
- adopted Compose live create/config 与真实 crash gate；
- Cluster/Kubernetes 独立 cutover authority；
- 强认证 operator ceremony、审计 UI/API 和外部审批集成。

本 ADR 关闭 Docker `manual_required` 的实例级绕过、只读诊断和最小双阶段新 ceremony
授权，但不宣称所有 controller 或 QingLong 3.0 整体完成。
