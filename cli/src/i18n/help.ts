const chinese: Record<string, string> = {
  'Skip OS boot registration (for containers)': '跳过系统开机注册（用于容器）',
  'Authenticate with a remote panel application': '使用远程面板应用凭据登录',
  'Panel URL including optional base path': '面板地址，可包含基础路径',
  'Verify authentication and resource permission': '检查登录状态和资源权限',
  'Permission to check': '要检查的权限',
  'Remove local credentials (does not revoke the server token)':
    '清除本机凭据（不会撤销服务端令牌）',
  'List remote tasks': '列出远程任务',
  'Search task name or command': '按任务名称或命令搜索',
  'Page number': '页码',
  'Page size': '每页数量',
  'Read the latest task log': '读取最新任务日志',
  'Last N lines': '最后 N 行',
  'List panel subscriptions': '列出面板订阅',
  'Search subscriptions': '搜索订阅',
  'Read latest subscription log': '读取最新订阅日志',
  'Remove expired logs not referenced by a task':
    '删除过期且未被任务引用的日志',
  'Execute the user extra.sh hook': '执行用户的 extra.sh 钩子',
  'Restore missing configuration templates and runtime directories':
    '恢复缺失的配置模板和运行目录',
  'Install runtime dependencies, repair files, diagnose and reload services':
    '安装运行依赖、修复文件、诊断并重载服务',
  'Install dependencies and start the optional local Telegram bot':
    '安装依赖并启动可选的本机 Telegram 机器人',
  'Install runtime prerequisites and start nginx and panel services':
    '安装运行环境并启动 nginx 和面板服务',
  'Restart services without installing packages or starting optional hooks':
    '重启服务，跳过依赖安装和可选钩子',
  'Restart local services or apply staged system/data files':
    '重启本机服务或应用已准备的系统／数据文件',
  'Reload target': '重载目标',
  'Stage and apply a local panel upgrade': '准备并应用本机面板升级',
  'Archive source': '升级包来源',
  'Prepare upgrade without replacing files or restarting services':
    '仅准备升级包，不替换文件或重启服务',
  'One JSON result on stdout; diagnostics on stderr':
    '标准输出返回一个 JSON 结果，诊断写入标准错误',
  'Show help': '显示帮助',
  'Installed panel root (defaults to QL_DIR)':
    '已安装面板的根目录（默认 QL_DIR）',
  'Panel data directory (defaults to QL_DATA_DIR)':
    '面板数据目录（默认 QL_DATA_DIR）',
  'Usage:': '用法：',
  'Options:': '选项：',
  'default:': '默认：',
  'Alias: login = auth login.': '别名：login = auth login。',
  'Local operator commands require an installed panel.':
    '本机运维命令需要已安装的面板。',
};
const actions: Record<string, string> = {
  get: '查看',
  run: '运行',
  stop: '停止',
  enable: '启用',
  disable: '禁用',
};
for (const [action, text] of Object.entries(actions)) {
  chinese[`${action} a remote task by ID`] = `按 ID ${text}远程任务`;
  chinese[`${action} a panel subscription by ID`] = `按 ID ${text}面板订阅`;
}
for (const [action, text] of Object.entries({
  resetlet: '清除登录限制',
  resettfa: '关闭双因素认证',
  resetpwd: '重置密码',
  resetname: '重置用户名',
}))
  chinese[`Local panel ${action}`] = `本机面板：${text}`;

export function helpText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.QL_LANG === 'en' ? text : chinese[text] ?? text;
}
