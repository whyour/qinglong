# ADR-0505：固定 Alpine OpenSSL 运行时安全补丁

- 状态：Accepted
- 日期：2026-08-27
- 决策：D-410
- 关联：ADR-0193、ADR-0195、ADR-0196、ADR-0503、ADR-0504

## 背景

提交 `21852199` 的 Kubernetes deployment 与 Security Administration 门均通过，但主 CI run `32944129457` 的 10 个原生 Local/Cluster 镜像 job 全部在 Trivy OS vulnerability gate 失败。共同原因不是 QingLong workspace 依赖，而是固定的官方 Node Alpine runtime digest 仍包含 Alpine 3.23.5 的 `libcrypto3/libssl3 3.5.7-r0`；当前漏洞数据库将其判定为 `CVE-2026-14456` HIGH，Alpine 已在 `3.5.8-r0` 修复。

继续接受旧 runtime、加入漏洞例外或只修某一个 profile，都会让同一发布集合中的镜像处于不同安全基线。仅等待官方 Node tag/digest 刷新则会使已经可试运行的阶段产物无法通过当前安全门。

## 决策

### 1. 保留 immutable Node 基础 digest，并固定升级两个受影响 OS package

五个 runtime Dockerfile 在固定 Node Alpine `FROM` 后执行同一条、单层命令：

```Dockerfile
RUN apk add --no-cache --upgrade \
    libcrypto3=3.5.8-r0 \
    libssl3=3.5.8-r0
```

覆盖 Local Application、Local operator、Cluster Control（含 AI target）、Cluster Admin 与 Worker。不得只依赖 `apk upgrade` 的时间漂移解析，也不得将该 CVE 加入 Trivy ignore。

### 2. 仓库审计把补丁视为关闭条件

Local image、Local operator、Cluster deployment 和 Worker deployment audit 必须验证完整的版本化命令，且对应 Dockerfile 只能出现一次 `apk` 调用。删除版本、漏掉角色、增加第二个隐式 package mutation 或退回受影响版本都必须在进入镜像构建前失败。

### 3. 这是有界的临时基础镜像修正，不是新的运行时能力

该层只替换既有动态库，不新增 workspace package、常驻进程、网络监听或运行时控制面依赖，因此不改变 Edge/Standalone/Cluster 的资源模型和 18-package 边界。构建仍需从 Alpine v3.23 repository 取得固定架构 package；SBOM、实际镜像 package inventory 和 Trivy native architecture gate 共同证明最终内容。

当新的官方 Node immutable digest 已包含不低于 `3.5.8-r0` 的修复版本时，必须通过同一审计、SBOM/inventory 与双架构 Trivy 门后，以新的 ADR 移除显式补丁，不能因 floating tag 看似更新而静默删除。

## 被拒绝的替代方案

### 为 CVE-2026-14456 增加临时例外

拒绝。Alpine 已提供可安装修复，例外会把可消除的 HIGH 漏洞带入所有阶段产物。

### 把基础镜像从固定 digest 改回 floating tag

拒绝。它不能证明每次构建使用相同 runtime，且会把修复与未来未审变更一起引入。

### 只修当前 Local Trial Kit

拒绝。10 个 native image job 使用同一受影响运行时族；Cluster 候选和 Worker 不能保留不同 OS 安全基线。

## 影响

- 所有 QingLong 3.0 runtime family 使用一致的 OpenSSL 修复版本；
- 不增加低配路由设备的常驻 RSS、CPU 或端口，只增加一个很小的镜像替换层；
- immutable base digest 仍可追踪，但构建可重复性还依赖 Alpine 保留所固定的 v3.23 package；
- 官方 Node digest 更新后会有一项明确的补丁移除工作，而不是无限保留额外 OS mutation。

## 验证

- 六个本地 arm64 runtime target 均构建成功，镜像内 `libcrypto3`、`libssl3` 均为 `3.5.8-r0`；
- 使用 `aquasec/trivy:0.70.0` 和 CI 等价的 OS-only、`HIGH,CRITICAL`、`ignore-unfixed` 策略逐个扫描，六个 target 均为 0 vulnerability；
- 四个 deployment/image audit 均要求相同的固定补丁；
- 最终阶段产物资格仍以提交后的 amd64/arm64 原生 CI 全绿为准，本地 arm64 结果不替代远端双架构证据。
