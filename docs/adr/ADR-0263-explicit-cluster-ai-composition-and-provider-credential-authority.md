# ADR-0263：显式 Cluster AI 组合与 Provider Credential Authority

- 状态：Accepted
- 日期：2026-08-02
- 关联：RFC D-08、D-12、D-85、D-124、D-156、D-159、D-244；ADR-0167、ADR-0169、ADR-0261、ADR-0262

## 背景

ADR-0169 已定义 Project-bound Provider credential、可清零 Secret material 和
audit-before-network，但当时还没有 Cluster 产品组合：binding 与 audit 没有 PostgreSQL
authority，Secret material 没有可部署的 Cluster adapter，默认 Cluster 镜像也不能安全地
选择性包含 AI。

QingLong 3.0 同时服务低配路由设备和多副本 Cluster，因此不能通过以下方式补齐能力：

- 让默认 control image、Edge 或 Standalone 常驻安装/加载 AI；
- 为 binding、Secret adapter、composition 或 CLI 各拆一个单文件 workspace package；
- 让常驻 control 持有 Kubernetes API、Secret list/watch 或 credential mutation 权限；
- 把静态环境变量 token、ConfigMap 明文或进程内 cache 当作 credential authority；
- 只发布一个内容随构建参数变化、却共享同一镜像身份的 Cluster Control artifact。

## 决策

### 1. Credential catalog 与 audit 使用 append-only PostgreSQL authority

在既有 `@qinglong/ai` 包内新增显式 catalog/storage subpath，不新增 workspace package。
`pg-9012-ai-model-provider-credential-catalog` 在 `ql3_ai` schema 追加：

- immutable binding revision；
- generation/CAS 驱动的 `bind|revoke` transition；
- content-free credential use audit。

runtime 只取得 current binding read 与 audit append；binding mutation 只属于既有
`ql3_ai_maintenance` authority。exact mutation 可重放，generation、command 或 binding
identity 漂移必须冲突。audit 只保存 Project、Provider、request、operation、binding
revision/digest 和数据库时间，不保存 SecretRef、token、header、Prompt 或输出。

### 2. Cluster Secret material 使用只读 projected-file adapter

首个 Cluster material adapter 接受一个部署注入的绝对只读目录。文件名是 canonical
SecretRef 的 lowercase SHA-256；每次调用重新解析并读取一个有界 regular file：

- 允许 Kubernetes atomic-writer symlink，但最终文件必须仍位于受信 root 内；
- 拒绝可写、可执行、other-readable、hard-link、路径/identity/size 漂移；
- material 以 owned bytes 返回并由 authorization lease 清零；
- 不使用 Kubernetes client、ServiceAccount token、list/watch、cache、timer 或后台进程。

该 adapter 可以消费 Kubernetes Secret、CSI 或 Secret operator projection，但不把这些
projection 冒充最终 KMS/HSM。轮换由外部 authority 原子替换 projection，下一次调用自然
读取新 material。

### 3. Cluster AI 必须是显式 composition root

AI 产品组合留在 `@qinglong/cluster-control/ai-production`，复用既有认证、Project Policy、
route registry、生命周期和 PostgreSQL runtime contract。只有独立 AI entrypoint 解析
`QL3_CLUSTER_AI_ENABLED=true` 及 AI 配置，并按以下顺序 fail closed：

1. 校验 projected Secret root 与可选 Prompt output keyring；
2. 建立独立、有上限的 PostgreSQL runtime pool；
3. 装配 credential reader/audit、Secret material 与 projected Provider authority；
4. 执行有界 Prompt recovery；
5. 将 Prompt execution capability 注入既有产品 route；
6. 再启动 Cluster Control，并在任一侧不可用时统一有界停止。

默认并发为 4、recovery page 为 32、AI 数据库连接为 4，且都有硬上限。该增量只开放
已经受审的 Prompt execution；Prompt output read、credential management 和通用裸 model
gateway route 仍保持关闭。

### 4. 默认与 AI 镜像是两个独立供应链 artifact

同一 Dockerfile 提供两个显式 target：

- `runtime` / `qinglong3-cluster-control`：只含 runtime-core、cluster-postgres、
  cluster-control，使用干净输出目录编译并断言不存在 AI package、AI composition 和 AI CLI；
