# ADR-0046: Cluster 两阶段安全 Admission

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-04、D-08、D-13、D-27 至 D-32、D-43、D-44

## 上下文

ADR-0045 建立了有界 HTTP surface，并保证 `/api/v3` 在 readiness 与 recovery 完成前不可达。但如果 Authentication 和 Policy 只是普通业务 handler 中的 middleware，HTTP adapter 仍会先读取、缓存并解析整个 JSON body。匿名或已撤权请求因此可以在拒绝前消耗内存和 CPU；新增 route 也可能因漏装 middleware 绕过统一 Policy/Approval/Audit。

cluster-control 还不能复用 legacy Express Controller 作为安全入口：它会把 2.x session、Sequelize、route scope 和控制面装配重新耦合到 cluster artifact，并破坏 edge/cluster 的 Profile 隔离。

## 决策

### 1. 共享安全契约属于 runtime-core

`@qinglong/runtime-core/security` 只定义并严格规范化：

- `SecuritySubject` 与 active `SecurityPrincipal`；
- authentication assurance；
- `allow | deny | require_approval` Policy decision；
- 可选 Project/RoleBinding version fence；
- 有界、低敏 reason code。

该入口没有数据库 driver、JWT library、HTTP framework 或 legacy 依赖。adapter 返回过期、未来时间、扩展 shape、非法 identifier、空 reason 或无效 fence 时视为安全依赖故障并 fail closed。

### 2. HTTP admission 固定为两个阶段

第一阶段 `prepare(metadata)` 只接收 method、path、query、有界 headers、request ID 和 AbortSignal，固定执行：

1. route resolver 产生稳定 operation、permission、Project scope 和 handler；
2. authenticator 产生 active Principal；
3. Policy authorizer 返回 decision/fence；
4. security audit sink 记录低敏 decision fact。

只有全部成功且 decision 为 `allow` 时，pipeline 才返回 `PreparedAdmission`。HTTP adapter 随后才读取有界 JSON body，并调用 prepared operation。`deny` 与 `require_approval` 均不会读取 body 或调用业务 handler。

### 3. 安全依赖与审计 fail closed

- 无 credential 返回 `401 authentication_required`；
- Policy deny 返回 `403 forbidden`；
- 需要审批返回 `403 approval_required`；
- route/authentication/authorization/audit 不可用返回各自稳定的 `503` code；
- adapter 原始错误、credential、Principal、内部 Policy reason 和 stack 不进入 wire response；
- `allowed` decision 必须先完成安全审计，审计失败不得继续 handler。

HTTP 的通用 `onError` 仍只用于技术诊断，不能替代安全 decision fact。

### 4. 当前 pipeline 不是生产身份实现

本 ADR 只建立不可绕过的顺序与端口。生产启用仍需要：

- 真实 credential authenticator（panel/API App/mTLS 等必须分别建模）；
- PostgreSQL Project/RoleBinding Policy adapter 与 version fence；
- 经过评审的 route registry 和领域 handler；
- 有界、持久化、可告警的安全审计 sink；
- ApprovalRequest/dispatch 对 `require_approval` 的产品入口。

禁止用 allow-all authenticator、固定 owner Principal 或无操作 audit sink 把当前 generic host 宣布为 production-ready。

## 被否决的替代方案

### 在每个 Controller 内手写鉴权

拒绝。无法证明所有 route 都经过相同顺序，且默认发生在 body 解析之后。

### 只依赖反向代理完成认证授权

拒绝。代理身份可以作为 credential transport，但领域 permission、Project fence、Approval 与审计仍必须由 QingLong 裁决。

### 认证成功后立即读取 body，再执行 Policy

拒绝。已认证不等于对目标 Project/operation 有权，撤权或 Agent approval 仍会让大 body 成为无意义资源消耗。

### 审计失败时继续业务请求

拒绝。允许动作却没有对应安全 decision fact 会破坏可追责性，并使安全存储故障静默降级。

## 影响

### 正向

- 未认证、撤权和需审批请求在 body 读取前被拒绝，保护低资源设备与 cluster gateway；
- route 新增时必须显式提供 operation/permission/scope，不存在可选安全 middleware；
- Principal/Policy contract 可被 edge、standalone、cluster-control 和 worker 复用；
- wire error 保持低敏、稳定且不绑定具体认证/数据库实现。

### 代价

- route resolver 必须能仅凭 method/path/query/headers 确定 permission 与 Project scope；依赖 body 才能授权的动作必须先重构为 path identity 或单独的受限 preview/admission 协议；
- 安全审计成为 availability dependency，需要有界队列、持久化和告警设计；
- 两阶段 handler contract 比普通 `(request) => response` 多一个 prepared operation。

## 验证

1. runtime-core contract test 拒绝过期/未来 Principal、widened shape、非法 reason 与 fence。
2. admission pipeline test 固定 route→authenticate→authorize→audit→handler 顺序。
3. authentication reject、Policy deny、approval required、adapter failure 和 audit failure 都证明 handler 未执行。
4. 真实 Node HTTP 测试只发送声明的 `Content-Length` 而不发送 body，仍必须立即得到认证拒绝，证明 preflight 不等待 body。
5. 公开 admission/config/application import closure 不得加载 legacy `back/**`、PostgreSQL migration DDL 或 Drizzle schema。
6. Node 24、依赖审计和 GitNexus impact/detect-changes 作为合并门禁。
