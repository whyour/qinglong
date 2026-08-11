# ADR-0289：按执行 Request ID 恢复并读取 Durable Package Prompt 输出

- 状态：Accepted
- 日期：2026-08-08
- 关联：D-85、D-87、D-156、D-157、D-213、D-244、D-257、ADR-0261、ADR-0263、ADR-0267、ADR-0274、ADR-0275、ADR-0276、ADR-0288

## 上下文

ADR-0288 允许调用方在 Prompt execute 响应丢失后，用自己持久化的 `executionRequestId` 精确恢复 Run 状态；但其
结果刻意排除了 Artifact identity 和正文。现有 Prompt output read 又要求调用方同时保存服务端返回的 `runId`、
`artifactId` 和 `artifactDigest`。当首次 durable execute 已成功提交而 HTTP/CLI 响应丢失时，这三个事实同样无法取得，
形成“知道执行成功、却不能取回已付费输出”的产品断点。

Cluster 已定义 caller-selected Artifact read route，但显式 AI production composition 尚未装配其 read authorizer 和
capability。Local application runtime 支持 durable output，Owner CLI 却只接受 `live_only`。仅新增一个 Artifact reference
发现接口会把重试、权限、retention、密钥解析和解密继续留给调用者，不能构成 QingLong 3.0 的恢复闭环。

## 决策

1. 新增共享结果 schema `qinglong/plugin-package-prompt-execution-output-read-result@v1`。输入固定为强认证
   principal 与 `projectId/packageName/promptId/executionRequestId`；成功结果返回既有 immutable Artifact reference
   和受界 `GenerateResult`，缺失统一返回 `not_found`。
2. SQLite/PostgreSQL 在现有 Prompt admission `request_id` 主键上精确定位，只连接 succeeded finalization、
   ModelInvocation completion、Run、StepRun 和 immutable output Artifact，并要求 `step.output_ref=artifact_id`。
   查询固定 `LIMIT 2`，只投影 `runId/artifactId/artifactDigest`，不得读取 `artifact_json`、ciphertext 或 key material。
3. 定位成功后必须委托既有 `PluginPackagePromptOutputReadService`，保持 metadata→`artifact.read` Policy→retention/
   tombstone→key resolve→AES-GCM decrypt→key wipe 的顺序。新服务不得直接解密、绕过 tombstone 或请求 active key。
4. Local `ql3-prompt` command-file schema v1 增加 `prompt.execution.output.read`，权限和 allowed audit operation 均固定为
   `artifact.read`/`prompt.execution.output.read`。读取只装载 SQLite、output Artifact/retention repository 和显式
   `promptOutputKeyringPath`，不得加载 Provider authority、Provider Secret 或 Model Gateway。
5. Local `prompt.execute` 接受显式 `durable_artifact + retentionPolicy`。只有该模式要求并装载
   `promptOutputKeyringPath` 与 completion coordinator；`live_only` 继续禁止配置 output keyring，确保默认路由设备路径
   零 Artifact/key/repository 增量。exact replay 返回相同 Artifact reference，不再次调用 Provider。
6. Cluster 显式 AI Profile 新增
   `GET /api/v3/projects/{projectId}/packages/{packageName}/prompts/{promptId}/executions/{executionRequestId}/output`，
   operation 为 `prompt.execution.output.read`，permission 为 `artifact.read`。生产组合仅在 Prompt output keyring opt-in
   时同时装配现有 caller-selected Artifact route 和新 request-keyed route；默认 AI-free control 不注册二者。
7. absent execution、live-only、未完成、失败、cross-target、policy deny、已 tombstone 或 GC 后 Artifact 均统一映射
   `not_found`/HTTP 404，不暴露目标存在性。内部 shape、digest 或 identity 漂移映射 503，正文不得进入错误和审计。
8. 本增量不新增 workspace package、生产 dependency、migration、表、索引、Pool、端口、listener、timer、watcher、
   cache、队列、controller 或部署单元。三个新 AI 文件全部进入既有 `prompt-output/` domain，workspace 保持 19 包且
   root-file hard cap 不变。

## 被拒绝的方案

- **把 Artifact reference 加入 ADR-0288 的 content-free inspection**：会把 `run.read` 与 `artifact.read` 内容边界混合，
  也让所有状态轮询暴露存储与 retention 元数据。
