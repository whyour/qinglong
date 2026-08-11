# ADR-0362：systemd/OpenRC 双 Authority Service Bridge

- 状态：Proposed（产品 bridge、Owner consumer、adversarial、双 manager/双身份 adopted+graceful-stop 组合门与物理 recorder 协议升级已完成；实机报告待采集）
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-06、D-17、D-64、D-85、D-274、ADR-0194、ADR-0205、ADR-0309–0315

## 上下文

QingLong 3.0 已能为 Edge/Standalone 生成 systemd/OpenRC descriptor，也有真实物理设备的 init-managed
启动证据；正式部署仍要求管理员手工 `install`、enable/start。Docker cutover controller 不能直接推广：
它以最终服务 UID 运行，command、deployment root、journal 和 outcome 都必须是同一 UID 的私有
`0600/0700` 文件；system unit 安装、systemd system manager 与 OpenRC 通常属于 root。让 Owner CLI
直接 sudo，或让 root 读取/接管 Owner 私有 journal，都会破坏当前 UID、文件身份和 crash replay 边界。

路由器还存在两类真实形态：root-only OpenWrt/嵌入式设备可让 service UID 与 controller UID 都为 0；普通
NAS/Linux 则必须让常驻 QingLong 以非 root UID 运行、只有安装桥短暂取得 root。两者不能由一个隐式
“是否 sudo 成功”分支裁决。

## 决策

### 1. Owner 与 root bridge 是两个显式 authority

Owner deployment authority 先在既有私有 deployment root 中发布 no-replace service intent。intent 精确绑定：

- Profile、instance、cutover/generation 或 fresh deployment identity；
- service kind 与固定 service name；
- service UID/GID、deployment root、application config；
- prepared descriptor 的 canonical source、SHA-256、预期 root destination/mode；
- action ID、动作（install-enable-start、start/restart 或 stop）和请求时间；
- 上一代 active/stop/receipt/lineage digest（适用时）。

管理员使用独立 root-owned `0600` command file 调用短生命周期 `ql3-service-bridge`。bridge 必须要求
real/effective UID/GID 都为 root，不接受 setuid mismatch、shell string、任意 unit path、任意 service name、
调用方自报 active/stopped 或可修改的 manager 参数。

### 2. root bridge 只拥有平台副作用，不拥有应用状态

bridge 只允许：

1. 验证 Owner intent、deployment/descriptor owner/mode/realpath/digest；
2. 将 exact descriptor 安装为 root:root `0644`（systemd）或 `0755`（OpenRC），existing 必须内容完全一致；
3. 以逐参数 `spawn` 执行固定 manager 动作；systemd 只能 daemon-reload、enable、start/stop、show，OpenRC
   只能 rc-update add/show 与 rc-service start/stop/status；
4. 读取 manager 的 exact service/fragment/PID/enabled 状态；
5. 写 root 私有 durable barrier/outcome，并发布一个绑定 intent、descriptor 和 manager observation digest 的
   Owner outcome。

bridge 不打开 SQLite，不读取 Secret/Plugin/AI material，不判断 application ready，不推进 cutover instance head，
不重启 legacy，也不执行数据 reconciliation。Owner 收到 outcome 后仍必须自己验证 startup receipt、PID/start
identity、application config、activation/commitment、数据 evidence 和当前 lineage，才可写 `target_active` 或
`target_stopped`。

### 3. 两侧 journal 独立且 crash-safe

root bridge 在固定 root-owned `0700` controller root 中按 action ID 保存 no-replace barrier/outcome；目标已存在、
descriptor drift 或 action ID 跨 intent 复用时失败关闭。barrier 发布后发生未知 start/restart 结果，重放只 inspect，
不再次执行 manager mutation；无法证明 exact active/stopped 时产出 `manual_required`。stop 可以在 mutation 前保持
幂等，但一旦 barrier 已存在，同样优先 inspect，避免把新一代进程误当旧 action 停止。

交给 Owner 的 outcome 只能发布到 intent 预先绑定、位于 Owner `0700` 目录内的新路径。bridge 以同目录随机 stage
写入、fsync、fchown 为 service UID/GID、hard-link no-replace、父目录 fsync；Owner 只接受自身拥有的 `0600`
regular file，并复验 bridge outcome digest。root journal 与 Owner outcome 任一缺失都不能靠另一个布尔值补齐。

### 4. root-only 与非 root 部署使用同一协议

root-only 设备必须显式 `allowRootService=true`，service UID/GID 均为 0；Owner intent、bridge command 和 outcome
仍分阶段发布，不能退化为一条 shell。非 root 部署使用 service UID/GID，bridge 仅在 outcome 最终发布时把文件
交还该 identity。两种模式共享 schema、状态机和审计器，避免形成“路由器快捷旁路”。

