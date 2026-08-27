# ADR-0507：Public Local Application 与 Operator 发布对

- 状态：Accepted（首份真实公开发布待受保护 tag）
- 日期：2026-08-27
- 决策：D-412
- 关联：ADR-0432、ADR-0437、ADR-0503、ADR-0506

## 背景

Local 用户的完整 3.0 旅程已经物理分离为常驻 Application 与短生命周期 operator。前者只运行 Edge/Standalone 数据面，后者通过统一 `ql3` 入口承担 setup、upgrade 和 recovery。Alpha Trial Kit 已同时携带两者，但正式 Public Release Set 仍只列出 Application。

这会产生不可接受的发布断层：受保护 workflow 可以签名并闭合一个无法独立完成 fresh setup 的“Local release”，操作者只能另找未被同一 source、catalog 和 tag closure 证明的管理镜像。把管理命令重新塞回常驻 Application 又会扩大低配路由器的攻击面和稳态资源闭包。

## 决策

### 1. Local family 是两个独立镜像的精确闭包

`local` scope 必须恰好包含：

- `qinglong3-local-application`：唯一常驻 Edge/Standalone service；
- `qinglong3-local-operator`：只在显式管理动作期间运行的 Owner authority。

`all` scope 因此由 Local 两镜像和 Cluster 四镜像组成，共六个；`cluster` scope 仍为四个。两个 Local 镜像分别构建、执行双架构 OCI 证明、OS 漏洞门、digest 签名与 attestation，不能共享 digest record 或由其中一个代替另一个。

### 2. 角色验证必须显式记录

image record 升为 `qinglong/release-set-image-record@v2`。publisher 必须传入 candidate matrix 中的 exact `localRoleVerification`：Application 为 `application_rollout_verified`，operator 为 `operator_entrypoint_verified`，Cluster 角色为 `not_applicable`。Application 必须完成 Edge/Standalone rollout；operator 必须在 read-only、network none、drop-all、no-new-privileges、128 MiB、0.5 CPU、32 PID 边界内通过 `--version` 和 `setup --help`。

release-set 升为 `qinglong/release-set@v4`，OCI artifact/file media type 同步升为 `application/vnd.qinglong.release-set.v4+json`。旧孵化 schema 没有公开 3.0 消费者，因此失败关闭，不引入含糊的自动补全。

### 3. 目标选择绑定 operator，但不把它常驻化

Local catalog selection 升为 `qinglong/local-compose-release-image@v3`，必须同时绑定同一 owner、source 和 release-set 中的 Application/operator immutable digest。Compose revision 升为 `qinglong/local-compose-image-selection@v3`，保存 `operator_image` 作为 setup/upgrade/recovery authority，但 Compose service 仍只有 Application。

发布后的 Local gate 从公开 catalog 重建 selection，拉取并验证 operator 入口，再用 Application 完成 Edge 与 Standalone rollout。operator 不开端口、不运行 listener/daemon/timer，默认无网络；低配设备稳态不新增进程、RSS 或连接。

## 被拒绝的替代方案

### Public Release Set 只发布 Application

拒绝。它没有覆盖 fresh setup 的真实用户旅程，并迫使用户使用 catalog 外管理制品。

### 将 Owner CLI 合并回 Application

拒绝。它把高权限管理闭包带进每个常驻低配设备进程，破坏物理隔离。

### 把 operator 配置为 Compose sidecar

拒绝。管理 authority 没有常驻需求；sidecar 会无谓增加稳态资源和攻击面。

## 影响

- Local 发布和首次拉取最多多一个 operator image；只运行 Application 的稳态不变；
- setup/upgrade/recovery 可在动作完成后删除 operator layer，下一次按 selection digest 重新获取；
- catalog、finalizer 和回退 revision 都能证明两个 Local 角色来自同一 release；
- 旧 v2 Local selection 与 Compose revision 失败关闭，孵化环境必须从 v4 catalog 重新物化；
- 该决策不产生真实 GHCR tag，也不把普通 CI artifact 声称为正式发布。

## 验证

- release candidate、record、set、catalog、publication closure 和 deployment-lock 正反向测试覆盖 `local=2`、`cluster=4`、`all=6`；
- 普通 CI 对 operator 增加独立 multi-arch OCI layout、SBOM/provenance 和 image-scoped Trivy 证据；
- 受保护 release workflow 在 record 前验证角色，在 catalog consumption 后再次验证 operator 入口；
- Local Owner CLI 的 prepare、upgrade、rollback 和 adopted deployment fixtures 保留同一 operator digest；
- 完整 backend、package boundary、Local Owner CLI 和静态 workflow 审计通过后才允许提交。
