import dotenv from 'dotenv';
import path from 'path';
import { createRandomString } from './util';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.QL_DIR) {
  // 声明QL_DIR环境变量
  let qlHomePath = path.join(__dirname, '../../');
  // 生产环境
  if (qlHomePath.endsWith('/static/')) {
    qlHomePath = path.join(qlHomePath, '../');
  }
  process.env.QL_DIR = qlHomePath.replace(/\/$/g, '');
}

const lastVersionFile = `https://qn.whyour.cn/version.yaml`;

const rootPath = process.env.QL_DIR as string;
const envFound = dotenv.config({ path: path.join(rootPath, '.env') });

const dataPath = path.join(rootPath, 'data/');
const shellPath = path.join(rootPath, 'shell/');
const tmpPath = path.join(rootPath, '.tmp/');
const samplePath = path.join(rootPath, 'sample/');
const configPath = path.join(dataPath, 'config/');
const scriptPath = path.join(dataPath, 'scripts/');
const bakPath = path.join(dataPath, 'bak/');
const logPath = path.join(dataPath, 'log/');
const dbPath = path.join(dataPath, 'db/');
const uploadPath = path.join(dataPath, 'upload/');
const sshdPath = path.join(dataPath, 'ssh.d/');
const systemLogPath = path.join(dataPath, 'syslog/');

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
const versionFile = path.join(rootPath, 'version.yaml');
const dataTgzFile = path.join(tmpPath, 'data.tgz');
const shareShellFile = path.join(shellPath, 'share.sh');

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
  tmpPath,
  dataPath,
  dataTgzFile,
  shareShellFile,
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
  uploadPath,
  configPath,
  scriptPath,
  samplePath,
  blackFileList: [
    'auth.json',
    'config.sh.sample',
    'cookie.sh',
    'crontab.list',
    'env.sh',
    'token.json',
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
    '/open/user/login',
    '/open/user/two-factor/login',
    '/open/system',
    '/open/user/init',
    '/open/user/notification/init',
  ],
  versionFile,
  lastVersionFile,
  sqliteFile,
  sshdPath,
  systemLogPath,
};
