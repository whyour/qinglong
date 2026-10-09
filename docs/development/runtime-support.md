# 发布运行时支持

2026-10-10 的依赖验收区分 npm 锁文件审计与镜像运行时维护。生产 npm 审计零公告命中不能证明 Node、Python、操作系统或用户脚本依赖没有漏洞。

默认 Debian 镜像使用 Node 22.23.3、Python 3.11.17 和 Debian 13（Trixie），保留 amd64、arm/v7、arm64、ppc64le、s390x 五种架构。Node 22 官方 Bookworm 镜像缺少 s390x，因此在原生构建阶段下载官方目标架构发布包，只将目标 Node 二进制复制到 Python 阶段；npm 等工具来自同源码 CI 构建的受控归档。不要将下载阶段自身的原生 Node 或附带的旧工具树复制到目标镜像。

`docker/install-node.sh` 使用仓库中固定的 Node 22.23.3 签名摘要清单和官方发布者公钥，通过 GPG 检查签名、发布者指纹和下载包 SHA256。升级 Node 时一起更新版本、签名清单和发布者公钥，并重新核验全部架构。arm/v7 需要 `libatomic1`。已读取五种实际 Node ELF：GLIBC 需求不超过 2.28，arm/v7 的 GLIBCXX 需求不超过 3.4.26；Trixie 满足这些要求，实际构建仍由完整镜像矩阵验证。

默认 Alpine 镜像固定 Python 3.11.17 / Alpine 3.24 基础镜像摘要，保留原有七种架构；运行时 Node 由 Alpine APK 提供。2026-10-10 的七架构 APK 索引均为 Node 24.18.1-r0。原生包安装阶段使用 Node 22.23.3，替换已结束维护的 Node 18。源码安装要求 Node 22.x >=22.22.2 或 Node 24.x >=24.15.0，CI 在 Node 22 和 24 上验证回归；镜像验证同时输出实际 Node、Python 和机器架构。

Python 3.10 已于 2026-10-01 结束维护。两个兼容 Dockerfile 仍单独验证，继续发布还是停止新增兼容标签需在正式发版前明确；不能将这些兼容镜像描述为受支持的默认运行时。已有历史镜像不会因这次准备工作删除。

运行时变更后必须重新执行镜像矩阵，并在使用实际新 Node 的独立 dev 容器中重新做至少两小时功能验证。原 Node 20 环境中的依赖长跑单独保留，不能替代新运行时结果。镜像准备与 CI 构建不会自动执行正式发布。

镜像中的全局 pnpm、PM2、npm 等工具不属于应用 `pnpm-lock.yaml` 的生产树。a70ec66 候选的实际全局工具补审发现 High/Critical 公告匹配。本轮收尾使用固定来源重构 npm 12.2.0 和 pnpm 10.34.6，更新实际 node-gyp 12.4.0、tar 7.5.22、PM2 的 js-yaml 4.3.2 等间接依赖；源码锁迁移到 PNPM10 格式，不改变已锁定的版本、依赖边或 peer 上下文。只供前端构建的 plots 移到开发依赖，应用生产树从 367 个减到 282 个（按 PNPM10 审计口径）。

受控工具归档是 Linux CI 生成的纯 JavaScript 产物。静态构建清单覆盖归档及 proof，proof 记录源码提交、所有构建输入 Git blob 与 SHA256、实际工具文件和安全相对链接。安装器只用 Node 标准库，先验收再原子替换已知工具，失败回退；不解析浮动 registry 版本，也不改变持久化 `global/5` 脚本依赖。启动、修复、源码升级共用这套安装路径。普通项目安装保留 PNPM10 的脚本批准规则，全局用户脚本依赖维持原有原生安装行为。

实际工具树的本机审计仍有 **一项 High：braces 3.0.3，GHSA-vfj7-8cjw-p6xm**，当前没有已发布修复版本。默认 PM2 watch 关闭；四个正常安装、冻结离线安装、workspace 和 pack 场景的 V8 覆盖未执行其 parse/compile/expand，正向控制确认覆盖有效。这仅限定这些已测场景，不证明所有命令不可达；用户启用 watch、维护 glob 或调用 Shell 模式仍属于相关输入面。[公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。最终 Linux CI、镜像实际树和 dev 维护行为仍须验收，不宣称全局依赖漏洞为零。

主 npm 包按单一冻结 PNPM 图生成 `bundleDependencies`，记录实际发货源文件、每个依赖 manifest 和 Node 解析边。消费者修复只校验随包树并处理 SQLite，不重新解析 npm 依赖。npm 12 默认阻止依赖安装脚本；全局安装需精确批准 `npm install -g @whyour/qinglong@2.23.0 --allow-scripts=@whyour/qinglong@2.23.0`，项目安装在自己的 `package.json` 设置 `allowScripts`。实际 SQLite 编译由主包安装脚本转发。CI 必须独立验证 npm10 本地、npm12 本地/全局的预编译和源码编译六种组合，正式发布只消费通过验收的同一 TGZ。[npm12 脚本配置](https://docs.npmjs.com/cli/v12/using-npm/config/#allow-scripts)。

源码安装固定 pnpm 10.34.6 和 frozen lock。若升级暂存源码遇到旧 manager，只有同提交、同锁和全部输入哈希匹配的静态工具归档才可在临时 prefix 完成安装；无受控归档时明确失败，不再回退到 npm 无锁解析。旧 Node20/PNPM8 容器应拉取新镜像并重建；宿主机先升级 Node，再重新安装完整 npm 包。Termux 的无锁源码回退也不再支持。CLI 的远程 API 模式仍仅需 Node >=22.12。

依据：[Node 发布计划](https://github.com/nodejs/Release/blob/main/schedule.json)、[Node 22.23.3 发布与下载](https://nodejs.org/en/blog/release/v22.23.3)、[官方 Node 发布者公钥](https://github.com/nodejs/release-keys)、[Python 支持周期](https://devguide.python.org/versions/)、[Python 3.11.17 Trixie 镜像元数据](https://github.com/docker-library/repo-info/blob/master/repos/python/remote/3.11.17-slim-trixie.md)、[Python 3.11.17 Alpine 镜像元数据](https://github.com/docker-library/repo-info/blob/master/repos/python/remote/3.11.17-alpine3.24.md)。
