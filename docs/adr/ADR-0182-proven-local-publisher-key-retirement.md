# ADR-0182：有 signer 影响证明的本机 Publisher Key 退休

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-133、D-169、D-170、D-171、D-172；ADR-0135、ADR-0179、
  ADR-0180、ADR-0181

## 背景

ADR-0181 只允许 addition-only overlap rotation。直接删除旧 key 不安全：catalog
可能仍保留由它签名的 recovery entry；即使一次扫描结果为零，也可能有并发 publish
正在验证 bundle、尚未写出 entry。SQLite audit、catalog/bundle 文件和 trust root
又不共享事务介质，不能把一次目录扫描伪装成原子证明。

## 决策

### 1. 正常退休使用 intent → proof → receipt → generation

authenticated Owner 执行 `plugin-package.publisher-trust.retire`。命令绑定 publisher、
key ID、expected generation、mutation ID 和首次 durable audit 时间，不接受调用方
提供的新 trust JSON。

管理器先在 `0700` trust root 以 hard-link no-replace 发布 `0600` immutable
retirement intent。intent 永久阻止该 signer 的新 catalog publication。随后分析全部
retained catalog entry；只有目标 signer 引用为零，且 catalog/bundle transaction
marker 总数为零，才发布 immutable receipt。receipt 绑定 intent、generation、
mutation、审计时间和低敏计数。

最后生成显式 `retire` snapshot。新 trust 必须精确等于前代删除一个目标 key，不得
改写其他 key，并至少保留一个在审计时间有效的 key。snapshot durable 后才原子提升
`current.json`。

### 2. Catalog publication 先暴露事务，再检查 intent

publish 在验证 bundle 前先创建可识别的 catalog transaction marker，并保持到 entry
发布完成。它在 marker 创建后以及 Owner audit/fence 后、任何 final bundle/entry
可见前各检查一次受管 trust root。

因此：

- intent 先赢：publisher 两次 guard 都拒绝旧 signer；
- publisher 先赢：retirement proof 看见 marker，拒绝生成 receipt；
- 任一进程崩溃：marker 保持为未决事实，由显式 collect 处理，退休继续失败关闭。

catalog Owner command 不再接受任意 `publisherTrustFilePath`，只从 options 中受管
`trustRoot/current.json` 读取，避免 stale trust 文件绕过 intent。

### 3. 恢复、容量与低配约束

intent、receipt、snapshot 或 current 提升后的崩溃都只允许同一认证 command 精确
重放。已发布 receipt 不重复扫描，已发布 snapshot 不重复生成；inspect 只返回
generation、key/snapshot/retirement 数量和 pending 状态，不返回 publisher/key ID。

trust root 最多 64 代 snapshot、32 个 intent、32 个 receipt 和 64 个临时文件；
未知或超限 entry 失败关闭。实现复用现有 local-admin/local-owner-cli，不新增
workspace package、第三方依赖、timer、watcher、listener、网络访问或 application
常驻 import。

### 4. 紧急撤销保持独立

本 ADR 只适用于计划内、已完成替代发布和旧 entry 回收的正常退休。key 疑似泄露时，
是否立即使历史 durable lock 失效、如何 quarantine、谁可 break-glass、如何恢复，
由 D-173/ADR-0183 的 durable proposal、双人或 break-glass confirmation 与 immutable
quarantine receipt 定义；不得用正常退休暗示 compromise 已得到处置。ADR-0183
先阻断新 publication/queued stage，但不把 receipt 冒充 active resource 热停止。

## 拒绝方案

1. **扫描为零后直接删除**：并发 publish 可在扫描后写入旧 signer entry。
2. **只分析 current SQLite head**：遗漏仍用于恢复或尚未 collect 的历史 entry。
3. **短暂内存锁**：不能跨进程、崩溃或设备重启提供证据。
4. **从请求读取任意 trust JSON**：stale 文件可绕过受管 intent。
5. **删除 intent/receipt 节省空间**：破坏 exact replay 与审计链。
6. **新增 watcher/reconciler**：给低配路由器增加 idle authority 和资源成本。

## 当前证据

- 有 signer 引用或任一未决 transaction 时拒绝退休；
- intent durable 后旧 signer publication guard 失败，新 signer 不受影响；
- receipt 后和 snapshot 后崩溃均可由 exact command 收敛；
- retire 精确删除一个 key，保留其他定义与至少一个当前有效 key；
- 非 Owner 在 intent 可见前被拒绝；成功和失败均使用既有低敏 SecurityAudit；
- trust root 的未知文件、超限 retirement evidence、宽权限和 identity 漂移失败关闭；
- local-admin 62/62、local-application 31/31、local-owner-cli 22/22、
  dependency/source boundary 30/30；
- workspace 仍为 22 package，未增加生产依赖或常驻资源。

Cluster 代码、migration、ACL 与部署 manifest 未变化，本切片不重新声明 Cluster
publisher trust 能力，也不要求重复 PostgreSQL HA Docker 门。

## 后续门禁

1. D-174 active/staged/activating Package 与 Task/Tool resource 撤出；
2. 被隔离 lock 的替代发布、恢复或永久 tombstone ceremony；
3. 在线 OCI fetch authority 与 publisher metadata/update channel；
4. 固定低配 Linux 路由器断电、ENOSPC、闪存写放大与容量证据；
5. Cluster 对等 trust lifecycle。
