# ADR-0532：原生 Console 的日志窗口导航

- 状态：Accepted（D-430 源码候选；远端 CI 与 exact Console 实物待验证）
- 日期：2026-09-04
- 关联：QL-RFC-0001 D-430、ADR-0515、ADR-0531

## 问题

原生 3.0 Console 已能创建任务、配置定时与加密凭据，但日志超过首个 32 KiB 后仍要求部署者离开页面自行调用 API。旧面板兼容不是长期产品目标，本切片在原生页面补齐日志观察的用户操作闭环。

## 决策

- 在既有 Attempt log API 上增加“下一片段”“回到开头”“刷新当前片段”。每次用户动作只读取一个 32 KiB 窗口并替换 `<pre>`，不累计历史窗口、不自动翻页、不新增轮询或全文下载。
- 翻页固定选择时的 Project、Run 与 Attempt；刷新当前片段不会悄然切换到另一个 Attempt。重新选择 Run 才重新读取 latest Attempt、Run/Event/Step 事实。
- 验证响应 schema、Project/Run/Attempt 身份、字节范围、解码字节数与前进 cursor。异常或停滞 cursor 不生成下一页操作；pending、retired、masked absence 和 unavailable 保持显式状态。
- 选择请求使用不含凭据的内存代次标记；旧请求在切换 Run、离开运行页、断开连接或同一 Run 重选后不能覆盖当前详情。翻页按钮请求中禁用且合并重复点击，未连接到当前文档的旧节点不能启动新请求。
- 字节分片仍遵循既有 API，UTF-8 跨片字符可能显示替换符，页面明确说明；不伪造完整行、不保存跨窗口解码缓冲、不修改日志字节偏移。

## 部署边界与验证

不新增 package、dependency、schema、migration、后端 route、数据库连接、listener 或后台任务。默认 headless 与独立 Cluster Console 不变，Local 原生资产仍受单文件 96 KiB / 总计 192 KiB 限制。

客户端行为测试直接执行发布的 `console.js`，覆盖分页替换、范围/身份漂移、连续点击、过期响应、错误状态、空窗口和 UTF-8 字节边界。真实 Chromium 预览已验证首片段 → 下一片段 → 回到开头，DOM 始终只有一个日志窗口，中文与 `<script>` 字面文本安全展示，三个动作只产生三个日志 GET。

本地验证：客户端行为测试 6/6、完整 Local API 99/99、后端 1685 项（1683 pass / 2 环境条件 skip / 0 fail），Local image 与 package boundary audit 均 compatible。原生 JS 为 74,695 bytes，三项资产合计 106,216 bytes，均在既有硬上限内。

源码与本地门通过不等同阶段镜像交付。远端完整 CI、exact Console 双架构构建与离线实物校验仍需闭合；此前 ADR-0531 的 `09ef1745` artifact 不包含本切片。
