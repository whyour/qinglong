// Migrated from shell/lang/en.sh; the original remains for differential evaluation.
export const english: Record<string, string> = {
  '需要双因素验证，请调用 user two-factor-login。': 'Two-factor authentication required; use user two-factor-login.',
  'QL_URL 和 QL_ACCESS_TOKEN 必须同时提供。': 'Provide QL_URL and QL_ACCESS_TOKEN together.',
  '接口返回 JSON，未保存下载文件。': 'The endpoint returned JSON; no download was saved.',
  '已选择的 CLI 安装路径必须为绝对路径。':
    'The selected CLI installation path must be absolute.',
  '保留 CLI 入口仅支持已确认的 2.x 升级载荷。':
    'Preserving CLI entries requires a verified 2.x upgrade payload.',
  '无法确认已选择的 CLI 命令加载器，请检查安装。':
    'Cannot verify the selected CLI command loader. Check the installation.',

  '容器入口仅接受通过环境变量配置。':
    'Container entry accepts configuration through environment variables only.',
  '任务延迟过滤已取消。': 'Task delay filtering cancelled.',
  '任务延迟过滤失败（退出码 %s）。': 'Task delay filtering failed (exit %s).',
  '直接运行的后端在启动期间退出（%s）。':
    'Direct backend exited during startup (%s).',
  '无法获取本机系统令牌，请检查运行中的面板。':
    'Cannot obtain a local system token. Check the running panel.',
  '本机面板端口无效。': 'Invalid local panel port.',
  '本机 API 拒绝请求（HTTP %s）。': 'Local API rejected request (HTTP %s).',
  '本机 API 请求失败；请先检查操作结果，不要直接重试写入。':
    'Local API request failed; do not retry a mutation without checking its result.',
  '本机 API 拒绝请求，请检查面板日志和权限。':
    'Local API rejected request. Check panel logs and permissions.',
  '任务列表响应无效。': 'Invalid task list response.',
  '任务响应无效。': 'Invalid task response.',
  '日志响应无效。': 'Invalid log response.',
  '订阅响应无效。': 'Invalid subscription response.',
  '订阅列表响应无效。': 'Invalid subscription list response.',
  '返回的订阅 ID 与请求不一致。': 'Unexpected subscription ID.',
  '订阅日志响应无效。': 'Invalid subscription log response.',
  '不支持的订阅操作。': 'Unsupported subscription operation.',
  '路径必须位于其管理目录内部。':
    'Path must be a descendant of its managed directory.',
  '仓库路径无效。': 'Invalid repository path.',
  '单文件订阅需要 HTTP(S) 地址。': 'Raw subscriptions require HTTP(S).',
  '订阅任务同步返回了无效任务列表。':
    'Invalid task list during subscription reconciliation.',
  '无法启动必要的可执行程序：%s': 'Cannot start required executable: %s',
  '子进程输出写入失败。': 'Child output sink failed.',
  '子进程输出超过配置的捕获上限。':
    'Child output exceeded the configured capture limit.',
  '必要的可执行程序失败（%s，退出码 %s）。':
    'Required executable failed (%s, exit %s).',
  'CLI 安装路径必须为绝对路径。': 'CLI installation paths must be absolute.',
  'CLI 入口必须为普通文件。': 'CLI entry is not a regular file.',
  '命令日志目录无效。': 'Invalid command log directory.',
  'QlPort 必须在 1 到 65535 之间。': 'QlPort must be between 1 and 65535.',
  'CLI 调用失败。': 'CLI invocation failed.',
  '不支持此部署操作系统：%s。': 'Unsupported deployment OS: %s.',
  'Python 返回了无效版本。': 'Python returned an invalid version.',
  '启动需要以 /data 结尾的绝对数据目录。':
    'Startup requires an absolute data directory ending in /data.',
  '容器安装目录和数据目录必须为绝对路径。':
    'Container root and data directory must be absolute paths.',
  '容器目录不可写或不可访问：%s（UID %s）。请检查挂载目录的所有者和权限。':
    'Container directory is not writable/searchable: %s (UID %s). Check the mounted directory ownership and permissions.',
  '无法初始化 %s：%s': 'Cannot initialize %s: %s',
  'QL_SCHEDULER 必须为 node 或 system。':
    'QL_SCHEDULER must be node or system.',
  '容器调度器意外退出（%s）。': 'Container scheduler exited unexpectedly (%s).',
  'Bot 安装不支持此操作系统：%s。': 'Bot installation does not support OS: %s.',
  'Bot 仓库包含指向目录外部的符号链接。':
    'Bot repository contains an external symlink.',
  'Bot 仓库包含不支持的文件类型。':
    'Bot repository contains an unsupported entry.',
  'Bot 源必须为普通目录。': 'Bot source must be a regular directory.',
  'Bot 配置模板必须为普通文件。':
    'Bot configuration template must be a regular file.',
  'Bot 进程管理需要 Linux。': 'Bot process management requires Linux.',
  'Bot 安装和进程管理需要 Linux。':
    'Bot installation and process management require Linux.',
  'Bot 在启动期间退出（%s）。': 'Bot exited during startup (%s).',
  '订阅路径包含换行或空字符，无法安全过滤。':
    'Subscription paths with line breaks cannot be filtered safely.',
  '订阅 POSIX 正则表达式无效。':
    'Invalid subscription POSIX regular expression.',
  '订阅过滤失败（退出码 %s）。': 'Subscription filtering failed (exit %s).',
  '账号选择格式无效。': 'Invalid account selection.',
  '账号选择超出环境变量的账号范围。':
    'Account selection is outside the environment variable range.',
  '超时必须为正时长，例如 30s 或 5m。':
    'Timeout must be a positive duration, e.g. 30s or 5m.',
  '超时时长超出支持范围。': 'Timeout is outside the supported range.',
  '必须指定脚本或可执行程序。': 'A script or executable is required.',
  '必须指定有效的账号环境变量名。':
    'A valid account environment variable is required.',
  'cron 环境变量值无效。': 'Invalid cron environment value',
  'cron 安装路径必须为绝对路径。': 'Cron installation paths must be absolute',
  '拒绝覆盖不属于此 CLI 的用户 crontab 命令。':
    'Refusing to replace an unrelated user crontab command',
  '无法安装或读取面板 crontab，请检查环境路径和系统 cron 工具。':
    'Cannot install or read the selected panel crontab. Check its environment paths and system cron tool.',
  '后端进程未在 5 秒内停止，已取消重启。':
    'Direct backend did not stop within 5 seconds; restart cancelled.',
  '无法检查运行中的后端进程。': 'Cannot inspect running backend processes.',
  '升级文件包含指向目录外部的符号链接。':
    'Upgrade payload contains an external symlink.',
  '升级文件包含不支持的文件类型。':
    'Upgrade payload contains unsupported filesystem entries.',
  '升级归档包含无效路径。': 'Upgrade archive contains an invalid path.',
  '升级归档包含符号链接。': 'Upgrade archive contains symlinks.',
  '暂存升级指针无效。': 'Invalid staged upgrade pointer.',
  '暂存升级目录无效。': 'Invalid staged upgrade directory.',
  '暂存升级就绪记录与目录不匹配。':
    'Staged upgrade readiness does not match its directory.',
  '替换源与目标相同。': 'Replacement source equals destination.',
  '替换源位于目标目录内部。': 'Replacement source is inside its destination.',
  '重载失败；文件已恢复，但原服务无法重新启动。':
    'Reload failed; files restored, but the previous service could not restart.',
  '数据重载需要独立的数据目录。':
    'Data reload requires a dedicated data directory.',
  '暂存数据与已安装的数据目录必须分离。':
    'Staged data must be separate from the installed data directory.',
  '主机开机注册需要 OpenRC 或 systemd；仅在其他管理器负责服务时使用 --no-startup。':
    'Host startup registration requires OpenRC or systemd. Use --no-startup only when another supervisor owns the services.',
  '本机命令需要通过 --root 或 QL_DIR 指定绝对路径。':
    'Local commands require an absolute --root or QL_DIR.',
  '面板安装目录不存在或不是目录。': 'Panel root does not exist.',
  '用户配置加载已取消。': 'User configuration evaluation cancelled.',
  '用户配置加载失败。': 'User configuration evaluation failed.',
  '用户配置返回了无效的环境数据。':
    'User configuration returned invalid environment data.',

  '用法：ql-compat update [true|false]': 'Usage: ql-compat update [true|false]',
  '用法：ql-compat reload [services|system|data]':
    'Usage: ql-compat reload [services|system|data]',
  '未知旧命令，请运行 ql-compat --help。':
    'Unknown legacy command. Run ql-compat --help.',
  '命令已中断。': 'Command interrupted.',
  '旧命令适配器执行失败。': 'Legacy command adapter failed.',
  '用法：ql-subscription-worker repo|raw <url> [旧订阅参数]':
    'Usage: ql-subscription-worker repo|raw <url> [legacy subscription arguments]',
  '订阅布尔参数无效，只能使用 true 或 false。': 'Invalid subscription boolean.',
  '订阅参数过多。': 'Too many subscription arguments.',
  'SUB_ID 无效，必须为正整数。': 'Invalid SUB_ID.',
  '订阅执行器失败，请检查本机日志。':
    'Subscription worker failed. Check local logs.',

  '任务执行器选项无效。': 'Invalid runner options.',
  '本机任务在加载配置时已取消。':
    'Local task execution cancelled during configuration.',
  '本机任务执行失败，请检查面板环境和任务日志。':
    'Local task execution failed. Check the panel environment and task log.',
  '应用 ID': 'Client ID',
  应用密钥: 'Client secret',
  订阅: 'subscription',
  任务: 'task',
  应用凭据: 'application credentials',
  '应用凭据和 %s 权限': 'application credentials and %s permission',
  未知: 'unknown',
  ' 执行结果可能未知，请先检查%s状态再考虑重试。':
    ' Execution outcome may be unknown; check %s status before retrying.',
  'API 请求被拒绝（HTTP %s），请检查%s。%s':
    'API request rejected (HTTP %s). Check %s.%s',
  '请求失败或响应无效，执行结果未知。请先检查%s状态再考虑重试。':
    'Request failed or returned an invalid response; execution outcome is unknown. Check %s status before retrying.',
  '请求失败或返回的 JSON 无效，请检查实例 URL、网络和 TLS 证书。':
    'Request failed or returned invalid JSON. Check the instance URL, network and TLS certificate.',
  'API 请求被拒绝（code %s），请检查%s。':
    'API request rejected (code %s). Check %s.',
  'CLI 配置必须是当前用户拥有的私有普通文件（0600）。':
    'CLI config must be an owned private regular file (0600).',
  'CLI 配置无效，请运行 ql-cli login。':
    'Invalid CLI config. Run ql-cli login.',
  '尚未登录，请运行 ql-cli login。': 'Not logged in. Run ql-cli login.',
  '无法读取 CLI 配置，请检查文件权限并运行 ql-cli login。':
    'Cannot read CLI config. Check file permissions and run ql-cli login.',
  '请输入有效的面板 URL。': 'A valid panel URL is required.',
  '请使用不含凭据、查询参数或片段的 HTTP(S) 面板 URL。':
    'Use an HTTP(S) panel URL without credentials, query or fragment.',
  '远程认证需要 HTTPS；HTTP 仅允许回环地址。':
    'Remote authentication requires HTTPS; HTTP is allowed only for loopback.',
  '非交互登录需要 QL_CLIENT_ID 和 QL_CLIENT_SECRET。':
    'Non-interactive login requires QL_CLIENT_ID and QL_CLIENT_SECRET.',
  '登录已取消。': 'Login cancelled.',
  '凭据不能为空。': 'Credentials cannot be empty.',
  '认证响应无效。': 'Invalid authentication response.',

  '请输入支持范围内的整数。': 'Expected an integer within the supported range.',
  '未知命令，请运行 %s --help。': 'Unknown command. Run %s --help.',
  '选项未知或缺少选项值，请运行 %s --help。':
    'Unknown or missing option. Run %s --help.',
  '选项重复，请运行 %s --help。': 'Duplicate option. Run %s --help.',
  '参数多余或缺少必要参数。':
    'Unexpected argument or missing required argument.',
  '缺少 --%s。': 'Missing --%s.',
  '--%s 无效。': 'Invalid --%s.',
  'CLI 操作已取消。': 'CLI operation cancelled.',
  'CLI 操作失败，请检查本机配置和权限。':
    'CLI operation failed. Check local configuration and permissions.',
  '任务状态上报失败，请检查本机面板。\n':
    'Task lifecycle reporting failed; check the local panel.\n',
  '任务统计上报失败，请检查本机面板。\n':
    'Task statistics reporting failed; check the local panel.\n',
  '命令状态上报失败，请检查本机面板。\n':
    'Command lifecycle reporting failed; check the local panel.\n',
  '订阅同步已完成，但通知发送失败，请检查面板通知设置。\n':
    'Subscription synchronized, but notification delivery failed. Check panel notification settings.\n',

  '\n## 执行结束... %s 退出码 %s\n': '\n## Finished... %s exit code %s\n',
  '任务随机延迟 %s 秒，将于 %s 开始，配置文件参数 RandomDelay 置空可取消延迟\n':
    'Task delayed %s seconds, will start at %s. Set RandomDelay to empty to cancel delay\n',
  '开始执行...\n': 'Starting execution...\n',
  已停止: 'Stopped',
  完成: 'Completed',
  '失败(退出码 %s)': 'Failed (exit code %s)',
  '安装 %s 依赖包...\n': 'Installing %s dependencies...\n',
  '开始拉取仓库 %s 到 %s\n': 'Cloning repository %s to %s\n',
  添加成功: 'Added successfully',
  '添加失败(%s)': 'Add failed (%s)',
  更新成功: 'Updated successfully',
  '更新失败(%s)': 'Update failed (%s)',
  成功: 'Success',
  '失败(%s)': 'Failed (%s)',
  '通知发送成功🎉': 'Notification sent successfully 🎉',
  '通知失败(%s)': 'Notification failed (%s)',
  '当前有以下脚本可以运行:': 'Available scripts:',
  暂无脚本可以执行: 'No scripts available',
  '警告：工作目录不存在 %s': 'Warning: working directory does not exist: %s',
  '\n缺少并发运行的环境变量参数': '\nMissing concurrency environment variable',
  '\n缺少单独运行的参数 task xxx.js desi Test':
    '\nMissing parameter: task xxx.js desi Test',
  '暂不支持此系统 %s': 'Unsupported system: %s',
  '检测到 pm2 服务正在运行': 'pm2 service is running',
  'npm 模块位置: %s': 'npm module location: %s',
  '导入数据成功 %s': 'Data imported successfully: %s',
  '导出数据成功 %s': 'Data exported successfully: %s',
  '当前版本: %s / 最新版本: %s': 'Current: %s / Latest: %s',
  已是最新版本: 'Already up to date',
  '%s 个定时任务正在运行': '%s scheduled tasks running',
  '执行前置命令\n': 'Running pre-command\n',
  '\n执行前置命令结束\n': '\nPre-command finished\n',
  '\n执行后置命令\n': '\nRunning post-command\n',
  '\n执行后置命令结束': '\nPost-command finished',
  '警告: PM2 启动失败 (退出码: %s)，可能是由于硬件不兼容':
    'Warning: PM2 start failed (exit code: %s), possibly due to hardware incompatibility',
  '正在尝试直接使用 Node.js 启动服务...':
    'Attempting to start service with Node.js directly...',
  '已使用 Node.js 直接启动服务 (PID: %s)':
    'Service started with Node.js directly (PID: %s)',
  '注意: 使用此模式时，部分 PM2 管理功能将不可用':
    'Note: some PM2 management features are unavailable in this mode',
  '## 开始执行... %s\n': '## Starting... %s\n',
  '\n## 已停止 🛑... %s  耗时 %s 秒%s':
    '\n## Stopped 🛑... %s  took %s seconds%s',
  '\n## 完成 ✅... %s  耗时 %s 秒%s':
    '\n## Completed ✅... %s  took %s seconds%s',
  '\n## 失败 ❌(退出码 %s)... %s  耗时 %s 秒%s':
    '\n## Failed ❌(exit code %s)... %s  took %s seconds%s',
  '%s -> 添加成功': '%s -> Added successfully',
  '%s -> 添加失败(%s)': '%s -> Add failed (%s)',
  '%s -> 更新成功': '%s -> Updated successfully',
  '%s -> 更新失败(%s)': '%s -> Update failed (%s)',
  '%s成功🎉': '%s succeeded 🎉',
  '%s失败(%s)': '%s failed (%s)',
  '检测到有%s的定时任务:': 'Found %s scheduled tasks:',
  '\n开始尝试自动删除失效的定时任务...':
    '\nAttempting to remove invalid scheduled tasks...',
  '\n开始尝试自动添加定时任务...': '\nAttempting to add scheduled tasks...',
  '拉取 %s 成功...\n': 'Pull %s succeeded...\n',
  '拉取 %s 失败，请检查日志...\n': 'Pull %s failed, check logs...\n',
  '开始下载：%s 保存路径：%s\n': 'Downloading: %s to: %s\n',
  '下载 %s 成功...\n': 'Download %s succeeded...\n',
  '下载 %s 失败，保留之前正常下载的版本...\n':
    'Download %s failed, keeping previous version...\n',
  '%s文件不存在，跳过执行...\n': '%s does not exist, skipping...\n',
  '使用 %s 源更新...\n': 'Updating using %s mirror...\n',
  '更新青龙源文件成功...\n': 'Qinglong source updated successfully\n',
  '更新青龙源文件失败，请检查网络...\n':
    'Qinglong source update failed, check network\n',
  '更新青龙静态资源成功...\n': 'Static assets updated successfully\n',
  '更新青龙静态资源失败，请检查网络...\n':
    'Static assets update failed, check network\n',
  '\n开始检测依赖...\n': '\nChecking dependencies...\n',
  '\n依赖检测安装成功...\n': '\nDependencies installed successfully\n',
  '更新包下载成功...\n': 'Package download succeeded\n',
  '\n依赖检测安装失败，请检查网络...\n':
    '\nDependency installation failed, check network\n',
  '\n1、安装bot依赖...\n': '\n1. Installing bot dependencies...\n',
  '\nbot依赖安装成功...\n': '\nBot dependencies installed\n',
  '2、下载bot所需文件...\n': '2. Downloading bot files...\n',
  '\nbot文件下载成功...\n': '\nBot files downloaded\n',
  '3、安装python3依赖...\n': '3. Installing python3 dependencies...\n',
  '\npython3依赖安装成功...\n': '\nPython3 dependencies installed\n',
  '4、启动bot程序...\n': '4. Starting bot...\n',
  'bot启动成功...\n': 'Bot started successfully\n',
  '---> 1. 开始检测配置文件\n': '---> 1. Checking config...\n',
  '---> 配置文件检测完成\n': '---> Config check complete\n',
  '---> 2. 开始安装青龙依赖\n': '---> 2. Installing qinglong dependencies...\n',
  '---> 青龙依赖安装完成\n': '---> Dependencies installed\n',
  '---> 脚本依赖安装完成\n': '---> Script dependencies installed\n',
  '---> 1. 复制通知文件\n': '---> 1. Copying notification files...\n',
  '---> 复制一份 %s 为 %s\n': '---> Copying %s to %s\n',
  '---> 通知文件复制完成\n': '---> Notification files copied\n',
  '---> pm2日志': '---> pm2 log',
  '\n=====> 检测面板': '\n=====> Checking panel',
  '=====> 面板服务启动正常\n': '=====> Panel service running normally\n',
  '\n=====> 检测后台': '\n=====> Checking backend',
  '=====> 后台服务启动正常\n': '=====> Backend service running normally\n',
  '=====> 开始检测': '=====> Starting check',
  '\n=====> 检测结束\n': '\n=====> Check complete\n',
  '查询文件 %s': 'Checking file: %s',
  '删除中~': 'Deleting...',
  '正在被 %s 使用，跳过~': 'In use by %s, skipping...',
  '查找旧日志文件中...\n': 'Looking for old log files...\n',
  '删除旧日志执行完毕\n': 'Old log cleanup complete\n',
  '未找到 qinglong 模块，请先执行 npm i -g @whyour/qinglong 安装':
    'Module not found. Run: npm i -g @whyour/qinglong',
  '请先手动设置 export QL_DIR=%s，环境变量，并手动添加到系统环境变量，然后再次执行命令 qinglong 启动服务':
    'Set env: export QL_DIR=%s, then run qinglong to start',
  '请先手动设置数据存储目录 export QL_DATA_DIR 环境变量，目录必须以斜杠开头的绝对路径，并且以 /data 结尾，例如 /ql/data 并手动添加到系统环境变量':
    'Set QL_DATA_DIR (absolute path ending with /data, e.g. /ql/data)',
  'QL_DATA_DIR 必须以 /data 结尾，例如 /ql/data，如果有历史数据，请新建 data 目录，把历史数据放到 data 目录中':
    'QL_DATA_DIR must end with /data, e.g. /ql/data',
  '暂不支持此系统部署 %s': 'Unsupported system for deployment: %s',
  '命令输入错误...\n': 'Invalid command...\n',
};
