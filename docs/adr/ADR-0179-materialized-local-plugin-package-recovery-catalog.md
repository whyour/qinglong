# ADR-0179：Materialized Local Plugin Package Recovery Catalog

- 状态：Accepted
- 日期：2026-07-27
- 关联：RFC D-65、D-138、D-147、D-168、D-169；ADR-0138、ADR-0140、
  ADR-0143、ADR-0178

## 背景

本机 Plugin Package install repository 会把完整 `PackageLock` 和 queued/staged/
activating 状态持久化，但 lock 有意不保存主机文件路径、Registry credential 或其他
部署细节。进程若在 durable create 之后、stage 之前退出，下一次启动必须能按同一 lock
重做 stage；否则 ADR-0140 的 admission gate 会正确地失败关闭，却没有可用的产品恢复
路径。

把 `bundlePath` 写入 durable lock 会把主机拓扑变成领域事实，并让备份恢复依赖旧路径；
让常驻 application 直接拉 OCI 又会把网络、Registry credential、重试和供应链 authority
带进低配路由设备的 steady-state runtime。offline 与 OCI lock 的恢复也不能使用两套
不同的签名和内容校验语义。

## 决策

### 1. 使用按 lock digest 寻址的本机物化 catalog

`@qinglong/local-application/plugin-package-recovery-catalog` 在既有 package 内提供
`PluginPackageStageProvider`，不新增 workspace package。配置显式选择：

```json
{
  "mode": "materialized_catalog",
  "catalogRoot": "/opt/qinglong/private/plugin-package-catalog",
  "bundleRoot": "/opt/qinglong/private/plugin-package-bundles",
  "publisherTrustFilePath": "/opt/qinglong/private/plugin-package-publisher-trust/current.json"
}
```

catalog root 只允许当前 real/effective UID 拥有的、非 symlink、真实路径不漂移的
`0700` 目录。目录最多包含 64 个条目，而且只能出现
`<64-lowercase-hex-lockDigest>.json`；未知文件或越界目录整体失败关闭。

每个 source entry 必须是当前 UID、regular、no-follow、精确 `0600`、最大 256 KiB 的
exact-shape JSON：

```text
schema = qinglong/local-plugin-package-recovery-source@v1
lockDigest
source = exact durable PackageLock.source
bundlePath = bundleRoot/<source.artifactDigest>.bundle
manifest
signature
```

读取前后复验 catalog directory identity；私有 JSON reader 在打开前、打开后和读取后
复验文件 device/inode/UID/mode/size，并多读一个 byte 防止并发增长。

### 2. offline 与 OCI lock 共用本地 bundle 验证语义

`source.kind` 可以是 `offline` 或 `oci`，但 source 的 kind、locator、artifact digest、
artifact bytes 和 content digest 必须与 durable `PackageLock` 完全相同。OCI locator
仍保持 digest-pinned；catalog 中的 `bundlePath` 只是部署/管理 authority 已下载完成的
本地副本，不把 locator 改写成 offline。

provider 复用既有 `createLocalPluginPackageFileStageProvider`，因此两种 source 都执行
同一组发布者 Ed25519 trust/lifetime、签名、canonical manifest、tar、artifact、
content 和 install-plan 校验，并写入既有私有 opaque staging。已存在的 exact stage
按原协议 replay，不重新解释为新 generation。

### 3. trust 是每次 stage 重新读取的私有 authority

publisher trust 文件必须是当前 UID、regular、no-follow、精确 `0600`、最大 256 KiB
的 exact-shape JSON：

```text
schema = qinglong/plugin-package-publisher-trust@v1
keys = PluginPackagePublisherKeyDefinition[]
```

每次实际 stage 都重新加载并由既有 `PluginPackagePublisherTrustRegistry` 校验 key
类型、状态和有效期。进程不持有可变 trust cache，也不从环境变量或 catalog entry
接受额外公钥。

### 4. application 只在 queued stage 真实发生时加载 catalog

