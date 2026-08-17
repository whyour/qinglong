# ADR-0439：确定性私有证据收据与 Release-set 重放

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-335、D-336、D-346、D-347
- 关联 ADR：ADR-0427、ADR-0428、ADR-0430、ADR-0438
- Supersedes：ADR-0438 的 `qinglong/private-release-evidence-receipt@v1` 与 `qinglong/release-set@v2` 聚合版本

## 上下文

ADR-0438 把 Worker management 与 CloudNativePG disaster-recovery 私有报告投影为 content-free 收据，并将两份收据纳入 durable
release-set。v1 收据同时持久化 `observedAt` 和私有 job 实际运行时的 `validatedAt`。后者来自 runner wall-clock，不属于不可变 source
evidence。

因此，同一 tag、同一 source revision、同一报告与同一静态 lock 只要在不同时间重跑，就会产生不同 receipt digest、release-set digest 和 OCI
catalog manifest digest。这与 catalog plan 已冻结的 `republish_same_content_then_verify_digest` 恢复语义矛盾：一次合法的 workflow response-loss
恢复可能生成第二个 release identity，甚至让无 authority 的 discovery tag 指向不同内容。

## 决策

1. 私有收据升级为 `qinglong/private-release-evidence-receipt@v2`，`schemaVersion=2`。收据继续绑定报告自身的 `observedAt`、24 小时最大年龄、
   report digest、release identity、evidence kind、静态审计摘要和 self digest，但不持久化 runner validation wall-clock。
2. 创建路径仍必须取得当前私有 runner 时钟，并由既有 source-aware gate 以及 receipt assembler 双重验证：报告不得超过 24 小时，最多只允许五分钟
   未来时钟偏差。移除 durable clock 绝不等于移除 freshness gate。
3. 收据显式声明 `freshnessValidatedAtCreation=true` 与 `durableValidationClockPublished=false`。公开消费者可验证结构、source/report equality 和
   digest 闭包，但仍必须保持 `publicConsumerReplay=not_possible_without_private_reports`，不能把布尔声明冒充现场重放。
4. 相同 release identity、相同私有报告字节和相同 source-controlled static locks，无论私有 job 在有效窗口内何时重跑，必须生成逐字节相同的
   receipt。报告自身使用 owner-private、mode `0600`、commit-scoped、no-replace 发布路径；不同报告 digest 不是同一次恢复输入。
5. release-set 升级为 `qinglong/release-set@v3`，OCI artifact/file media type 同步升级为
   `application/vnd.qinglong.release-set.v3+json`。不能在 v2 release-set 或 media type 下静默替换嵌入收据的 schema 与字段。
6. catalog recovery 语义收紧为 `republish_deterministic_content_then_verify_digest`：只允许相同 source evidence 的确定性内容重发并回读同一 digest；
   source/report/static-lock 发生变化时必须作为新输入失败关闭，不能解释为同一发布的 response-loss replay。
7. 不新增 package、production dependency、数据库、migration、Pod、controller、listener、timer、设备工具或稳态资源。变化只影响短生命周期
   release runner 的 JSON 字段和 SHA-256；Local scope 仍为零私有收据。

## 失败与恢复

- 当前时钟超出 freshness window：创建在写文件前失败；不得因 durable JSON 不含 wall-clock 而放宽。
- 同一 source report 重跑：v2 收据、v3 release-set、catalog plan 与 manifest 内容必须逐字节一致，可安全重发并验证同 digest。
- 同一 source 路径内容被替换：私有 no-replace/stable descriptor 边界或 report digest 闭包失败；不能覆盖既有发布身份。
- v1 receipt、v2 release-set 或 v2 media type：3.0 尚未正式发布，不做隐式迁移；从原始私有证据重新运行受保护 release workflow。
- 历史 catalog consumer：只接受 v3 release-set；不会把 v1/v2 解释成当前 schema。

## 部署与资源影响

- Edge/Standalone 设备下载的仍是一个 Local image digest 和小型 selection；不安装证据工具，不增加常驻 CPU/RSS、I/O 或连接。
- Cluster 节点仍只消费 catalog-bound image references；确定性发生在发布工作站，不引入 Kubernetes workload 或运行期控制面。
- v2 收据比 v1 少一个时间字符串，并增加两个固定 boolean；差异不改变制品预算或包拓扑。

## 被拒绝的替代方案

### 保留 `validatedAt` 并允许重跑产生新 catalog

拒绝。同一不可变 release source 将拥有多个仅由 runner 时钟区分的 durable identity，response-loss 无法与新发布区分。

### 把 `validatedAt` 固定为 `observedAt`

拒绝。两个字段相同会伪称验证与观察发生在同一时刻。删除未发布的 ephemeral clock，并明确声明其未持久化，更符合证据强度。

### 删除 freshness 检查以换取确定性

拒绝。确定性只约束 durable projection；私有创建仍必须以当前时钟重放 source-aware gate。

### 保持 release-set v2 与 OCI v2 media type

拒绝。嵌入对象从 receipt v1 变为 v2 是消费者可观察的协议变化，复用旧 schema/media type 会隐藏不兼容语义。

## 验证

- receipt contract 必须证明相同报告在两个不同有效 validation clock 下生成相同对象和相同 canonical bytes，并拒绝重新注入 `validatedAt`；
- 既有 source/scope/report/static-lock/self-digest、私有字段、mode `0600`、stable read 与 no-replace 负向门全部保留；
- release-set、catalog、consumption、deployment-lock 与 workflow 审计必须只接受 receipt v2、release-set v3 和 OCI v3 media type；
- 定向发布链 135/135，完整 backend 1,363 项为 1,361 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0，12 项静态审计与 14 档
  Local artifact 均 compatible 且制品字节基线不变；PostgreSQL 18.6 arm64 HA 为 142/142、timeline `1→2`，独立报告审计 compatible，且
  Docker container/network/volume 零残留；
- 完整测试、制品与运行门结果记录于 QL-RFC-0001 D-347；首份真实线上重放仍须由受保护 `v3` release tag 产生。
