# ADR-0175：私有认证 Local Model Price Catalog CLI

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-49、D-73、D-84、D-85、D-156、D-162、D-163、D-164、D-165；ADR-0085、ADR-0143、ADR-0167、ADR-0173、ADR-0174

## 背景

ADR-0174 已完成授权型 Model Price Catalog facade、双方言 9006 原子授权事实与
Profile 决策模式，但本机用户仍没有受审产品入口。若直接把 repository 暴露给脚本，
调用方就可以伪造 actor、Policy、assurance 或授权结果；若让常驻 edge runtime 或
`local-admin` 根入口静态导入 AI，则禁用 AI 的路由设备仍要支付模块加载和制品成本。

本机入口还存在两个真实竞态：

1. local-console 在事务外验证 credential 后，credential、pepper、User 或 Owner
   binding 可能在 catalog transaction 开始前被撤销；
2. 同一私有命令文件在进程退出或响应丢失后重试，会建立新的认证时间窗。若把该时间
   漂移当作 durable authorization 漂移，已经提交的命令无法安全收敛。

AI migration 是显式 feature stream。产品 CLI 不能为了“方便”在运行时自动执行
9001–9006 DDL，否则只读检查、低资源设备和生产变更控制都会失去边界。

## 决策

### 1. 复用现有短生命周期 CLI package

在现有 `@qinglong/local-owner-cli` 增加：

- 显式子路径 `@qinglong/local-owner-cli/model-price-command`；
- 二进制 `ql3-model-price`；
- `model-price.publish|activate|deactivate|revoke|inspect` 五种 operation。

不新增 workspace package、第三方依赖、daemon、listener、timer、watcher、缓存或数据库
连接。只增加 `local-owner-cli → @qinglong/ai` workspace 依赖；通用
`local-admin`、`cluster-admin`、默认 edge/standalone runtime 和基础制品不得反向导入
AI。命令执行完成后关闭单一 SQLite authority。

CLI 只接受：

```text
ql3-model-price run --command-file /absolute/private-command.json
```

命令文件必须是私有、规范化、有界绝对路径上的 exact-shape JSON。body 只能包含公开
intent、CAS fence、幂等 ID 和失败审计 event ID，不得包含 principal、subject、
authentication ID、assurance、Policy、decision mode、catalog/result digest 或任意
authority seam。输出只含 publication/head 与低敏授权摘要，不返回 credential、
principal 或认证 ID。

### 2. 显式 feature activation，运行时不执行 DDL

入口打开已经通过主 SQLite readiness 的数据库后，只读核对：

- 9001–9006 六条 AI migration history、stream identity 与 checksum；
- 11 张 Model Invocation/Price Catalog 业务表；
- 独立 `QingLong3AiSchemaMigrations` history 表。

任一缺失或漂移均以 `LOCAL_MODEL_INVOCATION_FEATURE_NOT_READY` 失败，并且在认证前停止。
CLI 不创建、修补或迁移 schema。部署者必须通过受审 feature activation ceremony 先行
执行 AI migration。

### 3. 本机强认证与平台 Owner 资格

所有 operation 复用 local-console POSIX/private-file proof、API credential、
credential-version pepper provenance 和 `local_console` assurance。请求不得指定 User。

edge/standalone 当前以 `default` Project 的最新 active `owner` binding 证明该本机 User
是产品平台 Owner。这个 binding 只作为本机 operator 资格证据，不把价格数据变成
Project-scoped 资源：catalog、Policy、authorization 和 resolver 中仍不存在 Project ID。
`inspect` 也要求当前 Owner，避免该管理入口成为普通本机 User 的旁路。

本机平台 Policy 固定为：

- revision `local_console_platform_owner_v1`；
- allow reason `local_console_confirmed`；
- decision mode `human_confirmation`。

Policy、assurance、principal 和 result digest 均由受信 composition 派生。

### 4. SQLite transaction 内二次围栏

`publishAuthorized`/`transitionAuthorized` 在取得 `BEGIN IMMEDIATE` 后、读取 replay 或
写入任何 catalog/authorization 行前调用同步 transaction hook。hook 在同一 connection
和 transaction 内精确复验：

- credential ID/version、active state、secret digest 与有效期；
- active User identity；
- credential-to-pepper binding、active/retired pepper state 与 material digest；
- `default` Project active 状态和该 User 最新 active Owner binding。

任一撤销、版本、摘要、时间或角色漂移都回滚 publication/head/authorization 全部写入。
进程时钟和事务外 `confirm()` 只用于早拒绝，不能代替数据库 fence。

### 5. 成功事实、失败审计与重放

