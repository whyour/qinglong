# ADR-0416：有界 Cluster Copilot 产品客户端

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-324、Phase 2

## 背景

D-321 至 D-323 已提供默认关闭、受认证的 Cluster Copilot 故障诊断执行、状态/输出读取与取消路由，但部署用户仍需手工拼接动态 URL、Bearer API credential、请求 schema 和幂等 identity。这样既不可用，也容易把 credential 放进 shell history、把内部 diagnosis Run 当成外部 identity，或在取消时误报 Provider 已停止。

现有 `@qinglong/cluster-admin` 已拥有统一 `ql3-cluster-admin` 产品命令、私有 context 文件、TLS 客户端约束与短生命周期进程；继续在该 package 的嵌套领域目录增加 Copilot client，比新建 workspace package 或让 UI/MCP 直连数据库更内聚。Copilot 的 Project API credential 是 `single_factor|service` Bearer authority，不能复用管理面的强 User JWT、mTLS client certificate 或 Kubernetes tunnel 身份。

## 决策

1. `ql3-cluster-admin copilot` 与独立 binary `ql3-copilot-client` 提供 `diagnose|inspect|output|cancel` 四种 operation，分别只调用 D-321、D-322、D-323 的既有 Cluster Control API；客户端不导入 application capability、AI repository、PostgreSQL driver 或 Provider SDK。
2. 调用只接受三个绝对路径参数：`--config`、`--command`、`--credential`。文件都必须是当前 uid 拥有、canonical、非 symlink、mode 0600 的 regular file；credential 不允许来自 argv 值、环境变量、stdin、context 或 command JSON。
3. config schema 固定为 `qinglong/cluster-copilot-client-config@v1`，只含 HTTPS origin、DNS servername、CA 文件和 1–120 秒 request timeout。TLS 固定 1.3、验证 CA/hostname、禁用 client certificate、连接复用、压缩、redirect、proxy 与 implicit system CA。
4. command schema 固定为 `qinglong/cluster-copilot-client-command@v1`。所有 operation 都绑定 Project、source Run 与 diagnosis request；`diagnose` 额外要求 trace identity，`cancel` 额外要求 mutation identity。调用方不能提交 diagnosis Run、Artifact、Model/Provider、Policy fence、reason、outcome、usage、cost 或内部 Event。
5. `diagnose` 的 HTTP `x-request-id` 必须等于 diagnosis request identity；`cancel` 必须等于 mutation identity；只读操作生成新的 transport request identity。响应必须返回完全相同且唯一的 `x-request-id`，否则按不可信 transport 失败关闭。
6. client 对四种成功响应执行 exact-shape、target、schema、状态机、digest、usage/cost 与 UTF-8 byte 长度验证；只接受 operation 对应的 200/201/202。远端非成功响应只投影 status、稳定 code、request ID 与有界 Retry-After，不返回 response body、header、credential 或 TLS 细节。
7. `output` 是唯一可把诊断文本写到 stdout 的 operation，属于调用者显式请求；CLI 的 stderr 永远只包含低敏失败 fact。客户端不写结果文件、不缓存 credential/output、不创建 timer、daemon、queue、watcher 或后台重试。
8. product context 可保存 Copilot config 路径并参与离线 validate 与无认证 `GET /readyz` probe；credential 与 command 路径仍必须每次显式提供。context 不获得调用能力，也不读取 credential。
9. 实现留在现有 `@qinglong/cluster-admin` 的 `copilot-client/` 与 `product-cli/` 目录，不新增 workspace package、依赖、服务、端口、Pool、数据库 schema、Kubernetes 权限或 Edge/Standalone importer。UI 与 MCP 后续只能复用相同公开 API/contract，不能调用 CLI 子进程冒充共享 authority。

## 不选择

- **让用户使用 curl 示例作为产品入口**：无法持续验证私有文件、幂等 header、响应 target 和输出边界。
- **复用 management JWT/mTLS client**：把高风险管理身份错误提升为普通 Project Copilot authority，并与 API credential Policy 语义冲突。
- **新建 `@qinglong/copilot-client` package**：当前只有一个 Cluster 产品消费者，会形成过细 package 并扩大 workspace/制品矩阵。
- **把 credential 写进 context、command、argv 或环境变量**：扩大静态配置与进程观测面的泄露半径。
- **客户端自动轮询或取消超时请求**：会引入隐藏 timer/retry policy，并把 transport 超时混同 durable diagnosis/cancellation 状态。

## 验收

1. 覆盖四种 command normalization、私有文件/TOCTOU、TLS 1.3、无 client certificate、request identity、响应 exact validation、body/header/timeout/abort 上限、credential/output 清理与低敏错误。
2. 真实 HTTPS fixture 覆盖 diagnose exact replay、inspect running/terminal、potentially-sensitive output 显式返回、cancel accepted/replay 和拒绝 target/schema/request-ID drift。
3. product CLI/context 的 catalog、help、static target、validate/probe 与信号转发保持通过；cluster-admin 完整测试、18-package clean build/test、backend、package/dependency/Edge import 与 14 档 Local artifact 全部通过后才允许 D-324 阶段提交。
