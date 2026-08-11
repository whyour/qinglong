# ADR-0195：AI-excluded 本机 Application 候选镜像

- 状态：Accepted（候选镜像 contract、arm64 build 与 fresh live gate 已实现）
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-42、D-156、D-168、D-175、D-183、D-184、
  D-185
- 关联 ADR：ADR-0042、ADR-0088、ADR-0167、ADR-0178、ADR-0185、
  ADR-0193、ADR-0194、ADR-0196

## 背景

D-184 的 Compose 描述符已经拒绝 mutable tag，但仓库此前只有 Cluster
control/admin 镜像。直接把 workspace mount 到通用 Node image 可以用于测试，
不能作为本机交付物：它包含开发依赖，缺少独立 production lock，也无法证明 AI
没有进入默认 Edge/Standalone runtime。

为 Edge 与 Standalone 各建一个镜像也没有收益。两者使用相同 application 代码和
生产依赖，仅由私有配置选择 SQLite journal、页预算和资源 envelope。复制镜像会
产生两套 lock、SBOM、签名和漏洞响应。

## 决策

### 1. 一个镜像、两个本机 Profile、零新增 package

`deploy/containers/ql3-local-application` 是部署制品目录，不是 workspace
package。镜像运行时精确包含：

- `runtime-core`；
- `local-sqlite`、`local-admin`、`local-profile`、
  `local-adopted-profile`；
- `local-command-file`、`local-secret`、`local-process`、
  `local-execution`、`local-application`；
- `croner@7.0.8` 与 `semver@7.7.4`。

Edge/Standalone 继续由
`qinglong/local-application-process@v2` 私有配置选择。镜像不包含
`@qinglong/ai`；`ai.deployment` 只能为 D-184 生成的 `excluded`。后续 AI
镜像若成立，必须作为独立 opt-in 制品和预算评审，不能修改默认镜像闭包。

### 2. Builder authority 不进入 runtime

Dockerfile 的两处 base 都直接固定为同一 Node 24.18.0 Bookworm Slim OCI index
digest，不提供 `NODE_IMAGE` build argument。build dependency root 独立锁定
TypeScript、Node/Semver types 与 Drizzle schema 编译类型；`ql3-ai` 只在
workspace builder 中满足 application 的静态类型编译。

production dependency root 使用另一份 lock，只安装 `croner` 与 `semver`。
最终 stage 从 builder 仅复制上述十个内部 package 的 `package.json` 与 `dist`；
删除 npm 自动生成但 entrypoint 不需要的 `.bin` 链接，以及 TypeScript
`.js.map`/`.d.ts.map` 调试映射；不复制 AI、Drizzle、TypeScript、cache、源码或
开发类型。所有 `npm ci` 都禁用 lifecycle scripts。

### 3. 镜像身份与运行 envelope

镜像默认：

- `USER 65532:65532`；
- `NODE_ENV=production`；
- 唯一 entrypoint 为 `ql3-local-application`；
- 不声明端口或 health listener；
- 标记 `edge,standalone` 与 `ai=excluded`。

镜像自身不内置可写数据层。D-184 Compose 描述符必须继续固定：

- 由 host deployment owner 覆盖 numeric UID:GID；
- read-only root filesystem；
- `network_mode: none`；
- drop all capabilities 与 `no-new-privileges`；
- 唯一 `/var/lib/qinglong3` bind；
- 16 MiB noexec tmpfs；
- Edge 128 MiB/64 PID，Standalone 256 MiB/256 PID。

默认 numeric user 是无 Compose 覆盖时的最小权限兜底，不代表它能读取任意 host
volume。

### 4. 候选证明与 release 证明分开

静态审计复核 base digest、两份 manifest/lock、build/runtime package 闭包、
非必要文件删除、禁用 install scripts、默认 user、entrypoint 与 labels，并以
mutation fixture 拒绝 mutable base、AI runtime copy、额外 production
dependency、非必要文件回归和 lock 漂移。

真实 live contract 使用 D-184 prepare 分别创建 fresh Edge 与 Standalone
volume，再在 read-only、network-none 容器中以各自 128 MiB/64 PID 与
256 MiB/256 PID envelope 启动候选镜像。只有观察到 `active`、由
`docker stop` 触发 `SIGTERM`、`stopped`、exit 0，并在退出后取得 SQLite
`integrity_check=ok` 才通过。

CI 在原生 amd64 与 arm64 runner 重复 build、identity、CycloneDX inventory、
`--help` 和 fresh live contract。ADR-0196 又把本机 profile 接入共享 attested
OCI 与 release matrix；当前本机 arm64 成功仍不能替代尚未执行的远端双架构
结果。

本 ADR 不接受以下 release 声明：

- 本地 tag 或 Docker image ID 是可分发 digest；
- 单架构镜像代表双架构 OCI manifest；
- lock 文件代表 SBOM；
- Dockerfile 存在代表 provenance/signature；
- 128 MiB Docker 门代表固定物理路由器的闪存、冷启动或断电证据。

## 当前证据

- 静态 contract：`findings=[]`；
- mutation audit：6/6（含非必要文件与双 Profile/双架构 CI contract）；
- runtime inventory：10 个内部 package、2 个外部 package、AI absent，
  611/640 files、4,897,102/5,242,880 bytes、无 symlink/special file；
- 本机镜像：Linux arm64、默认 `65532:65532`；
- uncompressed image：251,932,346 bytes；
- Edge live：128 MiB、0.5 CPU、64 PID、network none、read-only root；
- Standalone live：256 MiB、0.5 CPU、256 PID、同一镜像与隔离边界；
- 两个 application：各 19 个低敏事件，active 后 SIGTERM graceful stop；
- SQLite：`integrity_check=ok`。

## 后续发布门

- 原生 amd64/arm64 CI 的实际成功记录；
- ADR-0196 已实现但尚未取得成功记录的双架构 OCI index、逐平台 digest、
  CycloneDX/SPDX、provenance、keyless signature 与远端 registry 回读；
- npm high/critical 与 SPDX license policy 已实现；base/OS vulnerability
  scanner 仍待完成；
- 固定低配路由器的存储占用、冷启动、idle RSS、断电、ENOSPC/EROFS；
- image upgrade/rollback 与 D-184 service activation controller。
