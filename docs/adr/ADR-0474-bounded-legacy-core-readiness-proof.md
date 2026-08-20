# ADR-0474：有界 Legacy Core Readiness Proof

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-64、D-274、D-275、D-380、D-381
- 关联 ADR：ADR-0315、ADR-0471、ADR-0472、ADR-0473

## 背景

ADR-0473 已把 adopted systemd/OpenRC 回滚安全地收敛到 `legacy_running`，但该状态只证明 init/process running、
target stopped 以及进程身份绑定。它不能证明 QingLong 2.x 已完成数据库初始化并能通过 HTTP 服务核心请求。把
`legacy_running` 直接当作回滚完成，会在服务仍启动中、初始化失败或错误版本占用端口时产生假成功。

readiness 证明同时必须适配低配路由设备与集群节点：它不能引入常驻 watcher、连接池、队列或新部署对象，也不能把
调用方提供的 URL、header、代理或重定向变成新的网络能力。编辑前 GitNexus 对 instance lineage 返回 MEDIUM：11 个累计影响、
9 个直接 importer、0 条已识别 execution flow；Local Owner CLI、live actor、Docker gate 和 package boundary 返回 LOW，未发现
HIGH/CRITICAL 风险。

## 决策

### 1. readiness 是显式、一次性 Owner ceremony

新增私有命令文件操作：

```text
ql3-local-deploy cutover-legacy-readiness-probe --command-file <private.json>
```

命令必须绑定 exact cutover/profile/instance/generation、activation digest、当前 `legacy_running` head digest、产生该 head 的
source record digest、legacy HTTP port、预期精确 2.x version 和请求时间。Owner 在任何网络请求前完成 instance head
compare-and-swap 复验；stale、漂移或非 `legacy_running|legacy_ready` 状态失败关闭。

该 ceremony 复用于 Docker、systemd 与 OpenRC，因为 readiness 所证明的是同一个 Owner instance lineage，而不是某个 init
manager 的私有事实。它仍是显式短生命周期进程，不自动挂接到 root bridge，也不在后台周期执行。

### 2. 网络能力固定且有界

生产探针只允许：

- `GET http://127.0.0.1:<bound-port>/api/system`；
- `Accept: application/json` 与 `Connection: close`；
- 每次请求最多 2 秒、响应最多 32 KiB；
- Edge 总预算 30 秒、最多 60 次，Standalone 总预算 60 秒、最多 120 次，固定 500 ms 间隔；
- 不使用 keep-alive agent、不跟随 redirect、不接受 caller URL/path/header/credential/proxy。

这些边界使失败成本由 Profile 固定，内存消耗为常数；集群节点不会因此获得新的外部网络、Worker 或控制面权限，低配设备也
不会新增常驻 RSS。

### 3. 只证明 2.x core readiness

成功必须同时满足 HTTP 200、现行 JSON envelope `code=200`、`data.isInitialized=true`，以及 `data.version` 与命令绑定的
精确 2.x version 相同。生产 Router 兼容测试直接运行 `/api/system`，证明当前 2.x 在已初始化与默认未初始化账户下保持该契约。

该结果称为 **core readiness**：它证明正确版本的本机 2.x HTTP core 已响应并完成初始化。它不证明任务执行、订阅、外部 provider、
通知、脚本依赖、Cluster Worker 或全部业务 API 健康，因此不得命名为 full health。

### 4. 成功持久化，失败不推进 lineage

成功后 Owner 以 no-replace、`0600` 发布 `legacy-readiness-gN.json`，收据绑定 prior head、legacy-running source record、endpoint、
预期/观察 version、attempts 与观察时间，再把 instance head 唯一合法地从 `legacy_running` CAS 到 `legacy_ready`。

相同命令的 exact replay 读取并复验收据，返回相同 `legacy_ready` 事实且发起零次网络请求。`unavailable`、`http_rejected`、
`response_too_large`、`response_invalid`、`not_initialized` 或 `version_mismatch` 都返回 `not_ready`，保持 head 为
`legacy_running`，不写失败收据，也不自动重启任何服务。

### 5. 保持 package 与部署边界

