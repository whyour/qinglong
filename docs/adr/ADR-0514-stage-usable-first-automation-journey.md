# ADR-0514：阶段可用的首个自动化旅程

- 状态：Accepted（v5 headless/Console 双变体 milestone 已交付）
- 日期：2026-08-28
- 对应 RFC 切片：D-419

## 背景

QingLong 3.0 已连续开发约二十天。D-416～D-418 已把 Local Alpha 从可构建镜像推进到可选择的 headless/Console Trial Kit：下载者可以离线校验、完成 fresh setup、建立首 Owner、启动受资源限制的 Application，并在 Console 中读取和启动既有 Task。主 CI 也已经在原生 amd64/arm64 上验证这些路径。

但 fresh 数据库没有 Task。更关键的是，Owner bootstrap ceremony 交付的 ready record 包含 claim 所需的完整记录，它不是 `ql3-task` 和 Web Console 接受的 credential presentation。让用户手工从 JSON 拼接 token，或让 Web Bearer 请求直接获得 strong 管理权限，都会把工程能力误报为阶段可用产品，并破坏既有认证边界。

## 决策

### 1. 增加独立、短生命周期的 credential presentation installer

`ql3 owner` 新增 `owner.credential-presentation.install-from-delivery` command-file operation。它只把一个已交付的 Owner credential ready record 转换为标准 `qinglong3-local-identity-credential-presentation` 文件：

- source、destination 必须位于同一个 canonical deployment root；
- root、父目录、source 和既有 destination 必须保持同 UID、`0700/0600`、非 symlink；
- destination 以临时文件、`fsync`、no-replace hard link 和目录 `fsync` 原子发布；
- 只允许首次 `installed`，或内容完全相同的 `existing` 重放；冲突时失败关闭；
- command 结果不返回 token、Secret、绝对路径或 delivery 内容。

该 installer 是新模块，不改变 `SecretDeliveryPrivateFilesystemStore` 的 record、recovery、acknowledgement 或 GC 语义。

### 2. quickstart 交付可直接使用的 Owner presentation

headless 和 Console quickstart 都在首 Owner claim 后调用上述 operation，生成数据根内的 `owner-credential.json`。这使后续受支持的 `ql3 task|trigger|identity|policy|...` 短生命周期命令不再依赖部署者手工拼接 Secret。

bootstrap delivery 仍保留到操作者完成消费确认；installer 不把“复制成功”冒充 delivery acknowledgement。

### 3. Console Trial Kit 创建一个有界示例 Task

只有显式选择 `console` variant 时，quickstart 才通过 strong local operator 创建 `alpha-first-automation`：

- immutable `qinglong/command@v1`；
- 只执行 Application image 内的 `/bin/echo`；
- 无网络、无 SecretRef、无定时 Trigger，默认不自动运行；
- 用户仍需在 Console 核对 revision/content digest 并显式启动。

默认 headless 路由/NAS 不创建示例 Task，也不增加 listener、常驻进程、timer、连接池或稳态 RSS；它只获得后续管理需要的 credential presentation。Cluster/Kubernetes 不复用此 SQLite/本机 credential 路径。

### 4. 原生门必须证明真实工作完成

Console live journey 不再只检查首页 200 和未认证 API 401。每个原生架构还必须：

1. 通过 operator 安装 Owner presentation；
2. 通过 operator 创建示例 Task；
3. 使用该 credential 从 loopback API 读取 Task；
4. 使用 revision/content digest fence 显式启动一次 Run；
5. 等待 `succeeded` 终态，并从 bounded Run log 看到固定工作标记；
6. 最后完成 graceful stop 和 SQLite integrity 检查。

Trial Kit 升级为 `qinglong/alpha-local-trial-kit@v5`（manifest schemaVersion 6），verification evidence 升级为 `qinglong/alpha-local-trial-kit-verification@v3`，新增 `ownerCredentialPresentation` 与 variant-aware `firstAutomationJourney` gate。Local milestone 与 stage index 文件形状不变，继续使用各自 v2 schema，但只能收录通过当前严格 auditor 的 bundle。

## 不采用的方案

- 不在 Web API 增加 Task create：HTTP Bearer principal 是 `single_factor`，不能伪装成 `local_console` strong assurance。
- 不依赖宿主 `jq`、Node.js 或 shell 字符串拼接 Secret：Trial Kit 的宿主前置仍只有 POSIX shell、`sha256sum` 和 Docker。
- 不修改 bootstrap ready record 为 presentation：claim、recovery 和 acknowledgement 已有独立安全语义，不能为 UI 便利改写。
- 不把示例 Task 放进 headless：低配设备默认档保持最小、无操作面、无示例数据。

## 结果与剩余边界

D-419 形成“下载、验真、启动、认证、执行、观察终态”的首个阶段可用业务闭环。它仍是 fresh Alpha，不是 2.x 升级、生产 HA、公开 release、签名或 LTS。实际大 archive 继续只允许维护者显式设置 `produce_alpha_artifacts=true`；普通 push 的绿色 CI 证明源码可生成和实跑，不自动产生可下载大产物。

Console v5 已由 run `33252179178` 交付最新 Secret-backed 自动化闭环；默认低配 headless v5 随后由独立 run `33258604609` 形成双架构 milestone，只安装 Owner presentation，不创建示例 Task 或开放 listener。两个变体下载后三件套的 checksum 与仓库 auditor 均返回 `compatible=true`，没有把 Console archive 改名给 headless 用户。
