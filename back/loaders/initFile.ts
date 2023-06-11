import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import Logger from './logger';
import { fileExist } from '../config/util';

const rootPath = process.env.QL_DIR as string;;
const dataPath = path.join(rootPath, 'data/');
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
const sampleNotifyJsFile = path.join(samplePath, 'notify.js');
const sampleNotifyPyFile = path.join(samplePath, 'notify.py');
const scriptNotifyJsFile = path.join(scriptPath, 'sendNotify.js');
const scriptNotifyPyFile = path.join(scriptPath, 'notify.py');
const homedir = os.homedir();
const sshPath = path.resolve(homedir, '.ssh');
const sshdPath = path.join(dataPath, 'ssh.d');

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
  const tmpDirExist = await fileExist(tmpPath);
  const scriptNotifyJsFileExist = await fileExist(scriptNotifyJsFile);
  const scriptNotifyPyFileExist = await fileExist(scriptNotifyPyFile);

  if (!configDirExist) {
    fs.mkdirSync(configPath);
  }

  if (!scriptDirExist) {
    fs.mkdirSync(scriptPath);
  }

  if (!logDirExist) {
    fs.mkdirSync(logPath);
  }

  if (!tmpDirExist) {
    fs.mkdirSync(tmpPath);
  }

  if (!uploadDirExist) {
    fs.mkdirSync(uploadPath);
  }

  if (!sshDirExist) {
    fs.mkdirSync(sshPath);
  }

  if (!bakDirExist) {
    fs.mkdirSync(bakPath);
  }

  if (!sshdDirExist) {
    fs.mkdirSync(sshdPath);
  }

  // 初始化文件
  if (!authFileExist) {
    fs.writeFileSync(authConfigFile, fs.readFileSync(sampleAuthFile));
  }

  if (!confFileExist) {
    fs.writeFileSync(confFile, fs.readFileSync(sampleConfigFile));
  }

  if (!scriptNotifyJsFileExist) {
    fs.writeFileSync(scriptNotifyJsFile, fs.readFileSync(sampleNotifyJsFile));
  }

  if (!scriptNotifyPyFileExist) {
    fs.writeFileSync(scriptNotifyPyFile, fs.readFileSync(sampleNotifyPyFile));
  }

  dotenv.config({ path: confFile });

  Logger.info('✌️ Init file down');
};
