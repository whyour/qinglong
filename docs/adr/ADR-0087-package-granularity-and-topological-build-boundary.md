# ADR-0087：Package 粒度与拓扑构建边界

- 状态：Accepted（粒度规则、五批物理合并、ADR-0106 Profile wrapper 收敛、21 importer 门禁、stale-dist 清理、CI 拓扑 build/test 与单包递归脚本退出均已完成）
- 日期：2026-07-21
- 关联 RFC：QL-RFC-0001 D-16、D-61、D-62、D-65、D-68、D-69、D-70、D-71、D-83、D-84、D-85、D-89
- 关联 ADR：ADR-0042、ADR-0062、ADR-0063、ADR-0066、ADR-0069、ADR-0070、ADR-0071、ADR-0072、ADR-0085、ADR-0086、ADR-0090

> 现行增量：ADR-0106 先将四个只有固定配置值、没有独立依赖或调用方的 Profile wrapper 迁入 `local-profile`/`local-adopted-profile` 精确 subpath，使 importer 从 27 收紧为 23。随后再次按本 ADR 的单 consumer 规则，将 Owner bootstrap/credential recovery 变成 `local-owner-console` 内部模块，并让 `local-owner-maintenance` 直接拥有 GC command adapter 与 `ql3-owner-gc` bin；受审 importer 与 hard cap 进一步收紧为 21。删除的两个包名继续作为 dependency tombstone。ADR-0090 的 production packlist 规则继续适用于现有 importer。

## 上下文

本 ADR 决策时 QingLong 3.0 有 32 个 workspace package importer；Owner maintenance、execution 与 Owner ceremony 三批合并后为 27 个。ADR-0106 进一步确认“制品构建目标”不自动等于 package 边界：四个 Profile wrapper 的依赖闭包分别完全相同且没有独立调用方，迁入两个现有组合包的精确 subpath 后降为 23 个。现行依赖图又证明 ceremony 只有 console 一个生产消费者、GC command adapter 只有 maintenance 一个生产组合，因此两组继续物理收敛为 21 个 importer。单文件 package 本身仍不一定错误；`@qinglong/local-command-file` 只有一个实现文件，但由两个 CLI 复用并承载独立的 POSIX 文件安全协议。

问题在于 package 曾被当作所有模块、use case 和 authority 的默认隔离手段。合并前 32 个 package 中有 13 个只有一个源文件，25 个 package 的 `build` 手写递归调用其他 package 的 build；全部展开约 198 次 build。三批合并后先降为 27 个 package、9 个单源 package、20 个递归 build script 和约 144 次 build；完成拓扑构建退出后，27 个 package 的 `build` 均只执行一次自身 `tsc`，全量构建固定为 27 次，`runtime-core` 从 84 次降为 1 次。

package 数量不会直接等于路由设备常驻 RSS，因为未 import 的模块不会加载；但它会增加 lockfile/importer、manifest、TypeScript build、CI matrix、版本协调、依赖审计 allowlist 和贡献者认知成本。反过来，为了减少数字而合并独立权限或部署边界，又会让 edge 安装破坏性 admin 代码或让 cluster/local authority 混合。

## 决策

### 1. Package 不是默认模块边界

新 package 至少必须满足下列一项，并在 ADR/manifest 中说明：

1. 独立可部署、可发布、带 `bin`，或定义一个受审 Profile 制品闭包；
2. 拥有不同 platform/engine/native/第三方生产依赖边界；
3. 为了让高权限、破坏性或短生命周期代码不进入常驻制品而必须物理隔离；
4. 被至少两个 production package 复用，且拥有稳定、窄的公开 contract；
5. 需要独立版本、发布节奏或供应链裁决。

若只表示一个 use case、只有一个 production consumer、与 consumer 总是共同部署、没有不同依赖或权限边界，则默认放在同一 package 的 internal module 或显式 subpath export。文件数和 LOC 只能触发评审，不能单独决定合并或保留。

### 2. 保留的单文件/薄 package 边界

以下薄 package 当前有充分理由保留：

