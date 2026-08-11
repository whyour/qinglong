# ADR-0353：有界、低敏的本机 MCP Approval 观察

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-259、D-260、D-261、D-262、D-263、D-264、D-265
- 关联 ADR：ADR-0138、ADR-0346、ADR-0347、ADR-0348、ADR-0349、ADR-0350、ADR-0351、ADR-0352

## 背景

Local MCP 已能发现 Task、Trigger 与 Run，但调用者看不到一个高风险动作为什么仍在等待、已经拒绝，还是已经消费。
这会诱使 Client 重试写操作或要求返回 Approval 内部记录。现有 Approved Action contract 已有完整状态机，SQLite 与
PostgreSQL 也已有 `(project_id, updated_at_ms, request_id)` 索引；缺口是只读、低敏、Profile-neutral 的发现端口和
MCP-only projection，不是新的审批状态机、表或 workspace package。

## 决策

1. Runtime Core 增加只读 `ApprovalRequestSource`，固定使用
   `(updatedAtMs DESC, requestId DESC)` keyset，默认由产品选择页大小，contract 最大页为 64。
2. SQLite 与 PostgreSQL 在既有 storage package 的 `approved-action/` domain 内实现该端口，读取 `limit + 1` 行，
   复验 canonical Approval record、record digest 与索引时间镜像。复用现有表和索引，不增加 migration。
3. Local MCP 增加第六个只读 Tool `qinglong.approval.list@1.0.0`。输入只允许 `after` 和 `limit`，Project 只能来自
   私有进程配置。每次调用仍经过 authentication、exact Tool permission、`approval.read`、durable Audit、credential
   confirm，之后才可读 Project-scoped page。
4. 输出只包含 request ID、version/state/risk/decision mode、permission、action type、requester type、请求/过期/决定/
   消费/更新时间。不得返回 Project、action reference、任一 digest、requester/decider ID、authentication ID、reason、
   fence、dispatch/consumption/decision ID 或 preview 内容。
5. `approval.read` 是所有既有 Project role 的只读权限，但不授予 `approval.decide`、consume、dispatch 或 execute。
   Agent 的通用 `tool.call:*` 审批规则不因此绕过。
6. cross-Project、乱序、超量、损坏 record/digest、非法 cursor 与 continuation 漂移全部失败关闭；存储错误只映射为稳定
   unavailable，不返回数据库细节。
7. 不增加 package、production dependency、listener、连接、timer、watcher、缓存或写 authority。MCP projection 留在既有
   `local-mcp-server/tool-projection`；默认 Edge/Standalone application 继续不安装 MCP SDK。

## Package 粒度裁决

本能力故意跨三个既有 adapter package 纵向实现，而没有建立 `approval-discovery` workspace package。公共 contract 属于
Runtime Core；方言查询分别属于 SQLite/PostgreSQL；单一 MCP 消费者的字段裁剪属于 MCP package。当前机器账本为 17 个包、
998 个 source，其中 972 个在 domain 子目录、26 个根文件均为 public facade 或 binary/process composition；没有单源或
shallow package。唯一两文件的 `local-command-file` 仍被四个不同生命周期 production closure 复用且没有 production
dependency，合并只会复制安全读取协议或扩大上层权限闭包。

## 被否决方案

1. 直接返回完整 Approval record：会泄露 action reference、digest、主体、fence 与执行关联。
2. 只返回 pending：当前没有 Project+state+order 复合索引；投影层过滤会造成无界补读和游标歧义。
3. 从 MCP approve/consume/execute：观察能力不具备强人类决策、原子 start barrier、幂等恢复和写审计产品门。
4. 为 contract、SQLite reader、PostgreSQL reader 或 projection 分别建包：没有独立制品、依赖、权限或版本生命周期。
5. 把全部本机实现合入单包：会让路由设备的默认 Profile 获得 MCP SDK、Owner authentication 或管理 authority。

## 验证

- Runtime Core 450/450、Local SQLite 207/207、Local MCP 33/33、PostgreSQL 289 pass/1 条件 skip。
- Project Policy、package boundary 与 dependency 专项 61/61；17 package/998 source、972 nested、26 root，零 finding。
- 十二档 artifact 全部 compatible。Standalone Application AI 为 6,253,063 bytes/637 files，距 6 MiB 上限 38,393 bytes；
  Standalone MCP 为 9,839,075 bytes/946 files/201 modules，RSS 增量 37,765,120 bytes。
- PostgreSQL 18.4 arm64 HA Docker gate `gates.passed=true`；promotion、`remote_apply`、旧主 fence/rewind、双 control replica
  与领域 COMMIT-response-loss 均通过，结束后临时容器、卷、网络为零。

## 后续约束

Approval detail、preview Artifact 读取、人工 decide 和任何执行能力必须分别定义权限、低敏字段、MFA/双人复核、事务与恢复
协议，不能扩大本列表偷渡。没有 Project+state keyset 索引前不得增加 state filter。Cluster 若提供 MCP，必须复用同一
Profile-neutral source 与独立进程/连接预算，不能让本机 sidecar 直接连集群数据库。
