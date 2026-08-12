# ADR-0388：有界统一 Cluster Operator 产品 CLI

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-300
- 前置决策：ADR-0127、ADR-0249、ADR-0259、ADR-0264、ADR-0271、ADR-0356、ADR-0365、ADR-0383

## 上下文

Local 部署者已有 `ql3 <command>` 可发现入口，Cluster operator 却仍需记忆二十多个 `ql3-*-client|manage|execute` binary。直接把所有 Cluster Admin 命令挂到一个 facade 会模糊远程客户端、常驻管理服务、数据库 migration、recovery、executor 与 key-custody 的 authority；新建 CLI package 又会恢复只有少量转发表文件的微包。

Cluster Admin 已是独立、短生命周期、非路由设备的发布镜像和 package。统一 operator UX 应留在该边界内，并且只能聚合调用方已经持有认证材料的远程客户端，不得借命令名称把服务端或数据库写 authority 交给普通工作站。

## 决策

1. 在既有 `@qinglong/cluster-admin` 的 `product-cli/` 领域目录增加 `ql3-cluster-admin` binary，不新增 workspace package、第三方依赖、数据库对象、角色、连接、listener、timer、watcher、cache 或 sidecar。
2. facade 只暴露七个固定远程客户端：`package`、`package-kubernetes`、`worker-credential`、`approval`、`run`、`automation`、`model-credential`。每项映射到同一安装中已经发布的一个 `*-client` binary。
3. `*-manage` 服务进程、migration、Plugin recovery、Worker/Package executor、provider test executor、AI migration、Prompt output rotation/retirement/recovery/GC 不进入 catalog；既有 binary 均保留，Kubernetes operation 继续显式指定精确入口。
4. dispatcher 只使用冻结 catalog、当前 `process.execPath` 和参数数组，固定 `shell=false`，不查询 `PATH`。目标必须是当前 package canonical `dist/` 内的 non-symlink regular file；package manifest 必须是 canonical non-symlink、64 KiB 内且 name/version 合法。子命令参数作为 opaque argv 原样转发。
5. facade 只转发 `SIGINT|SIGTERM|SIGHUP`，保持 child exit code 或 `128+signal`；未知命令与安装损坏只返回不含用户输入、路径或认证材料的低敏 JSON。
6. Cluster Admin image 默认 ENTRYPOINT 改为 facade，使无参数运行提供可发现帮助。所有生产 Job/Deployment 已显式覆盖 command，因此不改变其 authority 或生命周期。CI 在 amd64/arm64 Admin matrix 中以 non-root、read-only root、network none、capabilities none、128 MiB/32 PIDs 运行真实镜像门。
7. Local/Edge Profile、Local image、Cluster Control image 与 Worker image均不安装或加载该 facade。package boundary 仍为 18，Cluster Admin 根仍只有既有 migration binary；两个新增 source 全部位于 `product-cli/`。

## 不采用方案

- **把所有 Cluster binary 暴露为子命令**：可发现性不能消除服务、执行和密钥 authority 隔离。
- **删除原 binary**：会破坏 Kubernetes manifest、自动化脚本和已有运维协议。
- **通过 shell、PATH 或用户路径查找命令**：允许环境劫持、通配符和参数重解释。
- **复用 Local `ql3` package**：会让 Edge/Standalone 安装 Kubernetes/PostgreSQL 管理依赖，并混合两种部署模型。
- **新建 Cluster CLI package**：只有同镜像静态路由职责，不形成新的部署、authority 或重依赖边界。

## 验收门

- catalog、help/version、opaque argv、unknown/path traversal、symlink target/manifest、真实 7-client help delegation、退出码与有界信号转发；
- package manifest 和 Admin Dockerfile 的正反向部署审计，CI/release audit 必须要求 native image live gate；
- Cluster Admin 完整 package、backend、18-package clean build/test、package/dependency/deployment/image release boundary 全绿；
- 真实 arm64 Admin image 在受限 envelope 下通过，并记录 image bytes；PostgreSQL HA 不回归；
- Local 14 Profile artifact 与默认 Local image 不因 Cluster facade 变化。

## 当前证据

- facade 6/6、Cluster deployment 49/49、CI/release contract 48/48；部署审计复核全部 24 个 Admin image 引用都显式覆盖 `command`，并以突变测试锁定。真实 arm64 Admin image 为 330,444,072 bytes，`10001:10001`、只读根、无网络、无 capabilities、0.25 CPU、128 MiB/32 PIDs 下 7/7 客户端 help 委派成功。
- Cluster Admin 完整 package 为 293 tests、291 pass、2 条件 skip、0 fail；18-package clean build/test 退出 0；backend 为 1,186 tests、1,184 pass、2 skip、0 fail。workspace 保持 18 package；Cluster Admin 为 96 source，其中 95 nested、1 个既有 root binary entry，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；package/dependency/deployment/image release/Local image audit 零 finding。
- 14 个 Local Profile artifact 全部 compatible，最小 Edge 为 2,467,343 bytes/295 files/53 modules、最终运行 RSS 11,091,968 bytes；最大 Standalone MCP 为 7,168,978 bytes/778 files/213 modules、RSS 38,420,480 bytes，证明 Cluster facade 不进入路由设备与本机 Profile。
- PostgreSQL 18.4 arm64 physical HA 123 项 gate 全绿、timeline `1→2`，报告 SHA-256 `f5df5998d505b6d5af552e627bd3f83983bc347d08d94da5a2d73fde46eab0a4`；离线证据审计零 finding，测试容器、network 与 volume 零残留。
