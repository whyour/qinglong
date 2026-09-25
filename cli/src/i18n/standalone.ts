type Entry = 'runner' | 'compat' | 'worker' | 'developer' | 'startup';
const english: Record<Entry, string> = {
  startup:
    'Usage: qinglong-cli [reload] [--root PATH] [--data-dir PATH] [--no-startup] [--json]\nCompatibility entry for the legacy qinglong host startup command.\nNo mode: install prerequisites and start services. reload: restart without installing dependencies or registering host startup.\nQL_DIR and QL_DATA_DIR provide environment defaults. Use ql start --help for all options.\n',
  runner:
    'QingLong local task runner (ql task exec)\nUsage: ql task exec [--root PATH] [--data-dir PATH] [-m DURATION] [--json] <script|command> [args...]\n       ql task exec [options] <script> now [-- script-args...]\n       ql task exec [options] <script> conc|desi <variable> [account-ranges...] [-- script-args...]\n\nCLI flags precede the script. Arguments following -- belong to the script.\nLocal execution requires an installed panel; remote task IDs use ql task run.\n',
  compat:
    'Usage: ql-compat [-l] <update|reload|repo|raw|rmlog|extra|bot|check|resetlet|resettfa|resetpwd|resetname> [legacy arguments]\nLocal compatibility adapter; requires QL_DIR. Select it for installed ql via QL_CLI_ROOT.\nUse ql for authenticated panel management, ql task exec for local task execution.\n',
  worker:
    'Usage: ql repo|raw <url> [legacy subscription arguments]\nInternal local executor; manage panel subscriptions with ql subscription.\nRequires QL_DIR and optional QL_DATA_DIR/SUB_ID.\n',
  developer:
    'Usage: ql dev release --root <repository> [--remote origin] [--branch master] [--json]\nReview the plan, then execute with --apply --commit <full-reviewed-SHA>.\nPublishes CDN metadata and replaces the release branch/tag. Other tags are not pushed.',
};
const chinese: Record<Entry, string> = {
  startup:
    '用法：qinglong-cli [reload] [--root PATH] [--data-dir PATH] [--no-startup] [--json]\n兼容原 qinglong 宿主机启动命令。\n无模式参数：安装依赖并启动服务；reload：跳过依赖安装及开机注册后重载。\n可通过 QL_DIR、QL_DATA_DIR 设置目录。完整选项见 ql start --help。\n',
  runner:
    '青龙本机任务执行器（ql task exec）\n用法：ql task exec [--root PATH] [--data-dir PATH] [-m DURATION] [--json] <script|command> [args...]\n      ql task exec [options] <script> now [-- script-args...]\n      ql task exec [options] <script> conc|desi <variable> [account-ranges...] [-- script-args...]\n\nCLI 选项放在脚本之前；-- 后的参数原样传给脚本。\n本机执行需要已安装的面板；远程任务 ID 使用 ql task run。\n',
  compat:
    '用法：ql-compat [-l] <update|reload|repo|raw|rmlog|extra|bot|check|resetlet|resettfa|resetpwd|resetname> [legacy arguments]\n本机兼容适配器，需要 QL_DIR。可通过 QL_CLI_ROOT 将其选为已安装的 ql 入口。\n面板认证管理使用 ql，本机任务执行使用 ql task exec。\n',
  worker:
    '用法：ql repo|raw <url> [legacy subscription arguments]\n内部本机执行器；面板订阅管理使用 ql subscription。\n需要 QL_DIR，可选 QL_DATA_DIR/SUB_ID。\n',
  developer:
    '用法：ql dev release --root <repository> [--remote origin] [--branch master] [--json]\n先审阅计划，再通过 --apply --commit <full-reviewed-SHA> 执行。\n会发布 CDN 元数据并替换发布分支／标签；不推送其他标签。',
};
export function standaloneHelp(
  entry: Entry,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (env.QL_LANG === 'en' ? english : chinese)[entry];
}
