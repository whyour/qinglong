# ADR-0085：私有持久命令文件驱动的 Local Owner GC CLI

- 状态：Proposed（本机 CLI、maintenance package 收敛与自动化门禁已完成；Linux/路由器和真实存储故障门禁待完成）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-77、D-82、D-83
- 关联 ADR：ADR-0078、ADR-0083、ADR-0084

## 上下文

pepper material GC 与 delivery acknowledgement GC 已有短生命周期组合根，但直接把其字段映射为大量 CLI flags 会产生两个问题：mutation/request ID 未持久化时，进程崩溃后的重试无法复用同一幂等键；未来若沿用同一模式扩展 Owner ceremony，还容易把 credential/challenge secret 放入 argv、环境变量、stdin、stdout 或 shell history。

路由设备不应为低频维护保留 daemon、timer 或第二数据库连接；集群节点也不应复用本机 POSIX authority 绕过独立管理面。因此需要一个本机专用、短生命周期、可审计且不扩大常驻闭包的 adapter。

## 决策

### 1. 命令文件是 durable intent

`ql3-owner-gc run --command-file /absolute/path.json` 只接受一个规范化绝对路径。文件必须由当前 real/effective POSIX UID 拥有，是不可跟随 symlink 的 `0600` 普通文件，大小为 1–16 KiB；共享叶子 package `@qinglong/local-command-file` 在 `lstat → O_NOFOLLOW open → fstat` 中复核 device/inode/size，并在解析后清零输入 Buffer。该 package 不理解 GC、Owner、SQLite 或 runtime contract；GC CLI 与 ADR-0086 的产品 CLI 各自保留独立 command schema 和 authority。

命令采用 exact-shape、`schemaVersion: 1` 的 JSON，当前只允许 `owner.delivery-acknowledgement.compact` 与 `owner.pepper-material.collect`。mutation/request ID 必须在执行前写入命令文件；CLI 不从时间、PID 或内存临时生成幂等键，也不接受 stdin、环境变量或调用方时间。

### 2. CLI 只组合受审 authority

现行 `@qinglong/local-owner-maintenance/command` 与 `ql3-owner-gc` bin 除共享 `@qinglong/local-command-file` 外，只能通过同包相对模块调用 maintenance 的 acknowledgement/pepper GC authority。maintenance 不提供聚合根入口，依赖门禁把 destructive keyring、SQLite `/pepper-gc` 与 `/acknowledgement-gc` 权限分别锁定到对应源文件；command adapter 不能绕过 bridge proof、retention、reference、active-key 或 transaction 裁决。旧 `@qinglong/local-owner-gc-cli` package 名保持 tombstone，防止重新引入一对一 wrapper。

每次命令只打开一个对应短生命周期 authority，并在成功或失败后等待唯一 close fence；没有 listener、timer、watcher、自动分页或后台循环。

### 3. 输出是低敏结果，不是密钥通道

stdout 只输出单行 versioned JSON summary：operation、inserted/existing、mutation/target ID、终态和时间。credential/challenge secret、pepper material、material digest、backup digest、delivery digest、semantic digest、bridge evidence 与 destruction proof 均不输出。错误只写 stderr，并使用固定 code/name/message；CLI 不读取或打印 command file 内容。

该入口只完成两个 GC ceremony。ADR-0086 的 `ql3-owner` 已复用共享文件读取协议并以独立 schema 开放 provisioning/claim/delivery acknowledgement/credential recovery；两者仍不代表 fresh database/pepper setup、Secret 管理或远程 HTTP/UI 已完成。

## 被否决的替代方案

1. **所有字段使用 flags**：幂等 intent 难以跨崩溃保存，且扩展后容易进入 shell history，拒绝。
2. **从 stdin 读取 JSON**：没有 durable retry 证据，且未来可能承载 secret，拒绝。
3. **CLI 内部随机生成 mutation ID**：提交成功但响应丢失后无法 exact replay，拒绝。
4. **直接导入 SQLite/destructive 子入口**：绕过组合根的可信时间、文件证据和复验，拒绝。
5. **在 application 增加自动 GC timer**：增加路由设备常驻成本并扩大破坏性 authority 可达面，拒绝。
6. **复用本机 CLI 管理 cluster**：POSIX UID/文件证明不等同于集群身份、审批和多租户边界，拒绝。

## 验收证据

1. 4 项 CLI 测试覆盖两种命令、私有文件与 exact-shape 拒绝、authority close、低敏结果和 command-file-only 二进制接口。
2. dependency/source boundary 在 ADR-0087 与 ADR-0106 的物理合并后登记 21 个 QL3 importer，并只对白名单命令文件、console 内部 ceremony、maintenance/Profile 精确模块开放对应组合根导入；联网 production audit 必须以当次 registry 结果为准。
3. 六种常驻 Profile 制品均未导入 CLI/GC authority；最大 application 仍为 2,389,798 bytes、495 files、58 modules，低于 4 MiB/512 files/16 MiB 门禁。
4. maintenance package 只新增既有 `local-command-file` workspace 依赖，没有新增第三方生产依赖；Node 24 build/test 与 lockfile exact workspace resolution 通过。

## 未完成项

该 CLI 的本机自动化边界已完成，但 production rollout 仍需 Linux x64/arm64、rootless/root 容器 volume ownership、固定物理路由器 RSS/闪存写放大，以及真实断电、ENOSPC、EROFS 故障证据。Owner provisioning/claim 与 credential recovery 已由 ADR-0086 的独立产品 CLI 开放；fresh database/pepper setup 和 Secret 管理仍未完成，不能由本 GC CLI 推导为已完成。
