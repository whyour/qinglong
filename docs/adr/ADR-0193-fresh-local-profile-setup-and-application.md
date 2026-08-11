# ADR-0193：Fresh Local Profile 初始化与应用激活

- 状态：Accepted（fresh setup CLI、v2 process config、真实 SQLite
  edge 启停与 adopted v1 兼容已实现）
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-40、D-62、D-76、D-183
- 关联 ADR：ADR-0042、ADR-0062、ADR-0066、ADR-0077、ADR-0086、
  ADR-0175、ADR-0185

## 背景

`ql3-local-application` 已能在 adopted target 上恢复 Run、Plugin Package、
Tool snapshot、Secret、Scheduler 与 LocalProcess，但它始终要求
`sourcePath/manifestPath/activationDigest`。这使全新安装也必须伪造一套 2.x
adoption 事实，架构和产品语义都不合理。

底层 migration、Owner pepper keyring、backup、catalog activation 与 Local Secret
keyring 已分别存在，但部署者需要从测试代码推导调用顺序。任一阶段崩溃后如果重新
生成材料或 mutation identity，会让数据库与文件事实分叉。

## 决策

### 1. 本机应用显式区分 fresh 与 adopted

`qinglong/local-application-process@v2` 的 `storage` 是 exact-shape 判别联合：

- `fresh` 只接受 `databasePath` 与可选 `busyTimeoutMs`；
- `adopted` 接受原 source/target/recovery/manifest/activation fence。

v1 配置继续按 adopted 解释，并保持加载后的原对象 shape。fresh 直接经
`local-profile` 打开同一个 SQLite runtime authority，不取得或伪造 legacy source
fence。两种模式随后共用完全相同的 Plugin Package recovery、Tool snapshot、
Secret、Run recovery、Scheduler、Executor 与 shutdown 顺序。

AI optional feature 使用所选模式的实际数据库路径，不能继续假设 `targetPath`
必然存在。

### 2. 初始化属于短生命周期 authority

既有 `local-owner-cli` 增加 `ql3-local-setup` 和 `/local-setup` subpath，不新增
workspace package。命令只从当前 UID 的 canonical `0600` 文件读取，并按固定顺序
收敛：

1. 运行 reviewed SQLite migration stream；
2. no-replace 创建或精确复核唯一 Owner pepper；
3. no-replace 创建或精确复核独立 backup，要求 material digest 相同；
4. 以命令文件内持久化的两个 mutation ID 注册并激活 generation 1；
5. no-replace 创建或精确复核 Local Secret keyring。

deployment root、pepper root 与 backup root 必须是 canonical、当前 UID、`0700`
目录；数据库、keyring 和各目录必须是 deployment root 下互异的 authority。
已有不同 pepper、宽权限、symlink、路径逃逸或 mutation 漂移均失败关闭。

CLI 不创建 Owner Identity，也不自动 claim Owner。完成初始化后仍使用既有
`ql3-owner` staged delivery ceremony，避免把数据库/密钥初始化 authority 与身份
声明合并。

### 3. 资源与包边界

不新增 package、第三方生产依赖、listener、timer、watcher 或常驻连接。
`local-application` 新增对已在其制品链内的 `local-profile` 直接依赖，用显式依赖
替代传递依赖。`local-owner-cli` 把既有 `local-owner-keyring` 从 dev dependency
提升为 production dependency，并复用既有 `local-secret`。

## 验收

- v1 adopted 配置 exact round-trip；
- v2 fresh exact-shape，拒绝 widening；
- 真实 migrated SQLite fresh application 能启动、进入 active、响应 SIGTERM、
  完整释放且 `integrity_check=ok`，全程不产生 adoption audit；
- setup 首次返回 `prepared`，同一命令重放返回 `existing`；
- pepper 主/备、数据库 catalog 与 envelope keyring 各只有一个当前事实；
- CLI 输出不包含路径、material、digest、token 或 secret；
- local-application 与 local-owner-cli 全量测试通过。

## 未包含

- 自动创建部署目录或修改其 owner/mode；
- 自动签发 Owner Identity、challenge 或自动 claim；
- systemd/OpenRC/容器安装器与升级包签名；
- Linux 路由器断电、ENOSPC 与只读文件系统实机证据。
