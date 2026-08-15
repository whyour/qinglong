# ADR-0422：浏览器本地生成的脱敏 Cluster Evidence Bundle

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-330、Phase 2
- 扩展：ADR-0421

## 背景

ADR-0421 已让值班人员通过同一个 loopback-only Console 显式读取 Run、Task、Workflow 和 Copilot 事实，但证据仍只存在于页面 DOM。截图不利于机器复核，复制原始 JSON 又容易把 Project/Run/Task/Artifact 标识符、用户命名和 Copilot 模型文本直接带出工作站。若为“导出”新增 Cluster API、通用 proxy、服务端 ZIP 组装、对象存储或后台采集器，会扩大 credential、网络、持久化与资源边界，也会把一次人工观察错误升级为新的集群产品能力。

## 决策

1. D-330 在既有 `@qinglong/cluster-admin/copilot-console` 中增加第 4 个 digest-bound 静态资产 `evidence-bundle.js`。它同时是浏览器脚本和可由 Node 单测加载的纯生成器；不新增 workspace package、npm 生产依赖、Cluster route、BFF POST route、数据库、文件写服务、Kubernetes workload 或第二分发物。
2. 导出只由用户点击“导出脱敏包”触发，只消费当前页面内已经完成的显式读取。它不得调用 `fetch`、打开 socket、补读详情/分页、轮询、重试、排队、上传、调用 clipboard/share API 或读取 session/Cluster credential。
3. 页面账本硬限制为最近 16 条且原始 canonical JSON 合计不超过 8 MiB；新证据到达时在 DOM 与内存中同步淘汰最旧记录，并明确显示保留数量。单条仍受 BFF 约 2 MiB response ceiling 约束。bundle 本身不得超过 512 KiB，所有数组最多保留 64 项。
4. `qinglong/cluster-console-redacted-evidence-bundle@v1` 只包含 operation、非权威本机观察时间、固定安全枚举、boolean/有界 number、结构计数、分页事实、identifier alias 和每条原始事实的 canonical byte count/SHA-256。自由文本、名称、路径、URL、command、input/output、environment、reason/error/message、credential/token/authorization、未知 key/value 一律不进入 bundle；Copilot output 文本无条件省略。
5. Project、Run、Task、Workflow、Package、Step、Artifact、request 与 digest 等标识符按类型在每个 bundle 内稳定映射为顺序 alias，例如 `run-001`。原始到 alias 的映射不写入文件；相同原始标识在同一 bundle 内可关联，不同 bundle 之间不能依赖 alias 稳定性。
6. 生成器对每条原始 fact 做键排序 canonical JSON 后计算 SHA-256，再对不含顶层 `contentDigest` 的完整脱敏 bundle 做第二次 SHA-256。该 digest 只用于完整性/复核，不是服务端签名、durable audit、来源证明或行动授权；文件明确声明 `attestation=none`、`actionAuthority=none`、`generatedBy=browser_local`。
7. 下载格式固定为 UTF-8 JSON 加末尾换行，文件名不含任何 Project/Run/Task 标识。浏览器只使用 `crypto.subtle`、`TextEncoder`、`Blob` 与临时 object URL；点击后立即移除 anchor 并 revoke URL，不使用 timer、ServiceWorker、IndexedDB、local/session storage 或缓存。
8. Console 的 13 个 upstream read operation、`run.read|task.read|artifact.read` 推荐权限、Host/Origin/session、TLS 1.3、并发和 response ceiling 保持不变。该 bundle 不进入 Edge/Standalone 或 Cluster Control/AI closure；路由设备默认制品必须逐字节保持既有边界。

## 不选择

- **导出原始账本再提示用户自行脱敏**：把最困难且最容易遗漏的安全步骤交给值班人员，模型文本和用户命名会直接泄漏。
- **BFF/Cluster 服务端生成 ZIP**：需要更大 request body、临时文件、压缩库和新的 route，且会让浏览器提交的数据看起来像服务端证明。
- **下载前自动补齐所有分页和详情**：形成隐藏的读取放大器，破坏 ADR-0421 的“一次点击、一次读取”。
- **用 session key 签名 bundle**：session 是浏览器访问能力，不是签名身份；HMAC 会错误暗示集群来源证明并增加密钥滥用面。
- **长期稳定哈希标识符**：即使不包含原文，也会让不同导出物可关联；per-bundle alias 更符合最小披露。

## 验收

1. 生成器单测覆盖 exact input、16-entry/8 MiB/512 KiB/64-item ceiling、canonical digest、同包 alias 关联、跨包 alias 重置、原始/未知/自由文本和 credential/session/model output 永不出现，以及循环/非 JSON/非法时间/operation 失败关闭。
2. Console server/asset 单测证明第 4 个 asset 经过 realpath/type/UTF-8/size/SHA-256 复验，只从 same-origin 固定 GET path 返回；CSP、Host、Origin、session 和 upstream route vocabulary 不扩大。
3. 真实浏览器证明导出按钮初始禁用、读取后可用、下载文件可解析且 digest 可复算、恶意 HTML/credential-like 值和 Copilot output 不存在、alias 可关联；导出期间 upstream request 计数不增加，390px 无横向溢出且 0 console error/warning。
4. Console/distribution/package/dependency/Cluster deployment 审计零 finding，真实 Admin image 和 host-published Console 能取得第 4 个 asset；18-package、Cluster Admin、backend 与 14 档 Local artifact 全部通过后，本 ADR 才转为 Accepted 并进行 D-330 阶段提交。

## 验收结果

2026-08-16，D-330 完成以下发布门并接受本决策：

- 生成器、Console server、产品镜像契约与负面架构审计定向测试 24/24；`@qinglong/cluster-admin` 完整测试 382 pass、3 条件 skip、0 fail，18-package clean build/test 退出 0，backend 1,224 pass、2 条件 skip、0 fail。
- 真实浏览器以恶意 HTML、credential-like 值、私有路径和 Copilot 模型文本验证纯文本渲染与固定白名单脱敏；3 次显式读取前后，导出没有增加第 4 次 upstream 请求。下载的 3,611-byte JSON 可复算顶层 digest，同一 Project/Run alias 可关联，敏感样本零命中；390×844 无横向溢出，0 console error/warning，清空后内存账本与导出能力同步归零。
- 真实 arm64 `qinglong3-cluster-admin:d330-local` 为 344,543,263 bytes；在 UID/GID 10001、只读根、network none、drop ALL、no-new-privileges、0.25 CPU、128 MiB 与 32 PIDs 下通过 10 个产品命令、原生/host-published Console、第 4 个 asset 和内置分发物契约。
- npm pack dry-run 为 246 files、267,731-byte tarball、1,665,996-byte unpacked；package/dependency/Edge import/Cluster deployment/image release/Console/distribution 审计全部零 finding。workspace 保持 18 package、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；1,199 个源码中 1,181 个位于包内职责目录，Cluster Admin 为 120 个源码、119 个嵌套源码。
- 14 档 Local artifact 全部 compatible；默认 Edge/Standalone 精确保持 2,589,890/2,589,968 bytes、315 files、56 modules，application+AI 保持 4,493,043/4,493,175 bytes，MCP 保持 7,315,930/7,316,038 bytes，证明证据包未进入路由设备闭包。
- PostgreSQL 18.6 arm64 physical HA 142/142，timeline `1→2`，私有报告 SHA-256 为 `c9feb83c98ad2269c7649bd0869921d9dee7cfd00c9bc1a8a7879d81630d37c7`；离线证据审计零 finding，容器、网络和卷零残留。D-330 本身没有 schema、migration、SQL、role、Pool 或连接拓扑变化。