- `local-profile`、`local-adopted-profile`：前者拥有基础本机组合 contract，后者独占接管写栅栏/local-admin 依赖；四种制品通过 `/edge|standalone` subpath 表达；
- `local-command-file`：两个 CLI 复用、无领域依赖的私有文件安全协议；
- `local-secret-admin`：必须排除在常驻 application 之外的高权限短生命周期 authority；
- `local-identity`：未来 runtime authentication 与 Owner ceremony 共享的稳定身份边界，不能成为 console 私有实现。

`runtime-core`、`local-sqlite`、`cluster-postgres`、`cluster-control`、`cluster-admin`、`worker-runtime`、`local-process`、`local-owner-keyring`、`local-secret`、`local-cutover` 和产品 Owner CLI 也继续保持 package 边界，原因分别是 kernel、数据库方言/角色、部署面、OS/文件权限、制品排除或二进制入口。`ql3-owner-gc` 仍是独立二进制，但二进制目标本身不再自动构成 importer。

### 3. 第一轮合并候选

在不改变公开行为和执行流的前提下，按三个 bounded refactor 实施：

1. （已完成）将 `local-execution`、`local-execution-control`、`local-run-recovery`、`local-dispatch` 合并为 `@qinglong/local-execution`，只导出 `/execution`、`/control`、`/recovery`、`/dispatch`，不提供聚合根入口；内部只允许 recovery→control 与 dispatch→execution，side-effect/dynamic/require/from import 均进入同一 source-boundary 审计。`local-process` 继续独立，避免 OS capability 与策略重新耦合。
2. （已完成）将 `local-owner-pepper-gc` 与 `local-owner-acknowledgement-gc` 合并为 `@qinglong/local-owner-maintenance`，仅导出 `/pepper-gc` 与 `/acknowledgement-gc`，不提供聚合根入口。source boundary 把 destructive keyring 与两个 SQLite GC 权限分别锁定到对应源文件；GC CLI 本来就同时安装二者，因此没有扩大任何常驻制品闭包。
3. （已完成）将 `local-owner-bootstrap` 与 `local-owner-credential-recovery` 合并为 `@qinglong/local-owner-ceremony` 的 `/bootstrap` 与 `/credential-recovery` 独立 subpath，不提供聚合根入口。两个 subpath 禁止互相导入，只有 bootstrap 可取得 `local-identity`；console 只能导入两个精确入口。`local-identity`、`local-owner-console`、`local-owner-keyring` 和产品 CLI 继续独立。
4. （已完成）在 ADR-0106 后重新检查生产反向依赖：`@qinglong/local-owner-ceremony` 仍只有 `local-owner-console` 一个 consumer，二者总是共同安装、共同退出常驻制品，且 ceremony 没有独立第三方依赖、bin 或发布责任。其 bootstrap/credential-recovery 源文件与测试已迁入 console，两个模块继续禁止互相导入，只有 bootstrap 可取得 `local-identity`；它们不再作为 public package subpath 暴露。旧 package 名保持墓碑。
5. （已完成）`@qinglong/local-owner-gc-cli` 只有 `@qinglong/local-owner-maintenance` 一个 production dependency 且没有第二个消费者；其 command adapter、测试和 `ql3-owner-gc` bin 已并入 maintenance 的 `/command` 精确入口。destructive keyring、SQLite pepper GC、acknowledgement GC 权限仍按源文件分别门禁，产品 Owner CLI 不能导入 maintenance。旧 GC CLI package 名保持墓碑。

前三轮从 32 降至 27 个 importer，ADR-0106 删除四个无独立依赖责任的 wrapper，后两轮又删除两个单 consumer package，当前为 21 个。不得为了继续降低数字而合并基础/接管组合、local/cluster storage、admin/runtime 或 secret/keyring 权限边界。每个后续合并仍必须先做 GitNexus upstream impact，使用结构化 import 迁移，跑完整 package、source boundary、production vulnerability 和六种制品门禁。

### 4. 构建由 workspace 拓扑拥有

