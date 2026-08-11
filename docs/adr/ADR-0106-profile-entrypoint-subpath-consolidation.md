# ADR-0106：Profile 构建入口 Subpath 收敛

- 状态：Accepted
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-05、D-14、D-35、D-40、D-62、D-85、D-86、D-89、D-105
- 关联 ADR：ADR-0042、ADR-0062、ADR-0063、ADR-0087、ADR-0090
- Supersedes：ADR-0087 中“每个 Profile 构建目标必须保留独立 workspace package”的局部决策

## 上下文

ADR-0087 已把 package-per-use-case 的 32 个 importer 收敛为 27 个，但仍保留四个只有单一入口的 Profile wrapper：`@qinglong/edge`、`@qinglong/standalone`、`@qinglong/edge-adopted` 与 `@qinglong/standalone-adopted`。

当前实现证明这四个 wrapper 没有独立 `bin`、platform/engine/native/第三方依赖、版本责任或生产调用方。基础 Edge/Standalone 都只依赖 `@qinglong/local-profile`，接管变体都只依赖 `@qinglong/local-adopted-profile`；每个入口仅把调用参数中的 `profile` 固定为 `edge` 或 `standalone`。它们是不同制品的构建目标，但不是不同依赖或权限边界。

继续把“制品名称”等同于“workspace package”会增加 manifest、lockfile importer、拓扑 build、漏洞 allowlist 和贡献者认知成本，也使 D-85 的“独立制品”条件过于容易被空 wrapper 满足。反过来，合并 `local-profile` 与 `local-adopted-profile` 会让普通 Edge 安装接管写栅栏和 local-admin 依赖，仍然不可接受。

## 决策

1. 删除四个 wrapper package，把固定 Profile 的入口迁入既有 package 的精确 subpath：
   - `@qinglong/local-profile/edge`；
   - `@qinglong/local-profile/standalone`；
   - `@qinglong/local-adopted-profile/edge`；
   - `@qinglong/local-adopted-profile/standalone`。
2. `@qinglong/local-profile` 与 `@qinglong/local-adopted-profile` 的根入口继续保留现有通用组合 contract；根入口不聚合导出四个固定入口，制品审计必须显式 require 对应 subpath。
3. Edge、Standalone、Edge-adopted、Standalone-adopted 继续是四种独立 Deployment Profile 和制品门禁，但制品构建清单以“package 集合 + entry specifier”表达，不再要求 entry specifier 自己拥有 package manifest。
4. `local-profile` 与 `local-adopted-profile` 继续物理分包。后者独占 `local-admin/runtime` 接管写栅栏依赖，基础 Profile 的 production closure 不得安装 local-admin。
5. importer registry、lockfile、production vulnerability allowlist 与拓扑构建 hard cap 从 27 收紧为 23。已删除的四个 package 名仍作为禁止依赖保留在 source/root boundary tombstone 中，防止空 wrapper 被静默重新引入。
6. 以后只有当 Edge 与 Standalone 出现真实不同的 platform/native/第三方依赖、独立安装权限或发布节奏时，才能通过新 ADR 恢复独立 package。仅有不同配置值、制品标签或审计名称不满足 D-85。

## 被否决的替代方案

1. **继续保留四个 package 作为审计根**：构建目标可由精确 subpath 表达，空 wrapper 不应成为 package 边界，拒绝。
2. **把四个 wrapper 合成一个新 package**：仍然新增无独立依赖责任的中间 manifest，并会让基础与接管依赖方向难以表达，拒绝。
3. **合并 `local-profile` 与 `local-adopted-profile`**：会让基础 Edge/Standalone 的安装闭包取得接管与 local-admin 能力，拒绝。
4. **删除固定入口，直接让制品传任意 `profile` 字符串**：失去静态构建入口与错误配置防护，拒绝。
5. **按 LOC 自动合并其他单文件安全包**：`local-command-file`、`local-identity` 和 `local-secret-admin` 分别拥有复用、安全或权限排除边界，文件数不是裁决标准，拒绝。

## 验收证据

1. GitNexus 对四个旧 bootstrap symbol 的 upstream impact 均为 LOW：0 direct caller、0 execution flow；迁移风险集中在 exports、制品和审计配置。
2. 干净 `dist` 上根级拓扑构建精确执行 23 个 package，全部通过；`local-profile` 的 Edge/Standalone subpath 与 `local-adopted-profile` 的两个接管 subpath 行为测试共 4 项通过，两个 package 完整测试为 12/12。
3. dependency/source boundary 报告登记 23 个 importer、280 个 TypeScript source file、`findings=[]`；Edge import audit 无 forbidden dependency/import。
4. 六种实际 `pnpm pack → offline install → require` 制品均通过 4 MiB、512 files、16 MiB RSS 门禁：

| Profile | Packages | Bytes | Files | Loaded modules | RSS delta sample |
| --- | ---: | ---: | ---: | ---: | ---: |
| edge | 4 | 1,662,386 | 238 | 37 | 9,109,504 |
| standalone | 4 | 1,662,434 | 238 | 37 | 9,109,504 |
| edge-adopted | 6 | 1,898,370 | 266 | 40 | 10,403,840 |
| standalone-adopted | 6 | 1,898,442 | 266 | 40 | 10,584,064 |
| edge-application | 10 | 2,211,411 | 337 | 70 | 12,206,080 |
| standalone-application | 10 | 2,211,531 | 337 | 70 | 12,288,000 |

RSS 是本机单次抽样，只证明未超过硬门禁，不用于宣称跨次性能提升。Profile package 数量包含 `croner`；基础制品仍不含 local-admin、PostgreSQL、Drizzle、Sequelize 或 sqlite3。

## 后续约束

package 数量不是路由设备性能指标。后续仍以实际 production tarball 的 bytes/files、
import closure、RSS、连接/timer 数和物理设备证据裁决资源兼容性。ADR-0218 已完成此前
要求的 Cron provider 评审：`runtime-core` 只保留显式 port，真实 Croner adapter
归现有 `local-execution`/`cluster-control` 部署 owner，基础/adopted-only 制品排除
Croner，且没有新增 package。新的六 Profile 物理 bytes/files/RSS 仍必须在锁定依赖
物化后重跑，不能用 manifest 变化代替实测。
