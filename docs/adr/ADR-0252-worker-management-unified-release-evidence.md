# ADR-0252：Worker 管理统一 Release Evidence

- 状态：Accepted（聚合器、独立 source-aware auditor、测试与命令已实现；D-236/ADR-0253 已接入镜像发布门，生产报告待采集）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-229、D-230、D-232、D-234、D-235
- 关联 ADR：ADR-0245、ADR-0246、ADR-0248、ADR-0250、ADR-0251

## 背景

D-229、D-230、D-232 v2 与 D-234 分别证明 external OIDC 双人 ceremony、PostgreSQL durable audit、同 issuer
证书吊销和 client CA rollover。但四份报告各自通过并不自动证明它们属于同一发布边界。人工核对容易遗漏：

- durable、PKI 或 CA report 引用了另一份 ceremony；
- D-232 与 D-234 使用不同 operator、endpoint、server trust 或 inspect command；
- 两份 Kubernetes 证据来自不同 cluster、collector 或 Deployment；
- 最终汇总只复制 `gates.passed=true`，没有重新验证 source 文件与摘要链；
- 旧的 D-232 v1 被混入发布归档，重新引入 server/client PKI 耦合。

## 决策

1. 新增 repository-level、只读 `worker-management-release-evidence@v1` 聚合器。输入固定为 D-229 ceremony、
   D-230 durable audit、D-232 v2 PKI rotation 和 D-234 CA rollover 四份 canonical owner-private 报告，以及一个
   尚不存在的输出路径；不接受目录扫描、glob、网络 URL 或可选报告。
2. 聚合前必须调用四个原始 validator。任一 source schema/fixture/gate 不兼容即失败；D-232 v1 明确不接受。
3. 重新计算四份文件原始 SHA-256，并验证 durable→ceremony、PKI→ceremony/durable、CA rollover→ceremony/durable
   的既有摘要链。最终 source section 保存四个文件摘要和四个 exact fixture。
4. durable state 必须与 ceremony 的 action/project、plan/preview digest、requester/reviewer subject 完全一致；
   D-232/D-234 必须来自同一 external issuer/profile、同一 operator subject，且该 subject 是已审 requester 或
   reviewer。
5. D-232 与 D-234 必须绑定同一 management endpoint、servername、server trust bundle 和 inspect command，
   并绑定同一 cluster server、collector subject 与 Deployment UID。两种证据可以处于不同受审时间窗口；不要求
   D-232 两代 generation 与 D-234 三代 generation 互相连续或排序，因为 CRL leaf revocation 与 CA rollover 是
   正交操作，但每份 source 内部的代际单调与 Pod 全替换必须继续成立。
6. 聚合报告只保留 source/identity/transport/deployment 域分离摘要、generation 和布尔 control，不包含原始
   assertion、certificate、CRL、key、Kubeconfig/token、Secret/DSN 或基础设施原始 identity。输出为 `0600`
   no-replace 并 fsync；source 报告仍须随最终报告共同归档。
7. 独立 auditor 不能只接受最终报告。它必须同时接收最终报告与四份 source，重新运行四个 validator、复算摘要、
   重建期望 release report，并要求 canonical JSON 完全一致。改变 final gate、source 文件或交叉绑定字段都会失败。
8. 聚合器/auditor 不访问集群、数据库、IdP 或 PKI，不修改任何外部状态，不新增 workspace package、依赖、
   migration、daemon、controller、timer、watcher、listener、Pool 或连接；不进入 Edge/Standalone/Worker artifact。

## 失败与恢复

- source 文件权限、owner、symlink、大小或 UTF-8/JSON 不合法：不读取后续 authority，不创建 output；
- source validator、摘要链、review state、operator、transport 或 Deployment 绑定失败：修复或重新采集原始报告，
  禁止手工修改 release JSON；
- output 已存在：no-replace 失败，operator 必须选择新的审计路径，不能覆盖历史发布证据；
- auditor 找不到任一 source：发布门失败；最终 report 不是四份 source 的替代品；
- source report observedAt 顺序不可能，或 release observedAt 早于任一 source：拒绝时间倒置；
- 生产环境尚未完成四份真实报告时，只能声明实现门通过，不能声明 production release evidence 已取得。

## 被拒绝的替代方案

### 只聚合四个 `passed` 布尔值

拒绝。布尔值无法证明文件内容、摘要引用、operator、transport 或 Deployment 一致，也无法发现替换 source。

### 把四份报告内容全部嵌入最终 JSON

拒绝。它会复制审计材料、扩大低敏报告体积和 schema 耦合；摘要引用加 source-aware auditor可以保留单一事实来源。

### 要求 D-232 与 D-234 generation 全局连续

拒绝。两个协议证明不同控制，可能在不同维护窗口执行。强行连续会制造无安全价值的顺序依赖；共同 Deployment
UID/cluster/collector 与各自内部完整 rollout 已提供正确作用域证明。

### 新建 release-evidence package 或常驻服务

拒绝。该能力只在发布归档时短期运行；新 package 会加剧 `packages/` 碎片，常驻服务会给低配设备增加零收益成本。

## 验证

- 聚合 runner/source-aware auditor 定向 7/7：完整 happy path、摘要链断裂、operator/transport/Deployment 漂移、
  source false gate、final extra/false/sensitive/claimed drift、时间倒置和 exact CLI；
- happy path 的独立进程 auditor 同时读取 final + 四份 source 并返回 `compatible=true`；
- D-232 v2 9/9 和 D-234 8/8 保持通过；
- 顶层提供 `evidence:worker-management-release:ql3` 与 `audit:worker-management-release:ql3`；
- D-236 另以 `gate:worker-management-release:ql3` 在受保护 JIT runner 内重判 source 并执行 24 小时 freshness 门；
- workspace 保持 19 个 QL3 package，无新第三方依赖或 Profile 稳态资源。
