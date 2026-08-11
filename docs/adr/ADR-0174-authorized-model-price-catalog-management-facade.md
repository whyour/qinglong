# ADR-0174：授权型 Model Price Catalog 管理 facade

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-49、D-73、D-84、D-85、D-156、D-162、D-163、D-164；ADR-0142、ADR-0143、ADR-0144、ADR-0145、ADR-0173

## 背景

ADR-0173 已把价格目录冻结为不可变 publication 和 append-only generation head，
但低层 repository 仍要求调用方直接填写 `publishedByUserId`/
`changedByUserId`。这足以证明数据来源字段，却不足以证明：

1. actor 是仍有效且最近完成强认证的稳定 User；
2. 一个受信平台 Policy 确实允许本次全局价格配置 mutation；
3. cluster 的发布者没有自行激活自己的价格；
4. rate-limit/quota 使用稳定幂等键；
5. 授权事实和 publication/head 在崩溃、并发与 COMMIT response loss 下同成同败。

价格目录是跨 Project 的基础设施配置。把它绑定到任意 Project 的
`project.manage` 会制造虚假的租户边界；把它放进 provider credential authority
又会把 Secret 生命周期与计价权威合并。

同时，`local-admin` 是默认本机产品闭包的一部分，`cluster-admin` 还承载通用集群
管理任务。让这两个包静态依赖可选 `@qinglong/ai`，会使禁用 AI 的路由设备和管理
镜像仍安装 AI，违反 D-156 的零成本关闭语义。

## 决策

### 1. 管理服务留在现有 AI 能力边界

新增 `@qinglong/ai/price-catalog-management`，不新增 workspace package、生产依赖、
进程、timer、watcher、缓存或数据库连接。它只组合：

- `ModelPriceCatalogAuthorizedAdministrationRepository`；
- 显式注入的 platform-level authorizer；
- 可选、调用方驱动且以 authorization ID 幂等的 quota port；
- profile 决策模式。

通用 `local-admin`/`cluster-admin` 不反向依赖 AI。后续产品 transport 必须只在 AI
显式启用的短生命周期 composition root 中惰性装配现有认证、私有 command-file 或
HTTPS transport port。

现有 `@qinglong/ai/profile` 同时提供管理 capability 的禁用优先 composition root，
不再拆分新包。禁用态不调用 authority loader；edge/standalone 固定
`human_confirmation`，cluster 固定 `separation_of_duty` 且缺 quota authority 时
启动失败关闭。停止时先撤销新 mutation admission，再等待在途 mutation drain，最后
释放 authority。

### 2. 身份与 Policy

管理 mutation 只接受稳定 `User`，assurance 必须是 `local_console`、
`multi_factor` 或 `hardware`，且数据库观察提交时距认证不超过五分钟并早于
principal expiry。User ID 从 principal 派生，HTTP/CLI body 不得覆盖。

authorizer 返回 domain-separated、digest-bound 的 allow/deny decision，固定绑定
platform policy revision 与有界 reasons。该 Policy 是平台级 authority，不伪装为
某个 Project 的角色绑定。

### 3. Profile 决策模式

- edge/standalone 使用 `human_confirmation`，允许同一强认证 Owner/User 发布并在
  独立 mutation 中激活；
- cluster 使用 `separation_of_duty`。`activate` 的 User 必须不同于目标
  publication 的 publisher；
- `deactivate` 和 `revoke` 是收敛风险的操作，不要求与发布者不同，但仍必须通过强
  认证、Policy、quota 与 expected-generation/head fence。

职责分离在 service 预检查一次，并在 repository transaction 内从不可变 publication
authorization 再检查一次，不能由自定义调用方绕过。

### 4. 9006 授权事实

不修改 9001–9005。独立双方言 migration：

- `9006-ai-model-price-catalog-authorizations`；
- `pg-9006-ai-model-price-catalog-authorizations`。

新增单张 append-only authorization 表。每条事实固定绑定：

- authorization/request ID 和操作；
- provider/model/nullable revision；
- catalog command digest；
- publication digest 或 head digest（二选一外键）；
- User、authentication ID/assurance/lifetime；
- Policy revision/decision digest/reasons；
- decision mode、数据库提交时间和 authorization digest。

