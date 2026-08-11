# ADR-0307：有界且诚实的本机部署持久状态

- 状态：Accepted
- 日期：2026-08-09
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-184、D-199、D-201、D-202、D-258
- 关联 ADR：ADR-0086、ADR-0194、ADR-0197、ADR-0199、ADR-0201、ADR-0202、ADR-0257

## 背景

QingLong 3.0 的本机部署工具已经能以私有 command file 准备 systemd/OpenRC/Compose bundle，并为
Compose revision、preflight、apply、失败回滚、SQLite restore 与证据收集提供可重放事务。但每个命令
只返回本次操作结果。CLI 响应丢失、operator shell 退出或设备重启后，部署用户没有一个低成本入口确认
当前 Profile、service kind、Compose generation 和是否残留事务锁，只能直接查看私有文件或冒险调用
Docker。

实时服务健康与持久部署状态不是同一事实。路由设备不应为状态查询加载 Docker client、扫描全部历史
receipt 或增加守护进程；集群节点也不应让这个本机工具获得 Kubernetes/Cluster Control authority。

## 决策

1. 既有 `@qinglong/local-owner-cli/local-deployment` 与 `ql3-local-deploy` 增加
   `local.deployment.status`/`status`，不新增 workspace package、生产依赖、binary 或部署单元。
2. 输入继续是 canonical 当前 UID `0600` 私有 command file；命令只含 `deploymentRoot` 与匹配当前
   POSIX identity 的 `allowRootService`。不接受 caller 注入 Profile、service kind、generation 或健康结论。
3. 查询验证 deployment root/service/revision 私有目录，读取 application v2 Profile 和唯一 service
   descriptor。Compose 使用既有 canonical selection/revision reader，返回 generation、可选 rollback target
   及 revision/rollout/restore/evidence-collection 四个固定围栏状态。
4. 任一围栏存在时只报告 `transition=recovery_required`，表示需要寻找并重放原命令；不把锁解释成服务
   故障，也不自动删除、恢复或继续事务。没有围栏只报告 `stable`，不推导容器正在运行。
5. 顶层固定 `observation=durable`，运行态固定 `runtime.health=unobserved`。实时健康必须继续由 init/Docker
   与 application active event 证明；状态命令不打开 SQLite、socket、网络或子进程。
6. 输出只含 Profile、service kind、generation、rollback target 与枚举状态，不返回路径、instance/image/
   digest/mutation/operation ID、socket 或 secret。实现读取固定数量且有 64 KiB 上限的小文件，不按历史规模
   扫描，Edge 与 Standalone 使用同一常数工作量。

## 被否决的方案

- **直接执行 `docker compose ps`/`systemctl status`**：会把只读磁盘观察扩大为平台命令执行、socket 权限和
  实时环境耦合，OpenRC/rootless/低配设备行为也不一致。
- **把持久状态命名为 healthy/active**：selection 和 descriptor 只能证明期望配置，不能证明当前进程、boot
  或 application admission；这会产生危险的假阳性。
- **扫描并汇总所有 receipt/snapshot**：成本随升级历史增长，还会把恢复证据细节暴露到普通状态面。
- **新增 deployment-status package/daemon**：状态能力与部署文件共享同一 POSIX authority，且只有一个生产
  消费者；拆包或常驻进程只增加 Edge 制品与生命周期成本。
- **状态命令自动清理残留锁**：锁是 response-loss 与恢复事务的唯一围栏，删除会破坏 exact replay 和恢复证据。

## 验收证据

- 编辑前 GitNexus：唯一修改的既有函数 `localDeploymentCli.main` 为 LOW，1 direct/1 total/0 process；
  `deploymentPaths` 与 `inspectActiveComposeImageSelection` 只被复用，没有修改。
- 新增 process、Compose stable/rollback/recovery fence、私有低敏 CLI 与静态 authority 隔离门；本机部署
  27/27、完整 Local Owner CLI 108/108 通过。
- 状态实现没有 SQLite/Docker/init import，不建立 connection、socket、timer、watcher、listener、queue、cache
  或子进程；workspace 仍为 19 package。Owner CLI 为 49 source/1 root/50 root lines/48 nested，新增实现位于
  既有 `deployment/` domain，没有新增根平铺文件或提高 hard cap；workspace 为 770 source/32 root/738 nested。
- 从空 `dist` 重建并测试 19 package 通过；backend 1,113 项为 1,111 pass/2 条件 skip/0 fail。package
  boundary、dependency、Edge import、Local image、Cluster deployment 与 image release 六项审计全绿。
- 十档 Profile artifact/RSS 全部 compatible，且相对 ADR-0306 字节、文件和 loaded module 完全不变：基础
  Edge 为 3,635,156 bytes/333 files/49 modules，最大 Standalone Application AI 为 6,123,870 bytes/
  492 files/105 modules。Owner CLI 状态能力不进入任何常驻 Application 制品。
- 最终 GitNexus 为 43,402 nodes/98,605 edges/1,703 clusters/271 flows；status inspector 为 LOW 1 direct/
  1 total/0 process，normalizer 为 LOW 1 direct/2 total/0 process，CLI main 保持 LOW 1/1/0。
  `detect_changes` all/compare `develop` 为 12/31、14/34，均 low/0 affected process。

## 后续边界

该入口只关闭“部署持久状态不可见”，不关闭真实服务健康、签名 release digest、systemd/OpenRC 安装启用、
固定 Edge/多架构物理压力与完整升级回滚演练。若后续提供 live status，必须作为独立显式 operation 接受并
验证对应 supervisor authority，且不能改变本契约的 `durable/unobserved` 语义。
