# ADR-0135：确定性签名 Plugin Bundle 与私有本地 Staging

- 状态：Accepted（确定性 USTAR 检查、Ed25519 publisher trust、流式摘要和 POSIX
  私有 staging adapter 已实现；ADR-0136/0137 已补 SQLite/PostgreSQL durable
  repository，ADR-0138 已把 staging 外部证据接入本地 pointer activation；OCI 拉取、
  信任撤销分发、资源 generation 发布与生产管理入口仍未开放）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-130、D-132、D-133

## 背景

ADR-0134 已把来源、Manifest、安装计划、审批和目标环境锁进不可变 PackageLock，但
PackageLock 本身不会证明提交给安装器的 archive：

- 使用确定且唯一的编码，而不是同内容多种 tar 表示；
- 没有 traversal、symlink、hardlink、device、PAX 或额外文件；
- 来自本实例显式信任且当时有效的发布者密钥；
- 在流式读取、落盘和重启重放之间仍对应同一 artifact/content digest；
- 不会把 Package 内路径直接变成宿主机可访问路径。

低配路由设备不能为验证常驻 watcher、下载器或解压进程；集群节点又必须能复用同一
artifact 和签名事实。archive 检查和文件系统 staging 因此必须分权。

## 决策

### 1. Bundle contract 留在 runtime-core 的按需子入口

新增 `@qinglong/runtime-core/plugin-package-bundle`，不新增 workspace package或第三方
依赖，也不从 runtime-core 根入口导出。它只接受调用者提供的 `AsyncIterable` 和可选
transactional sink；自身不读取文件、网络、环境、数据库，不创建 timer 或后台任务。

bundle v1 media type 固定为 `application/vnd.qinglong.package.v1+tar`，上限为：

- artifact 256 MiB；
- 单 entry 4 MiB；
- Manifest 64 KiB；
- Manifest content 总计 64 MiB；
- 单输入 chunk 1 MiB；
- 发布者 trust registry 32 把 key。

### 2. archive 只有一个确定性 USTAR 表示

archive 必须依次包含 canonical `package.json` 和 Manifest 声明路径的字典序集合，
之后恰好两个 zero block，不能有额外 entry 或 trailing byte。每个 header 固定：

- USTAR magic/version、regular-file type、mode `0644`；
- uid、gid、mtime、owner、group、device、link 和未使用字段清零；
- canonical octal size/checksum；
- fatal UTF-8、安全相对路径和 zero padding。

拒绝目录、symlink、hardlink、device、PAX/GNU extension、路径穿越、重复/缺失/乱序
entry 和非 canonical Manifest。检查器在单次流式读取中计算每个 entry SHA-256、
domain-separated content tree digest 与完整 artifact SHA-256，并与 PackageLock
逐项比较。

### 3. 发布者签名绑定完整 PackageLock 事实

首版只接受 Ed25519。不可变 trust registry 由部署显式提供 publisher、key ID、
SPKI PEM 和 `[notBefore, notAfter)`；没有运行期 register。签名 payload 使用独立
schema，并绑定：

- publisher、key ID、lock digest；
- Package name/version；
- artifact digest/bytes；
- Manifest digest 和 content digest。

签名必须在观测时间处于 key 有效期且通过验证。未知、过期、算法不符或验证失败统一
视为 untrusted，不向调用者泄漏底层密码学错误。此机制不是完整撤销系统；官方索引的
key/version denylist 与安全公告仍是后续发布门禁。

### 4. 文件 authority 只在 local-admin staging 子入口

新增 `@qinglong/local-admin/package-staging`，同样不从 package 根入口或任何 production
composition root 导出。它只接受一次调用提供的绝对 bundle 路径和已存在 staging root：

- 需要 POSIX uid；
- root 必须是当前 uid 所有、真实路径、非 symlink、精确 `0700` 的非根目录；
- bundle 最终分量用 `O_NOFOLLOW` 打开，打开前后 inode/device 必须一致；
- bundle 必须为当前 uid 所有、无 group/world 权限、不可执行且长度与 lock 相同；
- root 最多 64 个已完成 lock 目录；未知 entry 或遗留临时事务失败关闭。

