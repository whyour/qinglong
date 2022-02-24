import dotenv from 'dotenv';
import path from 'path';
import { createRandomString } from './util';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const lastVersionFile = 'https://qn.whyour.cn/version.ts';

const envFound = dotenv.config();
const rootPath = process.cwd();
const dataPath = path.join(rootPath, 'data/');
const samplePath = path.join(rootPath, 'sample/');
const configPath = path.join(dataPath, 'config/');
const scriptPath = path.join(dataPath, 'scripts/');
const bakPath = path.join(dataPath, 'bak/');
const logPath = path.join(dataPath, 'log/');
const dbPath = path.join(dataPath, 'db/');

const envFile = path.join(configPath, 'env.sh');
const confFile = path.join(configPath, 'config.sh');
const crontabFile = path.join(configPath, 'crontab.list');
const authConfigFile = path.join(configPath, 'auth.json');
const extraFile = path.join(configPath, 'extra.sh');
const confBakDir = path.join(dataPath, 'config/bak/');
const sampleFile = path.join(samplePath, 'config.sample.sh');
const sqliteFile = path.join(samplePath, 'database.sqlite');

const authError = '错误的用户名密码，请重试';
const loginFaild = '请先登录!';
const configString = 'config sample crontab shareCode diy';
const versionFile = path.join(rootPath, 'src/version.ts');

if (envFound.error) {
  throw new Error("⚠️  Couldn't find .env file  ⚠️");
}

export default {
  port: parseInt(process.env.BACK_PORT as string, 10),
  cronPort: parseInt(process.env.CRON_PORT as string, 10),
  publicPort: parseInt(process.env.PUBLIC_PORT as string, 10),
  secret: process.env.SECRET || createRandomString(16, 32),
  logs: {
    level: process.env.LOG_LEVEL || 'silly',
  },
  api: {
    prefix: '/api',
  },
  rootPath,
  configString,
  loginFaild,
  authError,
  logPath,
  extraFile,
  authConfigFile,
  confBakDir,
  crontabFile,
  sampleFile,
  confFile,
  envFile,
  dbPath,
  configPath,
  scriptPath,
  samplePath,
  blackFileList: [
    'auth.json',
    'config.sh.sample',
    'cookie.sh',
    'crontab.list',
    'env.sh',
  ],
  writePathList: [configPath, scriptPath],
  bakPath,
  apiWhiteList: [
    '/api/user/login',
    '/open/auth/token',
    '/api/user/two-factor/login',
    '/api/system',
    '/api/user/init',
    '/api/user/notification/init',
  ],
  versionFile,
  lastVersionFile,
  sqliteFile,
};
