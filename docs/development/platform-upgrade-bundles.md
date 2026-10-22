# 平台完整升级包

CI 从同次构建的不可变镜像摘要导出完整 tar.gz，包含源码中的运行脚本和模板、前后端编译产物、锁文件和已经安装的生产 `node_modules`。不包含 Node 可执行文件、用户数据、`.env`、Git 历史或 npm 缓存。保留现有 Node 和用户脚本依赖。面板最低需要 Node 22.17，推荐 Node 24；Node 20 安装先升级运行时，应用更新包不会替换 Node。

## 在线升级

`package.json` 中 `qinglongUpgradeFormat: 2` 表示使用完整包。旧源码归档升级器可在运行时满足最低版本后迁移；已安装的旧格式 2 校验器仍要求 sqlite3 原生模块，首次切换到 node:sqlite 包需使用同批次新版独立安装器执行完整安装和重启，或先更新镜像。旧校验器会拒绝新依赖布局并保留旧服务；完整包版本不会在平台包缺失、损坏或不兼容时退回设备端 npm 安装。仅当完整包已通过校验、依赖加载或后端预启动明确报告依赖错误时，在线升级会按同一冻结锁文件修复一次生产依赖，然后再次预启动；第二次失败即停止，保留正在运行的旧服务。

面板下载任务与本地离线入口共用 `platformBundle.cjs`：平台匹配 → 归档安全检查 → 全文件/链接/权限和锁文件校验 → MikroORM/cron-parser/gRPC/undici 加载及 node:sqlite 内存库读写（旧包继续检查 SQLite/Sequelize） → 隔离后端预启动 → 发布就绪指针。预启动使用现有 Node、临时数据目录和 loopback 随机端口，运行真实数据库建表/迁移和事务读写、gRPC 服务，以及与正常启动共用的 HTTP 中间件、路由和 WebSocket 初始化，再通过 `/api/health` 确认双服务与目标版本、提交和后端摘要；不运行任务、订阅、通知、用户启动钩子和系统依赖安装。临时库不是用户数据库副本，因此实际应用后的健康检查和回退仍不可省略。点击重启时，接口只检查就绪记录并提交后台任务；完整文件与依赖复验由独立工作进程执行，复验通过后才停止旧服务，避免小设备的预检耗时超过 HTTP 请求期限。离线升级同步面板任务状态，并与在线任务互斥；中断准备时保留之前的可用就绪包。原有服务停止、文件备份、启动健康检查及失败恢复仍由共享升级引擎处理。

正式升级包跟随 master 同一次版本镜像构建；develop 的普通提交也自动构建开发包。两者都直接使用该次 Alpine/Debian 镜像的不可变 digest。Git tag 工作流和 `static_sync_only` 不生成完整包。需要重建当前开发包时，可手动运行同一工作流：

```sh
gh workflow run build-docker-image.yml --ref develop
```

开发包更新共用的 `upgrade-develop/latest.json`。`develop` 和 `debian-dev` 镜像都使用该索引，按实际 Node 架构和 musl/glibc 选择包，无需设置测试专用下载源。开发批次位于 `upgrade-build-develop-v<version>-<run-id>-<run-attempt>`，不会改写正式版本或 `upgrade-master`。同一开发渠道的镜像构建和包发布串行执行，与 master 独立。

开发包只保留最新一个已验证批次：所有平台资产和渠道索引的大小、SHA256 校验成功后，删除其他名称匹配的开发构建 prerelease；不删除正式包、渠道索引或无法分类的旧 release。构建或上传失败不会删除上一套可用包。旧批次被删除后，已选中旧索引但尚未下载完的客户端可能需要重新发起下载；准备失败仍保留旧服务和数据。

开发和正式包都必须在 12 个平台完成归档、解包后复验及依赖试运行，并且全部上传资产的大小和 SHA256 复验通过后，才更新各自索引。平台范围与现有 Alpine/Debian 镜像一致：ARMv6 仅提供 musl 包，不提供 ARMv6 glibc 包。

版本入口为 GitHub prerelease `upgrade-v<version>` 下的 `latest.json`；在线正式渠道保留 `upgrade-master/latest.json`，兼容现有客户端。二者指向同一套完整包，指定版本与 latest 不重复生成产物。索引记录渠道、版本、源码提交、构建批次、准确字节数、SHA256，以及 `upgrade-build-v<version>-<run-id>-<run-attempt>` 下的固定下载 URL。相同版本的镜像 tag 重新发布时，完整包也重新生成，版本和正式渠道索引同步覆盖到新批次；同一提交重跑也允许产生新内容。已选中旧索引的下载继续使用旧批次资产，避免覆盖文件导致哈希不匹配。master 的镜像构建和完整包发布整条流水线串行执行，避免镜像 tag 与完整包被并发重发交错覆盖；旧工作流明确重跑时也允许同版本、同提交重新发布。过期源码提交不能推进对应渠道或版本索引；平台包上传失败时不切换索引。