`publishAuthorized`/`transitionAuthorized` 必须在原 publication/head 事务内插入授权
事实。catalog command digest、result digest、authorization command digest 均唯一；
精确重放返回同一事实，任一 ID 或语义漂移冲突。已有低层 raw mutation 如果没有
authorization，不得由新入口事后补写“授权”；旧 publication 若需启用，必须使用新
revision 经正式 ceremony 重新发布。激活还要求目标 publication 已有 publish
authorization。

PostgreSQL `ql3_admin` 只获得授权表 `SELECT/INSERT`；runtime、PUBLIC 与其它业务
角色无权，任何角色都没有 `UPDATE/DELETE`。runtime 解析价格仍只读取 9005 的 active
publication/head，不加载授权 JSON。

### 5. 失败语义

- 弱、过期或非 User principal：authentication error；
- Policy deny：authorization error；
- authorizer/quota 不可用：unavailable，且目录 mutation 为零；
- quota 超额：保留有界 retry-after；
- 同人 cluster 激活：separation-of-duty error；
- raw publication、缺失授权事实、stale generation/head、摘要漂移或并发输家：
  conflict；
- 数据库在实际提交前再次验证 principal lifetime，进程时钟的预检查不能替代数据库
  事实。

认证失败、Policy deny、quota deny 的 transport-level 审计仍由后续产品入口完成；
本 ADR 只把成功授权事实与业务 mutation 原子化，不能据此宣称 HTTP/CLI/UI 已开放。

## 拒绝方案

1. **把价格目录当成某个 Project 的配置**：共享价格会被虚假租户 fence 控制，拒绝。
2. **只信任 body 中的 User ID**：不能证明认证与 Policy，拒绝。
3. **先写通用 security audit，再写 catalog**：两个事务留下审计与 mutation 裂缝，
   拒绝。
4. **在 9005 原表加列**：破坏已发布 checksum 和 migration 历史，拒绝。
5. **允许 raw publication 后补 authorization**：会把事后批准伪装成原子授权，拒绝。
6. **cluster 发布者自行激活**：价格配置缺少独立复核，拒绝。
7. **让 local-admin/cluster-admin 静态依赖 AI**：污染禁用闭包和低资源部署，拒绝。
8. **为管理 facade 新拆 package/service**：没有独立部署收益并增加运维成本，拒绝。

## 当前证据

- AI 全量 89 项：87 pass，2 条真实 PostgreSQL 条件 skip；新增 Profile 测试证明
  edge 禁用零 loader、standalone 惰性人工确认装配、cluster 缺 quota 失败关闭，以及
  cluster 固定职责分离；
- SQLite 已覆盖原子 publication/head/authorization、exact replay、authorization ID
  漂移、raw publication 拒绝、双层职责分离、FK 与 rollback；
- PostgreSQL 18 migration/admin/runtime 三角色专项测试覆盖 authorized publish、
  exact replay、双人 activation、授权读取、runtime deny 与 admin append-only ACL；
- 9001–9005 checksum 未变；9006 SQLite/PostgreSQL checksum 分别为
  `3ee48d1468569c9dc1fa9f04031a48a220161762d48eeac4cd924e2dcd7abd21` 和
  `486d46115e28e90604a47231fe95e3b1687649c063d93bf7ce267783f2a7165f`；
- 真实 PostgreSQL 专项目录测试 2/2 pass，Model Invocation 串行门另 1/1 pass。
- PostgreSQL 18.4 arm64 physical HA 门已证明 9001–9006 history/checksum、11 张
  `ql3_ai` 表及 9006 runtime deny/admin append-only/其它角色 deny ACL 在 timeline
  1→2 前后完全一致，`optionalAiFeatureSchemaSurvivesPromotion=true` 且总门通过；
- 22-importer dependency audit 覆盖 AI 20 个源码文件且 `findings=[]`，通用
  local-admin/cluster-admin 仍不依赖 AI；
- disabled benchmark 在 edge/standalone/cluster 的 storage/provider/management
  authority loader 均为 0，管理禁用启动最大 0.265 ms，模块加载 RSS 增量 425,984
  bytes；默认 edge/standalone 产物仍为 4 MB 以下、478 files 且不含 AI，显式
  edge-ai/standalone-ai 为约 4.54 MB、520 files，均通过各自门限。

## 后续门禁

1. 本机私有 command-file transport、local-console authentication 与失败审计；
2. Cluster TLS/identity assertion transport、平台 Policy repository、耐久 quota 与
   deny/unavailable 审计；
3. transport body 中不得接受 principal/Policy/result digest；
4. COMMIT response loss 注入覆盖 authorization 与 catalog result 的精确收敛。