成功 mutation 继续只由 9006 authorization 与 publication/head 在同一事务证明。
transport 不先写一条“成功 security audit”，避免双事务裂缝。

下列失败写入现有低敏 `QingLong3SecurityAuditEvents`：

- credential authentication rejection；
- credential/User/pepper transaction fence rejection；
- 当前平台 Owner 资格 rejection；
- Policy deny 或 quota deny。

审计只保存 caller 提供的独立 event ID、request/operation、nullable authenticated
subject/authentication ID、固定 outcome/reason 和本地时间；不保存 token、secret、
价格 body、stack 或 raw error。相同失败 event ID 的精确重放忽略观察时间差并收敛为
一条事实。

对于已提交 mutation，同一 authorization/request/catalog command、同一 User、同一
credential proof authentication ID、assurance、Policy 和 decision mode，可以在当前
transaction fence 再次通过后使用新的认证时间窗重放。repository 返回首次提交的不可变
authorization，不重写其时间或摘要；不同 User、authentication proof、Policy、ID 或
catalog command 仍然 conflict。

## 拒绝方案

1. **新增 `ql3-model-price-cli` package**：没有独立部署或权限边界，只会继续制造单文件
   package，拒绝。
2. **把 CLI 放进常驻 edge runtime**：会扩大默认导入闭包和攻击面，拒绝。
3. **由 CLI 自动运行 AI migration**：把产品调用升级为 DDL authority，拒绝。
4. **只做事务外 local-console confirm**：无法关闭撤权竞态，拒绝。
5. **把调用方 body 当作 Policy 或 User 来源**：可伪造授权，拒绝。
6. **把价格目录挂到 `default` Project**：全局 catalog 会形成虚假租户边界，拒绝；
   Owner binding 只证明本机 operator 资格。
7. **因新认证时间窗拒绝已提交重放**：会让响应丢失无法收敛，拒绝。
8. **用新认证覆盖首次授权事实**：会改写历史，拒绝。
9. **现在开放 Cluster CLI/HTTP**：尚无 TLS identity assertion、平台 Policy
   repository、耐久 quota 与双人 ceremony，拒绝。

## 当前证据

- `@qinglong/ai` 92 项：90 pass，2 条真实 PostgreSQL 条件 skip；新增 AI readiness、
  transaction hook 与 fresh-reauth replay 测试；
- `@qinglong/local-owner-cli` 16/16，覆盖 publish replay、activate、inspect、真实
  product binary、无敏感输出、未激活 schema、widened body、认证失败审计精确重放、
  过期强认证、precheck 后 credential revoke 和非 Owner rollback；
- 受影响 AI/local-sqlite/local-owner-console/local-owner-cli 均通过 TypeScript build；
- 22 个 QL3 package 已完成干净全量 build/test，0 fail；22-importer dependency audit
  覆盖 AI 20 个、Owner CLI 8 个源码文件且 `findings=[]`，edge 121-module import gate
  无 AI/cluster 越界；
- 默认 edge/standalone 仍为 3,910,465/3,910,525 bytes、478 files；显式
  edge-ai/standalone-ai 为 4,555,506/4,555,578 bytes、520 files。禁用态三个 Profile
  的 storage/provider/management loader 全为 0，模块加载 RSS 增量 475,136 bytes；
- PostgreSQL 18.4 arm64 physical HA 总门通过：9001–9006、11 张 AI 表和最小 ACL
  在 timeline 1→2 后一致，physical streaming、`remote_apply`、partition guard、
  fencing、promotion、`pg_rewind` rejoin 与全部 domain gate 为 true；临时 Docker
  资源已清理；
- workspace 仍为 22 个 QL3 package；没有新增第三方生产依赖或长期资源。

## 后续门禁

1. 独立、显式的 AI feature activation/deactivation 产品 ceremony（ADR-0176 已完成）；
2. 私有命令模板、operator 文档、备份/恢复和真实低配 Linux 设备证据；
3. Model Price Catalog mutation 专属 SQLite crash/COMMIT-response-loss 矩阵；
4. Cluster TLS/identity assertion、平台 Policy repository、耐久 quota、双人发布/激活
   ceremony 与 deny/unavailable audit；
5. Cluster 产品入口完成后重新运行 PostgreSQL 三角色 integration 与 physical HA 门。

## 后续状态

第 1 项已由 ADR-0176 完成：本机 9007 append-only active/inactive head、
`ql3-ai-feature`、migration plan/data-safety fence、Owner transaction fence 和
invocation/price 写事务内 active fence 已实现。其余门禁保持不变。
