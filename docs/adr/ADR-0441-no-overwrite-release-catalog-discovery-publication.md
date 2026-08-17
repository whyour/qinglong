# ADR-0441：Release Catalog Discovery Tag 无覆盖发布

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-336、D-347、D-349
- 关联 ADR：ADR-0428、ADR-0430、ADR-0439
- Supersedes：ADR-0428 中允许直接向 discovery tag 重发内容的恢复语义，以及 catalog plan/receipt v1

## 上下文

ADR-0428 把 `v<version>-<scope>` 定义为无部署 authority 的发现入口，并要求部署只信任验证后的 immutable manifest digest。
ADR-0439 又要求相同 source evidence 的合法 workflow 重跑生成相同 release-set 与 catalog identity。

但发布 workflow 仍直接对远端 discovery tag 执行 `regctl artifact put`。OCI Distribution tag 没有跨 registry CAS；如果该 tag 已被外部
写成另一个 digest，直接 put 会先覆盖冲突事实，再在新 digest 上完成验证。response-loss 重跑也无法区分“远端已经是同一确定内容”和“远端
曾指向不同内容”。workflow 的同 ref concurrency 只能串行本仓库 Actions 运行，不能证明 registry 没有其他 package writer。

## 决策

1. catalog plan 升为 `qinglong/release-catalog-plan@v2`，publication policy 固定声明：
   - staging/discovery tag authority 均为 `none`；
   - discovery 冲突必须在 mutation 前失败；
   - response-loss 只能复用 exact manifest digest；
   - immutable digest 仍是唯一部署 authority。
2. publisher 必须先把 canonical release-set 发布到 runner 私有的 `ocidir://` layout，并从该 layout 取得 manifest digest 和 raw
   manifest。绝不再直接对 discovery tag 执行 `artifact put`。
3. publisher 随后读取远端 catalog tag inventory。首次发布时 repository 可能尚不存在；只有在 inventory 读取失败后，才允许把本地
   immutable manifest copy 到 `staging-<plan-digest>`。该 deterministic staging tag 无 authority，写后必须解析为同一 manifest
   digest，再重新读取 inventory。第二次读取失败即失败关闭。
4. `qinglong/release-catalog-tag-inventory-decision@v1` 对 tag inventory 执行最大 1 MiB、canonical line、OCI tag 字符集和
   无重复校验。若 discovery tag 存在，必须读取其 digest；若缺失，则以显式 `absent` 状态进入 publication decision。
5. 新的 `qinglong/release-catalog-publication-decision@v1` 只接受已通过 exact manifest contract 的本地 manifest：
   - `absent` 产生 `publish_if_absent`；
   - exact digest 产生 `reuse_exact_digest`，用于 response-loss 恢复；
   - 任意不同、缺失格式或非 SHA-256 观察值在 discovery mutation 前失败。
6. `publish_if_absent` 只能从本地 immutable reference copy 到 discovery tag；`reuse_exact_digest` 不写 registry。两条路径都必须
   再读取 discovery digest、按 immutable reference round-trip release-set、逐字节比较本地/远端 raw manifest，然后才允许签名、
   provenance 和 receipt。
7. catalog receipt 升为 `qinglong/release-catalog-receipt@v2`，明确绑定
   `fail_closed_before_mutation` 与 `reuse_exact_manifest_digest_only`。release-set v3 和 OCI media type 不变，因为被发布的
   canonical release-set bytes 没有改变。
8. OCI registry 仍没有 tag CAS，因此本 Gate 不宣称能阻止仓库外 writer 在 inventory 与 copy 之间竞争。workflow 保持同 ref 串行，
   package write authority 必须由组织治理；最终回读会发现写入期间的竞争，而任何稍后改写也不能改变 receipt/provenance 中的 immutable
   digest。consumer 继续禁止把 discovery tag 当作 authority。

## 失败与恢复

- discovery 已指向不同 digest：不执行 discovery copy，不覆盖现场；操作者必须调查 tag/source/package authority，不能以重跑“修复”。
- discovery 已指向 exact digest：不重新发布，继续 immutable round-trip、签名和 provenance 验证，得到与首次成功相同的 durable
  plan/receipt bytes。
- catalog repository 尚不存在：deterministic staging copy 只用于建立 repository 和确定可读 tag inventory；staging tag 永远不能进入
  deployment lock。
- registry/auth/network 不可用：staging 或第二次 inventory 失败即停止；不能把不确定读取当成 tag 缺失。
- discovery copy response 丢失：重跑后 inventory 必须看到 exact digest 并走 reuse；看到其他 digest 则失败。

## 部署与资源影响

- Edge/Standalone/路由设备继续只接收 catalog-bound Local selection 和 immutable image digest，不安装 regctl、Node、Cosign 或 GitHub
  CLI，不增加 RSS、I/O、timer、listener、updater 或后台任务。
- Cluster 节点、Kubernetes object、CloudNativePG、数据库、migration、SQL、Pool 与运行时镜像均无变化。
- 新工作只在短生命周期发布 runner：一个私有 OCI layout、至多 1 MiB tag inventory、一次 publication decision 和必要时一次 staging
  copy；不新增 workspace package、生产依赖或常驻服务。

## 被拒绝的替代方案

### 继续直接 artifact put 后再验 digest

拒绝。后验一致只能证明覆盖后的结果，不能保留或拒绝原有冲突。

### 把 workflow concurrency 当作 registry CAS

拒绝。它只串行同仓库同 ref 的 Actions run，无法约束其他 package token、组织管理员或 registry 外部 writer。

### 让 discovery tag 成为不可变部署入口

拒绝。OCI tag 仍可改写；唯一可持久签名、attest 和部署锁定的 authority 是 manifest digest。

### 为 catalog 新增常驻协调服务

拒绝。发布路径不值得引入新的服务、数据库和低配设备依赖；确定性 staging、冲突决策与 immutable consumer 已能把剩余竞态限制在非权威 tag。

## 验证

- contract 覆盖空/存在/重复/畸形/超限 tag inventory、absent publish、exact response-loss reuse、不同 digest 冲突、非法观察值和
  closed CLI；
- workflow 静态门拒绝 direct discovery `artifact put`、缺失 publication decision、缺失 exact reuse、无界/malformed inventory 和未回读
  immutable digest；
- catalog consumption、deployment-lock、Local/Cluster post-publication gate 必须继续只消费 immutable reference；
- 定向发布链 143/143，完整 backend 1,371 项为 1,369 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0；
- 12 项静态审计和 14 档 Local artifact 全部 compatible，默认 Edge/Standalone 至 MCP 的既有字节/RSS 上限未漂移；
- PostgreSQL 18.6 arm64 physical HA 通过 142/142、timeline `1→2`，证据 SHA-256 为
  `13e2f3793d7f418f0c1cc3b05206b393c4f09a45e1b9a5783219c12fb930b3dd`，离线审计 compatible 且 Docker 资源零残留；
- 完整证据记录于 QL-RFC-0001 D-349；首份真实 GHCR conflict/reuse 证据仍须由受保护 `v3` release tag 产生。