package `build` 最终只编译自身，不再手写递归 `pnpm --filter ... build`。workspace 根以 pnpm 的依赖拓扑一次构建所有目标；测试分为“已构建的 package test”和“单包开发 convenience command”，CI 不得让每个 package 再递归构建其整个依赖闭包。

统一 `build:packages:ql3`/`test:packages:ql3` 编排先由受测清理器只删除具有 manifest 的 `packages/ql3-*/dist`，再由 pnpm 按 workspace 拓扑对当前 21 个 package 各执行一次自身 `build`，随后在已构建图上并发执行精确 `test/*.test.cjs`。CI 已切换到该根级拓扑，不再在 job 中逐包递归 build。所有 package 的 `build` 固定为 `tsc -p tsconfig.json`，并由 dependency audit 拒绝 `prebuild`/`precheck` 和手写 `pnpm --filter` 递归链。单包 `test/check` 通过共享的 `ql3-build-package-closure.cjs` 从当前 manifest 名称推导 pnpm dependency closure；它使用无 shell 参数数组、限制 cwd 为直接 `packages/ql3-*`、拒绝非 self-only build，因而 clean checkout 仍可单独测试而不会把递归重新藏回 build lifecycle。

### 5. 数量门禁只允许收敛

依赖审计的 importer hard cap 已从 64 收紧为 32，并随 Owner maintenance、execution、Owner ceremony、Profile wrapper、ceremony→console 与 GC CLI→maintenance 六批收敛依次降为 31、28、27、23、22、21。后续每完成一批合并都必须同步下调。若新需求满足独立 package 条件，必须先合并或移除一个不再合理的边界，或通过新 ADR 明确修改预算。

## 被否决的替代方案

1. **所有领域概念一个 package**：把模块边界误当发布边界，拒绝。
2. **所有 local 包合成一个 package**：让 admin、GC、setup 和常驻 runtime 共享安装闭包，拒绝。
3. **按 LOC 小于固定值自动合并**：Profile importer 和安全叶子会被误判，拒绝。
4. **保留 64 importer 宽松上限**：无法阻止每个新 use case 继续创建 package，拒绝。
5. **只优化 CI cache、不改递归 build**：掩盖 6.2 倍任务展开和本地开发成本，拒绝。
6. **先删除所有依赖 build 命令**：clean checkout 的单包测试可能找不到 dependency `dist`，拒绝。

## 验收证据

1. 当前依赖审计登记 21 个 importer、456 个 TypeScript source file，所有 exact dependency/source boundary `findings=[]`；hard cap 已同步收紧为 21，lockfile 已移除四个 wrapper、ceremony 与 GC CLI importer。
2. 当前剩余 3 个单源文件 package、0 个递归 build/prebuild/precheck script；全量构建从约 198 次降为精确 21 次，`runtime-core` 每轮仍只编译 1 次。
3. `local-profile` 与 `local-adopted-profile` 完整测试为 12/12；四个固定 Profile subpath 均保持 default-off/固定值语义。
4. 六种 Profile 制品继续通过；单 consumer 收敛后的当前最大 application 为 standalone 的 2,502,983 bytes、413 files、72 loaded modules、12,632,064 bytes RSS delta，且不含 `@aws-sdk/*`。该 RSS 是本机抽样，只用于硬门禁。
5. production vulnerability registry 已同步为 21 importer；本次联网 advisory 结果为全部 QL3 importer 0 条、legacy 根单独保留 2 条 high，未知 importer/finding 均为 0。发布流水线仍必须重新获取，不能用删除 importer 隐藏 legacy 根或未知 importer finding。

## 后续约束

本 ADR 的五批领域合并、ADR-0106 Profile wrapper 收敛、21 importer hard cap、CI 拓扑构建和递归脚本退出均已完成；本次已从清空全部 `dist` 的状态完成根级 21 次拓扑构建与全包测试。后续若增加 package 或改变依赖方向，必须继续通过 importer cap、self-only script、clean build、全包测试、联网依赖和六种制品门禁；不再以 package 数字替代真实依赖、权限和资源边界。
