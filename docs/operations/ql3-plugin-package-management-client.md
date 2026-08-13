# QingLong 3.0 Cluster Plugin Package 管理客户端

`ql3-plugin-package-client` 是短生命周期 operator 命令。每次启动只向私有
Plugin Package management Service 发送一个命令，然后退出；它不签发身份 assertion，
不自动重试，也不保存 server response。

直接 client 只适用于已经能够解析并访问 management Service DNS 的受控私有网络。
Kubernetes ClusterIP 从 workstation 访问时，使用后文的 tunnel client；不要把 Service
改成公共 LoadBalancer。

## 准备文件

创建三个由当前 UID 拥有、mode 为 `0600` 的 canonical regular file。不要使用 symlink，
也不要把 assertion 放进 shell 参数、环境变量或 stdin。

`client.json`：

```json
{
  "schemaVersion": 1,
  "endpoint": "https://ql3-plugin-package-management.qinglong3-system.svc:8443/api/v3/plugin-packages/management",
  "servername": "ql3-plugin-package-management.qinglong3-system.svc",
  "caFile": "/absolute/path/management-ca.pem",
  "requestTimeoutMs": 5000
}
```

CA 文件必须是 canonical、非 symlink、当前 UID 或 root 拥有且 group/world 不可写。

`command.json` 示例：

```json
{
  "schemaVersion": 1,
  "operation": "plugin-package.inspect",
  "request": {
    "actionRef": "package:example:1",
    "approvalRequestId": "approval-example-1",
    "inspectionId": "inspection-example-1"
  }
}
```

`assertion.jwt` 只包含外部 IdP ceremony 签发的短期 compact JWT，不带换行或其他字段。

```sh
chmod 600 /absolute/path/client.json \
  /absolute/path/command.json \
  /absolute/path/assertion.jwt
```

## 执行

```sh
ql3-cluster-admin package \
  --config=/absolute/path/client.json \
  --command=/absolute/path/command.json \
  --assertion=/absolute/path/assertion.jwt
```

统一产品入口会在同一 Cluster Admin 制品内委派给
`ql3-plugin-package-client`；后者保留为直接 binary 兼容入口，两者使用同一协议和
authority，不会启动第二个管理进程。

可用 operation 只有以下十八个：

- `plugin-package.propose|decide|inspect`
- `plugin-package.installation.inspect|list`
- `plugin-package.lifecycle.propose|decide|inspect`
- `plugin-package.publisher-revocation.propose|decide|inspect`
- `plugin-package.publisher-trust-transition.propose|decide|inspect`
- `plugin-package.secret-binding.plan|propose|decide|inspect`

首次 Secret binding 必须先提交 `plan`，由服务端从当前 active installation、lock、
Manifest 和 generation 重建目标。调用方只提供逻辑 requirement 到同 Project、固定
version `qlsecret:v1:` 引用的 assignment；不得提交 generation、digest、Manifest 或
Secret value。`plan` 返回 content-free target、requirement、digest 和有效期；随后以同一
`actionRef` 执行 `propose`，由另一名强认证 User 执行 `decide`。审批后的实际 binding 由
短生命周期 package executor 消费，management client 不持有 executor authority。

```json
{
  "schemaVersion": 1,
  "operation": "plugin-package.secret-binding.plan",
  "request": {
    "actionRef": "secret-binding:example:1",
    "projectId": "project-1",
    "packageName": "example",
    "assignments": [
      {
        "name": "TOKEN",
        "secretRef": "qlsecret:v1:REPLACE_WITH_FIXED_VERSION_REFERENCE"
      }
    ]
  }
}
```

成功时 stdout 只有服务端审查过的低敏 result。失败时 stderr 只有稳定 code，以及可能的
HTTP status、response code、request ID 和 Retry-After；不会输出 assertion、路径、
endpoint、command、证书、Error message 或 stack。

## 结果不确定与重放

连接中断或 timeout 不能证明服务端没有提交。客户端不会自动重试，也不会生成新的 ID。
operator 应先保留原 command 文件并检查 durable 状态；需要重放时，使用原文件再次显式
执行。服务端以原 action/decision/inspection identity 的 exact replay 收敛。

不要在结果不确定时修改 command 中的 ID、expected version 或业务字段后重试；那会形成
新的操作语义，而不是恢复原操作。

## Kubernetes ClusterIP tunnel

`ql3-plugin-package-client-kubernetes` 从 workstation 使用 Kubernetes port-forward
subresource 建立一次 raw tunnel，随后仍用 management CA 和 Service DNS 执行端到端
TLS 1.3。它不创建 Pod、Job、Secret、ConfigMap 或本地 listener。

新增 `kubernetes.json`：

```json
{
  "schemaVersion": 1,
  "kubeconfigFile": "/absolute/private/ql3-operator.kubeconfig.json",
  "context": "production",
  "namespace": "qinglong3-system",
  "apiTimeoutMs": 5000
}
```

该文件和 kubeconfig 都必须是当前 UID 拥有、canonical、非 symlink 的 `0600` 文件。
kubeconfig 必须是专用 exact JSON，而不是 ambient `~/.kube/config`：只能有一个
cluster、一个 user、一个 context，`current-context` 必须等于 `production`。cluster
只允许 HTTPS server 和内嵌 `certificate-authority-data`；user 只允许内嵌短期 token，
或一对匹配的内嵌 `client-certificate-data`/`client-key-data`。proxy、skip TLS、
token/certificate/key 文件引用、exec/auth-provider、basic auth 和 impersonation 都会
失败关闭。

operator Kubernetes identity 需要目标 namespace 的：

- `list` `pods`
- `create` `pods/portforward`

port-forward 是 Kubernetes RBAC 控制的独立私有入口，不是 labelled-Pod NetworkPolicy
证据；它仍须通过 QingLong User assertion、Project Policy、双人审批和 durable quota。

执行：

```sh
ql3-cluster-admin package-kubernetes \
  --config=/absolute/path/client.json \
  --command=/absolute/path/command.json \
  --assertion=/absolute/path/assertion.jwt \
  --kubernetes=/absolute/path/kubernetes.json
```

client 只接受
`ql3-plugin-package-management.qinglong3-system.svc:8443`，只选择最多两个
Running/Ready、无 token mount 的 management Pod，并且不会在失败后自动切换 Pod 或
重建 tunnel。