### 5. 代码与 package 边界

首版放入现有 `@qinglong/local-owner-cli` 的 `deployment/service-manager/` domain，并增加独立 binary entry；它与
现有 deployment/Docker cutover 共享安装制品、command-file 协议和 release cadence，不新增常驻依赖。root bridge
入口只能静态到达 command-file 与该 domain，不能 import Owner console、SQLite、AI、Docker cutover 或 application。

暂不新增第 18 个 workspace package。只有未来 root helper 需要独立 OS package、不同 Node/native 依赖、独立签名/
更新责任或必须从 Owner 安装闭包物理排除时，才以这些真实部署证据重新评审；“root 权限听起来重要”或文件数量
本身不足以拆包。

## 不采用方案

- **Owner CLI 直接执行 sudo/systemctl**：交互、policy、环境和 effective UID 不稳定，command-file owner 语义被破坏。
- **root 直接消费 Owner command/journal**：现有协议明确要求 current UID owner；放宽会让全部 Owner ceremony 扩权。
- **Application 自己管理 init service**：常驻进程将持有 root/service-manager authority，违反最小权限与自更新隔离。
- **只记录 manager exit code**：响应丢失、manager 接受但服务失败、PID/unit 被替换都无法裁决。
- **为 bridge 立即新增微型 package**：当前没有独立发布或依赖闭包收益；先用独立 entry 与 import gate表达权限。
- **只支持 root-only 路由器**：会把 NAS/普通 Linux 的非 root 常驻要求推回手工旁路。

## 验收门

1. contract 必须拒绝未知字段、任意 service name/destination、非 root bridge identity、symlink、错误 owner/mode、
   descriptor drift、action replay drift 和 shell-shaped manager 参数。
2. systemd 与 OpenRC 都必须覆盖 fresh install/start、exact replay、start response loss、stop、descriptor drift、
   replaced PID/unit、barrier 后 crash 和 Owner outcome no-replace。
3. Linux 容器门必须运行真实 systemd 与 OpenRC manager；fake runner 只属于单元故障矩阵，不能代替最终 manager gate。
4. 物理 Edge recorder 必须通过同一产品 Owner intent/root bridge/Owner outcome 安装固定 `qinglong3` unit，再证明
   boot→init→direct release active、graceful stop 与 root bridge 产物完全相同；容器门不替代
   固件启动、断电、flash 或低内存证据。
5. package boundary 必须保持 17，Edge/Standalone 常驻 artifact 不加载 bridge，Cluster/Worker 不安装或导入该入口。

## 当前实现与证据

2026-08-11 已在现有 `@qinglong/local-owner-cli/deployment/service-manager` domain 完成首个产品闭环：

- Owner 的 `service-intent-prepare` 从当前私有 `local-application.json` 与 prepared descriptor 派生 Profile、
  instance、UID/GID、canonical path、mode 和双方 SHA-256，以同目录 stage→fsync→hard-link no-replace 发布
  `0600` intent；adopted generation 1 只允许 install/start/stop，generation 2+ 只允许 restart/stop。Owner 还会
  读取当前 instance head 并执行 compare-and-swap 前置校验：首次 install/start 只能绑定
  `legacy_stopped@generation 0`，restart 只能绑定上一代 `target_active`，stop 只能绑定当前代
  `target_active`，且 `previousRecordDigest` 必须等于 head source record；已有 head 时禁止以 `fresh` 绕过。
- 独立 `ql3-service-bridge` binary 只接受 root-owned `0600` command，要求 real/effective UID/GID 全为 0；
  root 对显式 Owner `0600` intent 做 lstat→`O_NOFOLLOW`→fstat identity read，不放宽通用 current-UID
  command-file reader。descriptor、application config、Owner outcome directory、manager executable 与 destination
  parent 均按 owner/mode/realpath/digest 失败关闭。
- root controller 先发布 action barrier，再进行 exact descriptor install 和固定 argv manager mutation；barrier 后
  replay 只 inspect。root outcome 先 durable no-replace，再通过 `fchown(service UID/GID)`、`0600`、hard-link
  no-replace 与父目录 fsync 交给 Owner。Owner `service-outcome-consume` 重新验证 intent/outcome digest、当前
  descriptor/config、UID/GID、fragment 与 manager observation，不把 exit code 当 active 事实。
- 独立 Owner `service-cutover-consume` 只接受 adopted `@v3` application binding，将 manager outcome 与当前
  activation、legacy silence commitment、source/target/recovery/manifest 私有稳定身份汇合。active 还必须取得
  与上一代不同的 startup receipt，并从 `/proc` 复核 service UID、manager PID（systemd）、process start ticks 与
  Node executable；stop 必须证明原 receipted PID/start identity 已消失。consumer 先 no-replace 发布 digest 串联的
  service cutover record，再 CAS 推进 instance head；崩溃重放从 record/head 收敛，不重复 manager mutation。