- **只返回 reference，不返回正文**：调用者仍需拼接第二次 API、保存 digest 并处理 tombstone，响应丢失恢复仍不是一个
  原子产品动作。
- **用 request ID 计算 Artifact ID 后直接解密**：无法证明 Package/Prompt、terminal completion、StepRun output_ref 和
  Artifact digest 的完整绑定。
- **把正文复制到 admission/finalization receipt**：扩大热表、备份、审计和 HA 泄漏面，破坏 immutable 加密 Artifact
  authority。
- **为 recovery 建 projection 表或新索引**：现有 request 主键和 terminal join 已能精确定位，新增状态会产生双写和
  Edge migration 成本。
- **新增 workspace package 或常驻 recovery worker**：没有独立部署或故障域收益，并增加小设备 importer、内存和运维
  表面积。

## 当前证据

- 共享 service 5/5、Cluster route 3/3；SQLite/PostgreSQL locator 都使用 request 主键和 terminal joins，定位 SQL
  不读取 Artifact envelope/ciphertext，并覆盖 malicious widened reference/result、cross-target 与 missing。
- Local Owner CLI 定向新用例通过：显式 durable execute、exact replay、按原 execution request 读取正文、重复读取和
  allowed audit 均成功；Provider generate 仅一次，读取前后 Provider load 计数不变。
- Cluster AI/production/route 定向 19/19；output opt-in 同时装配 caller-selected 和 request-keyed read，默认 AI-free
  composition 保持不装配。
- AI、Local Owner CLI、Cluster Control 与 Local Application 的完整 package suites 均零失败；完整 19-package clean
  build/test 与 backend 1,110（1,108 pass/2 skip）全绿。cluster dependency、package boundary、Edge import、Cluster
  deployment、CloudNativePG 与 local image 六项审计 compatible；十档 artifact/RSS 全绿，Edge 3,614,826 bytes，
  最大 Standalone Application AI 6,102,447 bytes，默认非 AI closure 未新增 keyring/Artifact importer。
- package ledger 保持 19 包、`singleSourcePackages=[]`；762 个 source 中 49 个仅为受审公开/binary/composition 根入口，
  713 个实现位于领域目录。新增 AI/Cluster 实现进入既有 capability，未以恢复能力为由新增微包或根层平铺。
- PostgreSQL 18.4 arm64 physical-streaming HA 已实跑通过。轮换后的新 key durable output 在 primary 通过原
  execution request 精确解密，standby WAL replay 与 promoted runtime-role decrypt 结果一致，cross-target 保持
  `not_found`，报告不含正文；`pluginPackagePromptExecutionOutputRecoveryIsExactAndContentFree` 与
  `pluginPackagePromptExecutionOutputRecoveryReplicatesAndSurvivesPromotion` 均为 true。timeline 1→2、旧主
  fencing/rewind/read-only synchronous rejoin、两套 fresh control replica、`gates.passed=true` 与最终
  `ql3-ha-*` container/network/volume 零残留全绿。

## 接受条件

1. AI、Local Owner CLI、Cluster Control 定向与完整测试全绿；双方言 exact/cross-target/live-only/tombstone/replay/
   malformed-result 测试覆盖。
2. 完整 19-package clean build/test、backend、Edge/Cluster dependency、package boundary、deployment/local image 与十档
   artifact/RSS 门无回归；默认 Edge/Standalone 非 AI 与 live-only 闭包不得新增 keyring/Artifact importer。
3. PostgreSQL physical-streaming HA 必须证明 durable Artifact、request-keyed locator 和 decrypt read 在 primary、standby
   WAL replay、promotion 后 runtime role 上保持一致；cross-target/content-free audit、timeline、rewind、fresh replicas 和
   零残留继续全绿。
4. 刷新 GitNexus 后对所有已修改符号重新检查影响，并运行 `detect_changes` all/compare `develop`。

## 后续边界

- Prompt execution history、输出列表、全文搜索、流式增量输出与跨 Package 查询仍需独立索引、分页和可见性 RFC。
- UI 可在 execute 超时后先读 content-free execution 状态；只有用户显式查看 durable output 时调用本内容接口，避免
  状态轮询反复解密和传输正文。
