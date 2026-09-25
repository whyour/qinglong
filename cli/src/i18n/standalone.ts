import { runnerHelp } from '../framework/runnerDefinition';
type Entry = 'runner' | 'compat' | 'worker' | 'startup';
const english: Record<Exclude<Entry, 'runner'>, string> = {
  startup:
    'Usage: qinglong-cli [reload] [--root PATH] [--data-dir PATH] [--no-startup] [--json]\nCompatibility entry for the legacy qinglong host startup command.\nNo mode: install prerequisites and start services. reload: restart without installing dependencies or registering host startup.\nQL_DIR and QL_DATA_DIR provide environment defaults. Use ql start --help for all options.\n',
  compat:
    'Usage: ql-compat [-l] <update|reload|repo|raw|rmlog|extra|bot|check|resetlet|resettfa|resetpwd|resetname> [legacy arguments]\nLocal compatibility adapter; requires QL_DIR. Select it for installed ql via QL_CLI_ROOT.\nUse the separate @qinglong/cli npm entry for authenticated panel management, ql task exec for local task execution.\n',
  worker:
    'Usage: ql repo|raw <url> [legacy subscription arguments]\nInternal local executor; manage panel subscriptions with the separate @qinglong/cli npm entry.\nRequires QL_DIR and optional QL_DATA_DIR/SUB_ID.\n',
};
const chinese: Record<Exclude<Entry, 'runner'>, string> = {
  startup:
    '用法：qinglong-cli [reload] [--root PATH] [--data-dir PATH] [--no-startup] [--json]\n兼容原 qinglong 宿主机启动命令。\n无模式参数：安装依赖并启动服务；reload：跳过依赖安装及开机注册后重载。\n可通过 QL_DIR、QL_DATA_DIR 设置目录。完整选项见 ql start --help。\n',
  compat:
    '用法：ql-compat [-l] <update|reload|repo|raw|rmlog|extra|bot|check|resetlet|resettfa|resetpwd|resetname> [legacy arguments]\n本机兼容适配器，需要 QL_DIR。可通过 QL_CLI_ROOT 将其选为已安装的 ql 入口。\n面板认证管理使用独立的 @qinglong/cli npm 入口，本机任务执行使用 ql task exec。\n',
  worker:
    '用法：ql repo|raw <url> [legacy subscription arguments]\n内部本机执行器；面板订阅管理使用独立的 @qinglong/cli npm 入口。\n需要 QL_DIR，可选 QL_DATA_DIR/SUB_ID。\n',
};
export function standaloneHelp(
  entry: Entry,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (entry === 'runner') return runnerHelp(env);
  return (env.QL_LANG === 'en' ? english : chinese)[entry];
}
