const messages: Record<string, Record<string, string>> = {
  zh: {},
  en: {
    '认证服务暂时不可用，请稍后重试':
      'Authentication service is temporarily unavailable; try again shortly.',
    '升级任务启动失败，请检查日志后重试':
      'Failed to start the update. Check the logs and try again.',
    '[schedule][停止已运行任务] 任务ID: %s, PID: %s':
      '[schedule][Stopping running task] Task ID: %s, PID: %s',

    '接口已下线，请使用 /configs/detail 接口':
      'This endpoint has been retired. Use /configs/detail instead.',
    '接口已下线，请使用 /logs/detail 接口':
      'This endpoint has been retired. Use /logs/detail instead.',
    '接口已下线，请使用 /scripts/detail 接口':
      'This endpoint has been retired. Use /scripts/detail instead.',
    '仅支持 PNG、JPEG、GIF、WebP、AVIF 图片':
      'Only PNG, JPEG, GIF, WebP and AVIF images are supported',
    请先初始化: 'Please initialize the panel first',
    请先关闭两步验证: 'Please disable two-factor authentication first',
    '失败次数过多，请稍后重试':
      'Too many failed attempts. Please try again later.',
    配置更新失败: 'Failed to update configuration',
    'trust proxy 配置格式无效': 'Invalid trust proxy configuration',
    '代理层数不能超过 20': 'Proxy hop count cannot exceed 20',
    '环境变量 QL_TRUST_PROXY 已生效，系统设置不可覆盖':
      'QL_TRUST_PROXY is active and cannot be overridden by system settings',
    系统配置不存在: 'System configuration does not exist',
    '历史版本仅支持不超过 1 MiB 的 UTF-8 文本脚本':
      'Version history only supports UTF-8 text scripts up to 1 MiB',
    脚本不存在: 'Script does not exist',
    请选择脚本文件: 'Please select a script file',
    '历史版本读取失败，请检查历史文件':
      'Failed to read version history. Check the history file.',
    历史版本不存在或已清理:
      'This history version does not exist or has been removed',
    '文件已变化，请刷新历史版本后重试':
      'The file has changed. Refresh version history and try again.',
    '历史版本容量不足，无法安全保存':
      'Version history storage is full. The file cannot be saved safely.',
    '跳过订阅 %s 的无效定时配置: %s':
      'Skipping invalid schedule for subscription %s: %s',
    '[schedule][准备运行任务] 命令: %s':
      '[schedule][Preparing task] Command: %s',
    '[schedule][创建定时任务] 任务ID: %s, 规则数: %s':
      '[schedule][Creating scheduled task] Task ID: %s, schedules: %s',
    '[schedule][取消定时任务] 任务ID: %s':
      '[schedule][Cancelling scheduled task] Task ID: %s',
    '[schedule][取消任务失败] 任务ID: %s, 错误: %s':
      '[schedule][Failed to cancel task] Task ID: %s, error: %s',
    '[panel][停止任务失败] PID: %s, 错误: %s':
      '[panel][Failed to stop task] PID: %s, error: %s',
    '[panel][停止实例失败] 实例ID: %s, PID: %s, 错误: %s':
      '[panel][Failed to stop instance] Instance ID: %s, PID: %s, error: %s',
    '[panel][执行任务失败] 任务ID: %s, 错误: %s':
      '[panel][Task failed] Task ID: %s, error: %s',
    '[panel][执行任务结束] 任务ID: %s, 退出码: %j':
      '[panel][Task finished] Task ID: %s, exit code: %j',
    '[panel][创建任务失败] 任务ID: %s, 错误: %s':
      '[panel][Failed to create task] Task ID: %s, error: %s',
    '[panel][关闭任务日志失败] %s': '[panel][Failed to close task log] %s',
    '[panel][清理任务状态失败] %s': '[panel][Failed to clear task status] %s',
    '性能指标报告:': 'Performance metrics:',
    '[panel][开始执行任务] 任务ID: %s': '[panel][Starting task] Task ID: %s',
    '[panel][任务错误回调失败] %s': '[panel][Task error callback failed] %s',
    '[panel][任务结束回调失败] %s':
      '[panel][Task completion callback failed] %s',
    '[panel][任务队列失败] %s': '[panel][Task queue failed] %s',
    '[panel][创建cron任务] 任务ID: %s, cron: %s, 任务名: %s, 执行命令: %s':
      '[panel][Creating cron task] Task ID: %s, cron: %s, name: %s, command: %s',
    '[panel][跳过无效定时任务] 任务ID: %s, cron: %s, 错误: %s':
      '[panel][Skipping invalid schedule] Task ID: %s, cron: %s, error: %s',
    '[panel][取消定时任务] 任务名: %s':
      '[panel][Cancelling scheduled task] Name: %s',
    '[panel][创建interval任务] 任务ID: %s, 任务名: %s, 执行命令: %s':
      '[panel][Creating interval task] Task ID: %s, name: %s, command: %s',
    '[panel][执行任务失败] 命令: %s, 错误信息: %j':
      '[panel][Task failed] Command: %s, error: %j',
    '[panel][取消interval任务] 任务ID: %s, 任务名: %s':
      '[panel][Cancelling interval task] Task ID: %s, name: %s',
    生成私钥文件失败: 'Failed to generate private key file',
    删除私钥文件失败: 'Failed to delete private key file',
    '删除ssh配置文件%s失败': 'Failed to delete SSH configuration file %s',
    '跳过订阅 %s 的无效 SSH 配置: %s':
      'Skipping invalid SSH configuration for subscription %s: %s',
    '[schedule][补执行迟到任务] 任务: %s, 计划时间: %s':
      '[schedule][Running late task] Task: %s, scheduled time: %s',
    '[schedule][定时回调失败] 任务: %s, 错误: %s':
      '[schedule][Scheduled callback failed] Task: %s, error: %s',
    '[schedule][任务队列] 空闲中...': '[schedule][Task queue] Idle...',
    '[schedule][任务加入队列] 运行中任务数: %s, 等待中任务数: %s':
      '[schedule][Task queued] Running: %s, waiting: %s',
    '[schedule][开始处理任务] 运行中任务数: %s, 等待中任务数: %s':
      '[schedule][Processing task] Running: %s, waiting: %s',
    '[schedule][任务处理成功] 参数 %s':
      '[schedule][Task succeeded] Arguments: %s',
    '[schedule][任务处理错误] 参数 %s': '[schedule][Task failed] Arguments: %s',
    '[schedule][任务处理结束] 运行中任务数: %s, 等待中任务数: %s':
      '[schedule][Task finished] Running: %s, waiting: %s',
    '[schedule][任务重复运行] 通知失败 %s':
      '[schedule][Duplicate task] Notification failed: %s',
    '[schedule][任务重复运行] 参数 %s':
      '[schedule][Duplicate task] Arguments: %s',
    '[schedule][停止已运行任务] 任务ID: %s':
      '[schedule][Stopping running task] Task ID: %s',
    '[schedule][检查已运行任务失败] 任务ID: %s, 错误: %s':
      '[schedule][Failed to check running task] Task ID: %s, error: %s',
    '[schedule][开始执行任务] 参数 %s':
      '[schedule][Starting task] Arguments: %s',
    '[schedule][任务标准错误] 命令: %s, 信息: %s':
      '[schedule][Task stderr] Command: %s, message: %s',
    '[schedule][执行任务失败] 命令: %s, 错误: %s':
      '[schedule][Task failed] Command: %s, error: %s',
    '[schedule][执行任务结束] 任务ID: %s, 退出码: %j':
      '[schedule][Task finished] Task ID: %s, exit code: %j',
    '[schedule][创建任务失败] 命令: %s, 错误: %s':
      '[schedule][Failed to create task] Command: %s, error: %s',

    '检查更新失败，请检查网络后重试':
      'Failed to check for updates. Check your network and try again.',
    '资源已存在，请检查重复的名称或值':
      'Resource already exists; check for duplicate names or values',
    暂无权限: 'Access denied',
    参数错误: 'Invalid parameter',
    参数不正确: 'Invalid parameter',
    文件无法访问: 'File not accessible',
    文件不存在: 'File not found',
    路径不存在: 'Path does not exist',
    路径不正确: 'Invalid path',
    '通知发送失败，请检查参数': 'Notification failed, check parameters',
    '通知发送失败，请检查系统设置/通知配置':
      'Notification failed, check system settings',
    通知发送成功: 'Notification sent successfully',
    设置时区失败: 'Failed to set timezone',
    任务未找到: 'Task not found',
    密码不能设置为admin: 'Password cannot be admin',
    更新成功: 'Update successful',
    未知错误: 'Unknown error',
    验证失败: 'Verification failed',
    实例不存在或已停止: 'Instance does not exist or stopped',
    实例已停止: 'Instance stopped',
    确认停止实例: 'Confirm to stop instance',
    确认停止运行实例: 'Confirm to stop running instance',
    确认停止: 'Confirm to stop',
    确认停止定时任务: 'Confirm to stop scheduled task',
    确认删除: 'Confirm to delete',
    确认删除定时任务: 'Confirm to delete scheduled task',
    确认删除选中的定时任务吗: 'Confirm to delete selected tasks?',
    确认运行: 'Confirm to run',
    确认运行定时任务: 'Confirm to run scheduled task',
    确认保存: 'Confirm to save',
    确认保存文件: 'Confirm to save file',
    确认重启: 'Confirm restart',
    确认启用: 'Confirm to enable',
    确认禁用: 'Confirm to disable',
    确认: 'Confirm',
    删除成功: 'Deleted successfully',
    操作成功: 'Operation successful',
    参数不完整: 'Incomplete parameters',
    默认路径不支持删除: 'Default path cannot be deleted',
    必须在日志目录下: 'Must be within log directory',
    '备份数据上传成功，确认覆盖数据': 'Backup uploaded, confirm overwrite',
    '如果恢复失败，可进入容器执行': 'If restore fails, run in container:',
    系统将在: 'System will',
    秒后自动刷新: 'refresh in seconds',
    '生成数据中...': 'Generating data...',
    '每条数据 name 或者 value 字段不能为空，参考导出文件格式':
      'Each entry must have name and value, see export format',
    不支持当前依赖类型: 'Unsupported dependency type',
    依赖已存在: 'Dependency already exists',
    依赖不存在: 'Dependency does not exist',
    该脚本正在运行中: 'Script is running',
    该脚本未在运行中: 'Script is not running',
    文件内容为空: 'File content is empty',
    文件名不能为空: 'File name cannot be empty',
    标签不能为空: 'Label cannot be empty',
    名称不能为空: 'Name cannot be empty',
    名称不能为保留关键字: 'Name cannot be reserved keyword',
    名称已存在: 'Name already exists',
    密码错误: 'Incorrect password',
    用户不存在: 'User does not exist',
    请输入用户名和密码: 'Please enter username and password',
    无权访问: 'Access denied',
    登录成功: 'Login successful',
    退出成功: 'Logout successful',
    'Token 已失效': 'Token expired',
    'Token 无效': 'Invalid token',
    两步骤验证已开启: '2FA enabled',
    两步骤验证已关闭: '2FA disabled',
    验证码错误: 'Invalid verification code',
    验证码已过期: 'Verification code expired',
    请先开启两步骤验证: 'Please enable 2FA first',
    两步骤验证密钥不能为空: '2FA secret cannot be empty',
    用户已存在: 'User already exists',
    用户名不能为admin: 'Username cannot be admin',
    不能删除自己: 'Cannot delete yourself',
    不能禁用自己: 'Cannot disable yourself',
    文件路径无效: 'Invalid file path',
    保存成功: 'Saved successfully',
    'client_id 或 client_seret 有误': 'Invalid client_id or client_secret',
    订阅执行完成: 'Subscription completed',
    'wxPusher 服务的 TopicIds 和 Uids 至少配置一个才行':
      'wxPusher requires at least one of TopicIds or Uids',
    'wxPusher SPT 不能为空': 'wxPusher SPT cannot be empty',
    'wxPusher SPT 最多支持 10 个': 'wxPusher SPT supports at most 10 tokens',
    'Url 或者 Body 中必须包含 $title': 'Url or Body must contain $title',
    '绝对路径必须在日志目录内或使用 /dev/null':
      'Absolute path must be within log directory or use /dev/null',
    请先登录: 'Please login first',
    '运行中...': 'Running...',
    '日志不存在...': 'Log does not exist...',
    未分类: 'Uncategorized',
    任务重复运行: 'Duplicate task execution',
    日志设置为忽略: 'Log set to ignore',
    定时规则不能为空: 'Schedule rule cannot be empty',
    无效的定时规则: 'Invalid schedule rule',
    定时规则必须是字符串: 'Schedule rule must be a string',
    额外定时规则必须是对象: 'Extra schedule must be an object',
    额外定时规则必须是数组: 'Extra schedules must be an array',
    '日志名称只能包含中文、字母、数字、下划线、连字符、点和路径分隔符':
      'Log name can only contain Chinese characters, letters, numbers, underscores, hyphens, dots, and path separators',
    日志名称不能超过100个字符: 'Log name cannot exceed 100 characters',
    '错误的用户名密码，请重试':
      'Incorrect username or password, please try again',
    '该 IP 已被列入黑名单': 'This IP address has been blocked',
    '已加入 IP 黑名单': 'IP address added to the blacklist',
    '已移出 IP 黑名单': 'IP address removed from the blacklist',
    青龙快讯: 'QingLong',
    登录通知: 'Login Notification',
    你于: 'You at ',
    在: ' in ',
    端: ' client',
    内网IP: 'Private IP',
    登录失败: 'login failed',
    '，ip地址': ', IP: ',
    '任务#%s': 'Task#%s',
    安装: 'Install',
    删除: 'Uninstall',
    成功: 'Succeeded',
    失败: 'Failed',
    '失败次数过多，请%s秒后重试':
      'Too many failed attempts, please retry in %s seconds',
    智能助手: 'Smart Assistant',
    更多: 'More',
    '开始%s依赖 %s，开始时间 %s\n\n当前系统不支持\n\n依赖%s失败，结束时间 %s，耗时 %s 秒':
      'Start %s dependency %s, start time %s\n\nCurrent system not supported\n\nDependency %s failed, end time %s, elapsed %s seconds',
    '检测到已经安装 %s\n\n%s\n\n跳过安装\n\n依赖%s成功，结束时间 %s，耗时 %s 秒':
      'Already installed %s\n\n%s\n\nSkipping install\n\nDependency %s succeeded, end time %s, elapsed %s seconds',
    '开始%s依赖 %s，开始时间 %s\n\n':
      'Start %s dependency %s, start time %s\n\n',
    '依赖%s%s，结束时间 %s，耗时 %s 秒':
      'Dependency %s%s, end time %s, elapsed %s seconds',
    '任务：%s，命令：%s，定时：%s，处于运行中的超过 %d 个，请检查定时设置':
      'Task: %s, command: %s, schedule: %s, more than %d instances running, please check schedule settings',
    青龙: 'QingLong',
    '【蛟龙】测试通知 https://t.me/jiao_long':
      '[JiaoLong] Test notification https://t.me/jiao_long',
    生成token: 'Generate token',
    删除日志: 'Delete logs',
    '## 开始执行... %s\n': '## Start executing... %s\n',
    '执行before命令...': 'Execute before command...',
    '执行after命令...': 'Execute after command...',
    '## 执行结束... %s  耗时 %s 秒':
      '## Execution finished... %s  elapsed %s seconds',
    '调度器注册失败，任务创建已回滚':
      'Scheduler registration failed, task creation rolled back',
    '调度器注册失败，任务更新已回滚':
      'Scheduler registration failed, task update rolled back',
    '调度器注册失败，任务启用已回滚':
      'Scheduler registration failed, task enable rolled back',
    '任务ID %s: 无效的 cron 表达式 "%s"':
      'Task ID %s: invalid cron expression "%s"',
    '任务ID %s (extra_schedule): 无效的 cron 表达式 "%s"':
      'Task ID %s (extra_schedule): invalid cron expression "%s"',
  },
};

let currentLang: string = 'zh';

export function setLang(lang: string, persist = true) {
  currentLang = lang || 'zh';
  if (!persist) return;
  // Translation is also used by standalone scheduler and CLI helpers. Load
  // persistent storage only when changing the language, not when reading it.
  const { shareStore } = require('./store') as typeof import('./store');
  const language = currentLang;
  return shareStore.setLang(language).then(() => {
    if (currentLang === language && process.connected && process.send) {
      process.send({ type: 'language-changed', lang: language }, () => {});
    }
  });
}

/** 系统默认语言：Intl 检测 → 'zh'（仅返回 zh/en） */
export function systemLang(): string {
  const prefix = Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0];
  return prefix === 'en' ? 'en' : 'zh';
}

export function t(key: string, lang?: string): string {
  const effectiveLang = lang || currentLang;
  if (effectiveLang === 'en' && messages.en[key]) {
    return messages.en[key];
  }
  return key;
}

export function tf(key: string, ...args: (string | number)[]): string {
  return args.reduce<string>(
    (str, arg) => str.replace(/%s|%d/, String(arg)),
    t(key),
  );
}
