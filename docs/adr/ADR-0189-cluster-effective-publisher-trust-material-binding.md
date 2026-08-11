# ADR-0189：Cluster Effective Publisher Trust Material Binding

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-175、D-177、D-178、D-179；
  ADR-0185、ADR-0187、ADR-0188

## 背景

ADR-0188 已将 Cluster publisher trust 的有效代际保存在 PostgreSQL，并明确挂载文件只用于
初始化 base snapshot。但 recovery 进程仍直接用挂载文件中的全部 PEM 构造
`PluginPackagePublisherTrustRegistry`。这会形成控制面与执行面的 authority 分裂：

- operator 为 overlap rotation 预先分发 old+new ConfigMap 时，new key 会在 Approved
  Action 推进 effective head 前被 recovery 信任；
- 数据库已经撤销或退役 key 后，旧 Pod/旧挂载仍可能继续把该 key 当作 verifier material；
- 管理面比较 base snapshot 不能约束独立使用 Package-executor credential 的 recovery Job。

必须先关闭这个缺口，才能安全实现正常 overlap-add 与 retirement。

## 决策

### 1. 文件是 material，PostgreSQL head 是 authority

publisher trust 文件继续保存公开的 Ed25519 PEM、publisher、key ID 和 lifetime。读取器对
文件大小、regular-file、只读权限、exact JSON shape 和全部 key 定义执行既有严格验证。

运行时新增纯绑定函数：

1. 从全部文件定义构造 canonical low-sensitive material snapshot；
2. 规范化 PostgreSQL 返回的 effective snapshot；
3. 对每个 effective key 精确匹配 publisher、key ID、public-key digest、not-before 和
   not-after；
4. 只用匹配成功的定义构造 verifier registry；
5. effective key 缺材料、PEM 被替换、lifetime 漂移或 effective set 为空时失败关闭。

文件可以是 effective set 的真超集，因此允许先分发候选 key；额外 key 不进入 verifier。

### 2. stage authority 在数据库就绪后创建

`recoverClusterPluginPackages` 支持二选一：

- 调用方提供已构造的 `stageAuthority`；
- 调用方提供 `stageAuthorityFactory(pool)`。

两者必须且只能存在一个。factory 只在 Package-executor 数据库资源完成 schema/readiness
检查后调用；返回值立即执行同一 stage/verify contract 检查，并只在本次 recovery 周期内
使用。数据库仍由既有 one-shot composition 统一关闭，factory 不建立第二个 pool，也不让
repository 或 stage authority 逃逸。

生产 recovery 使用 factory：

1. 读取显式 `QL3_PLUGIN_PACKAGE_TRUST_AUTHORITY_ID`，默认 reviewed `cluster`；
2. 用现有只读 trust repository 查询 head 与 effective snapshot；
3. 将挂载 material 绑定为 effective registry；
4. 再构造 OCI stage authority。

因此 trust 查询、provenance recovery、stage 和 activation 共享一个最多 1 连接的
Package-executor pool，适合低资源单节点，也适合 HA writer endpoint。

### 3. 失败边界

以下状态必须在 OCI fetch、签名验证、Kubernetes 写入前失败：

- authority head 不存在；
- effective snapshot 在文件中缺少 exact material；
- public-key digest 或 lifetime 与 durable snapshot 不一致；
- 文件权限、大小、shape 或 key 类型不合法；
- database-bound factory 返回不完整 authority。

显式测试注入的 registry/stage authority 保留，用于无网络、无数据库的确定性测试；产品
部署不能通过环境变量选择绕过 durable head 的 registry。

### 4. 与 rotation/retirement 的关系

本 ADR 不新增 trust transition：

- overlap-add 后续采用 `old+new material` 预分发，再由受批 executor 推进 effective
  `old → old+new`；
- retirement 后续采用 durable impact proof 与 generation fence 推进
  `old+new → new`，随后才允许从文件清理 old material；
- emergency revoke 继续使用 ADR-0188 的 receipt/impact/quarantine 链。

正常 retirement 不能仅靠本次 recovery 启动时的 snapshot；后续 transition 必须在
provenance 写入和 head 推进处增加并发 fence。

## 包与资源边界

不新增 workspace package、migration 或生产依赖：

- `runtime-core` 保存纯 material/effective 绑定；
- `cluster-postgres` 复用现有 Package-executor 可读 trust repository；
- `cluster-admin` 在现有 recovery composition 内延迟构造 stage authority。

workspace 保持 22 包。没有新增 listener、timer、watcher、Service 或常驻 Pod；recovery
仍是显式 one-shot Job，数据库 pool 仍为 1 个连接。

## 不采用方案

### 文件 digest 必须等于 effective digest

这会禁止 old+new 候选材料预分发，并迫使 ConfigMap 更新与数据库审批形成不可实现的跨介质
原子提交。

### management 把 effective registry 推送给 executor

会把短生命周期 executor 依赖于管理进程可用性，并增加新的网络协议、身份和缓存一致性问题。

### recovery 启动前单独打开第二个数据库 pool

会增加低配设备连接开销，并让 trust 读取与实际 recovery 使用不同资源生命周期。

### 为 material binding 新拆 package

没有独立 Profile、credential、制品或第三方依赖边界，会违反 ADR-0185 的 package
收敛原则。

## 验收

- runtime-core 测试证明候选 key 被排除、exact durable key 可用、同 identity 替换 PEM
  失败关闭；
- recovery composition 测试证明 factory 只在 readiness 后接收同一 pool，且数据库仍精确
  关闭一次；
- Package recovery 配置与 base/CloudNativePG manifest 显式绑定 authority ID；
- 两套 Kustomize 渲染、deployment audit 与 dependency audit 无 finding；
- runtime-core 359/359；cluster-admin 111 pass、1 条真实 Kubernetes 条件 skip；
- PostgreSQL 18.4 arm64 physical HA 总门重跑 `gates.passed=true`，v38 Approved
  Action、trust generation `1→2`、quarantine exact-once、timeline `1→2`、旧主
  fence、`pg_rewind` 与同步只读重加入均无回归；
- workspace 仍为 22 包，无 migration、依赖或常驻资源增长。

## 后续

1. D-180 实现单 key overlap-add 与 safe-retire proposal/action。
2. retirement 在 signer provenance commit 与 trust-head transition 间增加 generation fence。
3. HA 门增加 old+new material 预分发、批准前拒绝、批准后接受和旧 key 安全退役证据。
