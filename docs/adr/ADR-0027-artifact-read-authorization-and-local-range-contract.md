# ADR-0027：Artifact 读取授权、存在性屏蔽与本地 Range 契约

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0024、ADR-0026

> 2026-08-12：Local/Cluster 生产读取接线由 ADR-0377 接受，Local retention 二次检查与 durable 410
> 由 ADR-0378 接受；Cluster retention 删除实现仍属于 D-291，本 ADR 的其余跨 adapter 扩展继续保持 Proposed。

## 上下文

2.x 日志 API 由全局登录或 Open API scope 保护，读取端仍接受 `path + file`，无法表达 Project 所有权、`artifact.read` 策略和 opaque Artifact identity。3.0 已把 LocalProcess 日志绑定到 `(projectId, runId, attemptId, logArtifactId)`，并用 retention tombstone 与 canonical truncation fact 保存清理和截断证据，但尚无稳定读取语义。

直接复用旧接口会产生四类问题：授权粒度不足；路径成为外部能力；文件缺失无法区分 retention 与异常丢失；文件大小等于 quota 时无法判断是否真正截断。对 edge，整文件读取还会产生与日志大小线性增长的内存峰值；对 cluster，本地路径又不是共享事实。

## 决策

### 1. API 只接受 identity 和有界 byte range

3.0 查询请求只包含 subject、Project ID、Run ID、opaque Artifact ID、offset 和 length，不接受目录、文件名、URI 或绝对/相对路径。首版本地单次读取长度上限固定为 256 KiB；offset 为非负安全整数，length 为正安全整数。

本地 reader 从 Artifact ID 派生私有 shard 和 `${artifactId}.log`，验证 root/shard 为非 symlink 目录，并以 `O_RDONLY|O_NOFOLLOW` 打开普通文件。它在打开的 fd 上采样一次 size，最多分配请求上限的 Buffer，并返回：

- `start`、`endExclusive`、`totalBytes`；
- 尚有快照内容时返回 `nextOffset`；
- 读取期间新增的 append 不进入当前响应，下一次 range 才可见；
- 文件在 stat 后异常缩短时 fail closed，不伪造完整 range。

这不是 HTTP `Range` 的最终 wire 格式；HTTP、MCP、CLI adapter 必须映射同一 application contract，不能各自直接读文件。

### 2. 数据库绑定和授权必须先于任何 Artifact 文件访问

固定顺序为：

1. 纯内存规范化 subject、Project/Run/Artifact identity 和 range；
2. metadata repository 按 `(projectId, runId, logArtifactId)` 查询 Run、Attempt 和 tombstone；
3. 只接受 `execution_owner=runtime`、`executor_type=local_process`、canonical `local-*` 绑定；
4. 调用 `artifact.read` authorizer，输入 subject、Project、Run 和 Artifact identity，不包含文件路径或内容；
5. 只有 `allow` 才能访问日志或 truncation fact；`deny` 与 `require_approval` 都不会触发 FS probe。

不存在绑定时返回内部 `not_found`，策略拒绝返回内部 `forbidden(effect)`。面向非可信调用方的 adapter 默认必须把 forbidden 和 not-found 映射为同一种不可用响应，避免通过状态、响应体、长度或 timing 暴露跨 Project 存在性；真实拒绝原因留给低敏审计。当前尚未实现 HTTP adapter，因此不能把 2.x 全局登录视为 3.0 authorizer。

### 3. 读取状态稳定区分 available、retained 与 missing

授权后 application service 返回以下领域状态：

- `available`：日志 fd 已安全打开并返回有界快照；
- `retained`：存在与 Attempt/Artifact identity 一致的 immutable tombstone，不访问已清理文件；
- `missing`：数据库仍有绑定、没有 tombstone，但本地文件不存在，表示需要运维诊断的未知丢失；
- `not_found`：请求 Project 内没有可读的 runtime/local Artifact 绑定；
- `forbidden`：内部策略结果，外部默认屏蔽。

为关闭 `metadata read → retention unlink → file open` 竞态，文件返回 ENOENT 后必须再次读取 metadata：若出现同 identity tombstone，收敛为 retained；若 identity 消失或漂移，按证据冲突 fail closed；仍无 tombstone才返回 missing。若 retention 在文件已打开后 unlink，POSIX fd 快照仍可完成 available 响应。

