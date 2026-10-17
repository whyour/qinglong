# 平台完整升级包

CI 从同次构建的不可变镜像摘要导出完整 tar.gz，包含源码中的运行脚本和模板、前后端编译产物、锁文件和已经安装的生产 `node_modules`。不包含 Node 可执行文件、用户数据、`.env`、Git 历史或 npm 缓存。保留现有 Node 和用户脚本依赖。

## 在线升级

`package.json` 中 `qinglongUpgradeFormat: 2` 表示使用完整包。旧版升级器仍可通过原归档路径完成首次迁移；完整包版本不会在平台包缺失、损坏或不兼容时退回设备端 npm 安装。

面板下载任务与本地离线入口共用 `platformBundle.cjs`：平台匹配 → 归档安全检查 → 全文件/链接/权限和锁文件校验 → SQLite/Sequelize/cron-parser/gRPC/undici 加载及 SQLite 内存库读写 → 发布就绪指针。重启前重新验证完整载荷。离线升级同步面板任务状态，并与在线任务互斥；中断准备时保留之前的可用就绪包。原有服务停止、文件备份、启动健康检查及失败恢复仍由共享升级引擎处理。

渠道索引为 GitHub prerelease `upgrade-develop` 或 `upgrade-master` 下的 `latest.json`。索引记录准确字节数、SHA256 和不可变 `upgrade-<commit>` release 资产 URL。12 个平台均完成归档、解包后复验及依赖试运行才发布渠道；过期工作流不能覆盖更新提交的渠道。

## 手动离线安装和升级

从同一个 `upgrade-<commit>` release 下载匹配设备的 `.tar.gz` 和独立 `install-bundle.cjs`。独立安装器已内置解析依赖，在目标设备无需 npm、pnpm 或重新安装 SQLite。可对照同 release 的 `latest.json` 核对归档 SHA256。

已有安装（默认应用并重启）：

```sh
node install-bundle.cjs --root /ql --file /absolute/path/qinglong-<commit>-linux-arm64-musl.tar.gz
```

只准备，稍后手动重启：

```sh
node install-bundle.cjs --root /ql --file /absolute/path/package.tar.gz --download-only
ql reload system
```

安装到空目录：

```sh
node install-bundle.cjs --root /opt/qinglong --file /absolute/path/package.tar.gz --install
QL_DIR=/opt/qinglong bash /opt/qinglong/shell/start-simplify.sh
```

`--install` 拒绝非空目录，不覆盖既有配置。该包安装青龙及其 Node 生产依赖；首次启动仍需已有 Python、Bash、PM2、nginx 等相应运行环境，不会在线安装或替换它们。服务启动和系统自启按原手动安装流程配置。

## 平台兼容

- 最低 Node 为 20.18.1，Node-API 至少 6；安装器只检查，不替换 Node。
- 以 Node 实际运行架构、ARM 指令集和 libc 类型/版本选择包；不依据 Docker 架构别名猜测。
- glibc、musl 分包，并记录构建系统 libc 下限。系统库仍以目标设备加载测试作为最后检查。
- ARMv6 与 ARMv7 使用不同包名。ARMv6 在目标镜像中从源码编译 SQLite，禁止复用 generic `arm` 的 ARMv7 预编译件；构建需通过加载和内存库读写，失败则不发布渠道。
- ARMv6 的归档构建、在线更新工作进程及独立离线安装器使用 `--jitless`，避开 ARM1176 上 V8 的优化编译崩溃；保留现有 Node 二进制，正常面板进程的启动参数不变。依赖加载和 SQLite 读写仍由现有 Node 的独立进程验证。
- tar 中允许 pnpm 的包内符号链接；拒绝绝对路径、越界路径、包外链接、硬链接、设备条目和经符号链接写入的条目。重启前再次校验依赖，暂存失败保留上一次可用的就绪包。

自托管镜像可设置 `QL_UPGRADE_INDEX_URL` 指向兼容索引；要求 HTTPS，测试时仅放行 loopback HTTP。索引和所有平台归档应部署到同一可访问源，避免依赖额外的 raw 域名。
