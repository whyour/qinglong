// Real service launch and Python supervisor; isolate database bookkeeping only.
const path = require('node:path');
const fs = require('node:fs');
const load = require('./load-security-module.cjs');
const { spawn } = require('cross-spawn');
const { LogStreamManager } = require('../../back/shared/logStreamManager');
const [root, command] = process.argv.slice(2);
process.env.QL_DATA_DIR = root;
const reporter = path.join(root, 'reporter.cjs');
fs.writeFileSync(reporter, `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'receipt.json'))}, process.argv[2]);`);
const Service = load('back/services/cron.ts', {
  '../config': { logPath: root },
  '../data/cron': {
    CrontabStatus: { queued: 3, running: 0, idle: 1 },
    CrontabModel: { update: async () => [1] },
  },
  '../data/runningInstance': {},
  '../config/util': { getUniqPath: async () => "log's $directory" },
  '../schedule/client': {},
  '../shared/pLimit': { manualRunWithCronLimit: fn => fn() },
  '../shared/triggerHistory': { TriggerHistory: class {
    async bindCommand(_, pid, log) { process.send({ pid, log }); return true; }
    async shouldStop() { return false; }
    async complete() {}
  } },
  '../shared/logStreamManager': { logStreamManager: new LogStreamManager(root) },
  'cross-spawn': { spawn: (file, args, options) => {
    // Record the real supervisor's receipt without starting a panel database.
    if (file === 'python3') args[7] = reporter;
    return spawn(file, args, options);
  } },
}).default;
const service = new Service({ info() {}, error(...args) { console.error(...args); } });
service.getDb = async () => ({ id: 1, status: 3, command, queued_token: 'test', log_path: '' });
service.makeCommand = () => command;
service.runSingle(1, 'test', 'manual-log-test').then(result => {
  process.send({ result }, () => process.disconnect());
});
