# ADR-0377：Profile-aware Run Attempt 日志范围读取

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-289
- 前置决策：ADR-0027、ADR-0367、ADR-0376

## 上下文

Task Start 已能在 Local 与 Cluster 创建可执行 Run，产品入口也能读取 Run、Event、Step 并请求取消，但调用方仍无法从同一 Project-scoped 产品面读取某个 Attempt 的执行日志。早期 `back/runtime` 已验证本机 metadata-first 授权、私有文件 Range 与截断三态，但它不在 QingLong 3.0 package 生产图中，也没有 Cluster 对象存储实现。

直接恢复 2.x 的 `path + file` 会把路径当作外部 capability；把整份日志编码进 JSON 会让内存与日志大小线性增长；把 Local 与 Cluster 强行放到同一存储 adapter，又会使控制面依赖 Worker 本地路径。低配路由设备和集群节点需要共享语义，但必须拥有不同的单次窗口与存储实现。

## 决策

### 1. 同一产品路由与只读权限

Local 与 Cluster 提供同构入口：

`GET /api/v3/projects/{projectId}/runs/{runId}/attempts/{attemptId}/log?offset={n}&length={n}`

- operation：`run.log.read`
- permission：`artifact.read`
- response schema：`qinglong/run-attempt-log-read-result@v1`
- `offset` 默认为 0；`length` 默认为当前 Profile 窗口
- 请求只接受 Project、Run、Attempt identity 和有界范围，不接受 Artifact ID、路径、URI、bucket 或 object key

Policy、durable security audit 与 credential confirmation 必须先于 Run/Attempt metadata 和 Artifact 存储访问。对非可信 HTTP 调用方，Policy deny、require-approval、跨 Project、不属于该 Run、legacy owner、错误 executor 和不存在均返回相同的 404，不形成存在性 oracle；真实结果只进入低敏审计。

### 2. 共享 application contract，不共享存储 adapter

`runtime-core` 定义唯一的 Run Attempt 日志读取服务和 byte-range port。服务复用现有 `RunRepositoryReader.findRunById/findAttemptById`，依次验证：

1. Run 属于请求 Project 且 `executionOwner=runtime`；
2. Attempt 属于请求 Run；
3. executor 与当前 Profile 一致；
4. Attempt 绑定 canonical `local-*` 或 `wlog-*` Artifact ID；
5. range 规范化且不超过调用 Profile 的上限；
6. 只有上述数据库事实成立后才调用存储 reader。

Local adapter 从 opaque `local-*` ID 派生私有 shard，拒绝 symlink、非普通文件、非当前进程 owner、多 hard link、异常短读和 identity 不一致的 truncation fact。Cluster adapter 先用现有 immutable S3 HEAD 校验 identity digest、length、content type、checksum metadata，再执行单次有界 Range GET；控制面从不拼接 Worker 路径。

S3-compatible provider 必须在最终对象 COPY 后，通过启用 checksum 的 HEAD 返回 canonical `ChecksumSHA256`；只返回调用方可写 metadata 而不能独立证明对象内容的实现不在兼容集合内，adapter 必须失败关闭，不能退化为信任 metadata 或 ETag。

### 3. Profile 窗口和资源上限

共享协议硬上限为 256 KiB，但部署档位收紧实际窗口：

- Local Edge：默认 16 KiB，最大 32 KiB；
- Local Standalone：默认/最大 32 KiB；
- Cluster Control：默认 64 KiB，最大 256 KiB。

当前 HTTP transport 只返回 JSON，因此 content 使用 Base64，并同时返回 byte range、总长度和下一 offset。Local 的 32 KiB 上限保证编码和元数据仍低于既有 64 KiB response hard limit；Cluster 保持低于既有 1 MiB 默认 response limit。reader 只分配请求窗口，不启动 watcher、tail timer、cache、额外 listener、Pool 或 S3 client。

### 4. 状态与失败语义

- `200 available`：返回当前文件/对象快照内的有界 bytes、`start`、`endExclusive`、`totalBytes` 和可选 `nextOffset`；
- `202 pending`：合法远端 Attempt 已绑定日志，但对象尚未在 upload-before-completion 协议中发布，或 Attempt 尚未产生 Artifact identity；
- `404 artifact_not_found`：不存在、越权或 identity/executor 不匹配的统一外部遮蔽；
- `503 artifact_unavailable`：数据库、文件安全检查、对象存储或证据一致性无法证明。

`truncated` 保持 `true | false | unknown`。Local 只相信 launcher canonical fact；Cluster 只相信 immutable S3 metadata；禁止从 size、尾部文本或退出状态推断。offset 等于或超过当前快照末尾时返回空的 available range，并把 start 收敛到 totalBytes，便于轮询而不制造 416 竞态。

