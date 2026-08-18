# QingLong 3.0 Manual Primary Canary 操作手册

本流程只适用于本机 `edge` 或 `standalone` Profile 的 `manual` origin。它不会自动执行用户任务，也不会在 `prepare`、`observe`、`resource` 或 `qualify` 阶段启用
Primary。`cluster-control` 与 `worker` 不适用。

示例使用：

```text
CONFIG_ROOT=/ql/data/config
DATABASE=/ql/data/db/database.sqlite
SESSION=edge-20260819-a
```

把示例中的绝对路径和 session 替换为目标实例的实际值。config root 必须由运行 QingLong 的同一 UID 拥有，不能是 symlink，也不能允许 group/world 写入；数据库必须是
非 symlink、group/world 不可写的普通文件。所有命令都应由该 UID 执行。

## 1. 准备不可变计划

Edge 必须精确 8 条；Standalone 可在 32–128 中选择一个精确目标：

```sh
pnpm canary:manual-primary:ql3 -- \
  --mode=prepare \
  --root=/ql/data/config \
  --session=edge-20260819-a \
  --profile=edge \
  --admissions=8
```

已有 enabled rollout 时命令拒绝执行；已有 disabled rollout 时 plan 绑定其 SHA-256。输出中的 `automaticActivation` 必须为 `false`，并给出三项环境值。将这些值写入目标
部署配置后重启当前 Shadow worker：

```text
QL_DEPLOYMENT_PROFILE=edge
QL3_SHADOW_ORIGINS=manual
QL3_SHADOW_CAPTURE_EVIDENCE_FILE=ql3-primary-canary-edge-20260819-a.capture.json
```

不要同时配置其他 Shadow origin，不要手工创建 capture 文件。

## 2. 执行真实 Legacy manual 样本并干净关闭

在隔离维护窗口中，通过现有 QingLong 用户界面/API 的正常 manual 执行入口精确提交计划数量的任务。不要用 canary 工具直接 spawn 脚本；那不会证明产品入口。

窗口期间禁止其他 manual execution。任务全部终态后，使用部署系统的正常 shutdown 停止同一 HTTP worker。只有干净 shutdown 才会 no-replace 写 capture evidence；kill -9、断电、
重复文件名或部分文件都不具备资格。

查看当前持久状态不会修改文件：

```sh
pnpm canary:manual-primary:ql3 -- \
  --mode=status \
  --root=/ql/data/config \
  --session=edge-20260819-a
```

## 3. 等待闭合窗口并运行终态审计

从 capture window 的 `endExclusiveMs` 起等待至少五分钟，然后运行：

```sh
pnpm canary:manual-primary:ql3 -- \
  --mode=observe \
  --root=/ql/data/config \
  --session=edge-20260819-a \
  --database=/ql/data/db/database.sqlite
```

工具固定使用 `origin=manual`、plan 内的 window 和五分钟 settling，不接受调用方覆盖。SQLite 以只读方式打开；结果必须为 `terminal_observed`、`assessment=matched`，scanned
必须等于计划样本数。

## 4. 在应用停止状态运行资源/回滚证据

低配路由设备必须保持应用停止，避免 128 MiB 预算内与常驻进程争用。命令使用临时 SQLite、compiled backend、full rollback 和固定 8 个 audit samples，不接触生产数据库：

```sh
pnpm canary:manual-primary:ql3 -- \
  --mode=resource \
  --root=/ql/data/config \
  --session=edge-20260819-a
```

结果必须为 `resource_proven`、`qualified=true`。Standalone 即使部署在集群节点上，也仍是本机证据，不得据此启用 cluster-control/worker Primary。

## 5. 生成资格并独立复核

```sh
pnpm canary:manual-primary:ql3 -- \
  --mode=qualify \
  --root=/ql/data/config \
  --session=edge-20260819-a

pnpm audit:manual-primary-canary:ql3 -- \
  --root=/ql/data/config \
  --session=edge-20260819-a \
  --require=qualified
```

`qualify` 生成 Primary gate 与 qualification，但输出仍必须为 `automaticActivation=false`。独立 audit 重新计算 source/gate/file digest；`compatible=true` 只证明可以提交人工审批。

## 6. 显式短期审批并重启验证

只有维护者完成审阅后才执行。示例审批一小时，允许范围为一分钟至 24 小时：

```sh
pnpm canary:manual-primary:ql3 -- \
  --mode=approve \
  --root=/ql/data/config \
  --session=edge-20260819-a \
  --approved-by=operator:local-owner \
  --approval-ms=3600000

pnpm audit:manual-primary-canary:ql3 -- \
  --root=/ql/data/config \
  --session=edge-20260819-a \
  --require=selected
```

正确状态是 `activation_approved`/`rolloutMode=primary_selected`，不是 `primary_active`；`requiresRestart=true` 且 `runtimeActivationObserved=false`。随后重启应用，并在结构化启动审计中依次确认
同一 revision 的 `selected`、`reconciled`、`activated`。缺少任一项都不能宣称运行态 Primary 已激活。

审批过期后 loader 自动 fail-closed 为 off，不会续期。不要修改原 manifest 时间；创建新 session 重新采样。

## 7. 回滚并重启

演练或出现异常时立即执行：

```sh
pnpm canary:manual-primary:ql3 -- \
  --mode=rollback \
  --root=/ql/data/config \
  --session=edge-20260819-a \
  --operator=operator:local-owner \
  --reason=operator_request

pnpm audit:manual-primary-canary:ql3 -- \
  --root=/ql/data/config \
  --session=edge-20260819-a \
  --require=rolled-back
```

支持的 reason 只有 `operator_request`、`runtime_failure`、`gate_rejected`、`approval_expired`。rollback 先发布 intent，再摘要复核并原子替换 live manifest，最后发布 completion；响应丢失时使用完全相同的参数重跑。

`rolled-back` 比普通 `off` 更严格：后者在初始 disabled 或审批过期时也成立，前者还要求本 session 的 intent/completion 摘要链完整。完成后重启应用，确认 rollout loader 返回
disabled/off，Legacy manual 执行继续可用且 Shadow/Primary 不再接管。保留整个 session 的 `0600` 文件和启动审计用于发布复核，不要覆盖或编辑。
