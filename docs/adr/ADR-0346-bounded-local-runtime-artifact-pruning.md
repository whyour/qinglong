# ADR-0346：有界本机 Runtime Artifact 裁剪

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-07、D-17、D-85、D-87、D-257
- 关联 ADR：ADR-0195、ADR-0217、ADR-0267、ADR-0276、ADR-0345

## 背景

完成 Tool Registry ownership 后，QingLong 3.0 仍保持 16 个有部署、权限、依赖、适配器、多消费者或供应链理由的 workspace package，且没有单源码或浅层 package。继续按文件数合并 package 会破坏这些边界；继续做纯 owner 拆分又会让最紧的 Edge Application AI 制品越过 6 MiB 门限。ADR-0345 的基线为 6,272,382 bytes，只剩 19,074 bytes 余量。

部署产物审计发现两类不参与运行的确定性冗余：删除 `.map` 后仍留在编译 JavaScript 末尾的 `sourceMappingURL` 指令，以及为开发者阅读而缩进、但字段必须完整保留的内部 `package.json`。应用加 AI 的九个内部 package 分别可回收 26,922 与 11,231 bytes，不需要删除 export、typesVersions、依赖或供应链元数据。

编辑前 GitNexus upstream impact：既有 `pruneRuntimeDevelopmentFiles` 为 LOW（1 direct/2 total/0 process），artifact audit `main` 为 LOW（1/1/0），`auditDockerfile` 为 LOW（1/3/0）。共享裁剪器建立并重建索引后，`pruneRuntimeArtifact` 为 LOW（2 direct/3 total/0 process），两个内部 helper 均为 LOW（1 direct/4 total/0 process）。

## 决策

新增 build-time `scripts/ql3-prune-runtime-artifact.cjs`，但不新增 workspace package、生产 dependency、runtime module 或公开 subpath。它只接受形如 `node_modules/@qinglong` 的窄目录，先完整清点并拒绝 symlink、特殊文件、缺失或非法直接 package manifest，再执行三类有界操作：

1. 删除内部 package 的 `.d.ts` 与 `.map`；
2. 只删除 JavaScript EOF 处、文件名受限的失效 `sourceMappingURL=*.map` 指令；
3. 对直接 `@qinglong/*/package.json` 做 `JSON.parse`/`JSON.stringify` 等价紧凑化，只有字节数实际减少才原子替换，并保留文件 mode。

本机 profile artifact audit 与生产 Local Application Dockerfile 复用同一裁剪器。审计保留原 `prunedRuntimeDevelopment*` 字段，并增量报告 sourcemap、manifest 与总回收字节。Local image 静态门要求 Dockerfile COPY、调用并删除临时裁剪器，防止审计和真实镜像行为漂移。

本批不修改源码 package manifest，不删除任何 manifest 字段，不对外部 npm package 动手，也不把裁剪器放进最终镜像。Cluster control/admin/worker 镜像保持原路径；在为各镜像建立独立体积与 SBOM 等价证据前，不扩大裁剪范围。

## 小设备与集群影响

十档产物的 package/file/module closure 不变。与 ADR-0345 相比，Edge/Standalone 各减少 22,298 bytes，Adopted 各减少 25,614 bytes，Application 各减少 28,179 bytes，AI 各减少 32,272 bytes，Application AI 各减少 38,153 bytes。

新的 Edge/Standalone 为 3,641,763/3,641,799 bytes，Adopted 为 4,258,956/4,259,016，Application 为 4,754,240/4,754,360，AI 为 5,121,686/5,121,734，Application AI 为 6,234,229/6,234,361。最紧 Edge Application AI 的 6 MiB 余量从 19,074 增至 57,227 bytes；预算没有放宽。

真实 arm64 Local Application image 构建成功。Edge 在 128 MiB/64 PIDs、Standalone 在 256 MiB/256 PIDs 下均以 UID/GID 65532、只读根文件系统和无网络完成 active、SQLite integrity 与 graceful stop。没有新增连接、Pool、timer、线程、常驻对象或集群角色。

PostgreSQL 18.4 arm64 HA 门继续通过 `remote_apply`、timeline 1→2、旧主先 fencing、晋升后单写目标与 `pg_rewind` 只读同步 rejoin；两个 fresh control activation 以及 Tool、Workflow、AI、Package durability gate 全部为 true。Local build-time 裁剪没有进入或改变 Cluster 数据路径。

## 被否决方案

1. 为裁剪器新增 workspace package：它是构建期供应链工具，不是部署或 runtime 能力边界。
2. 合并现有 16 个 package 来省 manifest：会破坏已审计的权限、依赖和部署边界，收益也不能证明等价。
3. 删除 `exports`、`typesVersions`、dependency 或 license 字段：会改变模块解析、消费者工具或 SBOM 事实。
4. 全量 minify 生产 JavaScript：收益更大但会改变调试与审计可读性，需要独立 source/debug policy。
5. 同时裁剪全部 Cluster/Worker 镜像：各镜像的 declaration、SBOM 与诊断需求不同，不能由 Local 证据外推。

## 验收证据

- 裁剪器定向测试覆盖语义等价、可执行 mode、非终端指令保留、symlink fail-before-mutation 与坏 manifest fail-before-mutation；相关 Local image 测试合计 10/10。
- 完整 16-package clean build/test 为 445/445；package-boundary、cluster-dependency、edge-import 与 local-image 审计 compatible。
- 十档 artifact 全部 compatible；最紧档实际回收 38,153 bytes，未提高 6 MiB 上限。
- 真实 arm64 image 构建成功，构建期报告删除 1,178 个开发文件、392 个失效指令并紧凑化 8 个 manifest；最终内部闭包 402 files，`.d.ts/.map`、失效指令、非紧凑 manifest 与临时裁剪器均为 0，Edge/Standalone live contract 均 compatible。
- 完整后端门先暴露 4 个此前 owner/package-closure 变化留下的旧快照；按当前 compatible 审计事实校准后最终为 1,117 pass、0 fail、2 skip。
- PostgreSQL HA Docker 门 `gates.passed=true`，HA 专用容器、网络和卷均已清理。
- GitNexus 重建为 44,589 nodes/101,675 edges/1,736 communities/296 flows；post-impact 中裁剪器为 LOW（2 direct/3 total/0 process），两个内部 helper 均为 LOW（1/4/0），Dockerfile 审计仍为 LOW（1/3/0）。`detect_changes` all 为 12 files/31 symbols/0 process/low，compare `develop` 为 14/34/0/low；当前 QL3 孵化树大部分尚未进入 Git 基线，因此该结果只作为补充证据。

## 后续约束

裁剪必须维持先验证后变更、窄根目录、无 symlink、只处理内部 package、manifest 字段等价、EOF sourcemap 精确匹配和原子写入。新增删除模式、外部 package、JavaScript minification、Cluster/Worker 复用或 manifest 字段裁撤必须独立评审。包数量继续由边界理由决定，不能把这一批的字节收益解释成继续制造微包的空间许可。
