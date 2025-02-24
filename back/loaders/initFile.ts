import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import Logger from './logger';
import { fileExist } from '../config/util';
import { writeFileWithLock } from '../shared/utils';

const rootPath = process.env.QL_DIR as string;
let dataPath = path.join(rootPath, 'data/');

if (process.env.QL_DATA_DIR) {
  dataPath = process.env.QL_DATA_DIR.replace(/\/$/g, '');
}

const preloadPath = path.join(rootPath, 'shell/preload/');
const configPath = path.join(dataPath, 'config/');
const scriptPath = path.join(dataPath, 'scripts/');
const logPath = path.join(dataPath, 'log/');
const uploadPath = path.join(dataPath, 'upload/');
const bakPath = path.join(dataPath, 'bak/');
const samplePath = path.join(rootPath, 'sample/');
const tmpPath = path.join(logPath, '.tmp/');
const confFile = path.join(configPath, 'config.sh');
const sampleConfigFile = path.join(samplePath, 'config.sample.sh');
const sampleTaskShellFile = path.join(samplePath, 'task.sample.sh');
const sampleNotifyJsFile = path.join(samplePath, 'notify.js');
const sampleNotifyPyFile = path.join(samplePath, 'notify.py');
const scriptNotifyJsFile = path.join(scriptPath, 'sendNotify.js');
const scriptNotifyPyFile = path.join(scriptPath, 'notify.py');
const jsNotifyFile = path.join(preloadPath, '__ql_notify__.js');
const pyNotifyFile = path.join(preloadPath, '__ql_notify__.py');
const TaskBeforeFile = path.join(configPath, 'task_before.sh');
const TaskBeforeJsFile = path.join(configPath, 'task_before.js');
const TaskBeforePyFile = path.join(configPath, 'task_before.py');
const TaskAfterFile = path.join(configPath, 'task_after.sh');
const homedir = os.homedir();
const sshPath = path.resolve(homedir, '.ssh');
const sshdPath = path.join(dataPath, 'ssh.d');
const systemLogPath = path.join(dataPath, 'syslog');

const directories = [
  configPath,
  scriptPath,
  preloadPath,
  logPath,
  tmpPath,
  uploadPath,
  sshPath,
  bakPath,
  sshdPath,
  systemLogPath,
];

const files = [
  {
    target: confFile,
    source: sampleConfigFile,
    checkExistence: true,
  },
  {
    target: jsNotifyFile,
    source: sampleNotifyJsFile,
    checkExistence: false,
  },
  {
    target: pyNotifyFile,
    source: sampleNotifyPyFile,
    checkExistence: false,
  },
  {
    target: scriptNotifyJsFile,
    source: sampleNotifyJsFile,
    checkExistence: true,
  },
  {
    target: scriptNotifyPyFile,
    source: sampleNotifyPyFile,
    checkExistence: true,
  },
  {
    target: TaskBeforeFile,
    source: sampleTaskShellFile,
    checkExistence: true,
  },
  {
    target: TaskBeforeJsFile,
    content:
      '// The JavaScript code that executes before the JavaScript task execution will execute.',
    checkExistence: true,
  },
  {
    target: TaskBeforePyFile,
    content:
      '# The Python code that executes before the Python task execution will execute.',
    checkExistence: true,
  },
  {
    target: TaskAfterFile,
    source: sampleTaskShellFile,
    checkExistence: true,
  },
];

export default async () => {
  for (const dirPath of directories) {
    if (!(await fileExist(dirPath))) {
      await fs.mkdir(dirPath);
    }
  }

  for (const item of files) {
    const exists = await fileExist(item.target);
    if (!item.checkExistence || !exists) {
      if (!item.content && !item.source) {
        throw new Error(
          `Neither content nor source specified for ${item.target}`,
        );
      }
      const content = item.content || (await fs.readFile(item.source!));
      await writeFileWithLock(item.target, content);
    }
  }

  Logger.info('✌️ Init file down');
  console.log('✌️ Init file down');
};