- systemd 只执行 daemon-reload/enable/start/restart/stop/show；OpenRC 只执行 rc-update add/show 与 rc-service
  start/stop/status，restart 为显式 stop→start。fake runner 故障矩阵覆盖 systemd response-loss 后 PID 变化、
  exact replay 不重复 mutation，以及 OpenRC 固定 argv/response-loss；root Linux 基础与 adversarial 定向门 5/5。
- 真实 Docker gate 使用 systemd PID 1 与 Alpine 的真实 rc-update/rc-service/openrc-run/supervise-daemon，在四个
  隔离容器中分别覆盖 systemd/OpenRC × root UID 0/非 root UID 10001。四组都完成 root command、exact
  descriptor install、enable/start、Owner outcome consume、exact replay、stop 与 `/proc` service UID 证明；
  systemd 双身份和 OpenRC root 还完成 restart。四组随后全部切换到 adopted v3 fixture，由真实受管 Node 进程
  原子发布 Linux startup receipt，Owner consumer 对真实 `/proc`、activation/commitment/static data 执行复验并
  分别推进 `target_active → target_stopped`。总 gate 新增 `adoptedCutoverActive/Stopped=true`，最新报告 SHA-256
  为 `267f8f3cb4145db6fb8acd5a3690352a78694cd25e2f6c1c483f0ef2227c85a0`，结束后相关容器为零。该轮还发现并修正
  gate 中缺失 `storage.mode=fresh` 的伪 v2 fixture；产品 intent parser 继续对该无效配置失败关闭。
- Local Owner service bridge/consumer 定向测试本机 13 pass/5 root-only skip，root Linux 5/5；完整 Owner 套件
  唯一一次非通过是 sandbox 禁止绑定 `127.0.0.1`，该原有 Provider 测试在允许本机
  loopback 后 9/9。package boundary 仍为 17，dependency audit 零 finding，Edge import compatible；独立
  bridge import audit 强制禁止 SQLite、Owner Console、AI、Docker cutover 与 application 进入 root binary。
- Owner cutover consumer 新增 5/5：首次 active journal→head、相同 outcome/head 幂等重放、restart 复用旧 receipt
  进入 `manual_required`、stop 仅在原 PID/start identity 消失后推进，以及 legacy source/recovery 内容漂移在 head
  mutation 前失败关闭，manager PID/receipt PID 替换也进入 terminal manual。root adversarial 5/5 覆盖 systemd/
  OpenRC response-loss inspect/replay、descriptor drift、barrier 后 crash+installed unit replacement、Owner outcome
  no-replace；既有 Docker cutover 24/24 回归通过。
- 既有 `evidence:physical-edge-direct-service-start` 已移除旧的直接 root install/enable plan：prepare 现在以 Owner
  发布 fresh `install-enable-start` intent，session 固定正式 `qinglong3` unit 并绑定 action/intent/outcome/root
  controller；operator 只得到固定 root bridge command。新 boot 的 resume 先以 Owner 复验 active outcome，再将
  outcome/observation digest 与当前 boot receipt、init/PID、descriptor 和 artifact 一起写入 candidate report；统一
  importer 会重新裁决 `owner_intent_root_service_bridge_owner_outcome`。该升级不新增 package、依赖或常驻资源。
- ADR-0363 增加 Application shutdown receipt 与 direct service stop recorder。Owner adopted stop 现在必须同时验证
  root bridge stopped outcome、与上一代 startup receipt 精确绑定的 SIGTERM/stopped receipt，以及旧 PID/start
  identity 消失；缺少 receipt 会进入 `manual_required`。真实四容器组合门已用 systemd/OpenRC × UID 0/10001
  证明该链路，最新报告 SHA-256 为
  `28d5c29f91747f88b099c4918648199c21338fa48b9840c48d8027e70f14c954`，容器零残留。

仍未完成且不得由上述证据替代：固定物理 Edge 上实际执行 root bridge/reboot/start-resume/stop-resume 得到的
start+graceful-stop 配对 report，以及断电、flash、低内存证据。因此本 ADR 与 D-274 继续保持 Proposed，管理员手工安装/启停仍是正式
运维路径。

## 影响

该决策明确关闭“直接把 Docker adapter 改名为 systemctl”的错误路线，并提供同时覆盖 root-only 路由器与非 root
Linux/NAS 的可恢复权限模型。当前状态仍为 Proposed：bridge contract、产品 binary、Owner outcome/lineage
consumer、adversarial、双 manager/双身份 adopted 组合真实门和物理 recorder 协议升级已经完成，但物理设备报告尚未采集；运维文档中的管理员显式安装/启停步骤继续是唯一受支持路径，
D-64 不能标记完成。
