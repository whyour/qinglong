import dotenv from 'dotenv';
import path from 'path';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const envFound = dotenv.config();
const rootPath = path.resolve(__dirname, '../../');
const cookieFile = path.join(rootPath, 'config/cookie.sh');
const confFile = path.join(rootPath, 'config/config.sh');
const sampleFile = path.join(rootPath, 'sample/config.sh.sample');
const crontabFile = path.join(rootPath, 'config/crontab.list');
const confBakDir = path.join(rootPath, 'config/bak/');
const authConfigFile = path.join(rootPath, 'config/auth.json');
const shareCodeDir = path.join(rootPath, 'log/export_sharecodes/');
const diyFile = path.join(rootPath, 'config/diy.sh');
const logPath = path.join(rootPath, 'log/');
const authError = '错误的用户名密码，请重试';
const loginFaild = '请先登录!';
const configString = 'config sample crontab shareCode diy';
const dbPath = path.join(rootPath, 'db/');
const manualLogPath = path.join(rootPath, 'manual_log/');
const cronDbFile = path.join(rootPath, 'db/crontab.db');

if (envFound.error) {
  throw new Error("⚠️  Couldn't find .env file  ⚠️");
}

export default {
  port: parseInt(process.env.PORT as string, 10),
  secret: process.env.SECRET,
  logs: {
    level: process.env.LOG_LEVEL || 'silly',
  },
  api: {
    prefix: '/api',
  },
  configString,
  loginFaild,
  authError,
  logPath,
  diyFile,
  shareCodeDir,
  authConfigFile,
  confBakDir,
  crontabFile,
  sampleFile,
  confFile,
  cookieFile,
  fileMap: {
    'config.sh': confFile,
    'crontab.list': crontabFile,
    'diy.sh': diyFile,
  },
  dbPath,
  cronDbFile,
  manualLogPath,
};
