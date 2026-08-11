# ADR-0178：Concrete Local Headless Application Process

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-37、D-40、D-65、D-138、D-167、D-168；ADR-0066、ADR-0140、ADR-0177

## 背景

`@qinglong/local-application` 已经拥有 adopted SQLite、Plugin Package 恢复、Secret
preflight、Run reconciliation、execution control 和 scheduler，但此前仍要求调用方注入
一个 `create(context)`：

```text
create → synthetic recover → synthetic lifecycle → synthetic admission → synthetic stop
```

仓库中没有生产实现，只有测试返回这一组方法。结果是 application 看似有组合根，实际
产品仍无法独立启动；新增 CLI 若继续注入一只 no-op Stack，只会把测试替身包装成
“可执行产品”。

另外，本机 scheduler 和 execution lifecycle 为了嵌入式/测试调用者都使用 `unref`
timer。未决 Promise 不维持 Node.js 进程，因此 headless binary 还必须显式拥有一个
process lifetime handle。

## 决策

### 1. 删除没有生产实现的 Stack seam

移除 `LocalApplicationStack`、`LocalApplicationAdmission`、
`LocalApplicationAssemblyContext`、`LocalApplicationRecoverySummary` 和 enabled
options 的 `create` factory。`bootstrapLocalApplication` 自身就是 concrete headless
runtime，并直接拥有：

```text
adopted storage/source fence
  → Plugin Package install recovery
  → Task publication recovery
  → Tool snapshot recovery
  → Secret keyring preflight
  → receipt-first Run recovery
  → execution control reconciliation
  → execution-control + scheduler lifecycle
  → active
```

停止顺序固定为 scheduler admission/drain → execution-control drain → adopted storage
与 source fence。启动失败按同一 ownership 逆序 best-effort 清理。这里没有 HTTP
listener，因此不保留一只虚构的 transport admission object；未来 API host 必须作为
外层真实 transport composition 拥有自己的 admission/drain。

### 2. 在现有 package 内提供 executable

不新增 workspace package。在 `@qinglong/local-application` 内增加：

- `ql3-local-application` binary；
- `/process-config` 严格配置子路径；
- `/process` 可测试的 process composition 子路径。

配置只从一个规范化绝对路径的私有 JSON 文件读取。复用现有
`@qinglong/local-command-file` 的 POSIX identity、`0600`、regular-file、
`O_NOFOLLOW`、16 KiB 和打开前后 inode/size fence，不复制一份较弱的文件读取器。
配置 schema 为 `qinglong/local-application-process@v1`，采用 exact shape，并要求：

- 稳定且有界的 `instanceId`；
- `edge|standalone` Profile；
- 五个互不别名的 adoption/storage authority path；
- activation digest；
- receipt、Artifact、Secret keyring 与 Plugin Package roots；
- 显式 AI deployment state。

路径和 digest 不进入 stdout/stderr 事实。CLI 只接受
`--config /absolute/private-config.json`，不接受大量环境变量、明文 token 或任意 JSON
override。

### 3. executable 必须选择产品 composition

进程统一调用 ADR-0177 的 AI-aware product composition：

- `deployment=excluded` 启动 base application，且不加载 AI runtime/provider；
- `deployment=installed` 必须获得受信 `loadAiProviders` authority；
- CLI 当前没有 provider ceremony，因此 installed 在触碰 storage 前失败关闭；
- schema absent/inactive/active 的后续裁决仍由 ADR-0177 durable head 执行。

这使 executable 不会绕过 durable 9007 head，也不会为了“先能跑”而从环境变量构造
明文 API token。provider binding/Policy/Secret material ceremony 是下一独立安全门。

### 4. 信号和 process lifetime 属于进程组合根

进程在 storage startup 前订阅 `SIGINT`/`SIGTERM`，内部 fence 只接受第一个信号，并
在 `finally` 解除订阅。收到信号后必须调用统一 `stop()`，将 `timed_out` 映射为非零
退出，不能直接依赖 Node 默认退出。