### 5. 本批明确不闭环 retention

本批不新增 tombstone table、delete marker、retention lifecycle 或对象删除权限。ADR-0027 的 retained/missing 竞态和 ADR-0026 retention 仍是独立后续切片。没有 tombstone 时，Local 的已绑定文件缺失和终态 Cluster 对象缺失都按 503 处理，不能伪装成已执行 retention；因此 ADR-0027 在 retention 完成前保持 Proposed。

### 6. package 与部署边界

- 不新增 workspace package、第三方依赖、migration、table/index、数据库连接或常驻资源；
- contract 放入 `runtime-core` 既有 Run 能力目录；Local reader 放入 `local-execution` 既有 Artifact 能力目录；S3 reader 扩展 `cluster-control` 既有 immutable store；
- 默认 headless Local 不加载文件 reader；只有可选 Local API product surface 通过 application authority 获得已构造 capability；
- Cluster 复用 production Worker artifact binding 的同一 S3 client/store；未配置对象存储时 route 保持存在并失败关闭为 503；
- MCP 本批不读取日志，避免在 Agent 面扩大敏感数据能力。

## 被否决的替代方案

1. **恢复 `path + file`**：路径成为跨 Project capability，拒绝。
2. **整文件返回或服务端 tail 长连接**：内存、连接和后台资源无界，不适合 Edge，拒绝。
3. **固定所有 Profile 为 256 KiB**：Base64 后突破 Local 64 KiB transport 门，拒绝。
4. **Cluster 读取 Worker 共享挂载**：绕过 immutable upload、checksum 与 fencing，拒绝。
5. **为日志读取新建微包或 metadata 表**：既有 Run/Attempt authority 足够，本批不制造薄 package，拒绝。
6. **将 missing 当 retention**：没有 durable tombstone 无法证明，拒绝。

## 验收

1. shared contract 覆盖 identity/range、Project/Run/Attempt/executor 绑定、pending/available/missing 与截断三态；
2. Local adapter 覆盖 symlink、owner/link count、append snapshot、短读、空/越尾 range 和 fact identity 冲突；
3. S3 adapter 覆盖 HEAD identity/checksum、精确 Range、abort、404、响应长度/Content-Range 漂移和终态缺失；
4. Local/Cluster HTTP 覆盖 route/query、`artifact.read`、durable audit、deny/not-found 遮蔽、202/200/400/404/503；
5. 默认 headless Edge closure 不增加；Local API 增量仍满足 64 KiB response、4 in-flight 与 128 MiB/64 PID 门；
6. 完整 package/backend、dependency/package boundary、Profile artifact、真实 SQLite+HTTP、S3-compatible integration、PostgreSQL HA 与 Local image 门全部通过后，状态才可改为 Accepted。

## Accepted 证据

- Runtime Core 494/494、Local Execution 35/35、Local API 45/45、Local Application 45 pass/4 platform skip、Cluster Control 215 pass/2 conditional skip；完整 18-package build/test 退出 0。
- backend 1,163 pass/2 skip/0 fail；package boundary、dependency boundary 与 Edge import audit 全部 compatible。workspace 仍为 18 package、1,045 source、1,027 nested/18 reviewed root entry，无 single-source 或 shallow package。
- 真实 SQLite+HTTP 已覆盖认证、Policy、durable audit、credential confirmation、Attempt metadata 与本地私有文件 Range 的完整顺序；Local 文件 adapter 的 symlink、权限、hard-link、短读、append snapshot、越尾空读与 truncation identity drift 全部通过。
- S3 单元门覆盖 checksum/metadata/ETag/Content-Range 漂移、短体与超长体；固定摘要 `minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` 的真实 KMS/SSE、条件 promotion、重放、HEAD 与 Range GET 通过。不能在 COPY 后返回 `ChecksumSHA256` 的旧 provider 被实测失败关闭。
- PostgreSQL 18.4 arm64 HA 通过 112 gates，timeline `1→2`，报告 SHA-256 为 `61bea38e3a4f66884b9642c2fc1944dd7084f70ceb358d6d3fea8c11d5d33b65`。
- 14 个 Edge/Standalone Profile artifact 全部 compatible。Edge Application API 为 3,596,457 bytes/423 files/84 loaded modules，距 6 MiB 门仍有 2,694,999 bytes；依赖闭包不包含 Cluster、PostgreSQL 或 AWS SDK。
- 当前源码构建的 arm64 Local image 为 10 package/385 files/3,331,225 bytes。Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs 均在 non-root、read-only root、network-none 下 active、20 events、graceful stop，SQLite integrity 为 `ok`。
- 本批没有新增 package、第三方依赖、migration、table/index、连接、listener、timer、watcher 或 cache；Artifact retention/tombstone 仍由 ADR-0027 后续闭环。
