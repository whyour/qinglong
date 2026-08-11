# ADR-0081：摘要绑定的 Owner Secret 确认与无密钥重放

- 状态：Superseded（摘要绑定确认仍有效；永久文件墓碑由 ADR-0082 的 SQLite 账本 + 瞬时文件桥梁取代）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-77、D-78、D-80
- 关联 ADR：ADR-0075、ADR-0076、ADR-0077、ADR-0078、ADR-0079、ADR-0080

## 上下文

ADR-0079 已关闭“数据库提交成功、一次性 secret 尚未发布”窗口，但 `ready` 文件不能永久保留。直接删除 `ready` 会让同一 mutation 的重放重新生成 candidate；新 secret 与既有数据库 digest 不一致，既无法恢复原 secret，也可能把调用方引入错误的再交付语义。

确认动作还必须区分“调用方确实看到本次 ready 文件”与“只知道 mutation ID”。只按文件名删除、把 secret 传回 CLI、或在内存记忆确认状态，都不能跨并发与崩溃提供证据。

## 决策

### 1. Inspect 只返回精确交付摘要

console 对 credential/challenge 分别提供 inspect。它以既有私有文件校验路径读取 `ready`，对原始有界字节计算 domain-separated SHA-256，并只返回 kind、mutation、request、摘要和绝对路径；不解析或返回 secret。

摘要覆盖文件的精确序列化材料，而不只覆盖数据库字段。因此换行、额外字段、secret 或任何字节变化都会改变 expected digest。

### 2. Acknowledge 必须同时绑定 ready 与数据库事实

调用方必须提交 inspect 得到的 64-hex delivery digest。确认入口重新读取并验证：

1. mutation/kind/request/project/identity/challenge/TTL；
2. ready 的 exact delivery digest；
3. credential secret 经部署 pepper 计算的 digest，或 challenge 的 domain-separated token digest；
4. 同一 SQLite authority 中已提交事实的 ID、fact digest 和 TTL。

摘要错误、ready 缺失且无既有确认、数据库事实缺失或任一字段不一致都 fail closed，且不得删除 ready。

### 3. 先耐久确认，再删除 secret

确认记录不保存 secret，只保存稳定 ID、数据库 fact digest、delivery digest、TTL 和首次确认时间。记录先写同目录 `0600` 临时文件并 fsync，再以 hard link no-replace 发布 `.acknowledged.json` 并 fsync 目录；只有随后才能删除 ready 并再次 fsync 目录。

并发确认同一稳定语义时，最先发布的记录和时间戳获胜；后续调用忽略自己的时间戳并采用既有记录。除时间戳外任何字段差异都视为冲突。

### 4. 启动恢复以数据库事实收敛确认窗口

启动先处理 acknowledgement：墓碑必须与数据库事实一致；若 ready 仍在，delivery digest、明文派生 digest 和全部 ID 必须同时匹配，随后删除 ready。acknowledgement 与 pending 共存、墓碑篡改、ready 被替换或数据库事实缺失都拒绝启动。

确认完成后，同一 mutation 的 service replay 通过 acknowledgement 解析既有数据库事实，只返回 `status=existing` 和稳定 ID，credential/challenge token 始终为 `null`，不得生成或暂存新的 secret。

### 5. 墓碑保留仍是显式容量门禁

当前 acknowledgement 与 staged record 共用最多 64 个目录项的硬预算，并永久保留以证明“该 mutation 的 secret 已不可重放”。在数据库级确认账本、mutation retention、credential revoke/rotation 和审计策略共同完成前，禁止自动删除墓碑或提高为无界扫描。

因此当前实现适合低频 fresh-owner ceremony 和受控恢复，不等同于可无限执行的 credential 管理面。最终 rotation CLI/API 必须先关闭该 retention 缺口。

## 被否决的替代方案

1. **确认时把 secret 打印到 stdout**：重新扩大 shell history、日志和编排采集泄漏面，拒绝。
2. **只凭 mutation ID 删除 ready**：不能证明调用方看到精确文件，也不能检测替换，拒绝。
3. **先删 ready、再写确认**：崩溃会同时丢失 secret 和无重放证据，拒绝。
4. **只保存内存确认状态**：重启后会重新生成 candidate，拒绝。
5. **忽略数据库事实只验证文件摘要**：可把未提交或跨部署记录提升为已确认，拒绝。
6. **自动清理最旧墓碑**：会重新打开旧 mutation secret 再生成窗口，拒绝。

## 验收证据

1. `@qinglong/local-owner-console` 21 项测试通过。
2. 覆盖 credential/challenge inspect、精确摘要确认、响应无 secret、确认后 exact replay、错误摘要保留 ready。
3. 覆盖两个不同时间戳的并发确认、ack 已发布但 ready 未删除的崩溃窗口和启动收敛。
4. 覆盖墓碑 fact 篡改、ack+pending 非法共存、record 权限/symlink/目录上限，以及注入 `ENOSPC`/`EROFS` 后临时文件清理。
5. package 仍无 `bin`、listener、watcher、timer 或第二 SQLite authority，默认 application 不导入 Owner authority。

## 未完成项

数据库级 acknowledgement ledger、credential-version key provenance、受审 tombstone retention/GC、keyring/active CAS 与 credential revoke/rotation/recovery 已完成；最终无 secret stdout CLI、真实只读文件系统/磁盘耗尽/断电测试、Linux 容器与固定物理路由器证据仍未完成。
