# ADR-0287：Content-free 的 Package Prompt 目录读取

- 状态：Accepted
- 日期：2026-08-08
- 关联：D-85、D-87、D-157、D-213、D-244、D-257、ADR-0150、ADR-0222、ADR-0260、ADR-0261、ADR-0263、ADR-0267、ADR-0276、ADR-0270、ADR-0286

## 上下文

QingLong 3.0 已经能通过 Local `ql3-prompt prompt.execute` 和 Cluster
`POST /api/v3/projects/{projectId}/packages/{packageName}/prompts/{promptId}/executions`
执行 generation-bound Package Prompt，但调用者必须预先知道精确 `promptId`。同一 Package 的 Workflow 已有受认证
目录读取，Prompt 却只能盲调用，导致 AI 产品链路缺少“发现可用能力”这一步。

直接返回 automation publication 会同时暴露 Prompt template、publication digest、installation/generation/lock、其他
Workflow 定义和内部持久化事实。把目录读取绑定到 Provider/Gateway/Secret 或本机 AI feature activation，又会让纯只读
操作承担网络、凭据、并发槽和可选 schema 的成本，不适合低配路由设备。Cluster 默认非 AI 镜像也不能因为目录读取而
获得 `@qinglong/ai` 生产依赖或新增常驻路由。

## 决策

1. 共享结果 schema 固定为 `qinglong/plugin-package-prompt-catalog@v1`。结果只包含 `projectId`、`packageName`、
   `found`、`publicationState` 和 Prompt 摘要数组；每个 Prompt 只允许 `id/name/description` 与参数
   `name/description/required`。
2. Prompt `template`、参数值、publication/lock/generation/installation digest、Provider、Model、SecretRef、Artifact、
   Run、StepRun、价格、quota、credential、authentication ID 和审计内部字段一律不得进入目录结果。
3. Local 在既有 `ql3-prompt` command-file schema v1 增加 `prompt.inspect`。固定要求强 User 和 `model.invoke`；只读
   options 只接受 deployment root、SQLite、Owner pepper、credential 与可选 busy timeout，不要求 Secret keyring、
   Provider authority、AI feature activation、Gateway 或网络。allowed/failure audit 的 operation 均为
   `prompt.inspect`。
4. Cluster AI Profile 增加
   `GET /api/v3/projects/{projectId}/packages/{packageName}/prompts`，operation 为 `prompt.read`、permission 为
   `model.invoke`。认证、Project Policy fence 和 allowed audit 继续由共享 admission pipeline 完成；默认 AI-free
   cluster-control 不注册该路由。
5. PostgreSQL catalog service 只通过当前 automation publication head 与 immutable publication 的精确 join 读取
   一个目标，参数为 Project/Package，查询固定 `LIMIT 2`；零行返回 `found=false`，重复行、损坏 JSON、target 漂移或
   存储失败统一 unavailable。HTTP 拒绝 GET body、无效 Package 与 capability identity drift。
6. Local 与 Cluster 共用 `@qinglong/ai/plugin-package-prompt-catalog` 的纯投影 contract；该 subpath 只依赖
   runtime-core，不取得数据库 mutation、Provider、Secret、Artifact 或 model invocation authority。
7. 本增量不新增 workspace package、生产 dependency、migration、表、索引、Pool、端口、listener、timer、watcher、
   cache、后台扫描或状态机。路由设备按一次短命令付费；Cluster 复用显式 AI 进程已有数据库 Pool。
8. Prompt 目录不是通用 Package inventory，也不是 template/source 下载 API。跨 Package 发现、全文检索、标签、版本
   筛选和模板读取必须分别定义索引、分页、权限与敏感内容边界，不能静默扩宽 v1。

## 被拒绝的方案

- **让调用者继续保存 `promptId`**：执行可用但能力不可发现，不构成完整产品入口。
- **返回完整 Prompt resource 或 automation publication**：会暴露 template 与无关的安装、Workflow 和 digest 事实。
- **用 `prompt.execute` 做探测**：会消耗 quota、加载 Provider/Secret，并可能产生外部费用和 durable Run。
- **Local inspect 强制 AI feature active**：目录事实属于已发布 Package，不需要 model invocation 可选 schema；这会让
  低配设备为只读发现承担无效前置条件。
