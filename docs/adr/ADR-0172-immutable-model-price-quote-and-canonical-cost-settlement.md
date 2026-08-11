# ADR-0172：不可变 Model Price Quote 与 Canonical Cost Settlement

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-12、D-13、D-157、D-160、D-161、D-162；ADR-0167、ADR-0168、ADR-0170、ADR-0171

## 背景

ADR-0170/0171 已经建立不可变 usage ledger 与 provider I/O 前的 Project quota
reservation，但费用仍有三个未封闭的权威裂缝：

- provider 返回的 `usage.costMicros` 既不可验证，也可能缺失、使用不同币种或被 adapter
  错误换算；
- model policy 的人工 `maxCostMicros` 只能作为上限，不能证明调用使用了哪一版价格；
- 价格变化后，如果只保存 model 和最终费用，就无法按历史 revision 重算、审计或精确重放；
- Cluster 多副本可能在一次调用期间观察到不同价格，本机重启也可能丢失当时的计价输入；
- 为价格目录、报价和结算各拆 package/service 会放大路由设备的 importer、制品与运维成本，
  却没有独立部署或权限收益。

## 决策

### 1. Policy 必须选择一个精确、不可变的价格 revision

`ModelInvocationPolicy.priceRevision` 与 provider/model 共同选择
`qinglong/model-price-catalog-entry@v1`。条目固定：

- `USD`；
- 每百万 input/output token 的整数 micro-USD rate；
- publisher time 与内容摘要；
- provider、model、price revision 的精确身份。

启用单次费用上限或 Project cost quota 时，`priceRevision` 和精确 catalog entry 都是必需
条件；缺失必须在 provider I/O 前失败关闭。无费用约束且 `priceRevision=null` 的调用继续
允许 usage cost 为 nullable，不强迫所有部署启用计价。

当前 catalog 是有界、注入式 `ModelPriceCatalogResolver`。它冻结运行时消费契约，但不
宣称已经完成数据库 catalog、签名发布、激活、撤销或管理 UI；这些运营能力必须另行建立
权限和发布协议。

### 2. Provider I/O 前生成不可变最坏情况 Quote

Gateway 在 durable admission 前生成
`qinglong/model-invocation-price-quote@v1`。Quote 绑定 invocation、Project、model policy
revision、provider/model、price revision、币种、input/output rate、catalog digest、
token 上限与独立 digest。

费用预留按 `maxTotalTokens` 和 `maxOutputTokens` 中合法且最昂贵的 input/output 分配计算，
不能用调用方估计值。每个 token 维度分别向上取整到整数 micro-USD，并用 `BigInt` 做中间
运算；越界失败关闭。Quote 的 `reservedCostMicros` 同时是单次费用 fence 和 Project
cost quota reservation 的权威输入，替代人工复制的 reservation 数值。

### 3. Provider 报价不是账单权威

provider 返回 usage 后，Gateway 只信任经过既有上限校验的 input/output/total token。
`usage.costMicros` 无论是 null、错误还是任意值，都由 Quote 重新计算的 canonical cost
替换。返回给调用方、Completion、UsageLedger、QuotaSettlement 使用同一个 canonical
usage。

`qinglong/model-invocation-price-settlement@v1` 绑定 Quote digest、Completion digest、
精确 token、canonical cost、settled time 与独立 digest。usage 缺失时不得创建零费用
Settlement；unknown outcome 保留 Quote 和 quota reservation，但不伪造价格结算。

### 4. Quote 与 Settlement 进入既有原子事务

准入事务原子提交：

1. `StepRun ready → running`、Run/Event/Mutation；
2. ModelInvocationStart；
3. PriceQuote；
4. 可选 QuotaReservation。

完成事务原子提交：

1. terminal StepRun/Run/Event/Mutation；
2. Completion；
3. 可选 UsageLedger；
4. usage 存在时的 PriceSettlement；
5. 可选 QuotaSettlement。

exact replay 必须复验全部预期事实；Quote/Settlement 缺失、意外存在、digest 或字段漂移均
失败关闭。持久化 JSON 的一致性比较按字段进行，不依赖 SQLite TEXT 或 PostgreSQL JSONB
的对象键顺序。

### 5. 9004 保持可选、append-only 和双方言一致

不改写 9001/9002/9003。新增：

