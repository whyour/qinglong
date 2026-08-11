# ADR-0048: Cluster 受审 Route Registry 与授权输入边界

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-04、D-08、D-13、D-27 至 D-32、D-43 至 D-46

## 上下文

ADR-0046 已固定 route→Authentication→Policy→security audit→body→handler，ADR-0047 也提供了 PostgreSQL Project Policy adapter。但 admission 当时仍接受任意 `ClusterControlRouteResolver`：resolver 可以在运行时根据未受审逻辑产生 operation、permission、Project ID 和 handler。类型检查不能证明该 resolver 没有从 query/header 自报 permission、依赖注册顺序选择重叠 route，或把 Project scope 延迟到 body 中决定。

对 cluster-control，这不是普通 router 的可替换实现细节，而是 Policy 的可信输入边界。路由表必须在 readiness 后开放流量之前完成验证；无权请求必须在低资源 edge gateway 或 cluster ingress 读取 body 前终结。

## 决策

### 1. Route definition 是启动时受审静态事实

`@qinglong/cluster-control/routes` 公开工厂，definition 必须显式提供：

- HTTP method 与 canonical `/api/v3/...` path template；
- 全局唯一 operation ID；
- Project Policy permission；
- Project ID 对应的显式 path parameter，或明确的 `null` global scope；
- query name allowlist；
- domain handler。

operation、permission 和 Project scope 不得由 header、query、body 或 handler 返回值决定。`null` scope 在当前 Project Policy adapter 下默认 deny；未来全局 operation 必须使用独立受审 Policy，而不是绕过 Project Policy。

### 2. Registry 编译阶段拒绝歧义和无界配置

registry 在启动时：

- 最多接收 256 条 route、每条最多 16 个 segment 和 8 个 path parameter；
- 禁止 wildcard、catch-all、可选 segment、尾随/重复斜杠和 percent-encoded template；
- 拒绝相同 method 下可能匹配同一 path 的 static/parameter 重叠；
- 拒绝重复 operation ID、重复 parameter、未知字段和未声明的 Project parameter；
- 固定最多 16 个 allowlisted query name。

拒绝重叠是为了让匹配结果不依赖注册顺序。新增 route 必须在 code review 中同时审阅 operation、permission、scope 和 handler。

### 3. Admission 只接受工厂产生的 Registry

admission 不再只做结构化鸭子类型检查。模块内部使用不可复制的 registry identity 验证 resolver；伪造相同 `contractVersion/resolve` shape 仍在装配时被拒绝。这样 application stack 不能静默注入临时 allow route 或 handler-owned resolver。

registry 仍返回原有 prepared route contract，使 Authentication、Policy、audit 和 HTTP body/drain 边界无需耦合具体业务 router 或框架。

### 4. 非规范请求在 Authentication 前拒绝

运行时匹配只接受安全 ASCII segment。以下输入返回稳定低敏 `400`，且不调用 authenticator、Policy、audit 或 handler：

- percent-encoding path alias；
- 重复/尾随斜杠、反斜杠或控制字符；
- 超长 path、过多 segment；
- 未 allowlist query；
- query 重复值、单值大小或控制字符超过硬边界。

canonical 但未注册的 method/path 返回 `route_not_found`，同样发生在 Authentication 前。

## 被否决的替代方案

### 继续接受任意 RouteResolver port

拒绝。可替换 resolver 对普通路由器是扩展点，对 Policy 输入却是 authority seam；任何调用方都可产生未受审 permission 或 Project scope。

### 复用 Express/Umi router metadata

拒绝。会把 cluster artifact 重新耦合到 2.x root/web framework，并且不能证明 middleware 注册、path normalization 与 Policy route 一一对应。

### 允许 wildcard 后按注册顺序选择

拒绝。新增 static route 可能被旧 wildcard 抢先匹配，使代码评审看到的 permission 与运行结果不同。

### 从 JSON body 提取 Project ID

拒绝。Policy 前读取 body 破坏两阶段 admission，也让攻击者先消耗解析内存。需要 Project scope 的 operation 必须把稳定 identity 放在 path 中。

## 影响

### 正向

- operation/permission/Project scope 从 handler 建议值提升为启动时验证的安全事实；
- 路由结果不依赖注册顺序或 URL 编码别名；
- 未知与畸形请求在认证和 body 读取前有界终结；
- registry package 入口不加载 legacy root、PostgreSQL migration DDL 或 Drizzle schema。

### 代价

- 动态插件不能直接向核心 `/api/v3` 注入任意 route；插件 action 必须经过独立 tool/action registry、Policy 和 manifest gate；
- 同一 operation 的多个 HTTP alias 需要不同 operation ID 或显式重构，不能共享一个模糊审计身份；
- 当前 ADR 只完成安全 registry 机制；后续 ADR-0049 已补齐真实 credential authenticator 与持久化 audit sink，但 production business route、credential 管理面和 audit retention/query 仍未完成。

## 验证

1. registry contract test 覆盖 immutable scope、handler parameter、伪造 registry 拒绝和 source mutation 隔离。
2. configuration test 覆盖 widened shape、重复 operation、static/parameter overlap、无效 Project parameter 和 route 数量硬上限。
3. request test 覆盖 percent traversal、重复/尾随 slash、反斜杠、unknown query、重复 query bound 与 control character。
4. admission test 证明未知 route 不调用 authenticator，伪造 resolver 在 assembly 时失败。
5. Node 22/24、公开入口 import closure、cluster dependency audit 与 GitNexus impact/detect-changes 继续作为门禁。