`pluginPackages.recoverySource` 是 process config 的必填字段：

- `disabled`：空队列可启动；存在 queued stage 时保持 ADR-0178 的
  `QL3_LOCAL_APPLICATION_PLUGIN_SOURCE_UNAVAILABLE`；
- `materialized_catalog`：只在 coordinator 调用 `stage()` 时 dynamic import catalog
  provider。

没有 queued work 时不读取 catalog、trust 或 bundle，也不加载 bundle inspector/
staging 依赖。实现不增加 timer、watcher、socket、网络客户端、第三方依赖或新的
workspace importer。应用不接收 Registry credential，也不负责下载 OCI。

配置规范化同时要求 storage、runtime、staging、activation、catalog 与 trust 的全部
authority path 互不别名。

### 5. catalog 发布与在线 OCI 获取不属于常驻 runtime

本 ADR 只定义消费协议。catalog entry、bundle 和 trust 的认证发布、替换、回收应由
短生命周期、可审计的部署或管理 ceremony 完成；在线 OCI 获取也属于该 authority。
ADR-0180 已产品化本机认证发布、inspect 与有界 collect；ADR-0181 已提供认证 trust
provision、addition-only overlap rotation，并把 key lifetime 绑定到不可变 lock
创建时间。在线 OCI fetch、旧 key retirement/紧急 revoke、自动更新与完整插件市场
仍不属于本 ADR。

## 拒绝方案

1. **把 bundle path/credential 写入 durable lock**：污染可迁移领域事实并扩大
   Secret 生命周期，拒绝。
2. **application 启动时扫描 bundle 目录推断 lock**：文件名不是审批事实，且扫描成本
   与目录内容相关，拒绝。
3. **OCI queued 时由 application 在线拉取**：把 egress、credential 和重试 authority
   带入 steady-state runtime，拒绝。
4. **offline/OCI 各写一套 verifier**：会使签名、manifest 与 digest 语义漂移，拒绝。
5. **常驻 watcher 自动热装**：绕过 durable Approved Action/install head，并破坏低配
   设备空载预算，拒绝。
6. **为 catalog 再拆一个 package**：没有独立部署或版本生命周期，只增加碎片化，
   拒绝。

## 当前证据

- offline 与 digest-pinned OCI lock 都使用真实 Ed25519 签名 bundle 完成 stage；
- source 漂移、trust 权限放宽、未知文件、超过 64 条、缺失 entry 均失败关闭；
- 已存在 exact stage 在原 bundle 删除后仍按既有 staged evidence replay；
- 真实 SQLite durable queued install 经 application recovery 推进到 active，最终
  `safeToAdmit=true` 且 active lock digest 精确一致；
- disabled 和 materialized-catalog 的空队列路径都不加载 catalog module；
- 未新增 package、第三方依赖、timer、watcher、socket或 cluster/runtime authority。
- local-command-file 3/3、local-application 30/30、dependency/source boundary 30/30；
- 22-package clean build/test 全绿，legacy/back 802/802，edge import audit 为 121 modules
  且 forbidden root dependency/import 为空；
- disabled AI benchmark 只加载 1 个 AI module，storage/provider/management authority
  loader 均为 0；
- edge/standalone application 为 4,668,784/4,668,928 bytes、605 files、90 个 startup
  modules；AI-inclusive application 为 5,346,605/5,346,761 bytes、649 files、89 个
  startup modules。四个制品门还会在离线安装后单独加载 catalog public subpath，全部
  在既有预算内。

## 后续门禁

1. publisher trust 的 current-signer impact、旧 key retirement、紧急 revoke、
   rollback 与重签恢复；
2. 短生命周期 OCI fetcher 的 Registry credential rotation、rate limit、审计和
   response-loss 恢复；
3. 固定低配 Linux 路由器的真实冷启动、idle RSS、闪存写入与断电恢复证据；
4. 外部 deployment/cutover controller、API host 与完整插件管理产品面。
