import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import Logger from './logger';
import { fileExist } from '../config/util';

const rootPath = process.cwd();
const dataPath = path.join(rootPath, 'data/');
const configPath = path.join(dataPath, 'config/');
const scriptPath = path.join(dataPath, 'scripts/');
const logPath = path.join(dataPath, 'log/');
const uploadPath = path.join(dataPath, 'upload/');
const bakPath = path.join(dataPath, 'bak/');
const samplePath = path.join(rootPath, 'sample/');
const confFile = path.join(configPath, 'config.sh');
const authConfigFile = path.join(configPath, 'auth.json');
const sampleConfigFile = path.join(samplePath, 'config.sample.sh');
const sampleAuthFile = path.join(samplePath, 'auth.sample.json');
const homedir = os.homedir();
const sshPath = path.resolve(homedir, '.ssh');

export default async () => {
  const authFileExist = await fileExist(authConfigFile);
  const confFileExist = await fileExist(confFile);
  const scriptDirExist = await fileExist(scriptPath);
  const logDirExist = await fileExist(logPath);
  const configDirExist = await fileExist(configPath);
  const uploadDirExist = await fileExist(uploadPath);
  const sshDirExist = await fileExist(sshPath);
  const bakDirExist = await fileExist(bakPath);

  if (!configDirExist) {
    fs.mkdirSync(configPath);
  }

  if (!authFileExist) {
    fs.writeFileSync(authConfigFile, fs.readFileSync(sampleAuthFile));
  }

  if (!confFileExist) {
    fs.writeFileSync(confFile, fs.readFileSync(sampleConfigFile));
  }

  if (!scriptDirExist) {
    fs.mkdirSync(scriptPath);
  }

  if (!logDirExist) {
    fs.mkdirSync(logPath);
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

  dotenv.config({ path: confFile });

  // 声明QL_DIR环境变量
  let qlHomePath = path.join(__dirname, '../../');
  // 生产环境
  if (qlHomePath.endsWith('/static/')) {
    qlHomePath = path.join(qlHomePath, '../');
  }
  process.env.QL_DIR = qlHomePath;

  Logger.info('✌️ Init file down');
};
