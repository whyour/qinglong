import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import Logger from './logger';
import { fileExist } from '../config/util';

const rootPath = process.cwd();
const confFile = path.join(rootPath, 'config/config.sh');
const sampleConfigFile = path.join(rootPath, 'sample/config.sample.sh');
const sampleAuthFile = path.join(rootPath, 'sample/auth.sample.json');
const authConfigFile = path.join(rootPath, 'config/auth.json');
const configPath = path.join(rootPath, 'config/');
const scriptPath = path.join(rootPath, 'scripts/');
const logPath = path.join(rootPath, 'log/');

export default async () => {
  const authFileExist = await fileExist(authConfigFile);
  const confFileExist = await fileExist(confFile);
  const scriptDirExist = await fileExist(scriptPath);
  const logDirExist = await fileExist(logPath);
  const configDirExist = await fileExist(configPath);

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

  dotenv.config({ path: confFile });

  Logger.info('✌️ Init file down');
};
