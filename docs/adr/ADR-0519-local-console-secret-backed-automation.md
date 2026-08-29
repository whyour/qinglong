# ADR-0519：Local Console Secret-backed 自动化

- 状态：Accepted（源码候选；阶段产物待远端门闭合）
- 日期：2026-08-29
- 对应 RFC 切片：D-424
- 关联：ADR-0069、ADR-0071、ADR-0512、ADR-0516、ADR-0517、ADR-0518

## 背景

D-423 已让部署者在 Local Console 创建 command Task 并配置 cron Trigger，但需要凭据的自动化仍只能借助受信 CLI。QingLong 3.0 已有 AES-256-GCM Secret custody、immutable version、pinned `SecretRef`、Task execution-time materialization 和 durable audit；缺口是一个不会暴露明文或复制密钥 authority 的有界产品入口。

该入口必须同时适配小路由设备和普通单节点：默认 headless 不承担 Console/API 成本，opt-in Console 不增加连接、迁移或后台生命周期。Cluster 必须继续使用自己的共享 Secret custody 和 HA authority，不能复用 Local SQLite/POSIX proof。

## 决策

### 1. 列表只暴露当前版本元数据

新增固定路由：

```text
GET /api/v3/projects/:projectId/secrets
PUT /api/v3/projects/:projectId/secrets
```

GET 使用按名称排序的稳定 keyset；Edge 默认 16 条、Standalone 默认 32 条、硬上限 64 条。每个名称只返回当前 version、创建时间和 canonical pinned `SecretRef`。响应不包含 plaintext、ciphertext、nonce、tag、key ID、mutation ID 或历史版本内容。

Fresh 与 adopted Profile 在既有数据库 close fence 上暴露只读 metadata source；不开第二个 SQLite connection，不新增 table、migration、cache、watcher 或 timer。损坏、关闭或越界查询均失败关闭。

### 2. Secret mutation 继续使用既有加密 authority

PUT body 精确包含 `name`、`plaintext`、`mutationId` 和 `expectedCurrentVersion`。请求只接受 User credential、`secret.manage` Policy 与绑定 exact plaintext digest、Project、credential ID/version、User subject 的两分钟一次性 owner-private proof。

proof 验证后再次确认 credential，并创建 request-scoped credential-fenced Secret repository。既有 Local administration service 在数据库事务外完成 AES-256-GCM 加密，在事务内重验 credential、Identity、RoleBinding、Policy 与 expected current version，再原子追加 immutable Secret version 和 durable audit。HTTP 只返回名称、当前版本、pinned reference 与幂等状态。

plaintext 仅在请求解析、proof 等待的页面内存与加密调用所需的短生命周期中存在；Console 在成功、取消、断开时清空输入和 pending body。它不进入 Cookie、Web Storage、URL、响应、audit 或日志。

### 3. Task 编辑器只保存 pinned SecretRef

Console 使用逐行 `ENV_NAME=secret-name[@version]` 绑定。省略 version 时只能从当前有界目录解析并立即固定为当前版本；显式历史版本不得大于目录中的当前版本。未知名称、未来版本、重复环境变量、`QL3_` 保留前缀和不安全格式均拒绝。

保存时保留完整 authoring snapshot 中未展示的 public environment 与其他 config/labels，只替换 Console 可识别的 Secret bindings。Task spec 只持久化 canonical `SecretRef`；执行时继续由既有 runtime materializer 解密，不把明文写回 Task、Run、Event 或 Console。

### 4. Profile 与部署边界不扩张

- 默认 Edge/Standalone headless 不开放 Secret HTTP/Console surface，不携带静态资产或 listener；常驻增量仅是复用现有 SQLite connection 的小型 metadata repository。
- `edge-application-api` 与 `standalone-application-api` 才装配 Secret metadata、presence 与 administration capability；仍是同一 Application 进程和数据库连接。
- `@qinglong/local-api` 仅允许 `src/secret/secretRoutes.ts` 导入 Local administration，Local Application contract 仅允许 runtime-core 的 metadata contract；Cluster dependency audit 对其他路径继续拒绝。
- Cluster 不使用 Local proof、keyring 或 SQLite authority。后续 Cluster Console Secret 管理必须走共享 custody、TLS、RBAC/Approval、PostgreSQL transaction 与 HA fence。

## 不采用的方案

- 不让浏览器读取、回显或下载 Secret 明文；轮换也只接受新值，不提供“显示现值”。
- 不把 ciphertext、key ID 或 mutation metadata 当作“低敏列表字段”；这些都留在 custody 边界内。
- 不把 Secret value 写入 Task environment、authoring lease、presence challenge 或 audit detail。
- 不用单因子 Bearer 直接创建或轮换 Secret；长期自动化凭据需要本机 presence 与 credential transaction fence。
- 不新建只有一两个文件的微包；该能力留在现有 runtime-core contract、Local SQLite repository、Local administration 和 Local API capability 内。
- 不为低配设备增加 Secret cache、后台清理器或独立进程。

## 结果与验证边界

定向测试覆盖 current-only metadata、稳定分页、关闭/越界失败、无 ciphertext/key 泄漏、exact presence、plaintext digest 漂移、宽化 body 拒绝、admission delegation、HTTP 路由与真实 SQLite/loopback 创建。集成旅程验证数据库只保存不含 plaintext 的密文，Task spec 保存精确 pinned `SecretRef`，并出现 `secret.create` 与 `secret.list` durable audit。

本地 18-package clean build/test 为 `3,052 total / 3,030 pass / 22 conditional、platform 或 external-service skip / 0 fail`，其中 Local SQLite `250/250`、Local API `76/76`、Local Admin `96/96`、Local Application `55 total / 51 pass / 4 platform skip / 0 fail`。package boundary 保持 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`；122-module Edge source import 与精确 Cluster dependency audit compatible。

三项 Console 静态资产合计 102,182 bytes，低于 192 KiB 总闭包与 96 KiB 单文件门。默认 Edge 为 2,760,847 bytes/332 files/3 packages/59 loaded modules，RSS delta 11,026,432 bytes；opt-in Edge/Standalone Console 为 4,210,024/4,210,168 bytes、482 files/12 packages/111 loaded modules，RSS delta 20,447,232/18,399,232 bytes，均低于既有门。Edge executor benchmark 继续通过。

这些证据只把 D-424 提升为可提交的源码候选。必须等待 exact source commit 的普通主 CI、Kubernetes deployment 和显式 Local Console 双架构 milestone 全绿，并下载复核 milestone checksum/auditor 后，才能把 D-424 称为新的阶段可用实物。在此之前，D-423 run `33245745837` 仍是最新可下载、可验真的 Console Trial Kit。