- **把 Prompt 目录加入默认 cluster-control**：会破坏默认镜像 AI-free 的依赖与路由闭包。
- **新增 catalog package、projection 表或缓存**：既有 immutable publication 已是权威事实，额外持久化会制造双写和
  常驻资源成本。
- **使用通用 `run.read` 或 `package.manage`**：前者没有表达模型调用能力，后者会把普通 Prompt 使用者错误提升为
  Package 管理者；v1 固定使用现有 `model.invoke`。

## 当前证据

- `@qinglong/ai` 204 tests：201 pass、3 条外部 PostgreSQL 条件 skip；目录纯投影与 PostgreSQL current-head
  `LIMIT 2` 正反向测试通过。
- `@qinglong/cluster-control` 在可绑定本机端口的环境中 179 tests：177 pass、2 条外部服务条件 skip；新增 route、
  identity drift、GET body、共享认证/Policy/audit 和 AI-only composition 通过。
- `@qinglong/local-owner-cli` 在可绑定本机端口的环境中 102/102；`prompt.inspect` 证明不激活 AI、不加载 Provider、
  不要求 Secret/Provider path，并且结果不包含 template 正文。
- AI、Cluster Control、Local Owner CLI TypeScript package closure 均通过；`git diff --check` 与 HA 脚本语法检查通过。
- 完整 19-package clean build/test 全绿；backend 1,110 tests 为 1,108 pass/2 条环境条件 skip，零失败。Edge import、
  Cluster dependency、package boundary、Cluster deployment、CloudNativePG 与 local image 六项审计均 compatible；
  package boundary 仍为 19 个受审包、零单文件包，只有两个纯公开产品入口允许浅层布局。
- 十档 Local artifact/RSS 门全部 compatible。最小 Edge 为 3,614,826 bytes，最大 Standalone Application AI 为
  6,053,998 bytes，距 6 MiB 上限仍有 237,458 bytes；所有实测 RSS 增量均低于对应预算。
- 刷新后的 GitNexus 为 42,868 nodes/97,573 edges/1,675 clusters/261 flows；13 个关键修改符号均为 LOW，
  最大 3 个上游符号，生产执行流无扩散。`detect_changes` all/compare `develop` 分别为 12 files/31 symbols 与
  14/34，均为 low/0 affected process；QL3 孵化树大部分仍 untracked，因此该统计不替代逐符号 impact、完整测试、
  制品与真实 HA 证据。
- PostgreSQL 18.4 arm64 physical-streaming HA 已实跑通过：Prompt catalog 在 primary、standby WAL replay 与
  promoted primary 完全一致，`found=true/state=active`、Prompt ID 精确，template/private input 持续缺席。
  timeline 1→2、旧主 fencing、`pg_rewind --write-recovery-conf` 只读同步 rejoin、两套 fresh control replica 与
  `gates.passed=true` 全绿；最终 `ql3-ha-*` container/network/volume 零残留。

## 接受条件

1. 完整 19-package workspace test、backend、package/deployment/image boundary audit 与十档 artifact/RSS 门全绿。
2. PostgreSQL 18.4 arm64 physical-streaming HA 必须证明 primary、standby WAL replay 与 promoted primary 返回完全相同
   的 catalog，`found=true/state=active`、Prompt ID 精确且 template/private input 均缺席；旧主 fencing、
   `pg_rewind`、fresh replicas 与零残留仍须全绿。
3. 刷新 GitNexus 后关键修改保持受审影响范围，并运行 `detect_changes` all/compare `develop`。

## 后续边界

- 若 UI 需要跨 Package 搜索，先交付受认证、按 Package name keyset 的可见 Package 目录，禁止在内存中扫描全部
  publication。
- Prompt template 预览、版本 diff、参数默认值和示例输入可能包含敏感内容，必须使用独立 permission/schema，不能
  扩宽 content-free catalog。
- 默认非 AI Profile 继续保持零 Prompt route；Local inspect 继续保持 request-driven、零 daemon/Provider/Secret。
