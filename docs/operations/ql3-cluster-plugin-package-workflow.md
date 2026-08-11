# QingLong 3.0 Cluster Plugin Package Workflow

Cluster Workflow 入口由既有 `ql3-cluster-control` `/api/v3` mTLS listener 提供。不要启动额外 Workflow
daemon，也不要向 `cluster-admin` 暴露 runtime PostgreSQL credential。

## 前置条件

- `cluster-control` readiness 已通过并已安装 admission；
- 客户端通过部署受信 CA 的 mTLS 校验；
- Bearer API credential 绑定 active User/API app/MCP client/Agent；
- subject 在目标 Project 的当前 RoleBinding 具有 `run.read` 或 `run.start`；
- Package install、lifecycle、publication 与目标 Workflow 均为 active，且未 quarantine/revoke。

Bearer 格式为 `ql3c_<credentialId>_<43-char-base64url-secret>`。不要把 token 写入命令历史、URL、日志或
工单；示例中的 `$QL3_API_TOKEN` 应由进程私有 secret provider 注入。

## 检查 Workflow

```sh
curl --fail-with-body \
  --cacert /run/secrets/ql3/ca.pem \
  --cert /run/secrets/ql3/client.pem \
  --key /run/secrets/ql3/client-key.pem \
  -H "Authorization: Bearer $QL3_API_TOKEN" \
  "https://cluster-control.example.test:7443/api/v3/projects/default/packages/example-automation/workflows"
```

结果只包含 publication state 与 Workflow/Step/Task metadata。保存目标 Workflow 和所有 Step `id`；不要从
Package bundle 手工拼 generation、revision 或 digest。

## 启动 Workflow

为 plan、Run 和每个 StepRun 分别生成 UUID v4；`stepRunIds` key 必须与检查结果的 Step `id` 精确一致：

```json
{
  "schema": "qinglong/cluster-plugin-package-workflow-start-request@v1",
  "planId": "123e4567-e89b-42d3-a456-426614174000",
  "runId": "123e4567-e89b-42d3-a456-426614174001",
  "stepRunIds": {
    "collect": "123e4567-e89b-42d3-a456-426614174002",
    "summarize": "123e4567-e89b-42d3-a456-426614174003"
  }
}
```

```sh
curl --fail-with-body \
  --cacert /run/secrets/ql3/ca.pem \
  --cert /run/secrets/ql3/client.pem \
  --key /run/secrets/ql3/client-key.pem \
  -H "Authorization: Bearer $QL3_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @workflow-start.json \
  "https://cluster-control.example.test:7443/api/v3/projects/default/packages/example-automation/workflows/daily/runs"
```

HTTP 201/`created` 表示 admission 已耐久提交，不表示 Workflow 已完成；唯一 scheduler cadence 会继续推进
frontier 与 Task Attempt。响应丢失时必须原样重放相同 body，尤其不能重新生成 plan/Run/StepRun UUID；
HTTP 200/`existing` 返回同一 receipt。每次 HTTP 尝试有 request audit，首次成功 mutation 只有一条与 plan
原子提交的 `workflow.start` audit。

409 `authorization_fence_changed` 表示 credential、Identity、Project 或 RoleBinding 已变化；重新认证和读取
当前授权后才能表达新请求。409 `workflow_start_conflict` 表示 UUID 已绑定其他语义或当前 Package evidence
漂移。404 不应通过重试绕过 Package lifecycle/quarantine/revocation。
