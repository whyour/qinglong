# ADR-0440：Release-set 闭合时私有证据 Freshness 重验证

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-335、D-346、D-347、D-348
- 关联 ADR：ADR-0427、ADR-0438、ADR-0439
- Extends：ADR-0439 的确定性私有证据收据与 release-set replay

## 上下文

ADR-0439 从私有证据收据中移除了 runner `validatedAt` wall-clock，使同一 release identity、私有报告和静态 lock 在合法 workflow 重跑时生成相同
receipt、release-set 与 catalog digest。创建私有收据时仍会用当前私有 runner 时钟执行 24 小时 freshness gate。

但 release-set job 可能在镜像构建、扫描、签名和 attestation 后才消费短期收据。D347 的聚合路径只验证 `observedAt` 可解析、receipt identity 和
self digest，没有在 tag promotion 前以闭合时钟重新计算年龄。GitHub artifact 的一天 retention 是存储配置，不是精确的证据 freshness authority；
收据在创建时有效，不代表在 release-set 闭合时仍有效。

## 决策

1. `cluster|all` release-set closure 必须取得一个 runner-owned、safe-integer validation clock。该时钟不是 release-set input field，也不能由 CLI
   参数、环境变量、image record 或私有 receipt 指定。
2. `inspectPrivateReleaseEvidenceReceipt` 在 closure caller 显式提供 validation clock 时，除 exact shape/source/report/self-digest 外，还必须用公开的
   `observedAt` 重新执行 24 小时最大年龄和五分钟未来偏差门。
3. release-set `aggregate` 与紧随其后的 source-record `audit` 各自从进程内当前时钟执行该门；缺失、非安全整数、过期或未来漂移均在写 release-set、
   tag promotion 和 catalog publication 前失败关闭。
4. validation clock 只参与准入，不进入 receipt、release-set、catalog plan、OCI manifest 或 digest。两个不同但都在有效窗口内的闭合时钟必须生成
   逐字节相同的 release-set。
5. `local` scope 必须保持零私有收据，closure freshness 为 `not_applicable`，不要求该时钟即可创建同一 Local release-set。
6. `inspectReleaseSet` 是历史 durable catalog 的 standalone verifier，不以当前日期淘汰曾经合法的发布。它继续验证结构、identity、image/receipt 顺序与
   self digest，并诚实声明 source records/private reports 未重放；当前年龄不能证明过去发布时的 freshness。
7. 不升级 receipt v2、release-set v3 或 OCI v3 media type，因为 durable bytes 和消费者结构没有变化；本 Gate 只收紧创建/审计时可接受的瞬时输入。

## 失败与恢复

- 收据在创建时有效、闭合时超过 24 小时：aggregate 在任何 durable 输出和 tag mutation 前失败，必须重新取得 source-aware 私有报告及其确定性收据。
- 收据时间超过闭合时钟五分钟：视为时钟/报告异常并失败，不能通过推迟发布等待其“自然有效”。
- aggregate response-loss 后以同一 source evidence 重跑：新的闭合时钟若仍在窗口内，生成相同 bytes；若已过期则必须重新取得私有证据，而不是复用旧收据。
- 历史 catalog 多年后验真：standalone inspection 仍可通过 structural/digest/provenance 链；不得声称重新执行了当年的私有 freshness gate。
- Local 发布：没有私有 evidence receipt，不执行 Cluster freshness 语义，也不新增设备或发布 runner 工作。

## 部署与资源影响

- Edge/Standalone 设备、Local image、selection 和 Compose 路径零变化，不安装发布工具，不增加 CPU/RSS、I/O、timer、listener 或 updater。
- Cluster 节点和 Kubernetes object 零变化；重验证只发生在短生命周期 release-set runner，成本为两次时间读取和两个时间戳的常数比较。
- 不新增 workspace package、生产依赖、数据库、migration、SQL、Pod、controller、RBAC、Secret、网络连接或持久状态。

## 被拒绝的替代方案

### 重新把 `validatedAt` 写入 receipt

拒绝。它会恢复 D347 已消除的 wall-clock digest 漂移，让合法 workflow retry 产生第二个 catalog identity。

### 依赖一天的 GitHub artifact retention

拒绝。retention 是删除上限，不保证下载瞬间的精确年龄、未来偏差或 tag promotion 前重验证，也不是 release contract 的可测试语义。

### 让 CLI 传入 `--validation-clock`

拒绝。发布者可选择旧时钟会把 freshness gate 变成自报事实。测试通过显式 dependency injection 驱动边界，生产 CLI 不开放该输入面。

### 在所有历史 catalog inspection 中按当前时间拒绝

拒绝。这样所有合法发布都会在 24 小时后不可审计，并把“当前仍新鲜”错误等同于“发布时曾通过 freshness gate”。

## 验证

- 同一 Cluster source evidence 在两个不同有效 closure clock 下生成对象和 canonical bytes 完全相同；
- 超过 24 小时、未来偏差和缺失 validation clock 均在 release-set 写入前失败；
- CLI production path 使用内部 clock，测试证明 stale retry 不产生输出；
- Local scope、历史 standalone inspection、catalog consumption 和 deployment lock 保持兼容；
- 定向发布链 137/137，完整 backend 1,365 项为 1,363 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0；
- 12 项静态审计和 14 档 Local artifact 全部 compatible，Edge/Standalone 至 MCP 的既有制品字节与 RSS 上限未漂移；
- PostgreSQL 18.6 arm64 physical HA 通过 142/142、timeline `1→2`，证据 SHA-256 为
  `7566a54f86f3e4e0fee2096a49ea2877d827595575c7075bc44b65314cb2ba19`，离线审计 compatible 且 Docker 资源零残留；
- 完整证据记录于 QL-RFC-0001 D-348；首份真实线上 closure 仍须由受保护 `v3` release tag 产生。
