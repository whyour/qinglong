# ADR-0180：Authenticated Local Plugin Package Recovery Catalog Publication

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-65、D-138、D-147、D-169、D-170；ADR-0138、ADR-0140、
  ADR-0143、ADR-0178、ADR-0179

## 背景

ADR-0179 已让本机 application 能按 durable `PackageLock.lockDigest` 消费
materialized recovery catalog，但只定义了读取协议。要求部署者手工拼装 entry、
复制 bundle 和覆盖路径既容易产生 schema 漂移，也没有当前 Owner 复验、审计、
no-replace 发布、崩溃残留清理或有界回收。

精确 lock 只有 Approved Action 派发建立 durable install head 后才存在；签名 payload
也绑定该 lock。因此 catalog 不可能在 dispatch 前发布。SQLite 事务与文件系统发布又
不能伪装成一个原子事务：dispatch 已提交而 catalog 尚未发布时，application 必须继续
失败关闭，不能合成 source evidence。

## 决策

### 1. 复用现有管理包与 Owner CLI

不新增 workspace package：

- `@qinglong/local-admin/package-recovery-catalog` 拥有签名验证、私有文件发布、inspect
  和有界 collect；
- `@qinglong/local-owner-cli/package-catalog-command` 负责私有 command file、当前
  SQLite install head、认证、Owner fence 和 security audit；
- `ql3-package-catalog` 是短生命周期 executable，只支持
  `publish|inspect|collect`，不进入 application 常驻闭包。

三种命令统一使用 `local_package_catalog` authentication namespace。`publish` 与
`collect` 在可见变更前重新确认 credential、User 和 default Project Owner，写入耐久
authorized audit，再次复验 fence。失败审计和 CLI stderr 只输出低敏 code/name，
不得输出 credential、locator、路径、manifest 或 bundle 内容。

### 2. catalog 拥有 content-addressed bundle root

application 配置必须显式提供：

```json
{
  "mode": "materialized_catalog",
  "catalogRoot": "/opt/qinglong/private/plugin-package-catalog",
  "bundleRoot": "/opt/qinglong/private/plugin-package-bundles",
  "publisherTrustFilePath": "/opt/qinglong/private/plugin-package-publisher-trust/current.json"
}
```

`catalogRoot` 和 `bundleRoot` 都必须是当前 real/effective UID 拥有、规范真实路径、
非 symlink、精确 `0700` 的不同目录，各最多 64 个 final object。bundle final name
固定为 `<artifactDigest>.bundle`，entry 中的 `bundlePath` 必须精确等于该路径；
application 不再接受指向任意主机位置的 bundle。

发布者从 deployment root 下的私有 source bundle 流式读取，在私有临时文件中复用
既有 canonical manifest、tar/content/artifact digest、install plan、Ed25519 publisher
trust/lifetime 校验。全部校验和 Owner/audit fence 完成后，以 hard-link no-replace
发布 immutable entry 与 content-addressed bundle；同内容重放返回 `existing`，同名
异内容失败关闭。目录会 `fsync`，识别出的临时事务保留为显式 GC 候选。

### 3. 发布只绑定 durable current head

`publish` 请求只给出 `projectId`、`packageName`、私有 descriptor 与 trust 文件，不
接受调用方提交 lock。命令从同一受认证 SQLite authority 读取当前 install head 和
完整 `PackageLock`，再验证 descriptor：

```text
schema = qinglong/local-plugin-package-recovery-publication@v1
bundlePath = deploymentRoot 下的私有 source bundle
manifest
signature
```

正确顺序是：

```text
package propose/decide/consume/dispatch
  → durable current PackageLock
  → ql3-package-catalog publish
  → start/restart application
```

dispatch 与 filesystem publish 之间没有跨介质原子性。此窗口内 queued recovery 因
缺 entry 而阻断 admission；相同 command file、request ID 和 audit event ID 可安全
重放并收敛。不得在失败窗口伪造空 stage、自动回滚 durable install head，或让
application 在线拉取。

### 4. inspect 和 collect 都有硬上限