## 手动离线安装和升级

从 `upgrade-v<version>` 的说明或 `latest.json` 中取得当前批次的下载链接，下载匹配设备的 `.tar.gz` 和独立 `install-bundle.cjs`；两者都来自同一个 `upgrade-build-v<version>-<run-id>-<run-attempt>` release。独立安装器已内置解析依赖，在目标设备正常情况无需 npm、pnpm 或重新安装 SQLite。离线准备和预启动默认不联网；依赖不符合要求时直接报错。可对照同批次 release 的 `latest.json` 核对归档 SHA256。

已有安装（默认应用并重启）：

```sh
node install-bundle.cjs --root /ql --file /absolute/path/qinglong-<commit>-linux-arm64-musl.tar.gz
```

已迁移的安装只准备，稍后手动重启（首次从旧格式 2 迁移应直接执行上一条新版独立安装器命令，不能调用旧版 `ql reload system`）：

```sh
node install-bundle.cjs --root /ql --file /absolute/path/package.tar.gz --download-only
ql reload system
```

仅在明确允许联网修复时添加 `--repair-deps`（安装和升级均支持），例如：

```sh
node install-bundle.cjs --root /ql --file /absolute/path/package.tar.gz --download-only --repair-deps
```

修复需要已有 pnpm 8.3.1。新包在私有目录按 `--prod --frozen-lockfile` 重装生产 JavaScript 依赖，不编译 SQLite。只有旧包显式依赖 sqlite3 时才需要编译工具并重建 SQLite；旧 ARMv6 包强制源码编译和 ARMv6 硬浮点指令，禁止下载 generic ARM 的 ARMv7 二进制。修复仅执行一次；不安装或替换 Node、不改锁文件、不改已校验源码和静态产物。应用前以原包校验清单和独立记录的修复依赖摘要复验。

修复继承调用环境中的标准 HTTP/HTTPS/ALL/NO_PROXY（含小写形式），其余 Node 预加载和编译参数仍隔离。修复安装或 SQLite 重建失败时，清理私有目录，保留当前服务、当前依赖及上一次就绪包；不会标记本次更新就绪。预启动或修复主进程退出时立即终止其进程组，防止持有输出管道的子进程继续写入已清理目录。

通过 Bash 或已选择的本地 CLI 执行上述重启时，也会把已准备的面板任务更新为完成或失败；启动成功必须同时匹配目标版本、提交和后端哈希，匹配失败则恢复旧文件和服务。

手动应用会以当前就绪指针为准建立新的应用任务，并清除之前的失败信息。因此，准备失败后应用保留的旧就绪包、此前任务已完成后再次应用，以及完整包安装中任务记录丢失或尚未建立时，仍会校验实际启动版本并同步面板状态。未支持完整包且没有任务记录的旧版保留原重载兼容路径。

重启中断后的停止新服务、恢复文件和启动旧服务不再使用已经取消的信号。若新服务无法停止，则保留备份，避免在仍运行的进程下覆盖文件；若文件已恢复但旧服务也无法启动，任务仍报告失败。Bash 和本地 CLI 启动后端时都移除离线包选择、修复许可和升级启动器 PID，避免后续在线更新误用旧离线包；用户配置及代理保持不变。回滚恢复应用文件和依赖，不把用户数据库恢复到历史快照；数据库迁移仍需保持向后兼容。

安装到空目录：

```sh
node install-bundle.cjs --root /opt/qinglong --file /absolute/path/package.tar.gz --install
QL_DIR=/opt/qinglong QL_DATA_DIR=/opt/qinglong/data bash /opt/qinglong/shell/start-simplify.sh
```

`--install` 拒绝非空目录，不覆盖既有配置。该包安装青龙及其 Node 生产依赖；首次启动仍需已有 Python、Bash、OpenSSL、PM2、nginx 等相应运行环境，不会在线安装或替换它们。手动启动脚本会在启动工作进程前完成首次 gRPC 证书准备，避免慢设备生成密钥耗尽工作进程的就绪期限；已有证书继续复用。服务启动和系统自启按原手动安装流程配置。

ARMv6 小设备使用 `linux-armv6-musl.tar.gz`，要求已有兼容的 musl 系统及硬浮点 Node。ARMv6 glibc（例如 Raspbian/Raspberry Pi OS 32 位系统）不在平台包支持范围内，不能使用 ARMv7 或 musl 包替代；安装器仍会检查实际架构和 libc，拒绝不匹配的包。

## npm 面板包

`@whyour/qinglong` 仍通过 npm 安装生产依赖；它包含运行脚本、gRPC proto、升级引擎和完整前后端构建，不包含用户数据、Node、开发 CLI 或生产 `node_modules`。`@whyour/qinglong-cli` 是单独的远程管理包。