实现内聚在现有 `@qinglong/local-owner-cli`：

```text
deployment/cutover/legacy-readiness/
  contract.ts
  probe.ts
```

不新增 workspace package、production dependency、binary、daemon、listener、timer、watcher、数据库连接、systemd/OpenRC unit、
容器或 Kubernetes workload。用于 Docker live gate 的 HTTP 服务只是测试 fixture，不进入产品制品。

## 被否决方案

1. **把 `legacy_running` 当作健康**：进程存在不能证明 HTTP 与数据库初始化，拒绝。
2. **探测 `/api/health`**：该端点的进程局部 gRPC 观察在多节点/Worker 语义下容易过度声明，不适合作为 2.x core 回滚证明。
3. **接受 caller URL、header 或 `curl` 参数**：会扩大 SSRF、凭据与代理面，且无法形成可重放的固定契约，拒绝。
4. **在 root bridge 内自动探测**：会混合 OS mutation 与 Owner lineage authority，并延长 root ceremony，拒绝。
5. **后台 watcher 或无限重试**：会给路由设备增加常驻成本，也让失败无法有界，拒绝。
6. **新建 readiness package**：两个同生命周期源码模块没有独立交付和依赖理由，拒绝。

## 升级与回退

`legacy_ready` 是 additive lineage state；新版本只在 exact `legacy_running` 后写入。升级前应记录实际 2.x version 与 port，并以
Owner 私有命令文件传入。若回退到不认识 `legacy_ready` 的旧 3.0 孵化构建，应保留收据和 instance journal、停止自动 ceremony，
由 operator 审核后从受支持版本恢复；不得手工改写 head 伪造旧状态。

## 验收证据

- readiness 聚焦门 `6/6`，覆盖闭合 contract、成功/零网络重放、Edge 有界失败、version mismatch/stale head、真实固定回环和
  oversized/redirect 拒绝；生产 `/api/system` Router 兼容门 `2/2`。
- Local Owner 全量 `187 total / 182 pass / 5 conditional skip / 0 fail`；backend 全量
  `1,525 total / 1,523 pass / 2 conditional skip / 0 fail`。
- 18-package clean build 与逐包测试单次退出 0。package boundary、Service Bridge import、Edge import、Cluster dependency、
  Cluster/Worker deployment、Console 与 Console distribution 八项审计全部 compatible/passed；workspace 仍为 18 packages、
  `singleSourcePackages=[]`、`shallowSourcePackages=[]`，Local Owner 为 `113 source / 112 nested / 1 root binary entry`。
- 14 档 Local artifact audit 全部 compatible。基础 Edge/Standalone 保持 `2,598,669 / 2,598,747` bytes、316 files、
  57 loaded modules；Adopted 为 `2,817,964 / 2,818,087` bytes、58 loaded modules；Application+AI 为
  `4,501,822 / 4,501,954` bytes；MCP 为 `7,324,601 / 7,324,709` bytes、227 loaded modules。readiness ceremony
  没有进入基础运行闭包。
- systemd Docker live gate 覆盖 root/non-root success，真实 `/api/system` 使 Owner 进入 `legacy_ready` 并完成零网络 exact replay；
  root barrier-crash 保持 `manual_required`，不会错误执行 readiness。
- OpenRC actor 因 `node:24-alpine` 拉取卡在本机 Docker credential helper 而未执行，所以本 ADR 不宣称 systemd/OpenRC 全组合门闭合。
- 本阶段不修改 SQL、migration、PostgreSQL ACL/repository/role/Pool、连接或 failover 语义，因此不重跑且不重新占有 PostgreSQL HA 证明。

## 未完成

- 镜像基础设施恢复后的 OpenRC root/non-root success 与 barrier-crash live actor；
- 固定物理 Edge 的完整 rollback/readiness 证据；
- System、Script、Open API、鉴权与错误 envelope 的更完整 2.x 兼容矩阵；
- 真实 2.x 数据目录升级、Primary 双态和目标实例 rollback rehearsal。

本 ADR 关闭 `legacy_running` 到有界 `legacy_ready` 的 core readiness 证明，不代表 QingLong 3.0 升级/回退 Gate 已全部完成。
