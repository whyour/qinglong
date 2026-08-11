# ADR-0123：Worker Production Credential Material Boundary

- 状态：Accepted（请求时加载、轮换消费与 Session 拒绝分类已实现；远端签发/恢复仍为发布 Gate）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-23、D-59、D-60、D-121、D-122
- 关联 ADR：ADR-0058、ADR-0059、ADR-0060、ADR-0061、ADR-0121、ADR-0122

## 背景

Worker certificate store 已用 generation + active manifest 持久化本地私钥/证书，续期 coordinator 也已
保持无 timer；Cluster Admin 能一次性签发 `ql3w` credential，Worker HTTPS client 则在每个请求前调用
credential provider。但此前 product 入口只能注入测试 provider，没有具体、受限且支持轮换的 material
adapter。若部署把 PEM/token 读一次后长期缓存在 composition root，证书 active pointer 或 token 原子替换
不会生效；若新增 watcher/timer，则会给路由设备增加第二套常驻生命周期。

证书 possession 与 `ql3w` principal 仍是两个 authority。把 token 写进 certificate manifest、Session journal
或 Agent pool key 都会错误耦合它们，并扩大 secret 的持久化和重放范围。

## 决策

### 1. 不新增 package，只开放显式 production credential subpath

具体 adapter 放在 `@qinglong/worker-runtime/production-credentials`，默认 package 根与本机 Edge/Standalone
制品都不加载它。它不创建数据库、socket、Agent、watcher、timer 或信号处理器，只实现既有
`WorkerIngressHttpsCredentialProvider`。

product deployment 注入：

- 既有 `WorkerCertificateStore.readActive()` authority；
- 本地 trust-anchor provider；
- 一个绝对、规范化、非根路径的 `ql3w` token 文件；
- 可选 expected credential ID 和时钟。

### 2. 每个请求重新裁决 active certificate 与 token

provider 每次 `load(signal)` 都先检查取消和本地时钟，再读取 trust anchors，以同一 observation 调用
certificate store 验证 active generation。随后以 `O_NOFOLLOW` 重新打开 active key/chain，复验私有
parent/file 权限、普通文件、1 MiB hard cap，并再次执行 key/certificate/trust/validity 校验及 manifest
fingerprint 对比，关闭 active-pointer 后文件替换的 TOCTOU 窗口。

token 文件最多 256 bytes，父目录不得对 group/other 开放，文件不得是 symlink 且权限不得对
group/other 开放。内容只能是一个 canonical `ql3w_<credentialId>_<43-char-secret>`，允许单个结尾 LF；
未知字符、多行、credential ID 漂移、宽权限或不可用存储全部 fail closed。部署以同目录原子 rename 替换
token，certificate renewal 继续以 active manifest 切代；下一请求自然观察新 generation，不需要 watcher。

### 3. Client 复制后必须释放 provider-owned Buffer

`WorkerIngressHttpsCredentials` 增加可选同步 `dispose()`。共享 HTTPS client 在校验并复制 certificate、key、
trust 后，无论成功还是 malformed credential 都调用它；dispose 失败视为 credentials unavailable，且已经复制
的 Buffer 也清零。现有 provider 不实现该 hook 时保持兼容。

Agent pool identity 继续只由 certificate/key/trust digest 决定；token 每请求进入 Authorization header，轮换
token 不新建 Agent。证书代际变化产生新的 pool identity，旧 material 不参与新请求。

JavaScript header string 不能可靠清零；本决策只承诺 provider/file/Buffer 边界的显式清理，不宣称清除 V8、
TLS native heap、内核页缓存或运维备份中的所有副本。

### 4. Provider 不是 credential issuer 或 recovery authority

本 adapter 只消费已由可信部署 ceremony 原子发布的 token，不调用 Cluster Admin 签发接口，不保存服务端
digest/version/expiry，不自动轮换或撤销 credential，也不把认证拒绝解释为可自行签发。共享 transport 只
暴露低敏 HTTP status class；Session client 将 401/403 映射为 credential rejected、409 映射为 fenced，
coordinator 立即停止暴露 Pull authority，但继续在原 Session/lease 上重试 heartbeat。token 修复后同一
Session 恢复，禁止自动 register 新 Session。远端 issue/rotate/revoke/recovery、一次性 secret delivery
acknowledgement、deployment template 与其他 route 的产品策略仍需独立协议和 Gate。

## 被否决的替代方案

1. **启动时只读一次 PEM/token**：active pointer 与 Secret rotation 在进程重启前不生效。
2. **为文件轮换建立 watcher/timer**：增加路由设备常驻资源，并与原子 rename/平台 Secret controller 竞争。
3. **把 token 放入 certificate manifest**：混合 transport possession 与 QingLong principal authority。
4. **把 token 加入 Agent pool key**：每次 token 轮换都复制 TLS socket pool，且 header authority 本不属于 TLS。
5. **provider 收到 401 后自行签发新 credential**：绕过管理 Policy、audit、delivery acknowledgement 与旧
   Session fencing。
6. **新建 credential package**：该 adapter 与 Worker transport 总是同部署、没有独立依赖或发布责任，违反
   D-85/ADR-0087。

## 验收证据

1. 真实 certificate store + 测试 CA 证明 active certificate 与 token 原子替换在下一次 load 可见，旧/new
   material 不混代。
2. credential ID 漂移、token 宽权限、相对路径和非法 ID 均在网络前失败关闭；pre-abort 零 trust/store/file
   读取。
3. provider 返回的 certificate/key/trust Buffer 可幂等 dispose；共享 client 在成功和拒绝路径都调用 hook。
4. Worker Runtime 122/122 通过，覆盖 JSON、stream、TLS 1.3、Session、Offer、Activation、Artifact、
   Completion、Lease 与 production lifecycle；严格类型检查通过。
5. 非 200 response 不读取/保存错误 body；401/403 立即暂停 Pull，409 标记 Session fenced，503 在已观察
   lease 内保持原 Session，并证明 token 修复后只恢复 heartbeat、不创建新 Session。
6. `worker-credential`/`worker-credential-token` 的 `typesVersions` 与既有 exports 对齐，旧 Node module
   resolution 的 TS consumer 不再需要复制 credential ID contract。