library timer 继续全部 `unref`。binary 额外持有一只最大 Node timer 周期
`2_147_483_647 ms` 的 referenced keepalive，正常/失败退出必定清理；它约 24.8 天才
可能唤醒一次，不给路由设备增加短周期轮询。真实 child-process 门验证 process 在
`active` 后不会因零 referenced handle 自行退出，并能接收 SIGTERM、完成 drain、释放
legacy source fence 后以 0 退出。

### 5. 恢复 source 不得伪造

嵌入式 host 可注入受信 `PluginPackageStageProvider`。通用 CLI 没有离线
bundle/OCI credential catalog authority，因此默认 provider 只在存在 queued stage
work 时以 `QL3_LOCAL_APPLICATION_PLUGIN_SOURCE_UNAVAILABLE` 失败关闭；空队列不触碰
source。

不得返回伪造 stage evidence，也不得把“不知道如何恢复”当成 safe-to-admit。通用
ADR-0179 已补充通用 materialized offline/OCI recovery catalog；它只消费部署者预先
放入的本机签名 bundle，不给常驻 application Registry credential 或网络 authority。
catalog 的认证发布/GC、在线 OCI fetch、credential rotation 与管理入口仍属于后续
产品门。

### 6. 只输出低敏、机器可读事实

stdout 每行一个 schema v1 JSON fact，只包含 component、instance/profile、activation
state、有界 recovery count、AI state、signal 和 stop result。启动错误只输出
`name/code`，不输出 Error message、路径、digest、SecretRef、credential 或堆栈。

## 拒绝方案

1. **保留 no-op Stack 并由 CLI 注入**：把测试替身冒充生产 runtime，拒绝。
2. **再拆 `local-application-process` package**：没有独立部署/依赖收益，加剧过细
   importer，拒绝。
3. **把入口接进 `back/app.ts`**：会让 2.x worker/master 成为 3.0 cutover authority，
   破坏 side-by-side fence，拒绝。
4. **从环境变量直接读 provider token**：绕过 Project SecretRef、binding、Policy 和
   audit，拒绝。
5. **让未决 Promise 自然维持进程**：Node.js 不提供该保证，真实门已证明会提前退出，
   拒绝。
6. **对 queued Plugin Package 返回空 evidence**：会在未知 source 下开放 admission，
   拒绝。

## 当前证据

- local-application 29/29，包含 real SQLite/adoption/Secret/Run 启动、首信号、
  installed-AI pre-storage fail-close、默认 Package source fail-close、CLI usage/脱敏，
  以及真实 child process `active → SIGTERM → drain → exit 0 → source fence released`；
- dependency/source boundary 30/30，workspace 仍为 22 个 QL3 package；本增量只复用既有
  单文件协议 primitive，没有新增 importer；
- 22-package clean build/test 全绿，legacy/back 兼容回归 802/802；disabled AI
  benchmark 只加载 1 个 AI module，storage/provider/management loader 均为 0；
- edge/standalone application 为 4,631,855/4,631,999 bytes、603 files、90 loaded
  modules；AI-inclusive application 为 5,309,676/5,309,832 bytes、647 files、
  89 startup-loaded modules，全部通过既有预算；门禁同时验证 `/process`
  import、精确 bin manifest、离线安装后的 `--help` 和 ADR-0179 catalog subpath；
- edge import audit 为 121 modules，forbidden root dependency/import 均为空；
- PostgreSQL 18.4 arm64 physical HA 在本增量前已重跑，`gates.passed=true`；本决策
  未修改 Cluster schema、migration 或进程。

## 后续门禁

1. provider binding/Policy/Secret material 的本机产品 ceremony，并让 installed AI CLI
   可达；
2. ADR-0179 catalog 的认证发布/GC ceremony 与短生命周期 OCI fetcher；
3. 由独立 deployment/cutover controller 启动该 binary，完成 2.x 停机与 3.0 source
   fence 的外部证据闭环；
4. 真实 HTTP/Unix-socket API host 的 admission、认证、Policy、audit 与有界 drain；
5. 固定低配 Linux 路由器的冷启动、idle RSS、24h wakeup/write、断电、ENOSPC 和恢复
   证据。