inspect 只返回 entry/bundle/transaction 数量，以及 current/stale entry 数量，不返回
路径、digest 列表或 source locator。current 的唯一判据是 catalog lock 同时存在于
SQLite lock ledger，且仍是对应 project/package 的当前 install head。

collect 只删除：

1. 识别出的私有 catalog/bundle 临时事务；
2. 明确证明不是当前 head 的 catalog entry；
3. 删除 entry 后不再被任何保留 entry 引用的 bundle。

每个候选在 unlink 前复验 device/inode/UID/mode；删除 bundle 前重新扫描引用。单次
上限为 edge 4、standalone 16，总目录上限仍为 64。命令不建立 timer、watcher、
listener、后台线程或定时 GC；运维者显式重复 collect，直到 `remaining=false`。
同一 catalog 的 publish/collect ceremony 必须由外部 supervisor 串行执行。

### 5. trust 生命周期与在线 OCI 获取是独立能力

本决策读取显式私有 publisher trust。ADR-0181 已提供认证 provision、addition-only
overlap rotation 和 snapshot-before-current 精确恢复，但有意不提供旧 key 删除、
retirement、紧急 revoke 或 rollback；这些操作必须先证明 current catalog signer
影响并定义重签/隔离语义。OCI lock 可以消费已物化 bundle，Registry credential、
下载、限流和 response-loss 恢复仍属于未来短生命周期 fetch authority，不得进入
application。

## 拒绝方案

1. **新增 catalog workspace package**：没有独立部署和版本生命周期，只会加剧小包
   碎片化，拒绝。
2. **把 lock 或 bundle path 写回 SQLite install fact**：混合领域事实与主机拓扑，
   拒绝。
3. **先发布未验证文件，再异步补签名检查**：会让 application 看到不受信 evidence，
   拒绝。
4. **用 rename 覆盖既有 entry/bundle**：破坏 immutable replay 和冲突检测，拒绝。
5. **按 mtime/LRU 自动删 bundle**：不能证明 durable current head，拒绝。
6. **application 内置 watcher/GC/fetcher**：扩大常驻 authority 和低配设备空载成本，
   拒绝。
7. **宣称 SQLite 与文件系统原子提交**：不存在共同事务介质，拒绝。

## 当前证据

- 真实 Approved Action 生命周期建立 durable current lock 后，authenticated Owner
  命令可发布签名 bundle，重放返回 `existing`，inspect 精确报告 current/stale；
- application 直接消费管理面发布的 entry，并复用同一签名 verifier 完成 stage；
- collect 在单次硬上限内清理临时事务、stale entry 与最后一个无引用 bundle，并在
  删除前执行授权 fence；
- catalog/bundle 都是 exact `0700` authority root，final object 为 no-follow
  `0600` regular file，未知文件和容量越界整体失败关闭；
- local-admin 57/57、local-owner-cli 22/22、local-application 30/30、
  dependency/source boundary 30/30，edge import 121 modules 无越界；
- 全量 22-package build 完成；受限沙箱中仅 loopback listener 测试因 `listen EPERM`
  不能执行，移到非沙箱后 cluster-admin 为 98 pass/1 条 Kubernetes 条件 skip；
- edge/standalone application 为 4,668,784/4,668,928 bytes、605 files、90 startup
  modules；AI-inclusive 为 5,346,605/5,346,761 bytes、649 files、89 startup
  modules，全部在预算内；
- disabled AI 仍只加载 1 个模块，storage/provider/management authority loader 均为
  0；未新增 package、第三方依赖或常驻网络/定时资源。

## 后续门禁

1. publisher trust current-signer impact、旧 key retirement、紧急 revoke、
   rollback 和重签恢复；
2. 短生命周期 OCI fetcher 的 credential lease、egress policy、rate limit、审计与
   response-loss 恢复；
3. application 启动与 package dispatch/publish 的外部 deployment controller；
4. 固定低配 Linux 路由设备上的冷启动、idle RSS、闪存写入、ENOSPC 与断电恢复；
5. Cluster 对等的双人管理 ceremony；本机 Owner CLI 不能冒充 Cluster authority。
