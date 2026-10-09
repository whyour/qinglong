# 发布运行时支持

2026-10-10 的依赖验收区分 npm 锁文件审计与镜像运行时维护。生产 npm 审计零公告命中不能证明 Node、Python、操作系统或用户脚本依赖没有漏洞。

默认 Debian 镜像使用 Node 22.23.3、Python 3.11.17 和 Debian 13（Trixie），保留 amd64、arm/v7、arm64、ppc64le、s390x 五种架构。Node 22 官方 Bookworm 镜像缺少 s390x，因此在原生构建阶段下载官方目标架构发布包，再将目标 Node 与 npm 复制到 Python 阶段；不要将下载阶段自身的原生 Node 复制到目标镜像。

`docker/install-node.sh` 使用仓库中固定的 Node 22.23.3 签名摘要清单和官方发布者公钥，通过 GPG 检查签名、发布者指纹和下载包 SHA256。升级 Node 时一起更新版本、签名清单和发布者公钥，并重新核验全部架构。arm/v7 需要 `libatomic1`。已读取五种实际 Node ELF：GLIBC 需求不超过 2.28，arm/v7 的 GLIBCXX 需求不超过 3.4.26；Trixie 满足这些要求，实际构建仍由完整镜像矩阵验证。

默认 Alpine 镜像固定 Python 3.11.17 / Alpine 3.24 基础镜像摘要，保留原有七种架构；运行时 Node 由 Alpine APK 提供。2026-10-10 的七架构 APK 索引均为 Node 24.18.1-r0。原生包安装阶段使用 Node 22.23.3，替换已结束维护的 Node 18。源码安装要求 Node >=22，CI 在 Node 22 和 24 上验证回归；镜像验证同时输出实际 Node、Python 和机器架构。

Python 3.10 已于 2026-10-01 结束维护。两个兼容 Dockerfile 仍单独验证，继续发布还是停止新增兼容标签需在正式发版前明确；不能将这些兼容镜像描述为受支持的默认运行时。已有历史镜像不会因这次准备工作删除。

运行时变更后必须重新执行镜像矩阵，并在使用实际新 Node 的独立 dev 容器中重新做至少两小时功能验证。原 Node 20 环境中的依赖长跑单独保留，不能替代新运行时结果。镜像准备与 CI 构建不会自动执行正式发布。

依据：[Node 发布计划](https://github.com/nodejs/Release/blob/main/schedule.json)、[Node 22.23.3 发布与下载](https://nodejs.org/en/blog/release/v22.23.3)、[官方 Node 发布者公钥](https://github.com/nodejs/release-keys)、[Python 支持周期](https://devguide.python.org/versions/)、[Python 3.11.17 Trixie 镜像元数据](https://github.com/docker-library/repo-info/blob/master/repos/python/remote/3.11.17-slim-trixie.md)、[Python 3.11.17 Alpine 镜像元数据](https://github.com/docker-library/repo-info/blob/master/repos/python/remote/3.11.17-alpine3.24.md)。
