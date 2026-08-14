# ADR-0399：物理 Edge 证据的外部发布归档证明

- 状态：Accepted（协议、exact recorder 重建与本地离线验签已实现；18-package/backend/边界门通过，固定物理设备和真实 release ceremony 待执行）
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-86、D-196、D-307
- 关联 ADR：ADR-0088、ADR-0206、ADR-0363、ADR-0398

## 上下文

物理 Edge 聚合报告已经能绑定设备、数据文件系统、同 boot workload，以及最终
systemd/OpenRC unit 直接运行的 Node、production application artifact 和 startup
receipt；但它仍把 `release_archive_signature` 保留为发布 Gate。仅记录 Git revision
或归档 SHA-256 不足以证明归档、源码 revision、设备实际运行 artifact 与 Node 是同一
次发布决策；让 QingLong 自己生成并保存发布私钥，又会把构建、签发和验证 authority
混入低配设备工具。

基础 importer 还存在一个较窄的身份绑定缺口：Edge Executor、Node SQLite 和 Plugin
Package recovery 三个子 workload 虽在 recorder 中由同一进程启动，离线重建时没有逐项
复验其 platform/architecture。攻击者可以在重算外层摘要后把其他主机报告注入统一报告。

## 决策

新增非 workspace-package、无第三方依赖、无常驻进程的
`scripts/ql3-physical-edge-release-evidence.cjs`，根命令为
`evidence:physical-edge-release`。它只承担确定性载荷生成与验签，不持有或调用私钥。

协议分两阶段：

1. `prepare` 读取当前 UID 所有、`0600`、无 symlink 的统一物理报告，完整重建其 manifest、
   三个基础 workload、全部 supplemental evidence、qualification 和 SHA-256；必须已有通过的
   direct release service start evidence，并且 `release_archive_signature` 恰好仍缺一次。
2. 工具以稳定 descriptor 流式读取不超过 64 MiB、不可被 group/other 写入的 release archive，
   生成不带换行的 canonical JSON signing payload。payload 精确绑定 repository、40 位小写
   Git revision、物理报告摘要、设备/boot、归档摘要/字节数，以及实机 direct report 中的
   artifact tree、metadata、entrypoint、Node digest/version。
3. 发布 operator 在工具之外通过 HSM、KMS、离线机或 OpenSSL 使用 Ed25519 私钥签署 payload
   原始字节。私钥不进入 QingLong data path、配置、环境变量、报告或进程参数。
4. `finalize` 从调用方固定的 Ed25519 SPKI 公钥重新计算 SHA-256 fingerprint，重新读取并
   计算全部输入，要求 payload 是 exact canonical bytes，再验证 64-byte detached signature。
   source revision、archive 或物理报告任一漂移都失败关闭；输出以 `0600`、no-replace、fsync
   发布。

通过的最终 envelope 只把 `release_archive_signature` 替换为
`release_archive_signature_or_attestation`。它永久保持 `supported:false`，保留原报告中的
firmware/bootloader、whole-device flash、migration、断电等所有未完成证据。

基础 recorder 同时收紧 workload identity：Edge report 的 `host.platform/architecture`、
SQLite report 的 `platform/arch`、Plugin Package report 的
`identity.platform/architecture` 必须全部等于统一物理观测值。该检查不增加设备工作量，
只拒绝跨主机拼接。

## Operator ceremony

```sh
pnpm evidence:physical-edge-release -- prepare \
  --physical-report=/opt/qinglong/evidence/physical.json \
  --release-archive=/opt/qinglong/releases/qinglong3-edge.tar.gz \
  --repository=https://github.com/whyour/qinglong.git \
  --revision=<40-lowercase-git-revision> \
  --payload=/opt/qinglong/evidence/release-signing-payload.json \
  --json

# 在 QingLong 工具之外签署 exact payload bytes；下面只是一种 operator 实现。
openssl pkeyutl -sign -rawin \
  -inkey /offline/release-ed25519.key \
  -in /opt/qinglong/evidence/release-signing-payload.json \
  -out /opt/qinglong/evidence/release-signing-payload.sig
chmod 600 /opt/qinglong/evidence/release-signing-payload.sig

pnpm evidence:physical-edge-release -- finalize \
  --physical-report=/opt/qinglong/evidence/physical.json \
  --release-archive=/opt/qinglong/releases/qinglong3-edge.tar.gz \
  --payload=/opt/qinglong/evidence/release-signing-payload.json \
  --signature=/opt/qinglong/evidence/release-signing-payload.sig \
  --trusted-public-key=/etc/qinglong/release-ed25519.pub \
  --expected-repository=https://github.com/whyour/qinglong.git \
  --expected-revision=<40-lowercase-git-revision> \
  --output=/opt/qinglong/evidence/physical-release-evidence.json \
  --json
```

public key 与 archive 必须是 canonical regular file、无 symlink，且 group/other 不可写；
physical report、payload、signature 必须为当前 UID 所有的 `0600` 文件。所有输入在读取前后
复验 device/inode/size/mtime/ctime，输出拒绝覆盖已有文件。

## 不证明的内容

- verifier 不展开 archive，也不自行复现 build；“archive、source 与 runtime artifact 属于同一
  发布”的关系由被信任 operator 的签名证明。
- 公钥分发、轮换、撤销、透明日志和 signer 组织流程仍由 release authority 负责。
- 签名不证明固定设备已经采集、firmware/bootloader 起点、exclusive cold cache、整机 CPU
  wakeup、NAND/FTL 写放大、突发断电、adopted migration 或 Cluster 容量。
- 本地生成的测试 key 和合成物理 fixture 只验证协议，不可作为正式 release evidence。

## 被否决的方案

1. **把私钥放入仓库或 recorder**：混合签发与验证 authority，并扩大低配设备 Secret 面，拒绝。
2. **只签 archive digest**：无法绑定 source revision、实机报告和实际运行 artifact，拒绝。
3. **只信任外层物理报告摘要**：无法阻止可重算摘要下的跨 platform workload 拼接，拒绝。
4. **验签成功即设置 `supported:true`**：签名只关闭一个 Gate，不能替代剩余物理证据，拒绝。
5. **为一次性工具新建 workspace package**：没有独立制品、依赖或常驻 authority，违反 package
   边界原则，拒绝。

## 验收

- exact payload、Ed25519 成功验签、公钥 fingerprint、归档篡改、source mismatch、私有文件
  mode、canonical path、no-replace 和 remaining evidence 由 backend contract test 覆盖。
- 跨 platform Plugin Package workload 必须使基础物理 candidate 失败。
- 工具不得新增 workspace package、production dependency、daemon、listener、timer、watcher、
  数据库 migration 或 Edge 常驻导入。
- 阶段合并前必须通过相关定向测试、18-package clean build/test、完整 backend、package 边界、
  dependency/import 审计和 GitNexus staged change 审计。

当前实现完成后，18-package clean build/test 退出 0；完整 backend 为 1,208 项、1,206
通过、2 条 Linux 条件跳过、0 失败。package boundary 仍为 18 个 package，
`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Cluster dependency、Edge import、
service bridge import 与 Cluster deployment 审计均无 finding。以上只验证协议和回归，
本地合成 fixture 与测试 key 不替代固定设备报告或正式 release signing ceremony。
