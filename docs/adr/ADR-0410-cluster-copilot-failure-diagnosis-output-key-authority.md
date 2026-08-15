# ADR-0410：Cluster Copilot Failure Diagnosis Output Key Authority

- 状态：Accepted
- 日期：2026-08-15
- 关联 RFC：QL-RFC-0001 D-318、Phase 2
- 关联 ADR：ADR-0405、ADR-0406、ADR-0408、ADR-0409

## 问题

ADR-0409 已定义 Copilot diagnosis Model output 的独立 AES-256-GCM Artifact 与 key provider 端口，
但 Cluster 产品还没有可以注入该端口的部署密钥 authority。若复用 Plugin Prompt output、Tool
invocation 或 Tool result keyring，会让一次轮换或退役跨越不同数据域，并使最小权限部署无法证明
哪个进程能够加解密诊断结果。

同时，路由设备不应因为 Cluster Copilot 能力增加任何 keyring、watcher 或常驻内存；Cluster 节点
也不能把 Kubernetes Secret/CSI projection 的瞬时路径、可写文件或跨目录 symlink 当成可信密钥。

## 决策

1. 新增独立 schema `qinglong/copilot-failure-diagnosis-output-projected-keyring@v1`。manifest 只包含
   一个 `activeKeyId` 和最多 16 个 canonical 32-byte key；key ID 有界，JSON 必须 exact 且 canonical。
2. `ClusterCopilotFailureDiagnosisOutputProjectedKeyring` 实现 ADR-0409 的 `active()` 与
   `resolve(keyId)` 端口。每次操作重新打开 projection，不持有 cache、watcher、timer、Kubernetes
   API client 或轮换权限；返回的 key material 由调用者使用后清零。
3. 文件读取复用 Cluster Control package-private `PrivateProjectedFileReader`：配置根必须是 direct
   absolute directory；允许 Kubernetes atomic-writer 的根内 symlink，但最终 regular file 必须单链接、
   只读、不可执行、other-inaccessible，并在读取前后复验 dev/inode/size/mtime 与双 realpath fence。
4. Copilot output key ID/material 不得与 Plugin Prompt output、Tool invocation、Tool result 或 Provider
   credential 互换。不同 schema 即使 key bytes 相同也拒绝；部署文档必须要求独立 Secret 和 mount root。
5. 能力内聚在现有 `@qinglong/cluster-control` 的 `copilot/failure-diagnosis/` 目录，只通过显式
   `failure-diagnosis-output-keyring` subpath 发布；不新增 workspace package、依赖、进程、Pod、连接、
   route 或默认 Profile import。
6. 本 Gate 只建立 runtime key custody，不提前伪造产品可用性。完整 Copilot composition 仍需同时装配
   admission、Tool invocation/result keyring、Artifact/log reader、Model Gateway、PostgreSQL repository
   与恢复状态机；该入口在后续 Gate 完成前保持不可达。

## 被否决方案

1. **复用 Plugin Prompt output keyring**：两个产品域的 retention、授权和泄漏半径不同。
2. **复用 Tool invocation/result keyring**：混淆请求、Tool 结果与模型结论的加密用途。
3. **从环境变量读取 base64 key**：密钥进入进程环境与诊断面，且无法安全保留历史 key。
4. **启动时读取一次并永久缓存**：轮换无法生效，退役和文件漂移也无法失败关闭。
5. **为 keyring 新建 package**：没有独立部署进程或依赖边界，只会增加薄包。

## 验证标准

1. 覆盖 canonical manifest、active rotation、historical resolve、missing key、wrong schema、缺失 active、
   非 32-byte material、可写 projection 与根外 symlink。
2. Cluster Control 完整构建/测试、package/dependency/Edge import/Cluster deployment 审计全部通过。
3. workspace 保持 18 个 package、无单文件或浅平 package；14 档 Local Profile artifact 证明默认
   Edge/Standalone 与本地 AI/MCP 不携带该 Cluster-only subpath。

## 后续门禁

1. 在独立默认关闭的 Cluster Copilot composition 中同时装配 admission、Tool、Model 与本 keyring，
   不能把 Plugin Prompt gateway 的 completion sink 当作 Copilot sink。
2. 建立 Tool failure、日志 missing/retired、Model admission 前 deadline/cancel 与 outcome-unknown
   resolution 的 durable terminalization/recovery。
3. 再开放经 authentication、Policy、audit 和 exact source fence 的 Cluster API/CLI/UI/MCP 入口。

## 当前验证

1. 定向 keyring 与 package-boundary 回归 13/13；Cluster Control 完整测试 241 项中 239 pass、2 条
   环境条件 skip、0 fail。
2. 18 个 QL3 package 从清理 `dist` 开始顺序构建并执行全部 package tests，退出码为 0；backend
   全量 1,209 项中 1,207 pass、2 条环境条件 skip、0 fail。
3. package boundary、dependency firewall、Edge import 与 Cluster deployment 四项架构审计均为
   `compatible: true`、零 finding。workspace 仍为 18 个 package，`singleSourcePackages` 与
   `shallowSourcePackages` 均为空；Cluster Control 的 58 个源码中，56 个位于嵌套领域目录，根层仅
   保留 2 个 binary entry。
4. 14 档 Local Profile artifact 全部通过。默认 Edge/Standalone 仍为
   2,589,890/2,589,968 bytes，Edge/Standalone AI 仍为 3,061,009/3,061,099 bytes；新增
   Cluster-only subpath 未进入默认、本地 AI 或 MCP 产品闭包。
5. 本 Gate 不修改 migration、schema、PostgreSQL role、SQL、连接或 HA 拓扑，因此不重复制造一份与
   变更无关的数据库实证；ADR-0409 的 PostgreSQL 18.6 arm64 HA 130/130、timeline `1→2` 仍是当前
   数据库基线。
