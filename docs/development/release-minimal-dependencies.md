# 2.23.0 最小依赖修补范围

本次候选基于 develop `68ffa106f80a2080ddd9b48affe0d7a7489e4d05`。按维护者决定，保留可影响现有请求处理的最小修补；完整依赖治理和运行时迁移留到后续版本。现有 draft PR #3088 保留为后续方案，不作为本次候选。

| 依赖 | 固定版本 | 本次保留的原因 |
| --- | --- | --- |
| compression | 1.8.2 | 全局 HTTP 压缩中间件处理提前关闭的响应时可能泄漏内存。[公告](https://github.com/advisories/GHSA-vc2v-76pw-4v95) |
| multer | 2.3.0 | 文件上传接口的 multipart 字段名可造成 CPU 或栈耗尽；接口认证不能消除服务进程的拒绝服务风险。[公告](https://github.com/advisories/GHSA-535w-7cp7-47q4) |
| @grpc/grpc-js | 1.14.5 | 畸形 HTTP/2 请求或压缩消息可能使服务器崩溃；青龙使用 mTLS，访问条件受到客户端证书限制。[公告](https://github.com/advisories/GHSA-5375-pq7m-f5r2) |
| proxy-addr | 2.0.8 | 可信代理配置接受 CIDR；特定 IPv4 映射 IPv6 网段可能错误信任全部 IPv4。默认 loopback 不触发该条件。[公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |
| websocket-driver | 0.7.5 | SockJS 使用的旧协议解析器存在长度头溢出；连接解析发生在应用异步鉴权完成前。[公告](https://github.com/advisories/GHSA-xv26-6w52-cph6) |
| sequelize | 6.37.8 | 任务 filters 可将 JSON 字段名传入查询；旧版将恶意 `::` 类型转换内容拼入 SQL，已在 SQLite 查询生成器复现。[公告](https://github.com/advisories/GHSA-6457-6jrx-69cr) |

更新 compression 同时更新其 on-headers 子依赖。保留 pnpm 8.3.1、锁文件格式、Dockerfile、业务代码和现有发布工作流。新增 readiness 工作流仅构建四种镜像的现有架构、检查原生依赖导入并导出 Debian 测试镜像，不推送镜像或发布 npm。

## 延期风险与限制

2026-10-11 的 `pnpm audit --prod --json` 仍报告 2 critical、40 high、55 moderate、11 low；这不是完整审计清零或所有告警均不可利用的结论。

- protobufjs 的反射/模式输入漏洞：当前 gRPC 服务使用静态生成协议；未发现处理用户提供的模式描述。tar 告警主要位于 SQLite 安装依赖链。二者仍保留 critical 告警，后续继续治理。
- jws 公告明确区分 createVerify 的用户控制密钥查找与 jsonwebtoken.verify；当前认证使用后者。Undici 的 WebSocket/共享缓存、Nodemailer 的 OAuth2/raw-message、Joi isoDate 和 lodash template 等触发条件未在本次现有路径中发现；这不替代未来新增用途的安全检查。
- js-yaml 用于本地版本文件及配置的更新来源；版本源与安装/订阅输入仍属于信任边界。其余正则、路径、构建和全局工具依赖告警保留，未通过全面不可达证明。
- Node 20 已结束上游维护，Node 18 构建镜像也已结束维护。[官方状态](https://nodejs.org/en/about/previous-releases)。本次按选定范围暂缓迁移，不能把通过功能测试描述为运行时仍受安全支持。
- 2.23.0 为最后一个 Python 3.10 兼容版本；发布后不再维护这两个兼容镜像。默认 Python 3.11 镜像继续作为迁移目标。

## 验证要求

冻结锁安装、前后端构建、回归测试和镜像构建需要针对当前最小候选重新验证。dev 使用新隔离数据目录，实际验证定时任务、订阅、环境变量、JS/Python/Shell 脚本、依赖及 SMTP/TLS 通知，累计有效运行至少两小时。之前大型候选的 CI、镜像和运行时长不计入本轮验收。候选通过后同步 qinglong-site 文档；正式发布另行确认。
