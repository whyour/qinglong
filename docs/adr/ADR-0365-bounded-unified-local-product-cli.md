# ADR-0365：有界统一 Local 产品 CLI

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-175、D-257、D-269、D-276、D-277、ADR-0185、ADR-0276、ADR-0364

## 上下文

QingLong 3.0 的 Local 产品能力已经通过 `ql3-task`、`ql3-trigger`、`ql3-policy`、
`ql3-local-deploy` 等专用 binary 建立了清晰的 command-file、权限和依赖边界，但部署
用户需要记忆二十多个顶层命令。继续让每个产品能力只暴露独立 binary 会把内部
authority 拆分直接转嫁为用户体验；反过来，把这些能力合并成一个常驻进程、共享
parser 或新 workspace package，又会扩大路由设备制品与权限面。

统一入口还不能通过 shell、`PATH` 或用户传入的模块路径选择实现。否则 command name
会变成任意程序执行入口，参数中的空格、通配符和 shell 元字符也会改变原专用 CLI 的
语义。root service mutation 与普通 Owner 管理尤其不能因为统一命令名称而混成同一
authority。

## 决策

### 1. 在现有 Local Owner CLI 制品内增加 `ql3`

`@qinglong/local-owner-cli` 增加一个短生命周期 `ql3` binary，提供二十个固定子命令：

```text
setup readiness deploy owner identity policy audit secret
task trigger workflow approval package package-catalog package-trust
ai-feature model-price model-credential prompt adoption
```

每个子命令只映射到同一 package manifest 已公开的一个既有 binary。原
`ql3-task`、`ql3-trigger` 等入口继续保留，参数、stdout/stderr、退出码和 command-file
协议不改变；统一入口只是用户体验 facade，不成为新的领域或 authority。

### 2. 路由必须是静态、同制品且无 shell

dispatcher 必须：

- 使用编译期冻结的 command→binary→相对目标表；
- 在当前 package 的 canonical `dist/` 内解析并复验真实文件，拒绝 symlink escape；
- 使用当前 `process.execPath` 和参数数组直接启动，固定 `shell=false`，不查找 `PATH`；
- 将子命令后的参数作为 opaque argv 原样传递，不解析 command file 或业务字段；
- 将 SIGINT、SIGTERM、SIGHUP 转发给当前 child，并保持 child 退出码或
  `128+signal` 语义；
- 对未知命令只返回低敏、稳定的 usage error，不回显用户输入或安装路径。

`--version` 从当前安装的有界 package manifest 读取并复验 exact package identity 与
SemVer，不维护第二份版本常量。

### 3. Authority 隔离优先于命令名称统一

`ql3-service-bridge` 不进入 `ql3` 子命令表。它仍是 operator 显式交给 root 的独立
binary，只接受 root-owned 私有 command file。`ql3-owner-gc` 属于另一短生命周期
maintenance 制品，Cluster Admin/Control/Worker binary 也不通过 Local facade 暴露。

因此 `ql3` 不提升 UID、不隐式 sudo、不读取 root handoff、不增加数据库连接、listener、
timer、watcher、daemon、migration 或第三方依赖。它只在 operator 主动调用时创建一个
短生命周期 child，路由设备的 application/MCP/AI-free 常驻闭包不加载它。

## 影响

部署者可以从一个可发现入口查看 Local 3.0 能力，并使用
`ql3 <command> --help` 进入原有精确协议；实现仍保留小设备所需的按制品、按 authority
隔离。代价是安装制品增加两个很小的 TypeScript 源文件和一个 binary manifest entry，
执行专用命令时多一个短生命周期 Node 父进程。

## 验收证据

- catalog、安装 identity、help/version、opaque argv、unknown/path traversal、canonical
  symlink escape、真实 help/usage delegation、退出码和有界 signal forwarding 6/6；
- 完整 Local Owner CLI 157 pass/5 条 root 条件 skip、0 fail；
- 原有二十一个专用 binary 全部保留，`ql3-service-bridge` 明确不在统一 catalog；
- `pnpm pack` 产物包含 executable `dist/product-cli/cli.js` 和 22 个 binary manifest
  entry；17-package 完整测试总命令退出 0；
- 完整 backend 1,155 pass/2 条条件 skip、0 fail；package boundary 正反向
  fixture 10/10；
- 十二档 Local Profile artifact 与 Local image 全部 compatible，任何常驻闭包均不含
  `@qinglong/local-owner-cli`；当前最紧的 Standalone Application AI 为
  6,270,872/6,291,456 bytes；
- workspace 保持 17 package、1,006 source、989 nested/17 root，结构审计无
  single-source/shallow package，dependency finding 为空；未新增第三方依赖或生产
  authority。

## 不采用方案

- **新增 `ql3-cli` package**：只有一个消费者和相同发布/authority 边界，会恢复微包碎片。
- **把所有 CLI 逻辑 import 到一个进程**：启动 help 也会加载 SQLite、AI 和管理依赖，
  并混合错误/状态生命周期。
- **通过 shell 或 PATH 调用 `ql3-*`**：允许环境劫持、引用歧义和参数重解释。
- **把 root bridge 作为普通子命令**：统一 UX 不能消除双 authority 边界。
- **删除旧 binary**：会无必要破坏现有运维脚本和证据协议。
