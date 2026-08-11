# ADR-0367：单进程、受认证的 Local Run HTTP API

- 状态：Proposed（实现完成，固定物理设备证据待补）
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-45、D-46、D-49、D-52、D-175、D-257、D-269、D-278、D-279，ADR-0347、ADR-0366

## 背景

Local 3.0 已有完整 Run、API Credential、Project Policy、安全审计、Owner Pepper 和 MCP 只读纵向链路，但部署用户仍没有稳定的 `/api/v3` HTTP 产品入口。直接复用 Legacy Express 会延续 Controller/Model/service-locator 架构；把 HTTP 放进 MCP package 会把 MCP SDK/Zod 带入普通 API 制品；另起 sidecar 又会让低内存路由器承担第二个 Node 进程和第二个 SQLite authority。

该能力满足 D-278 对新 package 的严格例外：它是默认关闭、独立交付的网络 listener 与安全入口，不是为了整理目录而拆出的 projection/codec 微包。它必须形成完整单进程 Profile，而不是只有一条 route 的壳。

## 决策

1. 新增 `@qinglong/local-api` 组合根，发布 `ql3-local-api`。它在同一 Node 进程中启动现有 Local Application 和 HTTP listener，复用 Application 已打开的唯一 SQLite operation authority；不得启动 sidecar、第二个数据库连接、scheduler 或 watcher。
2. `@qinglong/local-application` 增加可选、依赖反转的 product-surface port。默认未注入时构建、导入、启动、资源和制品闭包不变；注入时只能取得 `runs/apiCredentials/ownerPepper/projectPolicy/securityAudit` 五个窄 authority。Application 恢复完成并启动 scheduler/execution lifecycle 后才开放 surface；停机先撤 listener admission 并 drain，再停 scheduler/execution，最后关闭 SQLite。
3. 首个且唯一 route 为 `GET /api/v3/projects/{projectId}/runs/{runId}`，operation/permission 固定为 `run.get`/`run.read`，与 Cluster API 同构。原始 path 必须是无 query、无 `%` 编码、无尾斜杠的 canonical ASCII；Project/Run ID 各最多 128 字符。任何 body、Transfer-Encoding 或非零 Content-Length 都在读取 body 前拒绝。
4. v1 listener 只允许 `127.0.0.1` 或 `::1`。远端访问必须由同机受管 TLS reverse proxy 终止；进程不信任 Forwarded/X-Forwarded-*，也不允许配置非 loopback 地址。LAN TLS、Unix socket 与代理身份绑定需要后续独立 ADR。
5. 每个请求必须执行 route resolution → exact Bearer credential → Project Policy → durable security audit → credential/pepper fence confirm → bounded Run read。认证不得缓存；撤销、版本、subject、有效期、secret digest、pepper key state/material digest 任一变化都在读取前失败关闭。
6. HTTP Run 响应复用 Runtime Core 的 `qinglong.run.get` 低敏投影并映射为 Cluster 同构 `{run}`；不存在和跨 Project 均为 404。request/ref/trigger/attempt、executor handle、错误摘要、Artifact/日志位置、Secret 和数据库 row 不出网。
7. transport 固定 header、URL、并发、请求时限、keep-alive、响应和 drain 上限。Edge 默认并发 4，Standalone 默认 32；超载在认证前拒绝，避免攻击者制造无界 credential/Policy/SQLite 队列。
8. workspace hard cap 由 17 提升到 18，仅授权这个完整 deployable/authority package。新增 route、projection、认证 helper 或 client 必须进入该 package 的领域目录，不能继续增加 importer。

## 不采用方案

- **Legacy `back` Express route**：继续绑定 2.x Sequelize/Controller 与共享服务定位器。
- **MCP package 内增加 HTTP**：普通 API 制品会安装无关 MCP SDK，协议和攻击面混合。
- **独立 Local API sidecar**：低配设备承担第二个 Node RSS 和 SQLite connection；与单进程目标冲突。
- **把 listener 放进 Owner Console/CLI**：把短生命周期高权限 ceremony 变成长驻网络 authority。
- **默认把 HTTP 编进 headless Application artifact**：所有路由器即使不用 API 也支付 flash/审计面成本。

## 完成门

- [x] canonical route、认证拒绝/不可用、Policy deny/approval/allow、audit failure、credential fence、cross-Project 404、损坏 Run、过载、body-before-auth 和 graceful drain 均有定向测试；
- [x] 真实 loopback HTTP + SQLite + API Credential + Pepper + Policy + durable Audit E2E；
- [x] headless Edge/Standalone 十二档现有 artifact 数字不回归；新增 API Profile 有独立 bytes/files/RSS 预算；
- [x] 18-package build/test、dependency/source boundary、Local image与完整 backend 通过；
- [x] GitNexus compare/detect-changes 通过（已跟踪 diff 为 risk `low`、affected processes `0`；本分支尚未纳入 index 的新增文件另由重建后的代码图与 package/source/import gates 覆盖）；
- [ ] 固定物理路由设备 RSS/flash/并发报告完成前保持 Proposed，不宣称默认开放远程 API。

## 实现与验证证据（2026-08-11）

- workspace 为 18 package、1,015 个 TypeScript source；997 个位于领域子目录，18 个是受审 public/binary root entry。`local-api` 自身为 8 个 source，其中 7 个分布在六个内部领域目录，根只保留 `cli.ts`；当前没有 single-source 或 1–2 source 未登记薄包。
- `local-api` 定向门 15/15，包括真实 SQLite authority、API Credential、Owner Pepper、Project Policy、durable audit 与 loopback HTTP E2E，以及 Edge 并发 4 的过载拒绝和 accepted-work drain。
- Edge API artifact 为 5,073,844 bytes / 515 files / 54 loaded modules，启动 RSS 增量 12,517,376 bytes；Standalone API artifact 为 5,073,988 bytes / 515 files / 54 loaded modules，RSS 增量 12,582,912 bytes，均低于 6 MiB / 640 files / 24 MiB 门。
- Runtime Core 的 bounded Run read projection 已成为纯叶子 subpath；API 导入闭包不再加载 Tool Registry/SemVer，投影模块门为不超过 4 个 loaded modules。
- 十二档既有 Local artifact 全部 compatible；默认 Local Application image 静态闭包不含 `@qinglong/local-api`。package boundary、source/dependency firewall 均无 finding；完整 backend 为 1,156 pass / 2 条条件 skip / 0 fail。
- 尚欠的是固定物理路由器的 flash、冷启动/稳态 RSS 与并发 1/4 报告。该缺口只阻止 ADR 转为 Accepted，不回退已经验证的 loopback-only、默认关闭实现。
