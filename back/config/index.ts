import dotenv from 'dotenv';
import path from 'path';
import { createRandomString } from './util';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const lastVersionFile =
  'https://ghproxy.com/https://raw.githubusercontent.com/whyour/qinglong/master/src/version.ts';

const envFound = dotenv.config();
const rootPath = process.cwd();
const envFile = path.join(rootPath, 'config/env.sh');
const confFile = path.join(rootPath, 'config/config.sh');
const sampleFile = path.join(rootPath, 'sample/config.sample.sh');
const crontabFile = path.join(rootPath, 'config/crontab.list');
const confBakDir = path.join(rootPath, 'config/bak/');
const authConfigFile = path.join(rootPath, 'config/auth.json');
const extraFile = path.join(rootPath, 'config/extra.sh');
const configPath = path.join(rootPath, 'config/');
const scriptPath = path.join(rootPath, 'scripts/');
const bakPath = path.join(rootPath, 'bak/');
const samplePath = path.join(rootPath, 'sample/');
const logPath = path.join(rootPath, 'log/');
const authError = '错误的用户名密码，请重试';
const loginFaild = '请先登录!';
const configString = 'config sample crontab shareCode diy';
const dbPath = path.join(rootPath, 'db/');
const cronDbFile = path.join(rootPath, 'db/crontab.db');
const envDbFile = path.join(rootPath, 'db/env.db');
const appDbFile = path.join(rootPath, 'db/app.db');
const authDbFile = path.join(rootPath, 'db/auth.db');
const versionFile = path.join(rootPath, 'src/version.ts');

const configFound = dotenv.config({ path: confFile });

if (envFound.error) {
  throw new Error("⚠️  Couldn't find .env file  ⚠️");
}

if (configFound.error) {
  throw new Error("⚠️  Couldn't find config.sh file  ⚠️");
}

export default {
  port: parseInt(process.env.PORT as string, 10),
  cronPort: parseInt(process.env.CRON_PORT as string, 10),
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
  cronDbFile,
  envDbFile,
  appDbFile,
  authDbFile,
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
    '/api/login',
    '/open/auth/token',
    '/api/user/two-factor/login',
    '/api/system',
    '/api/init/user',
    '/api/init/notification',
  ],
  versionFile,
  lastVersionFile,
};