npm 会排除根目录的 `pnpm-lock.yaml`。主包的原生 `npm pack/publish` 在 `prepack` 中核对当前 Git 提交、干净工作区、锁文件及完整构建文件的哈希，通过后才将锁文件复制为 `shell/upgrade-lock.yaml`，安装时由仅使用 Node 内置模块的 `postinstall` 校验 SHA256 后恢复标准路径；源代码安装和 Docker 的最小依赖构建阶段继续使用原有锁文件。归档使用精确运行文件白名单，避免打入本地生成的预加载配置、缓存、测试和验收输出。静态构建中的 source map 与 gzip 文件也必须完整保留，否则清单复验会失败。

`package.json#files` 是 npm 包内容的唯一项目规则，不再维护根 `.npmignore`：npm 在根包使用 `files` 时会停用该目录的 `.npmignore` 和 `.gitignore` 规则。打包测试在没有 `.npmignore` 的独立源码目录中注入私有配置、密钥占位文件、缓存及生成的预加载配置，执行真实 `npm pack` 和安装，检查运行文件完整、私有文件及其内容不进入归档。此规则只用于 npm 包，完整平台 tar.gz 仍由平台包构建器处理。

干净源码完成 `pnpm build:front`、`pnpm build:back`、`pnpm build:info` 后，运行 `node scripts/verify-panel-package.cjs pack /tmp/qinglong-npm` 生成并检查真实 npm 归档。CI 在一次性 Linux 容器中，以 Node 22.17.0 和 Node 24 安装同一个归档，使用真实生产依赖和已安装的 `qinglong`、`ql` 入口，验证启动、损坏下载保留旧服务、在线准备与重启、离线准备与 Bash 重启及账号、配置、环境变量、任务和脚本保留。测试还安装完整性摘要固定的已发布 `@whyour/qinglong@2.23.0`，在旧服务中建立真实数据，再用新 `.tgz` 执行 npm 覆盖安装，验证账号、配置、环境变量、任务和脚本保留。之后升级到同次 Debian 镜像不可变 digest 通过正式 `Dockerfile.upgrade-bundle` 导出的原始平台包，确认运行目录变为 pnpm 布局。该单平台验收包仅上传短期 CI artifact，不发布 Release，也不推进开发或正式更新索引。

Umi 4.4.4 的构建依赖仍使用 Node 24 已移除的 `http_parser`。前端源码构建使用 `.nvmrc` 中的 Node 22，CI 从该文件读取版本，Vercel 前后端项目均配置为 Node 22.x。`package.json` 不声明 `engines.node`，避免 Vercel 用开放的最低运行版本范围覆盖项目的构建版本；`pnpm build:front` 直接执行构建，不下载或切换 Node。面板运行时最低为 Node 22.17，平台包清单、npm preinstall 和数据库进程均检查最低 Node 要求。CI 的 Node 20.18.1 项使用实际新 npm 归档验证拒绝安装，以及本地/全局旧包、`.env`、外置数据和旧服务保留；它不启动新后端。构建专用环境可跳过安装阶段的运行时探测，后端启动不跳过版本检查。

服务集成测试只能在专用容器中运行：设置 `QL_PANEL_PACKAGE_TEST_ISOLATED=1`、指向隔离 PM2 的 `QL_PANEL_TEST_PM2` 和指向正式构建脚本输出目录的 `QL_PANEL_TEST_BUNDLE_DIR`，然后执行 `node scripts/verify-panel-package.cjs verify /tmp/qinglong-npm /tmp/qinglong-npm-results`。容器需已有 Bash、curl、OpenSSL、Python、jq、nginx 和 procps。旧正式包会重置 PATH，因此验收容器将 PM2 6.0.14 安装到 `/usr/local/bin/pm2`，并以此设置 `QL_PANEL_TEST_PM2`；隔离通过专属容器和独立 `PM2_HOME` 保证。测试创建独立的 npm prefix、HOME、PM2_HOME 和数据目录，结束后清理。

通过 npm 覆盖升级前，应先停止服务，执行新包安装，再启动服务。正常 npm 安装的 `postinstall` 会从当前路径对应的 npm 旧包临时目录中自动保留 `.env`，逐字节恢复为权限 `0600` 的普通文件，不需要手工备份和恢复；新目录中已有的 `.env` 不会被覆盖。只读取包名匹配的旧包，不扫描其他安装或备份目录；异常配置（如符号链接）会使安装失败，由 npm 回退旧包，避免静默丢失配置。此机制需要启用 npm 安装脚本，不能使用 `--ignore-scripts`。持久数据仍必须放在包目录以外的 `QL_DATA_DIR`。验收直接检查真实旧 npm 包覆盖安装后配置自动保留，并校验外置用户数据。在线和离线平台包升级仍由事务保留现有 `.env`。

