# ADR-0354：精确、双授权的本机 MCP Approval 预览

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-259、D-260、D-263、D-265、D-266
- 关联 ADR：ADR-0138、ADR-0347、ADR-0351、ADR-0353

## 背景

`qinglong.approval.list` 可以说明动作处于 pending、approved、rejected 或 consumed，但故意不返回 preview。AI Client
若无法看见经过 redaction contract 生成的动作摘要，就不能做有意义的人工转交；若直接取得完整 Approval 或 Tool
Invocation Artifact，又会泄露 action reference、digest、主体与密文入口。现有 Approval 和 Tool preview 表已经分别保存
同一个 Project/action binding，缺口是最窄的精确关联读端口，而不是新表、Artifact 解密或审批写流程。

## 决策

1. 增加 `qinglong.approval.get@1.0.0`，输入只允许 `requestId`，Project 只能来自私有 MCP 配置。
2. 调用固定要求 exact `tool.call:qinglong.approval.get`、`approval.read` 和 `artifact.read`。两个既有只读权限缺一不可；
   之后仍须 durable Security Audit 和 credential fence confirm。
3. SQLite/PostgreSQL 先按 Project+request ID 读取并复验 canonical Approval、request digest 与更新时间镜像；只有
   `tool.invoke` 才按 `projectId/actionRef/actionDigest/previewDigest` 四元组 LEFT JOIN 已有 preview 表。
4. Adapter 必须规范化完整 preview Artifact，并复验 artifact/project/action/digest/redaction/size/time 的所有镜像；任何
   漂移映射为稳定 unavailable。无匹配 preview 是合法的 `previewAvailable=false`，不得猜测或扫描。
5. Runtime read port 只携带 Approval record 与已经验证的 preview document。MCP package 不得 import Tool Invocation Artifact
   subpath，不得取得 artifact ID、repository、input ciphertext、key、nonce、auth tag、任一 digest 或解密 authority。
6. 输出只含 Approval list 已公开的低敏元数据、`previewAvailable`，以及有界 title、summary、最多 16 个 field 和 8 个
   warning。`redacted` field 省略 value；不返回 Project、action reference、主体 ID、fence 或决定/消费/派发证据。
7. 不新增 package、dependency、migration、连接、listener、timer、watcher、cache 或写 authority。SQLite 复用 MCP 的唯一
   connection/operation queue/close fence；PostgreSQL 实现同一 port 供未来 Cluster 产品组合使用，但本 ADR 不建立 Cluster MCP。

## Package 粒度裁决

公共 read contract 属于 Runtime Core 的现有 `approved-action/` domain；双方言完整 Artifact 关联归各自 storage adapter；
单一 MCP 消费者的字段投影归现有 `local-mcp-server/tool-projection/`。因此只新增一个嵌套 projection 文件，没有新 workspace
package。当前为 17 package/999 source、973 nested、26 root，无单源或 shallow package。

## 被否决方案

1. 只要求 `approval.read`：把索引观察权限隐式扩大为 Artifact 内容权限。
2. MCP 直接使用 Artifact repository：会把密文存储面和未来解密能力带入协议进程。
3. Client 提供 action reference/digest 或 artifact ID：暴露内部证据，并形成跨请求枚举面。
4. 把 preview 复制进 Approval 表：需要 migration、重复事实和双写一致性协议。
5. 为 detail/source/projection 新建 package：没有独立制品、依赖、authority 或版本生命周期收益。
6. 同时开放 approve/consume：缺少强人类 ceremony、事务 start barrier 与写恢复产品门。

## 验证

- Runtime Core 451/451、Local SQLite 208/208、Local MCP 38/38、PostgreSQL 290 pass/1 条件 skip。
- 真实 SQLite migration/row corruption、PostgreSQL 参数化关联、in-memory MCP admission 与真实 stdio/API Credential/Audit 均覆盖。
- package boundary、dependency 和 edge import 审计 compatible；MCP 对 Artifact subpath 的一次越权 import 被门禁发现并通过
  document-only port 消除，而不是放宽规则。
- 十二档 artifact compatible。Standalone Application AI 为 6,261,021 bytes/637 files，余 30,435 bytes；Standalone MCP
  为 9,857,149 bytes/947 files/203 modules，RSS 40,632,320 bytes。
- PostgreSQL 18.4 arm64 HA `gates.passed=true`，结束后 QingLong 临时 Docker 容器、卷、网络均为零。

## 后续约束

人工 approve/reject、consume/dispatch 和实际 Tool execution 必须分别定义强认证、职责分离、幂等命令、原子审计、start
barrier 与响应丢失恢复协议。不得因为 preview 已可读就把任何写能力加入当前 MCP read authority。