- `runtime-ai` / `qinglong3-cluster-control-ai`：额外包含 `@qinglong/ai` 和独立 AI CLI。

CI、OCI layout、SBOM、OS vulnerability scan、签名/证明和 release matrix 均把
`control-ai` 作为第四个独立 artifact，与 control、admin、local 分别 pin digest。不能用
同一 tag 的隐藏 build arg 改变依赖闭包。

### 5. Kubernetes Cluster AI 是 opt-in component

默认 `ql3-cluster` base 保持 AI-free。`components/cluster-ai` 只在显式 overlay 中：

- 将 control image 替换为独立 AI image；
- 注入 canonical Provider authority ConfigMap；
- 以 `0440` 只读 Secret volume 提供 digest-named material；
- 保持 `automountServiceAccountToken: false`，不增加 Kubernetes RBAC/API egress；
- 要求私有 overlay 独立 pin AI image digest。

### 6. Package 边界不因该能力继续细拆

workspace 保持 19 个 package。catalog、repository、projection adapter、composition 与 CLI
分别进入已经承担对应依赖/权限/部署责任的 `ql3-ai` 或 `ql3-cluster-control` subpath。
源码文件数量只能触发复审，不能单独决定 package；新增 package 仍必须满足 RFC D-85 的
部署、权限、依赖闭包、多个 production consumer 或独立供应链责任门。

当前唯一单源 package `@qinglong/local-command-file` 有三个 production importer，并提供
共同的 POSIX private-file/TOCTOU 安全协议，因此暂时保留；如果 consumer 收敛为单一同包
入口，或不再形成共享安全边界，则必须回并为现有 subpath。

## 被否决方案

1. **默认 control image 直接安装 AI**：让禁用 AI 的节点承担依赖、漏洞与演进成本。
2. **每个 AI adapter 一个 package**：没有独立部署或权限收益，重复单文件包问题。
3. **环境变量保存 Provider token**：无法形成 Project-bound revision、轮换和 durable audit。
4. **常驻 control 读取 Kubernetes Secret API**：扩大 ServiceAccount、RBAC、网络和缓存边界。
5. **一个镜像 tag 通过环境变量切换 AI**：无法由 SBOM、签名和 digest 证明实际闭包。
6. **把 projection 宣称为 KMS**：它只解决 Pod 内只读 material delivery，不解决外部
   key custody、wrapping、灾备或 lost-secret ceremony。

## 验证

- `@qinglong/cluster-control`：175 项中 173 通过、2 条外部条件跳过、0 失败；
- `@qinglong/ai`：154 项中 151 通过、3 条外部 PostgreSQL 条件跳过、0 失败；
- Cluster AI composition 独立测试 3/3；deployment audit 40/40；
- release/SBOM/OCI/OS vulnerability policy 合并测试 117/117；
- frozen lockfile install、Cluster dependency audit、deployment audit 和 release audit 全绿；
- 实际 Docker `runtime` 不含 AI package/CLI/composition，`runtime-ai` 三者均存在且 AI CLI
  可执行；实际 `control-ai` inventory 为 47 components，其中 4 个 internal、43 个 external；
- PostgreSQL 18.4 arm64 physical-streaming HA 完成 `remote_apply`、timeline 1→2、旧主
  fencing、`pg_rewind`、双 fresh control；binding bind/revoke/rebind 与 content-free audit
  在晋升后保持一致，总 gate `passed=true`；
- 所有 `ql3-ha-*` 临时资源已清理，既有 evidence control-plane 未被修改；
- workspace 仍为 19 个 package，dependency findings 为空。

## 后续门禁

1. 为 binding bind/revoke、测试连接和 audit query 增加经过认证、Policy 与 quota 约束的
   Cluster 管理 ceremony；常驻 runtime 不取得 mutation authority；
2. 引入真正的 KMS/Vault/HSM custody adapter、首次 provision、active rotation、备份恢复与
   lost-secret 人工流程；
3. 在真实 Kubernetes API/CSI/Secret operator 上完成投影轮换、Pod rollout、网络隔离和
   credential 丢失故障注入；
4. 补齐真实 Provider 的计费、限流、超时和故障注入后，再评审更多 HTTP/MCP/UI route；
5. 持续以镜像字节、文件数、loaded modules、RSS、连接数和冷启动验证低配与 Cluster
   两端预算，不能用 package 数替代运行成本证据。
