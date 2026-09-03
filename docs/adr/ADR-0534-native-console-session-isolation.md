# ADR-0534：原生 Console 异步操作的连接代次隔离

- 状态：Accepted（D-432 源码候选；同源远端 CI 与阶段实物待验证）
- 日期：2026-09-04
- 关联：QL-RFC-0001 D-432、ADR-0533

## 问题

列表的请求代次不能覆盖所有编辑器调用链。已经复现：创建 Task 时读取 Secret 目录，用户断开连接后，迟到的响应仍会填充 catalog；完整 Task authoring、presence challenge 和写入后的刷新也可能把旧连接结果带入新页面。这个问题是客户端状态隔离缺陷，不是后端认证绕过。

## 决策

- 每次连接及断开都更换一个不含 credential 的内存代次对象；即使重新使用同一个 credential，也不是同一连接。
- 统一 `api` 在网络异常、JSON 解码异常和解码完成处检查代次；过期结果统一拒绝为 `session_changed`，不能向调用者暴露旧成功内容或旧错误。
- Task/Trigger/Secret 编辑、authoring、presence 提交和 Run 启停链在异步边界再次检查代次。旧调用不能重新打开对话框、写入 catalog/snapshot、覆盖新 proof、发布 toast，或在新连接下继续读取/写入。
- 断开时同步清空既有敏感状态并恢复提交按钮基线；旧 finally 不能解锁新连接正在提交的按钮。跨连接检查不替代同一连接内的列表和选择代次。
- 不增加 package、依赖、后台计时器、轮询或后端路由。默认 headless、Cluster、旧面板兼容入口和后端 Policy/presence/audit 规则不变。

## 不承诺的行为

丢弃页面响应不等于撤销已经发送的服务端操作。断开之前已提交的 Task/Trigger/Secret 写入、Run start 或 cancellation 仍可能成功；重连后应读取 durable 状态核对，不应自动重试或把断开视为取消。此切片不引入网络取消或事务回滚，也不把 Local Console 扩展为多用户远程会话产品。

## 替代方案

只比较 token 无法区分同一 credential 的重新连接；只加 AbortController 不能撤销已完成的解码、排队回调或服务端写入。逐页临时修补则容易遗漏编辑器和 finally。因此保留统一连接代次检查，并在会产生后续副作用的调用边界复核。

## 验证

测试直接执行发布的 `console.js`，通过 `test/support/consoleClient.cjs` 复用最小 DOM 夹具，不新增生产导出。16 项回归覆盖迟到目录、JSON 解码、网络错误、相同 credential 重连、authoring 全量定义、三种草稿、按钮 finally、Trigger pin 读取后的写入禁止，以及 Run 写入后的刷新/选择隔离。初始 13 项在修复前为 12 fail / 1 pass，修复后全部通过；新增 3 项也通过。

最终 Local API 130/130，完整后端 1685 项（1683 pass / 2 环境条件 skip / 0 fail）。Local image 与 18-package boundary audit 均 compatible；原生 JS 82,521 bytes，三项静态资产合计 114,042 bytes，仍在单文件 96 KiB / 合计 192 KiB 预算内。

真实 Chromium 使用当前静态资产和仅监听本机的合成 HTTP 服务完成连接、创建 Task、确认 Secret GET 挂起、断开、放行旧响应的交互；页面保持等待凭据且没有重开编辑器。测试没有真实数据库、生产 credential 或写入 authority，不能代替镜像端到端验收。

上述本地验证不代表修复已进入既有下载产物。D-431 的 `ce8c3a7d2afdbb11b2a33f4884702454d1d22a53` 产物也不包含本修复；本切片必须以自己的 source revision、CI 和阶段归档证据验收。

提交 `03afd7e8` 的独立 Kubernetes deployment 验证通过，但主 CI [run 33799350582](https://github.com/whyour/qinglong/actions/runs/33799350582) 在 CloudNativePG live gate 失败：rollout 已完成，旧 operator Pod 仍为 Terminating，`verifyImageIds` 纳入其空 imageID 后拒绝。`2005cb6b` 单独修正 operator 取样，排除 deletionTimestamp 已设置的 Pod；存活 Pod 仍执行原摘要校验，空集合仍失败，针对性回归 11/11。此本地修复不改写旧 run 的失败结论，须由后续同源 CI 验证。

2026-09-04 后续核对：包含上述修复的 `e4ba5d405f55543dd5d3ca432c24648171ebdda4` 主 CI [run 33802395394](https://github.com/whyour/qinglong/actions/runs/33802395394) 中 CloudNativePG live failover job 已成功，因而 operator 取样修复已有远程实测证据；这不改写旧失败 run，也不单独代表整体 CI 或 Console 实物交付完成。
