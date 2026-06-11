const messages: Record<string, Record<string, string>> = {
  zh: {},
  en: {
    '暂无权限': 'Access denied',
    '参数错误': 'Invalid parameter',
    '参数不正确': 'Invalid parameter',
    '文件无法访问': 'File not accessible',
    '文件不存在': 'File not found',
    '路径不存在': 'Path does not exist',
    '路径不正确': 'Invalid path',
    '通知发送失败，请检查参数': 'Notification failed, check parameters',
    '通知发送失败，请检查系统设置/通知配置': 'Notification failed, check system settings',
    '通知发送成功': 'Notification sent successfully',
    '设置时区失败': 'Failed to set timezone',
    '任务未找到': 'Task not found',
    '密码不能设置为admin': 'Password cannot be admin',
    '更新成功': 'Update successful',
    '未知错误': 'Unknown error',
    '验证失败': 'Verification failed',
    '实例不存在或已停止': 'Instance does not exist or stopped',
    '实例已停止': 'Instance stopped',
    '确认停止实例': 'Confirm to stop instance',
    '确认停止运行实例': 'Confirm to stop running instance',
    '确认停止': 'Confirm to stop',
    '确认停止定时任务': 'Confirm to stop scheduled task',
    '确认删除': 'Confirm to delete',
    '确认删除定时任务': 'Confirm to delete scheduled task',
    '确认删除选中的定时任务吗': 'Confirm to delete selected tasks?',
    '确认运行': 'Confirm to run',
    '确认运行定时任务': 'Confirm to run scheduled task',
    '确认保存': 'Confirm to save',
    '确认保存文件': 'Confirm to save file',
    '确认重启': 'Confirm restart',
    '确认启用': 'Confirm to enable',
    '确认禁用': 'Confirm to disable',
    '确认': 'Confirm',
    '删除成功': 'Deleted successfully',
    '操作成功': 'Operation successful',
    '参数不完整': 'Incomplete parameters',
    '默认路径不支持删除': 'Default path cannot be deleted',
    '必须在日志目录下': 'Must be within log directory',
    '备份数据上传成功，确认覆盖数据': 'Backup uploaded, confirm overwrite',
    '如果恢复失败，可进入容器执行': 'If restore fails, run in container:',
    '系统将在': 'System will',
    '秒后自动刷新': 'refresh in seconds',
    '生成数据中...': 'Generating data...',
    '每条数据 name 或者 value 字段不能为空，参考导出文件格式': 'Each entry must have name and value, see export format',
    '不支持当前依赖类型': 'Unsupported dependency type',
    '依赖已存在': 'Dependency already exists',
    '依赖不存在': 'Dependency does not exist',
    '该脚本正在运行中': 'Script is running',
    '该脚本未在运行中': 'Script is not running',
    '文件内容为空': 'File content is empty',
    '文件名不能为空': 'File name cannot be empty',
    '标签不能为空': 'Label cannot be empty',
    '名称不能为空': 'Name cannot be empty',
    '名称不能为保留关键字': 'Name cannot be reserved keyword',
    '名称已存在': 'Name already exists',
    '密码错误': 'Incorrect password',
    '用户不存在': 'User does not exist',
    '请输入用户名和密码': 'Please enter username and password',
    '无权访问': 'Access denied',
    '登录成功': 'Login successful',
    '退出成功': 'Logout successful',
    'Token 已失效': 'Token expired',
    'Token 无效': 'Invalid token',
    '两步骤验证已开启': '2FA enabled',
    '两步骤验证已关闭': '2FA disabled',
    '验证码错误': 'Invalid verification code',
    '验证码已过期': 'Verification code expired',
    '请先开启两步骤验证': 'Please enable 2FA first',
    '两步骤验证密钥不能为空': '2FA secret cannot be empty',
    '用户已存在': 'User already exists',
    '用户名不能为admin': 'Username cannot be admin',
    '不能删除自己': 'Cannot delete yourself',
    '不能禁用自己': 'Cannot disable yourself',
    '文件路径无效': 'Invalid file path',
    '保存成功': 'Saved successfully',
    'client_id 或 client_seret 有误': 'Invalid client_id or client_secret',
    '订阅执行完成': 'Subscription completed',
    'wxPusher 服务的 TopicIds 和 Uids 至少配置一个才行': 'wxPusher requires at least one of TopicIds or Uids',
    'Url 或者 Body 中必须包含 $title': 'Url or Body must contain $title',
  },
};

let currentLang: string = 'zh';

export function setLang(lang: string) {
  currentLang = lang || 'zh';
}

export function getLang(): string {
  return currentLang;
}

export function t(key: string, lang?: string): string {
  const effectiveLang = lang || currentLang;
  if (effectiveLang === 'en' && messages.en[key]) {
    return messages.en[key];
  }
  return key;
}
