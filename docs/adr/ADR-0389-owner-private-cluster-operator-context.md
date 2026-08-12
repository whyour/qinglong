# ADR-0389：Owner-private Cluster Operator Context

- 状态：Accepted
- 日期：2026-08-13
- 关联 RFC：QL-RFC-0001 D-301
- 前置决策：ADR-0191、ADR-0192、ADR-0250、ADR-0388

## 上下文

ADR-0388 统一了七个 operator-facing Cluster client 的命令发现与调度，但六个直连 client 仍重复要求 `--config/--command/--assertion`，Kubernetes tunnel 额外要求 `--kubernetes`。其中 client config 与 tunnel config 是可跨操作复用的稳定连接事实；command 和强用户 assertion 则是每次操作的短生命周期 authority。若把四类文件都写入默认 profile、环境变量或 home 自动发现，统一 UX 会以环境劫持、错集群和长期 assertion 为代价。

## 决策

1. 在既有 `@qinglong/cluster-admin/product-cli` 内增加 operator context reader，不新增 package、依赖、数据库对象、listener、timer、watcher、cache、Secret 或 Kubernetes workload。
2. facade 接受显式 `--context=/absolute/operator-context.json`。无该参数时继续 opaque 转发原有 `--config` 调用，保持所有已有 binary、脚本和 Job 兼容。
3. schema v1 根只允许 `schemaVersion` 与非空 `commands`。命令键只能来自 ADR-0388 七项 catalog；普通命令 entry 只允许 `configFile`，`package-kubernetes` 精确允许 `configFile+kubernetesFile`。context 不得包含 command、assertion、private key、token、endpoint 内容或默认命令。
4. context、client config 和 Kubernetes config 路径必须绝对、canonical、non-symlink regular file、当前 UID 所有、精确 `0600`。reader 使用 `O_NOFOLLOW|O_CLOEXEC`、descriptor 前后 identity/size 复验、64 KiB context 与 4,096-byte path 上限；读取 buffer 在退出时清零。
5. `--context` 与显式 `--config|--kubernetes` 冲突时失败关闭；重复、空值、未知命令、未知字段、缺失 command entry、弱权限、symlink 或非 canonical 路径统一返回低敏 `QL3_CLUSTER_PRODUCT_CONTEXT_INVALID`，退出 78，不输出路径或内容。
6. context 只注入稳定路径。`--command` 与 `--assertion` 仍必须由调用者逐次显式传入，并继续由原 client 执行 canonical/current-UID/`0600`、TLS 1.3、mTLS、Policy、quota 与结果校验。context 不扩大任何 server、migration、recovery、executor 或 key-custody authority。
7. Local/Edge、Cluster Control 与 Worker 制品不导入该 reader。示例文件只含占位路径，不能作为 Secret 或可直接运行配置；操作者必须复制到仓库外并设置 `0600`。

## 不采用方案

- **自动读取 `$HOME`、XDG 或环境变量**：ambient selection 容易连接错误集群，也让容器和服务账号继承未审计 authority。
- **把 assertion 或 command 放进 context**：会把逐操作、短生命周期授权退化为长期 profile。
- **在 context 内保存 TLS 私钥或配置内容**：重复既有 no-follow reader，扩大解析器的 Secret 生命周期与备份暴露面。
- **修改七个 client CLI**：它们已共享同一安全 transport，facade 注入路径即可改善产品 UX，无需复制变更到每个边界。
- **新建 workspace package**：context 只服务一个现有可部署 facade，不形成独立部署、权限或供应链边界。

## 验收门

- schema、权限、owner、canonical/no-follow、大小、未知/敏感字段、缺失命令、tunnel exact shape、重复/冲突参数与低敏退出码；
- 原调用方式保持 opaque argv，context 调用只注入 config/tunnel 路径且保持 command/assertion 显式；
- 真实 Admin image 在 non-root、read-only root、network none、drop ALL、no-new-privileges、128 MiB/32 PIDs 下完成合法注入与敏感字段拒绝；
- Cluster Admin 完整 package、backend、18-package clean build/test、package/dependency/deployment/image release/Local image、14 Local Profile artifact 与 PostgreSQL HA 不回归。

## 当前证据

- context/facade 与静态边界专项 70/70；真实 arm64 Admin image 为 330,453,309 bytes，较 D-300 增加 9,237 bytes，并在受限 envelope 下报告 `operatorContext=true`。
- workspace 保持 18 package；Cluster Admin 97 source 中 96 nested、1 root，无 single-source/shallow package，未增加依赖或常驻资源。
- Cluster Admin 完整 package 为 293 pass/2 条件 skip；18-package clean build/test 退出 0；backend 为 1,186 pass/2 skip。deployment 专项 50/50，package/dependency/deployment/image release/Local image 五项边界审计均 compatible、零 finding。
- 14 个 Local Profile artifact 全部 compatible，最小 Edge 为 2,467,343 bytes/295 files/53 modules，最大 Standalone MCP 为 7,168,978 bytes/778 files/213 modules；与 D-300 对应制品字节数完全一致，路由设备制品没有因 operator context 增重。
- PostgreSQL 18.4 arm64 HA 123 项 gate 全绿，timeline `1→2`；证据 SHA-256 为 `55707a4b59483a2281e0a338e06336eef0ce2ba5126efbdfe4dad6a88a466157`，离线审计 compatible、零 finding，门禁容器、网络与卷均零残留。
