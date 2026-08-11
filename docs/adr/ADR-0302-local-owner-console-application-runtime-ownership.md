# ADR-0302：Local Owner Console Application Runtime 实现归属

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-05、D-06、D-17、D-85、D-87、D-121、D-213、D-257、ADR-0143、ADR-0209、ADR-0267、ADR-0276、ADR-0296、ADR-0301

## 上下文

schema v4 根行数棘轮显示 `@qinglong/local-owner-console` 只有 7 个 source，却由根 `index.ts` 承担 604 个审计行。该文件不是薄
export，而是完整的短生命周期 Application Runtime：验证 POSIX UID、目录/文件 ownership、mode、device/inode，读取并清除 pepper
material，构造 `local_console` principal，打开 Local SQLite bootstrap authority，恢复/发布 credential delivery，并持有 close fence。

这些能力与 `bootstrap`、`credential-recovery`、`delivery`、`authentication` 目录共享同一 Owner Console authority、版本与进程生命周期；
根 package specifier 是公开契约，但物理 `src/index.ts`/`dist/index.js` 不是。为它再建 package 会制造一个只为目录形状存在的微型边界。

移动前 GitNexus 显示根文件与 `openLocalOwnerConsole` 均为 LOW、0 direct/0 process；最宽的
`LocalOwnerConsoleConfigurationError` 为 MEDIUM（10 direct/10 total/0 process），`identity` 为 LOW 2/4/0，其他 helper 与返回对象
方法均为 LOW、0 process，只有 `close` 为 LOW 1/1/0。没有 HIGH 或 CRITICAL，因此本批不改变 POSIX proof、pepper custody、
credential recovery、replay、authority TTL 或 close 语义。

## 决策

1. 将根实现原样归入 `src/application-runtime/localOwnerConsole.ts`，只调整到既有 `bootstrap`、`credential-recovery` 与 `delivery`
   目录的相对 import。
2. 不保留根 wrapper。manifest 的 `main`、`types` 与根 export 直接映射嵌套编译产物；公开
   `@qinglong/local-owner-console` specifier、symbol、类型和 error identity 保持不变。
3. package 内根契约测试改用公开 self-reference；依赖防火墙把新的 Application Runtime 路径登记为受审 ceremony consumer，身份认证
   authority allowlist 不扩大。
4. package ledger 将根文件/根行 hard cap 从 1/604 降为 0/0；一个 package 可以没有物理根 source，公开入口由 manifest 精确映射领域
   module，不以装饰性 `index.ts` 换取目录外观。
5. 不新增 workspace package、生产依赖、数据库对象、connection、timer、listener、进程、binary 或部署单元。

## 被拒绝的方案

- **保留根 facade**：物理旧路径没有兼容价值，只会留下无职责 root cap 和包内反向依赖。
- **拆成 POSIX Proof、Owner Recovery 新 package**：两者没有独立部署、版本或故障边界，会扩大低配部署的 importer、lockfile 与 SBOM。
- **同时拆分 604 行 Runtime**：路径归位可证明零行为变化；同步重写 custody/recovery/close 顺序会扩大安全审查面。
- **保留空 `index.ts`**：空入口仍是无语义文件；manifest 已能稳定提供根 package specifier。

## 接受条件

1. Local Owner Console 保持 7 source，root 1→0、604→0 审计行，nested 6→7；workspace 保持 19 package/768 source，
   root 38→37、nested 730→731。
2. 根 package specifier 与所有既有 subpath 保持；Console、完整 19-package clean build/test 和 backend 通过。
3. 旧根源码与 clean build `dist` 根产物均不存在；实现只在 `application-runtime` 产生。
4. dependency/boundary/Edge/Local image 与十档本机制品门 compatible，低配 Profile 预算不回退。
5. 强制 GitNexus 不增加产品流程，关键 symbol 调用半径不扩大，`detect_changes` 保持 low/0 affected process。

## 接受证据

- package boundary schema v4 报告 Console 为 7 source、0 root/0 root lines/7 nested；workspace 仍为 19 package/768 source、
  37 root、731 nested，`singleSourcePackages=[]`。
- Console 45/45、完整 19-package clean build/test 与 backend 1,112（1,110 pass/2 skip/0 fail）通过；clean build 的 `dist` 根为空，
  只在 `dist/application-runtime` 生成 `localOwnerConsole.*`。
- dependency 47/47、package boundary 7/7、Edge import 与 Local image 审计全部 compatible；受审 ceremony consumer 路径迁移后
  未放宽 identity authority。
- 十档本机制品门全部 compatible：基础 Edge 为 3,635,197 bytes/332 files/48 modules；最大 Standalone Application AI 为
  6,123,790 bytes/491 files/104 modules，各档 artifact/file/module/RSS 均未越界。
- 强制 GitNexus 刷新为 43,338 nodes/98,546 edges/1,701 clusters/269 flows。移动后 `openLocalOwnerConsole` 仍为 LOW、
  0 direct/0 total/0 process，配置错误保持 MEDIUM 10/10/0，`identity` 保持 LOW 2/4/0，`close` 保持 LOW 1/1/0；
  `auditSourceImports` 仍为 LOW 0/0/0。`detect_changes` all 为 12 files/31 symbols，compare `develop` 为 14/34，均
  low/0 affected process。
- 本批不修改 SQL、migration、生产依赖或 Cluster 状态，不需要重复 PostgreSQL HA 物理门。
