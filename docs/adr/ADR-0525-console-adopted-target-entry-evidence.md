# ADR-0525：Console Adopted Target 入口证据

- 状态：Accepted（源码与 CI 门禁已实现；exact Console 双架构阶段实物待生成）
- 日期：2026-09-01
- 决策：D-426b2c
- 关联：ADR-0512、ADR-0513、ADR-0522、ADR-0523、ADR-0524

## 上下文

ADR-0524 已用 headless Trial Kit 的只读 Application cutover probe 闭合 clean rollback 证据，但 Console 镜像的生产入口是 `ql3-local-api`。普通 Local API 启动会同时启动 Application、loopback listener、认证操作面、recovery、scheduler 与 execution admission；直接把它用于切换探针可能改变 adopted SQLite，既不适合低性能路由设备，也不能证明“target 尚未接收业务写入”。

把 Console artifact 继续标记为 `legacyUpgradeCutover=not_applicable` 又会留下另一类缺口：fresh Console journey 只能证明面板可用，不能证明下载到的 Console 镜像可由 adopted target controller 以 exact 生产入口启动。

## 决策

1. `ql3-local-api` 增加显式 `--cutover-probe --config <local-api.json>` 模式。它严格解析 Local API 配置，随后调用既有 Application 只读 cutover probe；不绑定 listener、不读取 credential 或 pepper、不启动 recovery、scheduler、execution、plugin recovery 或产品管理面，也不持有可写数据库。
2. Target run command 增加可选 `targetApi` 入口绑定：宿主 Local API 配置路径和容器内 exact 入口配置路径。省略该字段时，既有 headless command、journal digest 与证据 shape 保持不变。
3. Console target evidence 同时绑定外层 Local API 配置与内层 Application 配置：
   - 外层 schema、配置摘要、loopback host/port、deployment root、严格位于 root 内的 Owner pepper 目录；
   - 外层 `applicationConfigFilePath` 必须指向 exact 内层 Application target path；两个配置 target path 必须不同；
   - 两份只读配置 mount、deployment root mount、数据库与既有 activation/recovery/manifest/legacy mounts；
   - 容器命令必须精确为 `['--cutover-probe','--config',expectedLocalApiPath]`。
4. Trial Kit 的 canonical `upgrade-cutover-rehearsal.sh` 同时支持 `headless|console`。Console rehearsal 生成私有外层配置，运行同一 reviewed stage、Owner 强认证 apply、真实 synthetic Legacy stop、Console image probe start/stop 与 clean rollback classifier；成功 summary 升级为 `qinglong/local-alpha-upgrade-cutover-summary@v2`，并绑定 variant 与 target entrypoint。
5. 原生 amd64/arm64 artifact workflow 对两个变体都要求 `legacyUpgradeCutover=passed`，并在上传前删除 synthetic target/legacy 容器。fresh Console journey 仍单独证明真实 listener、HTTP、credential 与自动化能力，不能由无 listener probe 替代。

## Profile 与资源边界

- Edge/路由设备：默认仍选择 headless；若显式选择 Console，cutover probe 只增加一次性配置读取与只读 SQLite readiness，不新增 listener、daemon、timer、watcher、连接池或稳态 RSS。
- Standalone：与 Edge 使用同一证据模型，只保留现有 Profile 资源上限差异。
- Cluster：不复用 Local SQLite、POSIX owner、loopback Console 或 Docker target proof；Cluster control/admin/worker 部署链不变。

## 被拒绝的方案

- 用普通 `ql3-local-api --config` 做 probe：会激活写能力，破坏 clean rollback 语义。
- 只校验 Application 内层配置：不能证明下载镜像的真实 Console entrypoint 与 mount authority。
- 为 Console 增加独立 probe daemon/sidecar：扩大低配设备常驻面，且制造第二套生命周期。
- 把 fresh Console HTTP journey 当作 upgrade cutover：两者验证的权限、数据状态与失败恢复语义不同。

## 验证与交付状态

- Local API：80/80；cutover probe 单测覆盖成功、配置漂移与不启动 listener；
- Local Owner CLI：314 total / 307 pass / 7 conditional skip / 0 fail（新增双配置正向、内层指向漂移、路径别名与 Owner 目录边界）；
- Trial Kit bundle：12/12；Console gate 从 `not_applicable` 改为 `passed`，summary v2 绑定 `variant=console` 与 `targetEntrypoint=local-api`；
- Local Application：56 total / 51 pass / 5 conditional skip / 0 fail；
- package boundary、Cluster dependency、Edge import 与 Local image/operator image audit 均为 compatible；workspace package 仍为 18 个，未新增依赖、package 或常驻进程。

本机 exact Console image build 尚未形成阶段实物：Docker 配置的镜像镜像源 `register.liberx.info` 在解析固定 Node base image 时连续 EOF，构建未进入源码层。因此本 ADR 当前只声明“源码与 CI 门禁已实现”；只有同源原生 amd64/arm64 Console artifact、milestone 与离线 auditor 在成功终态 workflow 中闭合后，才能升级为“阶段实物已交付”。

## 后续

D-426c 继续处理 target 接收写入后的 capture、review、reconciliation 与恢复；Public Release 仍需受保护 tag、immutable multi-arch digest、签名/attestation、deployment lock 与生产回退门。
