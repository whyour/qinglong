# QingLong 3.0 Worker 管理客户端 CA 轮换

本流程只适用于 Cluster Profile 的 Worker credential management 客户端信任根。它不轮换服务端证书，
不改变 Worker-purpose OIDC、Project Policy 或双人审批，也不允许用客户端证书替代 User authority。

## 固定边界

- `ca.crt` 必须是严格 UTF-8，只含 1–16 张唯一、当前有效且 Basic Constraints 为 CA 的 PEM 证书；
- `client.crl` 必须只含 1–16 份唯一、OpenSSL 可加载的 PEM CRL；生产 PKI operator 必须为 overlap 中每个
  issuer 发布当前 CRL，并在真实请求门中分别验证；
- 两个文件都只在新进程启动时读取。禁止原地 watcher、动态 TLS context、第二 listener 或 sidecar；
- 每一阶段都必须同时计算 CA/CRL 原始 bundle 的 SHA-256，更新 Pod-template 两个摘要注解，并完成
  `maxUnavailable=0` rollout；只更新 Secret 而不推进 Deployment generation 不算生效；
- 证据 collector 保持只读，PKI/Deployment operator 才能更新 Secret 和 Deployment。

## 阶段 1：old

1. 盘点全部仍可能调用管理面的 old client identity，并确认 old CRL 当前有效；
2. Secret 只投影 old CA 与 old CRL；摘要注解分别绑定这两个文件；
3. 完整 rollout 后，从两个新 Pod 分别证明 old client 业务请求 200，未知 CA 请求 401，健康探针无证书 200；
4. 保存 Deployment generation、Secret revision、Pod 世代与低敏请求结果，不保存私钥、JWT 或 Secret 内容。

## 阶段 2：overlap

1. 在外部 PKI 中签发 new CA 和 new client identity；先分发 new client 私钥，后扩大服务端 trust；
2. `ca.crt` 精确变为 `old CA + new CA`，`client.crl` 同时包含 old/new issuer 的当前 CRL；
3. 更新两个 bundle 摘要注解并完成完整 rollout，确认旧 Pod 全部退役；
4. 在每个新 Pod 上分别证明 old client 200、new client 200、未知 CA 401；继续运行 D-229 身份、D-230
   durable audit 与 D-232 CRL 证据所需的 inspect 检查；
5. 只有所有合法 caller 都已观测 new client 成功，且 overlap 达到组织规定的最小传播窗口，才允许退休 old。

## 阶段 3：new

1. 停止签发 old CA，吊销或禁用残留 old identity，并先发布最终 old CRL；
2. `ca.crt` 精确收敛为 new CA，`client.crl` 收敛为 new issuer 的当前 CRL；
3. 更新两个摘要注解并完成完整 rollout，确认 overlap Pod 全部退役；
4. 在每个新 Pod 上证明 old client 401 `client_certificate_required`、new client 200、健康探针 200；
5. 保留 old CA/CRL 与变更证据到审计保留期结束，但不得再把 old CA 加回运行时 trust。

## D-234 三阶段证据命令

三个阶段必须由同一只读 collector、同一外部 OIDC operator subject、同一 endpoint/server trust 和同一
`worker-credential.inspect` command 采集。`--client-ca-bundle` 是服务端用来验证客户端证书的 CA 集合；client
config 内的 `caFile` 是客户端用来验证管理 API 服务端证书的 trust bundle，两者互相独立，不要求同一 issuer。

所有输入都必须是 canonical absolute path。assertion、client config、private key、Kubeconfig 和阶段/最终报告使用
owner-private 文件；输出路径必须尚不存在，runner 以 `0600` no-replace 创建。先在阶段 1 执行：