master 发布任务等待上述测试通过，直接发布已验证的 `.tgz`，不重新构建或打包。develop 只生成测试归档与验收记录，不发布 npm。

## 数据库兼容与回滚

生产环境使用 MikroORM 7 的官方 NodeSqliteDialect。Sequelize 和 sqlite3 只作为开发测试依赖，用于验证旧库读写，不进入生产依赖。九张业务表及既有迁移记录保留原名和结构，不运行 ORM 自动改表；日期保持旧版 UTC 文本格式，JSON、ID、排序精度及 Keyv 缓存格式保持兼容，旧版可读新版写入的数据。

每个后端进程延迟启动一个有界数据库子进程，避免同步 node:sqlite 阻塞 HTTP 和调度事件循环。事务独占请求队列，嵌套事务使用 SAVEPOINT；事务异常回滚。数据库进程退出或超时后拒绝后续请求、健康检查失败，不自动重放写入；恢复由服务重启完成。后端正常退出会终止其数据库子进程，预启动监督器还会终止整个临时进程组。数据库进程在打开 SQLite 前启动一个仅监视父进程的轻量线程；即使主 SQL 线程阻塞，父进程被强杀后也会终止整个数据库进程并释放事务锁，避免阻止旧服务重启。

## 平台兼容

- 最低 Node 为 22.17，Node-API 至少 6；安装器只检查，不替换 Node。Debian amd64、arm64、ppc64le、s390x 使用 Node 24；官方 Node 24 不提供 Linux ARMv7 二进制，Debian ARMv7 使用 Node 22 LTS。
- 以 Node 实际运行架构、ARM 指令集和 libc 类型/版本选择包；不依据 Docker 架构别名猜测。
- glibc、musl 分包，并记录构建系统 libc 下限。系统库仍以目标设备加载测试作为最后检查。
- ARMv6 与 ARMv7 使用不同包名。当前生产依赖没有 SQLite 原生 addon，使用设备 Node 自带的 node:sqlite。ARMv6 Node 本身仍须兼容 ARM1176 和硬浮点；构建需通过内置 SQLite 的加载和内存库读写，失败则不发布渠道。
- ARMv6 的归档构建、在线更新工作进程及独立离线安装器使用 `--jitless`，避开 ARM1176 上 V8 的优化编译崩溃；保留现有 Node 二进制，Node 24 及以上的 ARMv6 面板进程通过共享 `nodeRuntime` 使用 `--no-opt --no-sparkplug --no-maglev`，其他架构和较低 Node 版本保持原启动参数。ARMv6 的 gRPC 工作进程首次启动及重建最多等待 2 分钟；升级后的整体健康检查最多等待 5 分钟，覆盖慢设备按顺序启动数据库、调度与 HTTP 工作进程的耗时；其他平台仍为 60 秒，超时或版本校验失败仍执行回退。依赖加载与后端预启动保留 HTTP/WebAssembly 所需能力。预启动使用一个后端和一个数据库子进程，按顺序初始化数据库、gRPC、HTTP，不启动 PM2/cluster；后端的 ARMv6 V8 堆上限 128 MiB、期限 5 分钟，其他平台为 192 MiB/60 秒。数据库执行主线程的 V8 堆上限 128 MiB，ARMv6 使用 `--jitless`；监视线程不加载 ORM、HTTP 或 ts-node，并保留进程的 V8 模式。主线程和监视线程的 V8 限制不是 RSS 总内存上限，系统仍需为现有服务和 OpenSSL 留出内存。依赖修复的包管理器及编译使用单并发、低网络并发和有界时长；ARMv6 包管理器采用 `--jitless`、256 MiB 堆上限，并优先复用版本匹配的现有 Node 头文件与实际运行时编译配置；超时、中断会终止整个进程组并清理临时目录。
- tar 中允许 pnpm 的包内符号链接；拒绝绝对路径、越界路径、包外链接、硬链接、设备条目和经符号链接写入的条目。重启前再次校验依赖，暂存失败保留上一次可用的就绪包。

归档先完整预检路径、类型、大小与链接，再向新建的私有目录逐个流式写入文件。文件写入使用 Node 的完整写入接口，处理短写后才关闭文件；目录权限在写入结束后恢复，避免受调用进程的 umask 影响。读取、解析或写入失败时，等候待写文件关闭后再清理，不发布就绪状态。校验失败会列出最多五个文件的预期和实际权限、哈希或链接信息，不输出文件内容。

自托管镜像可设置 `QL_UPGRADE_INDEX_URL` 指向兼容索引；要求 HTTPS，测试时仅放行 loopback HTTP。索引和所有平台归档应部署到同一可访问源，避免依赖额外的 raw 域名。