### 4. truncated 是严格三态

`truncation.truncated` 只能是 `true | false | unknown`：

- canonical fact 的 `quotaReached=true|false` 分别映射 true/false；
- fact 缺失映射 unknown，禁止从 size、末尾文本或退出状态推断；
- fact 的 Run/Attempt/Artifact identity 与数据库不一致时 fail closed；
- retained 始终返回 unknown，因为 ADR-0026 retention 会删除 fact，当前 tombstone 没有保存截断字段。

已知 fact 可以同时返回 bounded `maximumBytes` 和 `observedAtMs`，但不能返回 launcher capability、路径或用户输出。

### 5. edge、standalone 与 cluster 复用语义，不复用 adapter

- edge/standalone：SQLite metadata + private local range reader + local truncation fact；单次内存上限 256 KiB，无 watcher、tail timer 或目录扫描；
- cluster-control：PostgreSQL metadata + Project policy + object-store range GET/delete marker；控制面不得拼接 Worker 本地路径；
- worker：本地 spool 读取属于 Worker capability，必须由 authenticated transport、Run lease/fencing 和上传 ACK 约束。

所有实现必须通过同一 contract suite，保持状态、授权顺序、存在性屏蔽、range 边界和三态截断一致。

### 6. 当前保持 production unreachable

本切片已实现领域类型、`ArtifactReadAuthorizer`、metadata/range ports、SQLite metadata adapter、私有文件 reader 和组合 service，但没有注册到 typedi、Express/Open API、MCP、UI 或启动 lifecycle。生产接入至少还需要：

- Project/Actor 身份来源和真实 policy engine；
- forbidden/not-found wire masking、审计和 rate limit；
- content type、下载头、流式 tail/backpressure 与客户端取消契约；
- cluster PostgreSQL/object-store adapter 和 Worker transport；
- 实机权限、unlink/append、ENOSPC 和多架构 contract 测试。

## 影响

正面影响：

- 授权拒绝可结构化证明不会接触日志文件和 truncation fact；
- 调用方不再持有路径能力，单次读取内存有固定上限；
- retention、异常缺失和截断三态有稳定、可测试解释；
- edge 与 cluster 可以共享领域协议而替换存储 adapter。

代价与风险：

- 每次首次读取至少需要一次 metadata 查询和一次 policy 决策；ENOENT 竞态需要第二次点查；
- 当前 tombstone 不保存 truncation，retained 历史只能返回 unknown；
- 外部 adapter 若错误区分 forbidden/not-found，仍可能形成存在性侧信道；
- 256 KiB 是首版安全上限，后续调整必须结合 edge 内存并发预算，而不是只看单请求吞吐。

## 未选择的方案

1. **复用 2.x `path + file`**：路径是越权能力且没有 Project 绑定，拒绝。
2. **先打开文件再授权**：即使不返回内容也泄露存在性并触发敏感副作用，拒绝。
3. **一次读取完整日志**：内存随 Artifact 增长，不适合 edge，拒绝。
4. **文件不存在统一当 404**：无法解释已执行 retention，也无法暴露运维异常，拒绝。
5. **size 达到 quota 即 truncated=true**：精确写满与超额不可区分，拒绝。
6. **cluster 通过共享挂载读取 Worker 路径**：没有对象 ownership、ACK 和 fencing，拒绝。

## 验证要求

- 非法 identity/range 在 metadata、policy 和 FS 副作用前拒绝；
- deny/require-approval 时 file/fact 调用次数为零；
- available range 的 byte、offset、snapshot size、nextOffset 和 256 KiB 上限可重复验证；
- symlink file、symlink shard、非普通文件和异常短读 fail closed；
- retained 不访问 FS，ENOENT 后出现 tombstone 收敛为 retained；
- missing 与 retained 稳定区分，identity 漂移 fail closed；
- truncation true、false、unknown 和 fact identity 冲突均有测试；
- SQLite adapter 排除跨 Project、legacy owner、非 LocalProcess 和非 canonical Artifact；
- Node 22/24 类型检查和全量测试通过；production import graph 保持不可达。