- SQLite `9004-ai-model-pricing-snapshots`；
- PostgreSQL `pg-9004-ai-model-pricing-snapshots`；
- PriceQuote/PriceSettlement 两张双方言表。

PostgreSQL `ql3_runtime` 只有 `SELECT, INSERT`，没有 `UPDATE, DELETE`；其它业务角色与
PUBLIC 不获得权限。Quote 与 Settlement 不是第二状态机，StepRun 仍是执行权威。

### 6. 不新增 package、依赖或后台服务

价格 contract、resolver 和计算留在已有 `@qinglong/ai/pricing`；Gateway、coordinator、
repository 与 Profile 复用现有 AI package。没有新增 workspace package或第三方依赖。

AI 禁用时不解析 catalog、不执行 9001–9004、不加载 provider/credential/storage，也不
创建 timer。edge/standalone 只在显式启用 AI 时把该模块纳入制品；Cluster 可注入未来的
数据库/配置发布 resolver，但不能把价格管理 authority 放进常驻 runtime。

本 ADR 不开放 HTTP/MCP/UI，也不把静态 resolver 解释为产品级价格目录管理。

## 被否决方案

1. 直接信任 provider `usage.costMicros`：来源、币种、revision 与舍入不可验证。
2. 只保存最终费用：价格变更后不能历史重算或证明计价输入。
3. 调用完成后读取最新价格：一次调用可能跨 revision，Cluster 副本会产生不同结果。
4. 用浮点美元计价：序列化与舍入会产生跨运行时漂移。
5. 把 unknown usage 结算为零：允许预算绕过并伪造账单事实。
6. 为 pricing 新建 workspace package/service：没有独立部署、依赖或权限边界，只会增加
   路由器制品、lockfile importer 和 CI 成本。
7. 立即把 catalog 管理写入 runtime 表：会把运营写 authority 与调用 runtime 合并。

## 当前验证

- `@qinglong/ai`：70 项测试，69 pass、1 条 PostgreSQL 条件 skip；真实 PostgreSQL 18
  migration/runtime 分角色集成另 1 pass；
- SQLite 覆盖 exact revision、最坏情况 Quote、provider cost 覆盖、PriceSettlement、
  quota 原子提交、exact replay，以及 priced unknown recovery 保留 Quote/全额 reservation
  且不创建 Settlement；
- PostgreSQL 真实集成覆盖 JSONB 回读、9004 DDL/ACL、Quote/Completion/Ledger/
  PriceSettlement/QuotaSettlement 同一事务；
- SQLite 9004 checksum 为
  `572e37d2f44df43a50b51a07c1b4b0bb87fbb22e9cafbd3421ec7ab250036951`；
  PostgreSQL 9004 checksum 为
  `d38b12c2640fdd9fe21dc43a4743fb3480c988fa0a87e210fd81074d87569d2f`；
- QL3 22 个 package importer 的完整拓扑 build/test 退出 0；dependency audit 覆盖
  `@qinglong/ai` 16 个源码文件且 `findings=[]`；
- edge-ai 为 4,363,769 bytes/512 files/41 loaded modules，standalone-ai 为
  4,363,841 bytes/512 files/41 modules，均低于 5 MiB/640 files；disabled AI 只加载
  1 个模块、RSS 增量 425,984 bytes，三种 Profile 的 storage/provider loader 均为 0；
- PostgreSQL 18.4 arm64 physical HA 在 timeline 1→2 promotion 前后精确复验八张
  `ql3_ai` 表、9001–9004 history/checksum 和八表 runtime append-only ACL；
  `optionalAiFeatureSchemaSurvivesPromotion=true` 且总 `passed=true`。

## 后续门禁

1. 建立签名或受权限保护的 durable catalog publisher、activation/revoke 与配置 ceremony；
2. 明确非 USD 币种、汇率 revision、cached-input/批处理等 provider-specific 计价维度；
3. 增加 Quote/Settlement 数据行级 COMMIT-response-loss、promotion 与并发 revision 切换
   fault，而不只验证 schema promotion；
4. 完成认证、Project Policy、rate limit、低敏 audit 的 pricing/usage/quota API、CLI/UI；
5. 完成不可变 rollup、coverage receipt、retention 和磁盘耗尽证据。