adapter 不按 Package 路径解压。所有 entry，包括 Manifest，写入
`blobs/<ordinal>-<sha256(path)>.blob` 的扁平 opaque 文件；目录固定 `0700`、文件固定
`0600`。每个 blob 先 fsync，再写并 fsync canonical receipt，最后以同一 root 内的
directory rename 原子发布 `<lockDigest>`。最终目录出现即表示 receipt 和全部 blob
完整，不存在半激活语义。

### 5. replay 必须重新验证已落盘事实

同一 lock 已有最终目录时，不要求原始离线 bundle 仍存在，但必须：

- 重新验证 publisher signature 和观测时间；
- 验证 final/receipt/blob 的 owner、mode、type、exact entry set；
- canonical 解析 receipt，并逐项绑定 lock、Manifest path 和 signature evidence；
- 重新流式计算全部 blob digest 和 content tree digest。

任一漂移失败关闭。竞争发布只能接受另一方留下的完全相同且可复验的最终目录。
失败清理只触及当前 root 下由本次调用生成且名称通过固定 pattern 的临时目录和 blob；
未知残留不会自动递归删除。

### 6. staging 本身仍不激活插件

本 ADR 不实现：

- OCI registry client、Git/HTTP source resolver、缓存或自动更新；
- publisher key 获取、撤销 feed、透明日志或官方插件索引；
- staging 与 SQLite/PostgreSQL repository 的生产产品入口；
- Task/Workflow/Prompt/Tool 注册、资源 generation pointer 或旧代回收；
- Runtime/UI Extension、动态代码加载、Trigger activation；
- 具体 Approved Action consumer、startup lifecycle、API、CLI 或 UI。

staging 成功只能提交 ADR-0134 的 `stage_completed` evidence；不能直接使内容可执行。
ADR-0138 的本地组合会把 adapter `receipt.json` 摘要作为独立 evidence 持久化，并由
显式 activation publisher 在切换 pointer 前重新验证全部 blob；这不改变 staging
自身无激活 authority 的边界。

## 影响

- 路由器可使用短生命周期离线文件 capability，验证完成后删除源 bundle；重放从私有
  content-addressed stage 复验，不需要常驻下载器。
- 集群未来的 OCI adapter 可向同一个纯流式检查器供给字节，无需复制 archive 语义。
- Package 内路径永远不会成为 staging filesystem path，压低 traversal 与 symlink
  攻击面。
- `packages/` 仍为 21 个 importer；实现落在既有 runtime-core 和 local-admin。
- base edge/standalone 只增加按需 bundle 文件的闪存成本，loaded module 仍为 39；
  adopted/application 包含 staging authority，但根入口未加载它。
- ADR-0139 加入后的六种制品最新最大值为 2,825,780 bytes/437 files，最大单次
  RSS delta 12,615,680 bytes，仍低于 4 MiB/512 files/16 MiB 门禁。

## 验证

单元和架构门禁必须覆盖：

1. canonical streaming USTAR 与任意 chunk boundary；
2. Manifest/artifact/content digest 与 PackageLock exact binding；
3. missing/extra/reordered entry、非 canonical header/padding/trailing 拒绝；
4. unknown、expired、错误 key 和错误 Ed25519 signature 拒绝；
5. transactional sink commit/abort；
6. 私有 bundle/root、`O_NOFOLLOW` 与 inode identity；
7. opaque blob、mode、receipt、原子 final directory；
8. exact replay 不依赖原始 bundle；
9. receipt/blob tamper 和 stale temporary transaction 失败关闭；
10. runtime-core 与 local-admin 两个 subpath-only export；
11. dependency audit 只允许 staging 源文件访问三个 exact runtime-core subpath；
12. 六种 Profile artifact 和 edge import 门禁。

当前针对性结果为 runtime-core 215/215、local-admin 50/50、local-sqlite 68/68，
cluster-postgres 非数据库全量 124 pass/1 skip；21-package clean build 与全量 package
聚合测试退出 0，六种制品、edge import 和 cluster dependency audit 均通过且
`findings=[]`。
