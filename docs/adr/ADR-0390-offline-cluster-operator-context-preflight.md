# ADR-0390：Offline Cluster Operator Context Preflight

- 状态：Accepted
- 日期：2026-08-13
- 关联 RFC：QL-RFC-0001 D-302
- 前置决策：ADR-0250、ADR-0388、ADR-0389

## 上下文

ADR-0389 让操作者可以显式复用稳定 client 路径，但 context reader 只证明路径、owner、权限和 schema；endpoint route、CA、client certificate/private key 配对及 Kubernetes config 仍要到某次真实命令才由生产 client 发现。发布或维护窗口中用 mutation 命令做配置探针既迟又危险，另写一套宽松校验器则会与真实请求路径发生语义漂移。

## 决策

1. `ql3-cluster-admin` 增加内建 `context validate --context=/absolute/operator-context.json`。它是 facade 的本地命令，不进入七项远程 client catalog，不产生新的 binary、package、进程或部署 authority。
2. context 仍先通过 ADR-0389 的 canonical/current-UID/`0600`/no-follow reader。随后每个 entry 必须调用与真实 client 相同的 production configuration preparation：精确 route、HTTPS hostname、timeout、CA、client certificate/private key 配对及 Kubernetes embedded credential/config 全部同语义验证。
3. production HTTPS client 把配置读取、解析和密钥配对提炼为可显式 `dispose()` 的 preparation；真实请求与 preflight 共同调用。Kubernetes tunnel 同样提炼 config preparation；只有真实命令才创建 Pod client、PortForward、socket 和 deadline timer。
4. preflight 不读取 per-operation command 或 assertion，不打开 socket、不访问 DNS/HTTP/Kubernetes、不创建 timer、不查询数据库且不执行 mutation。它还复验同一安装内七个受审 client target 均为 canonical non-symlink regular file。
5. 成功结果只输出固定 command 名、`https|kubernetes-port-forward`、是否要求 client certificate、Kubernetes credential class，以及 `networkAccess:false/mutation:false`。禁止输出路径、endpoint、port、servername、namespace、Kubernetes context、证书主体、token 或其他 credential 内容。
6. 任一 context、安装或引用配置失败均失败关闭。context/config 类错误统一返回低敏 `QL3_CLUSTER_PRODUCT_CONTEXT_INVALID` 与退出 78；CLI 语法错误返回既有 usage code 与退出 64；不暴露失败 entry 或路径。
7. 能力继续只存在于短生命周期 Cluster Admin image。Local/Edge、Cluster Control 与 Worker 的依赖、文件、模块、RSS、listener、timer、连接和镜像闭包不得变化。

## 不采用方案

- **发送 health/read-only 请求验证连接**：仍会产生外部副作用、泄露使用时机，也不能证明 mutation 路径的全部本地材料。
- **复用某个虚构 command/assertion 执行真实 client**：会混淆配置错误与业务拒绝，并可能进入审计、quota 或 mutation 前置流程。
- **复制 JSON schema 到 facade**：两套 parser 会随 route、TLS 或 Kubernetes contract 演进而漂移。
- **把 endpoint 或证书主体写入成功摘要**：这些事实对“本地材料可解析”结论没有必要，会扩大日志敏感面。
- **为 preflight 新建 package**：它只有一个 Cluster Admin 产品消费者，不形成部署、authority 或供应链边界。

## 验收门

- 七命令完整 context、部分 context、mTLS/非 mTLS、Kubernetes token/certificate、错误 route、CA、key 配对、权限、symlink、未知字段与低敏失败；
- 生产 HTTPS/Kubernetes client 全量回归，证明提炼前后请求、TLS、PortForward 和错误语义不变；
- 真实 Admin image 在 network none、non-root、read-only root、drop ALL、no-new-privileges、128 MiB/32 PIDs 下完成 preflight；
- package/dependency/deployment/image release/Local image、18-package clean build/test、backend、14 Local Profile artifact 与 PostgreSQL HA 不回归。

## 当前证据

- product facade/preflight 11/11；七类 client 与 Kubernetes tunnel 定向回归 45/45。Cluster Admin 完整回归 298 tests、296 pass/2 条件 skip/0 fail；18-package clean build/test 退出 0；backend 1,189 tests、1,187 pass/2 skip/0 fail。
- 真实 arm64 Admin image 为 330,463,528 bytes，较 D-301 增加 10,219 bytes；在 `10001:10001`、read-only root、network none、drop ALL、no-new-privileges、0.25 CPU、128 MiB/32 PIDs 下报告 `contextPreflight=true`。五项 package/dependency/deployment/image release/Local image 边界审计零 finding。
- workspace 保持 18 package；Cluster Admin 97 source 中 96 nested/1 root，无 single-source/shallow package且未增加依赖。14 个 Local Profile artifact 全部 compatible，最小 Edge 为 2,467,343 bytes/295 files/53 modules，最大 Standalone MCP 为 7,168,978 bytes/778 files/213 modules；与 D-301 对应制品字节数一致。
- PostgreSQL 18.4 arm64 HA 123 项 gate 全绿，timeline `1→2`；报告 SHA-256 为 `339cd10e1da2428da6c099c52c2397d5f79f7cb32b64b7e1ae927d2803b8cfc0`，离线审计零 finding，门禁容器、网络与卷均零残留。
