# ADR-0418：显式 Cluster Copilot MCP Host 部署与资源边界

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-326、Phase 2

## 背景

D-325 提供了独立 `ql3-copilot-mcp` stdio 进程，但只存在 binary 并不能证明用户可以安全部署它。若把 stdio server 直接包装成 Kubernetes Deployment/Service，Pod 没有拥有其 stdin/stdout 的 MCP host session，既不可达又长期携带 API credential；若让用户随意拼 `docker run`，则容易使用 mutable tag、默认网络、root、可写文件系统、无限资源或把 credential 写入环境。Cluster Admin 镜像的默认入口已经是统一产品 façade，但 OCI layout 审计仍错误期待旧 recovery binary，模拟证据不能约束真实镜像。

QingLong 的部署跨度还要求明确区分：Edge/Standalone 小设备不应安装 Cluster Admin/MCP 依赖；Cluster MCP host 本身也要支持资源受限的运维终端与较高并发的专用节点，而不能靠隐藏队列或无限容器配额吸收差异。

## 决策

1. `ql3-cluster-admin` 产品 façade 增加静态 `copilot-mcp` 命令，仍用当前 Node executable、same-image canonical target、`shell=false` 和 inherited stdio；不通过 shell、动态 package resolution 或 entrypoint override 启动 MCP。
2. `ql3-copilot-mcp --check --config ...` 在不启动 MCP transport 的情况下完整验证 owner-private MCP/client/credential/CA authority，并只发一个不带认证的 `GET /readyz`。成功结果仅包含 transport、ready、配置/credential 有效性、并发上限和固定请求语义；不返回 endpoint、DNS、路径、credential、Project 或 Cluster identity。not-ready 退出 69，异常仍只输出低敏失败事实。
3. CLI 接受可选 `--concurrency-ceiling=1..16`。配置的 `maxConcurrentRequests` 高于外部部署 ceiling 时在 listener、stdio server 和网络 probe 前失败关闭。该 ceiling 不改变 D-325 的即时 busy/no-queue 语义，只防止私有配置越过容器资源档位。
4. 提供唯一受审 host-side Docker stdio launcher。它只接受 `check|serve` 和四个非 secret 环境值：immutable Admin image digest、canonical private projection root、专用 Docker network 名和 `compact|standard|dense` resource class。credential value 不得进入 argv、environment、host adapter 或 image。
5. 三档固定为：compact `192 MiB/0.25 CPU/32 PID/concurrency 1`，standard `512 MiB/1 CPU/64 PID/concurrency 4`，dense `1 GiB/2 CPU/96 PID/concurrency 16`。launcher 固定 `--pull never --init --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001`，只读挂载一个私有目录，不挂载 Docker socket、Kubernetes token、数据库 credential 或可写目录。
6. launcher 拒绝 mutable/tag-only image、非 canonical/含分隔歧义的 private root、隐式或 `bridge|default|host|none` 网络和未知资源档。专用 Docker network 只提供命名隔离；生产 host firewall 仍必须把 egress 限制到 DNS 与 exact Cluster API destination。
7. stdio MCP 由外部 MCP host 父进程启动，不新增 Kubernetes Deployment、Service、Ingress、RBAC、ServiceAccount、sidecar、health timer 或 restart controller。Cluster AI component 继续只拥有 server-side Copilot composition；二者不能合并。
8. Admin image 继续独立发布；本 Gate 不再拆第 19 个 package 或复制 MCP runtime。镜像 metadata 改为同时描述 cluster operations 与 bounded stdio MCP，OCI layout 审计必须期待 Dockerfile 的真实 product façade entrypoint，而非历史 recovery binary。
9. Edge/Standalone、Local MCP、Cluster Control、Cluster AI 和 shared Kubernetes operations 均不得引用 host launcher。路由设备默认制品与依赖闭包保持不变；需要本机 MCP 时仍只使用独立 `@qinglong/local-mcp-server` Profile。

## 不选择

- **把 stdio MCP 作为独立 Kubernetes Deployment/Service**：没有父 host session，网络 Service 也不能把 MCP stdio 变成 HTTP；会留下不可达的长期 credential Pod。
- **在 Cluster Control/AI Pod 增加 MCP sidecar**：混淆 server-side Tool/Model authority 与 operator API credential，扩大常驻资源和故障域。
- **允许任意 Docker flags 或 mutable tag**：无法证明镜像、身份、挂载、网络和资源边界。
- **为 launcher 新建 workspace package**：部署 adapter 没有新的领域模型或 consumer closure，会重新制造过细包并突破 18-package hard cap。
- **把 resource class 只写进文档**：私有 config 可静默扩大并发，容器内存上限无法成为可执行契约。
- **在 MCP 进程增加轮询 health timer**：引入常驻网络负载和隐藏生命周期；一次性 check 与 host-owned restart 足够。

## 验收

1. 产品 catalog/help/delegation 覆盖八个 remote client 与 `copilot-mcp`，并证明 target 位于同一安装、stdio 原样继承、signal 可收敛。
2. TLS 1.3 preflight 覆盖 config/credential validation、无 Authorization 的 exact `/readyz`、ready/not-ready/transport failure、并发 ceiling 和低敏输出。
3. launcher 测试以假 Docker 捕获完整 argv，证明三档资源、immutable digest、named network、non-root/read-only/no-capability/no-new-privileges、只读 projection 和无 secret env；负例覆盖 tag、ambient network 与路径漂移。
4. Cluster deployment audit 必须拒绝 launcher contract 漂移以及任何 Kubernetes YAML 中的 `ql3-copilot-mcp` 常驻资源；package/Edge import/Local artifact 门不得放宽。
5. OCI layout fixture 与真实 Dockerfile 必须共同绑定 product façade entrypoint 和新 metadata；Admin image live gate 至少验证 `copilot`、`copilot-mcp` help 与全部既有命令。
6. Cluster Admin、18-package clean build/test、backend、SBOM/OCI/部署审计和 14 档 Local artifact 全部通过后才允许 D-326 阶段提交。本 Gate 无 schema、migration、SQL、role、Pool 或 HA 拓扑变化，不重复数据库物理 HA。
