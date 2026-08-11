# ADR-0191：私有 Cluster Plugin Package 管理客户端

- 状态：Accepted
- 日期：2026-07-29
- 关联：RFC D-140、D-144、D-145、D-175、D-178、D-180、D-181；
  ADR-0144、ADR-0145、ADR-0185、ADR-0188、ADR-0190

## 背景

Cluster 已有独立、默认关闭的 Plugin Package management HTTPS process，服务端具备
TLS 1.3、强 User assertion、Project Policy、durable quota、Approval 与低敏响应。
`ql3-plugin-package-manage` 只是该服务端进程入口；现有调用端仅是 release live-evidence
脚本，不是可交付的日常 operator CLI。

因此 D-180 虽已完成数据库与 transport 能力，部署者仍需要自行拼 HTTP header、JSON 和
TLS 参数。直接建议 `curl` 会让 assertion 进入 shell history/process argv，并容易关闭
证书验证或把完整错误响应写入日志。

## 决策

### 1. 新增 client binary，不复用 server binary

在既有 `@qinglong/cluster-admin` 内新增：

- `./plugin-package-management-client` library subpath；
- `ql3-plugin-package-client` executable。

不新增 workspace package、第三方生产依赖、数据库角色、Service、listener、timer、
watcher 或 controller。server 的 `ql3-plugin-package-manage` 名称和启动语义保持不变，
避免一个 binary 同时承担入站 authority 与出站 client。

### 2. 私有文件是唯一 credential/command 输入

CLI 只接受三个非秘密路径参数：

- `--config=/absolute/client.json`
- `--command=/absolute/command.json`
- `--assertion=/absolute/assertion.jwt`

禁止从 argv、环境变量、stdin 或 command JSON 接收 assertion、Bearer token、私钥、
数据库 DSN 或 CA 内容。

config、command、assertion 必须是当前 POSIX UID 拥有、规范绝对路径、非 symlink、
`0600` regular file，并通过 `lstat → O_NOFOLLOW open → fstat` 在同一 descriptor
读取。config/assertion 最大 16 KiB，command 最大 256 KiB。CA 是公开验证材料，但仍须
是规范、非 symlink、owner 为当前 UID 或 root、group/world 不可写的 regular file，
最大 256 KiB。

config schema v1 精确包含：

- `endpoint`：固定 `/api/v3/plugin-packages/management` 的 HTTPS URL；
- `servername`：显式 DNS 名，必须等于 URL hostname；
- `caFile`：绝对 CA bundle 路径；
- `requestTimeoutMs`：1–30 秒。

不读取 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 或系统代理。

### 3. 一次进程只执行一个 exact command

command 必须是 management transport 已公开的 schema v1 command，operation 只能是：

- Package install `propose|decide|inspect`；
- publisher emergency revocation `propose|decide|inspect`；
- publisher trust transition `propose|decide|inspect`。

客户端不补 ID、不改 expected version、不派生 digest、不上传 PEM/snapshot，也不自动
重试。网络结果不确定时，operator 必须用原 command 文件显式重放；服务端 exact replay
负责收敛。

### 4. TLS 与 HTTP 严格失败关闭

client 固定：

- TLS 1.3 min/max；
- `rejectUnauthorized=true`；
- endpoint hostname 与显式 `servername` 一致；
- CA bundle 显式注入；
- 无 redirect、无 connection pooling、无压缩、单一 POST；
- request/response 各 256/128 KiB 硬上限；
- exact `application/json` request 与
  `application/json; charset=utf-8` response；
- bounded timeout，超时销毁 socket。

成功响应必须是 exact schema v1 envelope、带有 bounded request ID，且 result operation
与 command operation 完全一致。非 200 响应只保留 status、bounded error code、
request ID 和可选 Retry-After；不回显 response body、header、assertion、路径或 TLS
diagnostic。

### 5. 输出保持低敏

stdout 只输出服务端已经审查过的低敏 result envelope。stderr 失败事实只包含稳定
component/event/error code、可选 HTTP status/request ID/retry-after；不输出 Error
message、stack、文件路径、endpoint、assertion、command 原文或证书内容。

客户端在请求结束后清零可变 assertion/CA/command Buffer。Node.js/HTTP 内部可能产生
不可控复制，因此本能力不声称 secure enclave 或零内存残留；短生命周期进程和不落盘/
不回显是当前边界。

## 不采用方案

### 用 curl 文档代替产品 client

Bearer 参数容易进入 shell history/process argv，TLS/redirect/response 上限也无法被
仓库门禁稳定约束。

### client 自行持有 IdP 私钥并签 assertion

会把身份签发 authority 混入 Package 管理客户端；本 CLI 只消费外部 ceremony 产生的
短期 assertion。

### 把 client 合入 cluster-control

常驻 runtime 不应获得管理 assertion 或出站管理 authority。

### 新增独立 workspace package

客户端与现有 management protocol 同发布、无新依赖或独立制品矩阵；新增第 23 个包不满足
ADR-0185。

### 自动重试

网络断开不能证明服务端未提交。自动重试会隐藏 outcome unknown；显式 exact replay 才是
可审计恢复。

## 验收证据

- `@qinglong/cluster-admin/plugin-package-management-client` 与
  `ql3-plugin-package-client` 已发布在既有 cluster-admin 包，workspace 仍为 22 包，
  未新增第三方生产依赖、listener、timer、watcher 或 controller。
- client 专项 5/5 通过：真实 TLS 1.3 + CA + DNS hostname、one request、九种 operation、
  unknown operation、private/canonical/no-follow 文件、redirect、content-type、128 KiB
  response、timeout 与 CLI 输出脱敏均有正负向证据。
- cluster-admin 全量回归为 121 pass、0 fail、1 条真实 Kubernetes 条件 skip；构建闭包
  同时编译 runtime-core、cluster-postgres 与 cluster-admin。
- cluster deployment audit 18/18，dependency boundary 37/37；22 个 package importer、
  31 个 cluster-admin source、CloudNativePG 与 edge-import 审计均无 finding。
- operator 使用契约见
  `docs/operations/ql3-plugin-package-management-client.md`。
