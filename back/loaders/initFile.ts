import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import Logger from './logger';
import { fileExist } from '../config/util';

const rootPath = process.env.QL_DIR as string;
let dataPath = path.join(rootPath, 'data/');

if (process.env.QL_DATA_DIR) {
  dataPath = process.env.QL_DATA_DIR;
}

const configPath = path.join(dataPath, 'config/');
const scriptPath = path.join(dataPath, 'scripts/');
const logPath = path.join(dataPath, 'log/');
const uploadPath = path.join(dataPath, 'upload/');
const bakPath = path.join(dataPath, 'bak/');
const samplePath = path.join(rootPath, 'sample/');
const tmpPath = path.join(logPath, '.tmp/');
const confFile = path.join(configPath, 'config.sh');
const authConfigFile = path.join(configPath, 'auth.json');
const sampleConfigFile = path.join(samplePath, 'config.sample.sh');
const sampleAuthFile = path.join(samplePath, 'auth.sample.json');
const sampleTaskShellFile = path.join(samplePath, 'task.sample.sh');
const sampleNotifyJsFile = path.join(samplePath, 'notify.js');
const sampleNotifyPyFile = path.join(samplePath, 'notify.py');
const scriptNotifyJsFile = path.join(scriptPath, 'sendNotify.js');
const scriptNotifyPyFile = path.join(scriptPath, 'notify.py');
const TaskBeforeFile = path.join(configPath, 'task_before.sh');
const TaskAfterFile = path.join(configPath, 'task_after.sh');
const homedir = os.homedir();
const sshPath = path.resolve(homedir, '.ssh');
const sshdPath = path.join(dataPath, 'ssh.d');
const systemLogPath = path.join(dataPath, 'syslog');

export default async () => {
  const authFileExist = await fileExist(authConfigFile);
  const confFileExist = await fileExist(confFile);
  const scriptDirExist = await fileExist(scriptPath);
  const logDirExist = await fileExist(logPath);
  const configDirExist = await fileExist(configPath);
  const uploadDirExist = await fileExist(uploadPath);
  const sshDirExist = await fileExist(sshPath);
  const bakDirExist = await fileExist(bakPath);
  const sshdDirExist = await fileExist(sshdPath);
  const systemLogDirExist = await fileExist(systemLogPath);
  const tmpDirExist = await fileExist(tmpPath);
  const scriptNotifyJsFileExist = await fileExist(scriptNotifyJsFile);
  const scriptNotifyPyFileExist = await fileExist(scriptNotifyPyFile);
  const TaskBeforeFileExist = await fileExist(TaskBeforeFile);
  const TaskAfterFileExist = await fileExist(TaskAfterFile);

  if (!configDirExist) {
    await fs.mkdir(configPath);
  }

  if (!scriptDirExist) {
    await fs.mkdir(scriptPath);
  }

  if (!logDirExist) {
    await fs.mkdir(logPath);
  }

  if (!tmpDirExist) {
    await fs.mkdir(tmpPath);
  }

  if (!uploadDirExist) {
    await fs.mkdir(uploadPath);
  }

  if (!sshDirExist) {
    await fs.mkdir(sshPath);
  }

  if (!bakDirExist) {
    await fs.mkdir(bakPath);
  }

  if (!sshdDirExist) {
    await fs.mkdir(sshdPath);
  }

  if (!systemLogDirExist) {
    await fs.mkdir(systemLogPath);
  }

  // 初始化文件
  if (!authFileExist) {
    await fs.writeFile(authConfigFile, await fs.readFile(sampleAuthFile));
  }

  if (!confFileExist) {
    await fs.writeFile(confFile, await fs.readFile(sampleConfigFile));
  }

  if (!scriptNotifyJsFileExist) {
    await fs.writeFile(
      scriptNotifyJsFile,
      await fs.readFile(sampleNotifyJsFile),
    );
  }

  if (!scriptNotifyPyFileExist) {
    await fs.writeFile(
      scriptNotifyPyFile,
      await fs.readFile(sampleNotifyPyFile),
    );
  }

  if (!TaskBeforeFileExist) {
    await fs.writeFile(TaskBeforeFile, await fs.readFile(sampleTaskShellFile));
  }

  if (!TaskAfterFileExist) {
    await fs.writeFile(TaskAfterFile, await fs.readFile(sampleTaskShellFile));
  }

  Logger.info('✌️ Init file down');
  console.log('✌️ Init file down');
};