```sh
QL3_WORKER_CREDENTIAL_MANAGEMENT_CA_ROLLOVER_EVIDENCE=1 \
pnpm evidence:worker-management-ca-rollover:ql3 -- \
  --phase=old \
  --old-config=/secure/ql3/old-client.json \
  --new-config=/secure/ql3/new-client.json \
  --assertion=/secure/ql3/operator.jwt \
  --command=/secure/ql3/inspect-command.json \
  --kubernetes=/secure/ql3/evidence.kubeconfig \
  --client-ca-bundle=/secure/ql3/old-client-ca.pem \
  --client-crl-bundle=/secure/ql3/old-client-crl.pem \
  --output=/secure/ql3/old-state.json
```

完成 exact old+new rollout 后执行阶段 2；`--previous` 摘要绑定 old-state，不能复制或改写其 JSON：

```sh
QL3_WORKER_CREDENTIAL_MANAGEMENT_CA_ROLLOVER_EVIDENCE=1 \
pnpm evidence:worker-management-ca-rollover:ql3 -- \
  --phase=overlap \
  --old-config=/secure/ql3/old-client.json \
  --new-config=/secure/ql3/new-client.json \
  --assertion=/secure/ql3/operator.jwt \
  --command=/secure/ql3/inspect-command.json \
  --kubernetes=/secure/ql3/evidence.kubeconfig \
  --client-ca-bundle=/secure/ql3/overlap-client-ca.pem \
  --client-crl-bundle=/secure/ql3/overlap-client-crl.pem \
  --previous=/secure/ql3/old-state.json \
  --output=/secure/ql3/overlap-state.json
```

完成 new-only rollout 后执行阶段 3。D-229 ceremony 与 D-230 durable audit 报告必须来自本次受审变更，durable
report 必须已经摘要绑定 ceremony report：

```sh
QL3_WORKER_CREDENTIAL_MANAGEMENT_CA_ROLLOVER_EVIDENCE=1 \
pnpm evidence:worker-management-ca-rollover:ql3 -- \
  --phase=new \
  --old-config=/secure/ql3/old-client.json \
  --new-config=/secure/ql3/new-client.json \
  --assertion=/secure/ql3/operator.jwt \
  --command=/secure/ql3/inspect-command.json \
  --kubernetes=/secure/ql3/evidence.kubeconfig \
  --client-ca-bundle=/secure/ql3/new-client-ca.pem \
  --client-crl-bundle=/secure/ql3/new-client-crl.pem \
  --old=/secure/ql3/old-state.json \
  --previous=/secure/ql3/overlap-state.json \
  --ceremony-report=/secure/ql3/live-ceremony.json \
  --durable-audit-report=/secure/ql3/durable-audit.json \
  --output=/secure/ql3/ca-rollover-evidence.json
```

最终报告必须再由不需要集群凭据的离线门重判：

```sh
pnpm audit:worker-management-ca-rollover:ql3 -- \
  --report=/secure/ql3/ca-rollover-evidence.json
```

兼容输出必须同时包含 `"compatible":true`，最终报告的 `gates.passed` 必须为 `true`。D-232 同 CA 单证书 CRL
吊销证据仍可按组织策略独立运行，但不是把 old/new 两个 CA 合并成同 issuer 的前置条件。

## 失败与回退

- 新 Pod 因 PEM、有效期、CA 用途、重复或 CRL 解析失败而不能 Ready：停止 rollout，保留仍 Ready 的旧 Pod，
  修复候选 bundle 后推进新的 generation；
- overlap 中 new client 失败：保持 old+new，不得退休 old；检查 client key/certificate、EKU、issuer CRL 与
  NetworkPolicy，修复后重新完整 rollout；
- new-only 阶段出现未迁移 caller：只能经新的受审变更回到 exact overlap，并重新计算两个摘要、完整 rollout；
  禁止只重启单 Pod或把旧 CA 临时塞入某个副本；
- 紧急 old CA compromise 时可缩短 overlap，但仍必须先使 new client 可用、发布 CRL、推进完整 generation，
  并运行 D-232 的旧证书拒绝证据。可用性压力不能把未知结果解释成成功退休。

该流程不增加 workspace package、第三方依赖、migration、controller、timer、watcher、listener、Pool 或连接；
Edge、Standalone 与 Worker Profile 不装配该能力，低配部署没有稳态成本。
