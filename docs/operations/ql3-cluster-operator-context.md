# QingLong 3.0 Cluster Operator Context

Cluster operator context 只为短生命周期 `ql3-cluster-admin` 复用受审 client 与 Kubernetes 配置路径。它不是 credential store，不得包含 assertion、command、token、private key、endpoint 内容或默认业务操作；context 及引用的私有文件必须是 absolute、canonical、当前 UID 所有、非 symlink 的 `0600` regular file。

维护窗口按固定顺序执行：

```sh
ql3-cluster-admin context validate \
  --context=/secure/qinglong3/operator-context.json

ql3-cluster-admin context probe \
  --context=/secure/qinglong3/operator-context.json
```

`validate` 完全离线，验证所有 context entry、TLS/mTLS 与 Kubernetes 配置，不建立连接。`probe` 会再次先完成全量离线验证，然后按固定 catalog 顺序使用 production TLS 1.3 或 Kubernetes PortForward 发送无 Authorization、无 body 的 `GET /readyz`；它不会执行 management POST、读取 assertion/command、重试或切换 Pod。

- `validate` 成功退出 0；配置错误输出低敏 `QL3_CLUSTER_PRODUCT_CONTEXT_INVALID` 并退出 78。
- `probe` 全部 ready 退出 0；明确 not-ready、不可达或响应协议错误退出 69。not-ready 会输出各 command 的低敏状态；连接/协议失败只输出 `QL3_CLUSTER_PRODUCT_CONTEXT_PROBE_FAILED`。
- 退出 0 只证明探测时刻 readiness，不代表后续 mutation 一定成功。业务命令仍需单独、显式提供精确 command 与短生命周期 assertion。

不要把 probe 放进 cron、sidecar、router/Edge Profile 或 Cluster Control。持续监控应使用独立、最小权限的可观测性面；该命令保留为人工发布/维护窗口的有界诊断工具。
